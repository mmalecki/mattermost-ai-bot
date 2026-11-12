import { type ImageApi, type ImageContent, type ImageModel, Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionFactory, type McpServerConfig, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ImageArguments, ImageForm } from './config.ts';
import { textOf } from './content.ts';
import { errorMessage } from './error.ts';
import type { ImageFiles, ImageStore } from './images.ts';

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
 * Writes the system prompt for the tools the thread has. Before each run, `prompt` is given the tools
 * that are registered and `allowed`, so the prompt tells the model only how to use those, and it
 * replaces the prompt pi was given. Also drops the `<cwd>` section pi adds to every system prompt: the
 * bot has no file access, and a working directory invites the model to answer as if it were inside a
 * software project. Register it last: after the MCP extension, which registers direct servers' tools
 * before its own handler returns, and after the other extensions, so their sections are already in the
 * prompt it edits.
 */
export function threadPrompt(allowed: (toolName: string) => boolean, prompt: (tools: ReadonlySet<string>) => string): ExtensionFactory {
  return (pi) => {
    pi.on('before_agent_start', (event) => {
      // Set on the options rather than returned alone, so the sections pi records match what is sent.
      event.systemPromptOptions.customPrompt = prompt(new Set(pi.getAllTools().map((tool) => tool.name).filter(allowed)));
      return { systemPrompt: stripCwd(event.systemPrompt) };
    });
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

/**
 * `generate_image`, with `model`. Each image is kept in `store` and attached to the reply, and goes to
 * the agent too, which pi scales down and re-encodes like any tool result's images. When the model takes
 * images, the tool takes images to change or draw from, by their names in `store`.
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
                    description: "Names of images to change or draw from: ones posted in the thread, by the name on their [image] line, or ones you generated or a tool returned",
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
          const { prompt, images: names = [] } = params as { prompt: string; images?: string[] };
          // A model that doesn't take images never gets the parameter, but may send it anyway.
          const given = edits ? await store.get(names) : [];
          const result = await models.generateImages(model, { input: [{ type: 'text', text: prompt }, ...given] }, { signal });
          if (result.stopReason !== 'stop') throw new Error(result.errorMessage ?? `Image generation ${result.stopReason}`);
          const text = textOf(result.output, '\n').trim();
          const images = result.output.filter((c): c is ImageContent => c.type === 'image');
          if (!images.length) throw new Error(`${model.id} returned no image${text ? `: ${text}` : ''}`);
          const kept: string[] = [];
          for (const image of images) kept.push(await store.save('image', image));
          kept.forEach((name) => store.attach(name));
          return {
            content: [{ type: 'text', text: `Generated ${kept.join(', ')}, attached to your reply.${text ? `\n${model.id} said: ${text}` : ''}` }, ...images],
            details: { model: `${model.provider}/${model.id}`, names: kept },
            ...(result.usage ? { usage: result.usage } : {}),
          };
        },
      }),
    );
  };
}

/**
 * Keeps the images other tools return, such as webfetch's or an MCP server's, in `store`, as they
 * returned them, and names them in their results, so they can be passed to tools that take images.
 * Not `ownTools`', which keep their images themselves, nor those of nested calls, such as a codemode
 * script's, whose results go to the script rather than the model.
 */
export function toolImages(store: ImageFiles, ownTools: string[]): ExtensionFactory {
  return (pi) => {
    pi.on('tool_result', async (event) => {
      if (ownTools.includes(event.toolName) || event.parentToolCallId) return undefined;
      const images = event.content.filter((c): c is ImageContent => c.type === 'image');
      if (!images.length) return undefined;
      const names: string[] = [];
      // In order, so they're numbered as they come. Copies, as pi re-encodes the result's images.
      for (const image of images) names.push(await store.save('fetched', { ...image }));
      // A result replaces the whole of the tool's, so the rest is carried over.
      return {
        content: [...event.content, { type: 'text', text: `Saved as ${names.join(', ')}, which you can pass to tools that take images.` }],
        details: event.details,
        structuredContent: event.structuredContent,
        usage: event.usage,
      };
    });
  };
}

/**
 * Gives the MCP servers in `servers` images by name: where a call to one of their tools has the name of
 * an image in `store` in one of the server's image arguments, at any depth, or in a list there, the image
 * goes in its place, in the form the argument takes. Names elsewhere are left as they are, so an image
 * never reaches an argument that takes something else, and is echoed back in an error. Nested calls too,
 * such as a codemode script's. pi hands the hook its own copy of the arguments, so the image stays out
 * of the session.
 */
export function mcpImages(servers: Record<string, ImageArguments>, store: ImageFiles): ExtensionFactory {
  const prefixes = Object.entries(servers).map(([name, args]) => [`${mcpNamespace(name)}__`, args] as const);
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const args = prefixes.find(([prefix]) => event.toolName.startsWith(prefix))?.[1];
      if (args) await replaceImages(event.input, args, store);
      return undefined;
    });
  };
}

/** Might name an image: a file name, without directories, with an image's extension. */
const IMAGE_NAME = /^[^/\\]+\.(?:png|jpe?g|webp|gif)$/i;

/** Replaces the names of images in `store` in `value`'s image arguments, `args`, with the images, in place. */
async function replaceImages(value: unknown, args: ImageArguments, store: ImageFiles, form?: ImageForm): Promise<void> {
  if (typeof value !== 'object' || value === null) return;
  const entries = Array.isArray(value) ? value.map((item, i) => [i, item] as const) : Object.entries(value);
  await Promise.all(
    entries.map(async ([key, item]) => {
      // An image argument, or a list in one.
      const itemForm = typeof key === 'string' && Object.hasOwn(args, key) ? args[key] : form;
      if (typeof item !== 'string') return replaceImages(item, args, store, itemForm);
      if (!itemForm || !IMAGE_NAME.test(item)) return;
      // A name of something the thread doesn't have is left as it is.
      const image = await imageIn(store, item, itemForm).catch(() => undefined);
      if (image !== undefined) (value as Record<string | number, unknown>)[key] = image;
    }),
  );
}

async function imageIn(store: ImageFiles, name: string, form: ImageForm): Promise<string> {
  if (form === 'path') return store.path(name);
  const [image] = await store.get([name]);
  return form === 'base64' ? image!.data : `data:${image!.mimeType};base64,${image!.data}`;
}

/** Tool names are `mcp__<server>__<tool>`, with `-` in the server name replaced by `_`. */
export function mcpNamespace(server: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_]/g, '_')}`;
}
