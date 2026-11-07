import { type Api, type ImageContent, type Model, type ThinkingLevel, Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionFactory, type ModelRuntime, resizeImage } from '@earendil-works/pi-coding-agent';
import photon from '@silvia-odwyer/photon-node';
import type { ModelChoice } from './config.ts';
import { textOf } from './content.ts';
import type { ImageFiles } from './images.ts';

/** The vision tools, which keep the images they make themselves. */
export const VISION_TOOLS = ['look_at_image', 'locate', 'crop_image'];

/**
 * How much the vision model may say, so a model that repeats itself stops. Asked for short answers,
 * it needs far less.
 */
const MAX_TOKENS = 2048;

/** Asked of the vision model, which otherwise writes at length, and makes up what it can't read. */
const SYSTEM_PROMPT =
  "Answer briefly and factually, with what you see. Read text only as far as you can make it out, and say what you can't read, or aren't sure of, instead of guessing. Don't agree with what a question suggests unless the image shows it.";

/** A box in an image: `[ymin, xmin, ymax, xmax]`, from 0 to 1000 of its height and width. */
export type Box = [number, number, number, number];

/**
 * `look_at_image`, `locate` and `crop_image`: the agent asks `model`, a chat model that takes images,
 * about the images in `store`, finds things in them as boxes, and cuts boxes out as images of their
 * own, which `store` keeps for other tools to take. So a model that doesn't take images can use them,
 * and one that does can look closer: crops are shown to the agent when it `seesImages`.
 */
export function vision(
  models: Pick<ModelRuntime, 'completeSimple'>,
  model: Model<Api>,
  thinkingLevel: ModelChoice['thinkingLevel'],
  store: ImageFiles,
  seesImages: boolean,
): ExtensionFactory {
  /** `model`'s answer to `prompt` about the images `names` names, each scaled down to its limits. */
  const ask = async (prompt: string, names: string[], signal: AbortSignal | undefined) => {
    const content: (ImageContent | { type: 'text'; text: string })[] = [{ type: 'text', text: prompt }];
    const sizes: { width: number; height: number }[] = [];
    const images = await store.get(names);
    for (const [i, image] of images.entries()) {
      const resized = await resizeImage(Buffer.from(image.data, 'base64'), image.mimeType, model.inputLimits?.images?.resize);
      if (!resized) throw new Error(`${names[i]} is too large to look at`);
      sizes.push({ width: resized.width, height: resized.height });
      content.push({ type: 'text', text: `Image ${i + 1}: ${names[i]}` }, { type: 'image', data: resized.data, mimeType: resized.mimeType });
    }
    const message = await models.completeSimple(
      model,
      { systemPrompt: SYSTEM_PROMPT, messages: [{ role: 'user', content, timestamp: Date.now() }] },
      { signal, maxTokens: MAX_TOKENS, ...(thinkingLevel !== 'off' ? { reasoning: thinkingLevel as ThinkingLevel } : {}) },
    );
    if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error(message.errorMessage ?? `${model.id} ${message.stopReason}`);
    let text = textOf(message.content).trim();
    if (message.stopReason === 'length') text += `\n[${model.id} was cut off here]`;
    return { text, sizes, usage: message.usage };
  };
  const details = { model: `${model.provider}/${model.id}` };

  return (pi) => {
    pi.registerTool(
      defineTool({
        name: 'look_at_image',
        label: 'Look at Image',
        description: `Asks ${model.id}, which sees images, a question about images in the thread, such as what one shows, or what text is in it. Ask for everything you need at once. It can misread small or blurry text, and say what a question suggests: ask open questions, not whether it's something you have in mind, and check text it reads on a crop of it.`,
        promptSnippet: 'Ask a vision model about images in the thread',
        parameters: Type.Object({
          images: Type.Array(Type.String(), { description: 'Names of the images: posted ones, by the name on their [image] line, or ones you generated or a tool returned' }),
          question: Type.String({ description: 'What to tell about the images, in detail' }),
        }),
        // Small models often send a single image as a string. Validation follows.
        prepareArguments: (args) => withList(args, 'images'),
        async execute(_toolCallId, { images, question }, signal) {
          const { text, usage } = await ask(question, images, signal);
          return { content: [{ type: 'text', text: text || `${model.id} said nothing` }], details, usage };
        },
      }),
    );

    pi.registerTool(
      defineTool({
        name: 'locate',
        label: 'Locate',
        description: `Has ${model.id} find things in an image in the thread, as boxes, which crop_image cuts out. Boxes are [ymin, xmin, ymax, xmax], from 0 to 1000 of the image's height and width.`,
        promptSnippet: 'Find things in an image, as boxes',
        parameters: Type.Object({
          image: Type.String({ description: 'Name of the image' }),
          what: Type.String({ description: 'What to find, such as "barcodes", "the price tag" or "every face"' }),
        }),
        async execute(_toolCallId, { image, what }, signal) {
          // Named, as models give arrays in the order they were trained on, whatever they're asked for.
          const prompt = `Find ${what} in the image. Answer only with a JSON array, with an item for each one found: {"label": "<what it is>", "ymin": <top>, "xmin": <left>, "ymax": <bottom>, "xmax": <right>}, with coordinates from 0 to 1000 of the image's height (y) and width (x). Answer [] when there is none.`;
          const { text, sizes, usage } = await ask(prompt, [image], signal);
          const boxes = parseBoxes(text, sizes[0]!);
          const found = boxes.length ? `Found in ${image}, as [ymin, xmin, ymax, xmax] from 0 to 1000:\n${JSON.stringify(boxes)}` : `${model.id} found none in ${image}.`;
          return { content: [{ type: 'text', text: found }], details: { ...details, boxes }, usage };
        },
      }),
    );

    pi.registerTool(
      defineTool({
        name: 'crop_image',
        label: 'Crop Image',
        description:
          'Cuts a box out of an image in the thread, at its full size, and keeps it as an image of its own, which you can pass to tools that take images, to look closer or read it, such as a barcode or small text.',
        promptSnippet: 'Cut a box out of an image, as an image of its own',
        parameters: Type.Object({
          image: Type.String({ description: 'Name of the image' }),
          box: Type.Array(Type.Number(), { minItems: 4, maxItems: 4, description: '[ymin, xmin, ymax, xmax], from 0 to 1000 of the image\'s height and width, as locate gives it' }),
          margin: Type.Optional(Type.Number({ description: 'Added around the box, from 0 to 1000 of the image\'s height and width. Default 0' })),
        }),
        // Small models often send the box as JSON text. Validation follows.
        prepareArguments(args) {
          const input = args as { box?: unknown };
          if (typeof input?.box !== 'string') return input as never;
          try {
            return { ...input, box: JSON.parse(input.box) } as never;
          } catch {
            return input as never;
          }
        },
        async execute(_toolCallId, { image, box, margin = 0 }) {
          const [source] = await store.get([image]);
          const cropped = crop(source!, box as Box, margin);
          const name = await store.save(`${image.replace(/\.[^.]*$/, '')}-crop`, cropped.image);
          return {
            // Only to an agent that sees it: otherwise it would be kept in the session for nothing.
            content: [{ type: 'text', text: `Saved as ${name}, ${cropped.width}x${cropped.height}, which you can pass to tools that take images.` }, ...(seesImages ? [cropped.image] : [])],
            details: { name, width: cropped.width, height: cropped.height },
          };
        },
      }),
    );
  };
}

/** `args` with its `key` as a list, when sent as a single string. */
function withList(args: unknown, key: string): never {
  const input = args as Record<string, unknown> | undefined;
  return (typeof input?.[key] === 'string' ? { ...input, [key]: [input[key]] } : input) as never;
}

/**
 * The boxes a model answered with, from the JSON array in `text`, rounded and in order. Asked for
 * `ymin`, `xmin`, `ymax` and `xmax` from 0 to 1000; Gemini's `box_2d` is `[ymin, xmin, ymax, xmax]`, and
 * Qwen's `bbox_2d` `[xmin, ymin, xmax, ymax]`. Coordinates past 1000 are taken as pixels of the image
 * the model saw, of `size`, as Qwen 2.5 gives them. Items that aren't boxes are left out.
 */
export function parseBoxes(text: string, size: { width: number; height: number }): { label: string; box: Box }[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  let items: unknown;
  try {
    items = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error(`The vision model didn't answer with boxes: ${text.slice(0, 500)}`);
  }
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const { label, box_2d, bbox_2d, ...named } = item as Record<string, unknown>;
    // As [ymin, xmin, ymax, xmax].
    const raw =
      named.ymin !== undefined
        ? [named.ymin, named.xmin, named.ymax, named.xmax]
        : (box_2d ?? (Array.isArray(bbox_2d) ? [bbox_2d[1], bbox_2d[0], bbox_2d[3], bbox_2d[2]] : undefined));
    if (!Array.isArray(raw) || raw.length !== 4 || !raw.every((n) => typeof n === 'number' && Number.isFinite(n))) return [];
    let [ymin, xmin, ymax, xmax] = raw as number[];
    if (raw.some((n) => n > 1000)) {
      [ymin, xmin, ymax, xmax] = [(ymin! / size.height) * 1000, (xmin! / size.width) * 1000, (ymax! / size.height) * 1000, (xmax! / size.width) * 1000];
    }
    const scale = (n: number) => Math.round(Math.min(1000, Math.max(0, n)));
    const box: Box = [scale(Math.min(ymin!, ymax!)), scale(Math.min(xmin!, xmax!)), scale(Math.max(ymin!, ymax!)), scale(Math.max(xmin!, xmax!))];
    return [{ label: typeof label === 'string' ? label : '', box }];
  });
}

/** `box`, with `margin` around it, cut out of `image`, at its full size, as a PNG. */
export function crop(image: ImageContent, box: Box, margin = 0): { image: ImageContent; width: number; height: number } {
  if (box.length !== 4 || !box.every(Number.isFinite)) throw new Error('box must be [ymin, xmin, ymax, xmax], from 0 to 1000');
  const source = photon.PhotonImage.new_from_byteslice(Buffer.from(image.data, 'base64'));
  try {
    const width = source.get_width();
    const height = source.get_height();
    const [ymin, xmin, ymax, xmax] = box;
    const at = (n: number, size: number) => Math.round((Math.min(1000, Math.max(0, n)) / 1000) * size);
    const x1 = at(Math.min(xmin, xmax) - margin, width);
    const y1 = at(Math.min(ymin, ymax) - margin, height);
    const x2 = at(Math.max(xmin, xmax) + margin, width);
    const y2 = at(Math.max(ymin, ymax) + margin, height);
    if (x2 <= x1 || y2 <= y1) throw new Error(`The box ${JSON.stringify(box)} is empty`);
    const cropped = photon.crop(source, x1, y1, x2, y2);
    try {
      const data = Buffer.from(cropped.get_bytes()).toString('base64');
      return { image: { type: 'image', data, mimeType: 'image/png' }, width: x2 - x1, height: y2 - y1 };
    } finally {
      cropped.free();
    }
  } finally {
    source.free();
  }
}
