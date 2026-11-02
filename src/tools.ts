import { type ImageApi, type ImageContent, type ImageModel, Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionFactory, type McpServerConfig, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { errorMessage } from './error.ts';

const BLOCKED = 'Tools are off in this thread: someone who has posted in it is not allowed to use them.';

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
 * Blocks every tool call, nested ones from codemode scripts included, unless everyone in the thread
 * may use tools. Asked on every call, with the tool's name.
 */
export function toolGuard(allowed: (toolName: string) => boolean): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', (event) => (allowed(event.toolName) ? undefined : { block: true, reason: BLOCKED }));
  };
}

/** An image the agent generated, as the image model returned it, to be posted with the reply. */
export interface GeneratedImage {
  name: string;
  mimeType: string;
  /** Base64. */
  data: string;
}

const IMAGE_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/**
 * `generate_image`, with `model`. Each image goes to `onImage` as the model returned it, for the bot to
 * post, and to the agent too, which pi scales down and re-encodes like any tool result's images.
 */
export function imageGeneration(
  models: Pick<ModelRuntime, 'generateImages'>,
  model: ImageModel<ImageApi>,
  onImage: (image: GeneratedImage) => void,
): ExtensionFactory {
  return (pi) => {
    // Numbers the session's images, so their names in the thread differ.
    let count = 0;
    pi.registerTool(
      defineTool({
        name: 'generate_image',
        label: 'Generate Image',
        description: 'Generates images from a prompt. Every image it generates is attached to your reply in the thread.',
        promptSnippet: 'Generate images, which are attached to your reply',
        parameters: Type.Object({
          prompt: Type.String({ description: 'What the image shows, and in what style, in detail' }),
        }),
        annotations: { openWorldHint: true },

        async execute(_toolCallId, { prompt }, signal) {
          const result = await models.generateImages(model, { input: [{ type: 'text', text: prompt }] }, { signal });
          if (result.stopReason !== 'stop') throw new Error(result.errorMessage ?? `Image generation ${result.stopReason}`);
          const text = result.output
            .flatMap((c) => (c.type === 'text' ? [c.text] : []))
            .join('\n')
            .trim();
          const images = result.output.filter((c): c is ImageContent => c.type === 'image');
          if (!images.length) throw new Error(`${model.id} returned no image${text ? `: ${text}` : ''}`);
          const names = images.map((image) => {
            const name = `image-${++count}.${IMAGE_EXTENSIONS[image.mimeType] ?? 'png'}`;
            onImage({ name, mimeType: image.mimeType, data: image.data });
            return name;
          });
          return {
            content: [{ type: 'text', text: `Generated ${names.join(', ')}, attached to your reply.${text ? `\n${model.id} said: ${text}` : ''}` }, ...images],
            details: { model: `${model.provider}/${model.id}`, names },
            ...(result.usage ? { usage: result.usage } : {}),
          };
        },
      }),
    );
  };
}
