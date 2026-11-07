import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Api, AssistantMessage, Context, ImageContent, Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import photon from '@silvia-odwyer/photon-node';
import type { ImageFiles } from '../src/images.ts';
import { crop, imageCrop, parseBoxes, vision } from '../src/vision.ts';

/** A `width` by `height` PNG, red in its top left quarter and white elsewhere. */
function png(width: number, height: number): ImageContent {
  const pixels = new Uint8Array(width * height * 4).fill(255);
  for (let y = 0; y < height / 2; y++) {
    for (let x = 0; x < width / 2; x++) pixels.set([255, 0, 0, 255], (y * width + x) * 4);
  }
  const image = new photon.PhotonImage(pixels, width, height);
  const data = Buffer.from(image.get_bytes()).toString('base64');
  image.free();
  return { type: 'image', data, mimeType: 'image/png' };
}

/** The RGBA of the pixel at `x`, `y` of a PNG. */
function pixel(image: ImageContent, x: number, y: number): number[] {
  const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(image.data, 'base64'));
  const at = (y * decoded.get_width() + x) * 4;
  const rgba = [...decoded.get_raw_pixels().slice(at, at + 4)];
  decoded.free();
  return rgba;
}

test('reads boxes with named coordinates, as asked for', () => {
  const size = { width: 800, height: 600 };
  assert.deepEqual(parseBoxes('```json\n[{"label": "barcode", "ymin": 573, "xmin": 597, "ymax": 809.4, "xmax": 894}]\n```', size), [{ label: 'barcode', box: [573, 597, 809, 894] }]);
  assert.deepEqual(parseBoxes('[{"ymin": 1, "xmin": 2, "ymax": 3}]', size), []);
});

test('reads boxes as Gemini gives them, in JSON or a code block', () => {
  const size = { width: 800, height: 600 };
  assert.deepEqual(parseBoxes('[{"label": "barcode", "box_2d": [100, 200, 300.4, 400]}]', size), [{ label: 'barcode', box: [100, 200, 300, 400] }]);
  assert.deepEqual(parseBoxes('Here:\n```json\n[{"label": "tag", "box_2d": [500, 600, 400, 700]}, {"box_2d": [-10, 0, 50, 50]}]\n```', size), [
    // Corners in either order, kept within the image.
    { label: 'tag', box: [400, 600, 500, 700] },
    { label: '', box: [0, 0, 50, 50] },
  ]);
  assert.deepEqual(parseBoxes('[]', size), []);
});

test("reads Qwen's boxes, from 0 to 1000 or in the pixels of the image it saw", () => {
  const size = { width: 2000, height: 1000 };
  assert.deepEqual(parseBoxes('[{"bbox_2d": [200, 100, 400, 300], "label": "barcode"}]', size), [{ label: 'barcode', box: [100, 200, 300, 400] }]);
  assert.deepEqual(parseBoxes('[{"bbox_2d": [1000, 100, 1500, 500]}]', size), [{ label: '', box: [100, 500, 500, 750] }]);
});

test("leaves out items that aren't boxes, and fails on an answer without any JSON", () => {
  const size = { width: 100, height: 100 };
  assert.deepEqual(parseBoxes('[{"label": "a"}, {"box_2d": [1, 2, 3]}, {"box_2d": ["1", 2, 3, 4]}, 7, {"box_2d": [1, 2, 3, 4]}]', size), [{ label: '', box: [1, 2, 3, 4] }]);
  assert.throws(() => parseBoxes('I see no barcode.', size), /The vision model didn't answer with boxes: I see no barcode\./);
});

test('crops a box out of an image at its full size, with a margin', () => {
  const image = png(200, 100);
  const quarter = crop(image, [0, 0, 500, 500]);
  assert.deepEqual([quarter.width, quarter.height, quarter.image.mimeType], [100, 50, 'image/png']);
  assert.deepEqual(pixel(quarter.image, 99, 49), [255, 0, 0, 255]);

  const wider = crop(image, [400, 400, 600, 600], 100);
  assert.deepEqual([wider.width, wider.height], [80, 40]);
  assert.deepEqual(pixel(wider.image, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixel(wider.image, 79, 39), [255, 255, 255, 255]);

  // Kept within the image.
  assert.deepEqual([crop(image, [900, 900, 1200, 1200]).width, crop(image, [-50, 900, 100, 1000]).height], [20, 10]);
  assert.throws(() => crop(image, [500, 500, 500, 600]), /The box \[500,500,500,600\] is empty/);
});

const MODEL = { provider: 'openrouter', id: 'google/gemini-3.7-flash', input: ['text', 'image'] } as Model<Api>;

/**
 * The vision tools and crop_image, with a model that answers `answer`, a store that holds `stored`
 * images, and an agent that sees images unless `seesImages` is false.
 */
function tools(answer: string, stored: Record<string, ImageContent> = {}, thinkingLevel: 'off' | 'low' = 'off', seesImages = true, stopReason = 'stop') {
  const requests: { context: Context; options: unknown }[] = [];
  const models = {
    async completeSimple(_model: unknown, context: Context, options: unknown) {
      requests.push({ context, options });
      return { role: 'assistant', content: [{ type: 'text', text: answer }], stopReason, usage: { input: 1 } } as unknown as AssistantMessage;
    },
  };
  const saved: { name: string; image: ImageContent }[] = [];
  const store: ImageFiles = {
    async save(name, image) {
      saved.push({ name: `${name}.png`, image });
      return `${name}.png`;
    },
    async get(names) {
      return names.map((name) => {
        if (!stored[name]) throw new Error(`no ${name}`);
        return stored[name];
      });
    },
    async path(name) {
      return name;
    },
  };
  const registered = new Map<string, ToolDefinition>();
  const pi = { registerTool: (tool: ToolDefinition) => registered.set(tool.name, tool) };
  vision(models, MODEL, thinkingLevel, store, seesImages)(pi as unknown as ExtensionAPI);
  imageCrop(store, seesImages)(pi as unknown as ExtensionAPI);
  const run = (name: string, params: object) => registered.get(name)!.execute('t1', params, undefined, undefined, {} as never);
  return { requests, saved, registered, run };
}

test('look_at_image asks the vision model about the images, each named, for an agent that can\'t see them', async () => {
  const garage = png(40, 20);
  const { requests, run, registered } = tools('A red square.', { 'garage.png': garage }, 'low', false);
  const result = await run('look_at_image', { images: ['garage.png'], question: 'What is in it?' });
  assert.deepEqual(result.content, [{ type: 'text', text: 'A red square.' }]);
  assert.deepEqual(result.usage, { input: 1 });
  const [request] = requests;
  assert.deepEqual(request!.options, { signal: undefined, maxTokens: 2048, reasoning: 'low' });
  assert.match(request!.context.systemPrompt!, /^Answer briefly and factually/);
  const content = request!.context.messages[0]!.content as { type: string; text?: string }[];
  assert.deepEqual(
    content.map((c) => c.text ?? c.type),
    ['What is in it?', 'Image 1: garage.png', 'image'],
  );
  assert.deepEqual(registered.get('look_at_image')!.prepareArguments!({ images: 'garage.png', question: 'q' }), { images: ['garage.png'], question: 'q' });
  await assert.rejects(run('look_at_image', { images: ['nope.png'], question: 'q' }), /no nope\.png/);

  // An agent that sees images looks at them itself.
  assert.deepEqual([...tools('').registered.keys()], ['locate', 'crop_image']);

  // An answer that ran out of tokens says so.
  const cut = await tools('A red', { 'garage.png': garage }, 'off', false, 'length').run('look_at_image', { images: ['garage.png'], question: 'q' });
  assert.deepEqual(cut.content, [{ type: 'text', text: 'A red\n[google/gemini-3.7-flash was cut off here]' }]);
});

test('locate gives the boxes the vision model finds', async () => {
  const found = tools('```json\n[{"label": "barcode", "box_2d": [10, 20, 30, 40]}]\n```', { 'can.jpg': png(40, 20) });
  const result = await found.run('locate', { image: 'can.jpg', what: 'barcodes' });
  assert.deepEqual(result.content, [{ type: 'text', text: 'Found in can.jpg, as [ymin, xmin, ymax, xmax] from 0 to 1000:\n[{"label":"barcode","box":[10,20,30,40]}]' }]);
  assert.match((found.requests[0]!.context.messages[0]!.content as { text: string }[])[0]!.text, /^Find barcodes in the image\. Answer only with a JSON array, .*"ymin": <top>/);
  // Without thinking, none is asked for.
  assert.deepEqual(found.requests[0]!.options, { signal: undefined, maxTokens: 2048 });

  const none = await tools('[]', { 'can.jpg': png(40, 20) }).run('locate', { image: 'can.jpg', what: 'barcodes' });
  assert.deepEqual(none.content, [{ type: 'text', text: 'google/gemini-3.7-flash found none in can.jpg.' }]);
});

test('crop_image keeps the box as an image of its own, named after the image', async () => {
  const { run, saved, registered } = tools('', { 'can.jpg': png(200, 100) });
  const result = await run('crop_image', { image: 'can.jpg', box: [0, 0, 500, 500] });
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.name, 'can-crop.png');
  assert.deepEqual(result.content, [{ type: 'text', text: 'Saved as can-crop.png, 100x50, which you can pass to tools that take images.' }, saved[0]!.image]);
  assert.deepEqual(registered.get('crop_image')!.prepareArguments!({ image: 'can.jpg', box: '[1, 2, 3, 4]' }), { image: 'can.jpg', box: [1, 2, 3, 4] });

  // Kept, but not shown to an agent that doesn't see images.
  const blind = tools('', { 'can.jpg': png(200, 100) }, 'off', false);
  const unseen = await blind.run('crop_image', { image: 'can.jpg', box: [0, 0, 500, 500] });
  assert.deepEqual(unseen.content, [{ type: 'text', text: 'Saved as can-crop.png, 100x50, which you can pass to tools that take images.' }]);
  assert.equal(blind.saved.length, 1);
});
