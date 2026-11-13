import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssistantImages, ImageApi, ImageContent, ImageModel } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { imageGeneration, toolImages } from '../src/image-tools.ts';
import { fakeStore, PNG } from './fakes.ts';

const PAINTER = { provider: 'openrouter', id: 'google/gemini-2.5-flash-image', input: ['text'] } as ImageModel<ImageApi>;
const EDITOR = { provider: 'openrouter', id: 'microsoft/mai-image-2.6', input: ['text', 'image'] } as ImageModel<ImageApi>;

/**
 * generate_image, with an image model that answers with `output`, or as `result` says, and a store
 * that holds `stored` images.
 */
function imageTool(result: Partial<AssistantImages>, model = PAINTER, stored: Record<string, ImageContent> = {}) {
  const calls: unknown[] = [];
  const models = {
    async generateImages(model: unknown, context: unknown) {
      calls.push({ model, context });
      return { stopReason: 'stop', output: [], ...result } as AssistantImages;
    },
  };
  const { store, saved, attached } = fakeStore(stored);
  let tool!: ToolDefinition;
  const pi = { registerTool: (t: ToolDefinition) => (tool = t) };
  imageGeneration(models, model, store)(pi as unknown as ExtensionAPI);
  const run = (params: { prompt: string; images?: string[] }) => tool.execute('t1', params, undefined, undefined, {} as never);
  return { calls, saved, attached, tool, run };
}

const WEBP = { type: 'image' as const, data: 'd2VicA==', mimeType: 'image/webp' };

test('generate_image keeps each image, attaches it to the reply, and hands it to the agent', async () => {
  const { calls, saved, attached, run } = imageTool({ output: [{ type: 'text', text: 'Here is a fox.' }, PNG, WEBP] });
  const result = await run({ prompt: 'a red fox in the snow' });
  assert.deepEqual(calls, [{ model: PAINTER, context: { input: [{ type: 'text', text: 'a red fox in the snow' }] } }]);
  assert.deepEqual(saved, [
    { name: 'image-1', image: PNG },
    { name: 'image-2', image: WEBP },
  ]);
  assert.deepEqual(attached, ['image-1', 'image-2']);
  assert.deepEqual(result.content, [
    { type: 'text', text: 'Generated image-1, image-2, attached to your reply.\ngoogle/gemini-2.5-flash-image said: Here is a fox.' },
    PNG,
    WEBP,
  ]);
});

test("generate_image fails when the image model does, or doesn't return an image", async () => {
  await assert.rejects(imageTool({ stopReason: 'error', errorMessage: 'No credits' }).run({ prompt: 'a fox' }), /No credits/);
  const refused = imageTool({ output: [{ type: 'text', text: 'I cannot draw that.' }] });
  await assert.rejects(refused.run({ prompt: 'a fox' }), /returned no image: I cannot draw that\./);
  assert.deepEqual(refused.saved, []);
});

test('generate_image takes images to change only when its model takes images', async () => {
  const painter = imageTool({ output: [PNG] });
  assert.equal((painter.tool.parameters as { properties: Record<string, unknown> }).properties.images, undefined);
  // Sent anyway, they're left out.
  await painter.run({ prompt: 'darker', images: ['garage.png'] });
  assert.deepEqual(painter.calls, [{ model: PAINTER, context: { input: [{ type: 'text', text: 'darker' }] } }]);

  const editor = imageTool({ output: [PNG] }, EDITOR, { 'garage.png': WEBP, 'image.png': PNG });
  assert.ok((editor.tool.parameters as { properties: Record<string, unknown> }).properties.images);
  await editor.run({ prompt: 'put the fox in the garage', images: ['image.png', 'garage.png'] });
  assert.deepEqual(editor.calls, [{ model: EDITOR, context: { input: [{ type: 'text', text: 'put the fox in the garage' }, PNG, WEBP] } }]);

  assert.deepEqual(editor.tool.prepareArguments!({ prompt: 'darker', images: 'garage.png' }), { prompt: 'darker', images: ['garage.png'] });

  const missing = imageTool({ output: [PNG] }, EDITOR);
  await assert.rejects(missing.run({ prompt: 'darker', images: ['nope.png'] }), /no nope\.png/);
  assert.deepEqual(missing.calls, []);
});

test("other tools' images are kept as they returned them, and named in their results", async () => {
  const { store, saved } = fakeStore();
  let onToolResult!: (event: object) => Promise<unknown>;
  const pi = { on: (_event: string, handler: typeof onToolResult) => (onToolResult = handler) };
  toolImages(store, ['generate_image'])(pi as unknown as ExtensionAPI);

  const result = { toolName: 'webfetch', toolCallId: 'c1', content: [{ type: 'text', text: 'URL: x' }, PNG, WEBP], details: { url: 'x' }, structuredContent: { a: 1 }, usage: { input: 1 }, isError: false };
  assert.deepEqual(await onToolResult(result), {
    content: [...result.content, { type: 'text', text: 'Saved as fetched-1, fetched-2, which you can pass to tools that take images.' }],
    details: { url: 'x' },
    structuredContent: { a: 1 },
    usage: { input: 1 },
  });
  assert.deepEqual(saved, [
    { name: 'fetched-1', image: PNG },
    { name: 'fetched-2', image: WEBP },
  ]);

  // Not one of its own tools', a nested call's, nor a result without images.
  assert.equal(await onToolResult({ ...result, toolName: 'generate_image' }), undefined);
  assert.equal(await onToolResult({ ...result, toolCallId: 'c2/1', parentToolCallId: 'c2' }), undefined);
  assert.equal(await onToolResult({ ...result, content: [{ type: 'text', text: 'hi' }] }), undefined);
  assert.equal(saved.length, 2);
});
