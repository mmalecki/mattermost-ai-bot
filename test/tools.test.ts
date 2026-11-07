import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssistantImages, ImageApi, ImageContent, ImageModel } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { type ImageStore, imageGeneration, mcpImages, mcpServers, stripCwd, toolGuard, toolImages } from '../src/tools.ts';

const BLOCKED = 'Tools are off in this thread: someone who has posted in it is not allowed to use them.';

test('registers each configured MCP server, skipping ones pi rejects', (t) => {
  const registered: string[] = [];
  const pi = {
    registerMcpServer(name: string) {
      if (name === 'bad') throw new Error('needs "command" or "url"');
      registered.push(name);
    },
  };
  const error = t.mock.method(console, 'error', () => {});
  mcpServers({ home: { url: 'http://ha/api/mcp' }, bad: {} as never, docs: { command: 'docs-mcp' } })(pi as unknown as ExtensionAPI);
  assert.deepEqual(registered, ['home', 'docs']);
  assert.equal(error.mock.callCount(), 1);
});

test('blocks every tool call unless allowed', () => {
  let allowed = true;
  let onToolCall!: (event: { toolName: string }) => unknown;
  const pi = { on: (_event: string, handler: typeof onToolCall) => (onToolCall = handler) };
  toolGuard(() => allowed)(pi as unknown as ExtensionAPI);

  assert.equal(onToolCall({ toolName: 'websearch' }), undefined);
  allowed = false;
  for (const toolName of ['websearch', 'mcp__home__intent__HassTurnOn', 'codemode']) {
    assert.deepEqual(onToolCall({ toolName }), { block: true, reason: BLOCKED });
  }
});

test("drops only pi's cwd section from the system prompt", () => {
  const prompt = 'You are a bot.\n\n<mcp_servers>\n- docs: search\n</mcp_servers>\n\n<cwd>\n/srv/bot/data\n</cwd>';
  assert.equal(stripCwd(prompt), 'You are a bot.\n\n<mcp_servers>\n- docs: search\n</mcp_servers>');
  assert.equal(stripCwd('You are a bot.'), 'You are a bot.');
});

test('tells the guard which tool is called', () => {
  let onToolCall!: (event: { toolName: string }) => unknown;
  const pi = { on: (_event: string, handler: typeof onToolCall) => (onToolCall = handler) };
  toolGuard((name) => name === 'websearch')(pi as unknown as ExtensionAPI);
  assert.equal(onToolCall({ toolName: 'websearch' }), undefined);
  assert.deepEqual(onToolCall({ toolName: 'mcp__home__intent__HassTurnOn' }), { block: true, reason: BLOCKED });
});

const PAINTER = { provider: 'openrouter', id: 'google/gemini-2.5-flash-image', input: ['text'] } as ImageModel<ImageApi>;
const EDITOR = { provider: 'openrouter', id: 'microsoft/mai-image-2.6', input: ['text', 'image'] } as ImageModel<ImageApi>;

/** A store that holds `stored` images, and keeps those saved to it under `<name>-<n>`. */
function fakeStore(stored: Record<string, ImageContent> = {}) {
  const saved: { name: string; image: ImageContent }[] = [];
  const attached: string[] = [];
  const store: ImageStore = {
    async save(name, image) {
      saved.push({ name: `${name}-${saved.length + 1}`, image });
      return saved.at(-1)!.name;
    },
    async get(names) {
      return names.map((name) => {
        if (!stored[name]) throw new Error(`no ${name}`);
        return stored[name];
      });
    },
    async path(name) {
      return `/images/${name}`;
    },
    attach: (name) => attached.push(name),
  };
  return { store, saved, attached };
}

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

const PNG = { type: 'image' as const, data: 'cG5n', mimeType: 'image/png' };
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

test('MCP servers that take images get them in place of their names, in the form they take', async () => {
  const { store } = fakeStore({ 'garage.png': PNG, 'scan.jpg': { type: 'image', data: 'anBn', mimeType: 'image/jpeg' } });
  let onToolCall!: (event: { toolName: string; input: unknown }) => Promise<unknown>;
  const pi = { on: (_event: string, handler: typeof onToolCall) => (onToolCall = handler) };
  mcpImages({ 'bar-codes': 'base64', vision: 'dataUrl', files: 'path' }, store)(pi as unknown as ExtensionAPI);

  const call = async (toolName: string, input: unknown) => {
    assert.equal(await onToolCall({ toolName, input }), undefined);
    return input;
  };
  assert.deepEqual(await call('mcp__bar_codes__decode', { base64: 'garage.png', note: 'garage.png is mine' }), { base64: 'cG5n', note: 'garage.png is mine' });
  assert.deepEqual(await call('mcp__vision__describe', { images: [{ url: 'scan.jpg' }, 'garage.png'] }), {
    images: [{ url: 'data:image/jpeg;base64,anBn' }, 'data:image/png;base64,cG5n'],
  });
  assert.deepEqual(await call('mcp__files__open', { path: 'garage.png' }), { path: '/images/garage.png' });
  // Names the thread has no image under, and other servers' tools, are left as they are.
  assert.deepEqual(await call('mcp__bar_codes__decode', { base64: 'other.png' }), { base64: 'other.png' });
  assert.deepEqual(await call('mcp__home__look', { image: 'garage.png' }), { image: 'garage.png' });
  assert.deepEqual(await call('mcp__vision_extra__look', { image: 'garage.png' }), { image: 'garage.png' });
});
