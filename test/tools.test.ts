import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssistantImages, ImageApi, ImageContent, ImageModel } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { type ImageStore, imageGeneration, mcpServers, stripCwd, toolGuard } from '../src/tools.ts';

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

test("drops only pi's cwd section from the system prompt", () => {
  const prompt = 'You are a bot.\n\n<mcp_servers>\n- docs: search\n</mcp_servers>\n\n<cwd>\n/srv/bot/data\n</cwd>';
  assert.equal(stripCwd(prompt), 'You are a bot.\n\n<mcp_servers>\n- docs: search\n</mcp_servers>');
  assert.equal(stripCwd('You are a bot.'), 'You are a bot.');
});

test('tells the guard which tool is called', () => {
  const { onToolCall } = guard((name) => name === 'websearch');
  assert.equal(onToolCall('websearch'), undefined);
  assert.deepEqual(onToolCall('mcp__home__intent__HassTurnOn'), blocked('mcp__home__intent__HassTurnOn'));
});

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
  const added: ImageContent[] = [];
  const fetched: unknown[] = [];
  const store: ImageStore = {
    add: (image) => `image-${added.push(image)}.png`,
    addFetched: (toolCallId, index, mimeType) => `fetched-${fetched.push({ toolCallId, index, mimeType })}`,
    async get(refs) {
      return refs.map((ref) => {
        if (!stored[ref]) throw new Error(`no ${ref}`);
        return stored[ref];
      });
    },
  };
  let tool!: ToolDefinition;
  let onToolResult: ((event: object) => unknown) | undefined;
  const pi = {
    registerTool: (t: ToolDefinition) => (tool = t),
    on: (event: string, handler: (event: object) => unknown) => {
      if (event === 'tool_result') onToolResult = handler;
    },
  };
  imageGeneration(models, model, store)(pi as unknown as ExtensionAPI);
  const run = (params: { prompt: string; images?: string[] }) => tool.execute('t1', params, undefined, undefined, {} as never);
  return { calls, added, fetched, tool, run, onToolResult };
}

const PNG = { type: 'image' as const, data: 'cG5n', mimeType: 'image/png' };
const WEBP = { type: 'image' as const, data: 'd2VicA==', mimeType: 'image/webp' };

test('generate_image hands each image to the store and the agent', async () => {
  const { calls, added, run } = imageTool({ output: [{ type: 'text', text: 'Here is a fox.' }, PNG, WEBP] });
  const result = await run({ prompt: 'a red fox in the snow' });
  assert.deepEqual(calls, [{ model: PAINTER, context: { input: [{ type: 'text', text: 'a red fox in the snow' }] } }]);
  assert.deepEqual(added, [PNG, WEBP]);
  // Copies, which pi's re-encoding of the result doesn't reach.
  assert.notEqual(added[0], PNG);
  assert.deepEqual(result.content, [
    { type: 'text', text: 'Generated image-1.png, image-2.png, attached to your reply.\ngoogle/gemini-2.5-flash-image said: Here is a fox.' },
    PNG,
    WEBP,
  ]);
});

test("generate_image fails when the image model does, or doesn't return an image", async () => {
  await assert.rejects(imageTool({ stopReason: 'error', errorMessage: 'No credits' }).run({ prompt: 'a fox' }), /No credits/);
  const refused = imageTool({ output: [{ type: 'text', text: 'I cannot draw that.' }] });
  await assert.rejects(refused.run({ prompt: 'a fox' }), /returned no image: I cannot draw that\./);
  assert.deepEqual(refused.added, []);
});

test('generate_image takes images to change only when its model takes images', async () => {
  const painter = imageTool({ output: [PNG] });
  assert.equal((painter.tool.parameters as { properties: Record<string, unknown> }).properties.images, undefined);
  // Sent anyway, they're left out.
  await painter.run({ prompt: 'darker', images: ['f1'] });
  assert.deepEqual(painter.calls, [{ model: PAINTER, context: { input: [{ type: 'text', text: 'darker' }] } }]);

  const editor = imageTool({ output: [PNG] }, EDITOR, { f1: WEBP, 'image-1.png': PNG });
  assert.ok((editor.tool.parameters as { properties: Record<string, unknown> }).properties.images);
  await editor.run({ prompt: 'put the fox in the garage', images: ['image-1.png', 'f1'] });
  assert.deepEqual(editor.calls, [{ model: EDITOR, context: { input: [{ type: 'text', text: 'put the fox in the garage' }, PNG, WEBP] } }]);

  assert.deepEqual(editor.tool.prepareArguments!({ prompt: 'darker', images: 'f1' }), { prompt: 'darker', images: ['f1'] });

  const missing = imageTool({ output: [PNG] }, EDITOR);
  await assert.rejects(missing.run({ prompt: 'darker', images: ['f9'] }), /no f9/);
  assert.deepEqual(missing.calls, []);
});

test("other tools' images are named in their results, when the image model takes images", () => {
  const { fetched, onToolResult } = imageTool({}, EDITOR);
  const result = { toolName: 'webfetch', toolCallId: 'c1', content: [{ type: 'text', text: 'URL: x' }, PNG, WEBP], details: { url: 'x' }, structuredContent: { a: 1 }, usage: { input: 1 }, isError: false };
  assert.deepEqual(onToolResult!(result), {
    content: [...result.content, { type: 'text', text: 'Saved as fetched-1, fetched-2, which you can pass to generate_image.' }],
    details: { url: 'x' },
    structuredContent: { a: 1 },
    usage: { input: 1 },
  });
  assert.deepEqual(fetched, [
    { toolCallId: 'c1', index: 0, mimeType: 'image/png' },
    { toolCallId: 'c1', index: 1, mimeType: 'image/webp' },
  ]);

  // Not generate_image's own, a nested call's, nor a result without images.
  assert.equal(onToolResult!({ ...result, toolName: 'generate_image' }), undefined);
  assert.equal(onToolResult!({ ...result, toolCallId: 'c2/1', parentToolCallId: 'c2' }), undefined);
  assert.equal(onToolResult!({ ...result, content: [{ type: 'text', text: 'hi' }] }), undefined);
  assert.equal(fetched.length, 2);

  assert.equal(imageTool({}).onToolResult, undefined);
});
