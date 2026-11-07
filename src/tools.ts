import { type ImageApi, type ImageContent, type ImageModel, Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionFactory, type McpServerConfig, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { textOf } from './content.ts';
import { errorMessage } from './error.ts';

/** Why a call is blocked. Every tool may be off, so this doesn't say others are left. */
const blocked = (toolName: string) => `${toolName} is off in this thread: someone who has posted in it is not allowed to use it.`;

/**
 * Registers the configured MCP servers with pi's MCP extension, which validates each config and
 * resolves `${VAR}` references in it when connecting. An invalid server is reported and skipped.
 */
export function mcpServers(servers: Record<string, McpServerConfig>): ExtensionFactory {
  return (pi) => {
    for (const [name, config] of Object.entries(servers)) {
      try {
        pi.registerMcpServer(name, config);
      } catch (error) {
        console.error(`MCP server "${name}" skipped: ${errorMessage(error)}`);
      }
    }
  };
}

/**
 * Drops the `<cwd>` section pi adds to every system prompt. The bot has no file access, and a working
 * directory invites the model to answer as if it were inside a software project. Register it last,
 * so the other extensions' sections are already in the prompt it edits.
 */
export function withoutCwd(): ExtensionFactory {
  return (pi) => {
    pi.on('before_agent_start', (event) => ({ systemPrompt: stripCwd(event.systemPrompt) }));
  };
}

export function stripCwd(systemPrompt: string): string {
  return systemPrompt.replace(/\n*<cwd>\n[\s\S]*?\n<\/cwd>/, '');
}

/**
 * Keeps the model to the tools everyone in the thread may use. Before each run and turn, tools that
 * aren't allowed are taken off the ones declared to the model, which also keeps codemode scripts from
 * calling `direct` ones. A thread's tools only shrink while its session is open, so this only takes
 * tools away: a reopened session declares them afresh, and has them taken away again. And it
 * blocks every tool call, nested ones from codemode scripts included, unless allowed: tools reached
 * through codemode or tool_search are never declared, and a tool registered during a run, such as one
 * of an MCP server still connecting, is declared until the next turn. Asked with each tool's name.
 */
export function toolGuard(allowed: (toolName: string) => boolean): ExtensionFactory {
  return (pi) => {
    const narrow = () => {
      const active = pi.getActiveTools();
      const kept = active.filter((name) => allowed(name));
      if (kept.length < active.length) pi.setActiveTools(kept);
    };
    pi.on('before_agent_start', narrow);
    pi.on('turn_start', narrow);
    pi.on('tool_call', (event) => (allowed(event.toolName) ? undefined : { block: true, reason: blocked(event.toolName) }));
  };
}

/** Where generate_image keeps the images it makes, and finds the ones it is given. */
export interface ImageStore {
  /** Keeps a generated image, as the image model returned it, to be posted with the reply. Returns its name. */
  add(image: ImageContent): string;
  /**
   * Names an image another tool returned, the `index`th image of call `toolCallId`'s result, which is
   * found in the session when it is given. Returns its name.
   */
  addFetched(toolCallId: string, index: number, mimeType: string): string;
  /**
   * The images `refs` name, in order: ones posted in the thread by their file id, and generated and
   * fetched ones by name. Throws for a reference to anything else, naming it.
   */
  get(refs: string[]): Promise<ImageContent[]>;
}

/**
 * `generate_image`, with `model`. Each image goes to `store` as the model returned it, for the bot to
 * post, and to the agent too, which pi scales down and re-encodes like any tool result's images. When the
 * model takes images, the tool takes images to change or draw from, which `store` finds, and the images
 * other tools return are named in their results so they can be given too.
 */
export function imageGeneration(models: Pick<ModelRuntime, 'generateImages'>, model: ImageModel<ImageApi>, store: ImageStore): ExtensionFactory {
  const edits = model.input.includes('image');
  return (pi) => {
    pi.registerTool(
      defineTool({
        name: 'generate_image',
        label: 'Generate Image',
        description: `Generates images from a prompt${edits ? ', and from images to change or draw from' : ''}. Every image it generates is attached to your reply in the thread.`,
        promptSnippet: 'Generate images, which are attached to your reply',
        parameters: Type.Object({
          prompt: Type.String({ description: edits ? 'What the image shows, and in what style, in detail, or what to change in the images' : 'What the image shows, and in what style, in detail' }),
          ...(edits
            ? {
                images: Type.Optional(
                  Type.Array(Type.String(), {
                    description: 'Images to change or draw from: ones posted in the thread by their file id, ones you generated or a tool returned by their name',
                  }),
                ),
              }
            : {}),
        }),
        annotations: { openWorldHint: true },
        // Small models often send a single image as a string. Validation follows.
        prepareArguments(args) {
          const input = args as { images?: unknown };
          return (typeof input?.images === 'string' ? { ...input, images: [input.images] } : input) as never;
        },

        async execute(_toolCallId, params, signal) {
          const { prompt, images: refs = [] } = params as { prompt: string; images?: string[] };
          // A model that doesn't take images never gets the parameter, but may send it anyway.
          const given = edits ? await store.get(refs) : [];
          const result = await models.generateImages(model, { input: [{ type: 'text', text: prompt }, ...given] }, { signal });
          if (result.stopReason !== 'stop') throw new Error(result.errorMessage ?? `Image generation ${result.stopReason}`);
          const text = textOf(result.output, '\n').trim();
          const images = result.output.filter((c): c is ImageContent => c.type === 'image');
          if (!images.length) throw new Error(`${model.id} returned no image${text ? `: ${text}` : ''}`);
          // Copies, as pi re-encodes the result's images.
          const names = images.map((image) => store.add({ ...image }));
          return {
            content: [{ type: 'text', text: `Generated ${names.join(', ')}, attached to your reply.${text ? `\n${model.id} said: ${text}` : ''}` }, ...images],
            details: { model: `${model.provider}/${model.id}`, names },
            ...(result.usage ? { usage: result.usage } : {}),
          };
        },
      }),
    );
    if (!edits) return;

    // Images from webfetch, MCP servers and the like. Not those of nested calls, such as a codemode
    // script's, whose results go to the script rather than the model.
    pi.on('tool_result', (event) => {
      if (event.toolName === 'generate_image' || event.parentToolCallId) return undefined;
      const names = event.content.flatMap((c) => (c.type === 'image' ? [c] : [])).map((image, i) => store.addFetched(event.toolCallId, i, image.mimeType));
      if (!names.length) return undefined;
      // A result replaces the whole of the tool's, so the rest is carried over.
      return {
        content: [...event.content, { type: 'text', text: `Saved as ${names.join(', ')}, which you can pass to generate_image.` }],
        details: event.details,
        structuredContent: event.structuredContent,
        usage: event.usage,
      };
    });
  };
}
