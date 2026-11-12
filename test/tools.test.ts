import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssistantImages, ImageApi, ImageContent, ImageModel } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ImageStore } from '../src/images.ts';
import { imageGeneration, mcpImages, mcpServers, toolGuard, toolImages } from '../src/tools.ts';

const blocked = (toolName: string) => ({ block: true, reason: `${toolName} is off in this thread: someone who has posted in it is not allowed to use it.` });

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

/** The tool guard's handlers, by event, on a pi whose active tools are `active`. */
function guard(allowed: (toolName: string) => boolean, active: string[] = []) {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const pi = {
    active,
    on: (event: string, handler: (event: unknown) => unknown) => void handlers.set(event, handler),
    getActiveTools: () => pi.active,
    setActiveTools(names: string[]) {
      pi.active = names;
      pi.sets++;
    },
    sets: 0,
  };
  toolGuard(allowed)(pi as unknown as ExtensionAPI);
  return { pi, onToolCall: (toolName: string) => handlers.get('tool_call')!({ toolName }), emit: (event: string) => handlers.get(event)!({ type: event }) };
}

test('blocks every tool call unless allowed', () => {
  let allowed = true;
  const { onToolCall } = guard(() => allowed);
  assert.equal(onToolCall('websearch'), undefined);
  allowed = false;
  for (const toolName of ['websearch', 'mcp__home__intent__HassTurnOn', 'codemode']) {
    assert.deepEqual(onToolCall(toolName), blocked(toolName));
  }
});

test('takes the tools that are not allowed off the declared ones, before each run and turn', () => {
  let allowed = (name: string) => name !== 'webfetch';
  const { pi, emit } = guard((name) => allowed(name), ['websearch', 'webfetch', 'mcp__home__HassTurnOn']);
  emit('before_agent_start');
  assert.deepEqual(pi.active, ['websearch', 'mcp__home__HassTurnOn']);
  // Nothing to take away: the loadout is left alone.
  emit('turn_start');
  assert.equal(pi.sets, 1);
  // A tool registered meanwhile is taken off at the next turn.
  pi.active = [...pi.active, 'mcp__slow__write'];
  allowed = (name) => name === 'websearch';
  emit('turn_start');
  assert.deepEqual(pi.active, ['websearch']);
});

test('tells the guard which tool is called', () => {
  const { onToolCall } = guard((name) => name === 'websearch');
  assert.equal(onToolCall('websearch'), undefined);
  assert.deepEqual(onToolCall('mcp__home__intent__HassTurnOn'), blocked('mcp__home__intent__HassTurnOn'));
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

test('MCP servers that take images get them in place of their names, in their image arguments, in the form they take', async () => {
  const { store } = fakeStore({ 'garage.png': PNG, 'scan.jpg': { type: 'image', data: 'anBn', mimeType: 'image/jpeg' } });
  let onToolCall!: (event: { toolName: string; input: unknown }) => Promise<unknown>;
  const pi = { on: (_event: string, handler: typeof onToolCall) => (onToolCall = handler) };
  mcpImages({ 'bar-codes': { base64: 'base64' }, vision: { url: 'dataUrl', images: 'dataUrl' }, files: { path: 'path' } }, store)(pi as unknown as ExtensionAPI);

  const call = async (toolName: string, input: unknown) => {
    assert.equal(await onToolCall({ toolName, input }), undefined);
    return input;
  };
  assert.deepEqual(await call('mcp__bar_codes__decode', { base64: 'garage.png', note: 'garage.png' }), { base64: 'cG5n', note: 'garage.png' });
  // At any depth, and in lists.
  assert.deepEqual(await call('mcp__bar_codes__decode_batch', { items: [{ base64: 'scan.jpg', label: 'scan.jpg' }] }), { items: [{ base64: 'anBn', label: 'scan.jpg' }] });
  assert.deepEqual(await call('mcp__vision__describe', { images: ['scan.jpg', 'garage.png'], url: 'garage.png' }), {
    images: ['data:image/jpeg;base64,anBn', 'data:image/png;base64,cG5n'],
    url: 'data:image/png;base64,cG5n',
  });
  assert.deepEqual(await call('mcp__files__open', { path: 'garage.png' }), { path: '/images/garage.png' });
  // In another argument, it stays a name, as do names the thread has no image under, and other servers' tools' arguments.
  assert.deepEqual(await call('mcp__bar_codes__decode', { path: 'garage.png' }), { path: 'garage.png' });
  assert.deepEqual(await call('mcp__bar_codes__decode', { base64: 'other.png' }), { base64: 'other.png' });
  assert.deepEqual(await call('mcp__home__look', { base64: 'garage.png' }), { base64: 'garage.png' });
  assert.deepEqual(await call('mcp__vision_extra__look', { url: 'garage.png' }), { url: 'garage.png' });
});
