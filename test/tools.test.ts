import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssistantImages, ImageApi, ImageContent, ImageModel } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { type ImageStore, imageGeneration, mcpServers, stripCwd, toolGuard } from '../src/tools.ts';

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
  const store: ImageStore = {
    add: (image) => `image-${added.push(image)}.png`,
    async get(refs) {
      return refs.map((ref) => {
        if (!stored[ref]) throw new Error(`no ${ref}`);
        return stored[ref];
      });
    },
  };
  let tool!: ToolDefinition;
  const pi = { registerTool: (t: ToolDefinition) => (tool = t) };
  imageGeneration(models, model, store)(pi as unknown as ExtensionAPI);
  const run = (params: { prompt: string; images?: string[] }) => tool.execute('t1', params, undefined, undefined, {} as never);
  return { calls, added, tool, run };
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

  const missing = imageTool({ output: [PNG] }, EDITOR);
  await assert.rejects(missing.run({ prompt: 'darker', images: ['f9'] }), /no f9/);
  assert.deepEqual(missing.calls, []);
});
