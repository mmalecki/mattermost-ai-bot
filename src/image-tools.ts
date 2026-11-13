import { type ImageApi, type ImageContent, type ImageModel, Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionFactory, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { textOf } from './content.ts';
import type { ImageFiles, ImageStore } from './images.ts';

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
        prepareArguments: (args) => withList(args, 'images'),

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

/** `args` with its `key` as a list, when sent as a single string, for a tool's `prepareArguments`. */
export function withList(args: unknown, key: string): never {
  const input = args as Record<string, unknown> | undefined;
  return (typeof input?.[key] === 'string' ? { ...input, [key]: [input[key]] } : input) as never;
}
