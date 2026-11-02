import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssistantImages, ImageApi, ImageModel } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { type GeneratedImage, imageGeneration, mcpServers, stripCwd, toolGuard } from '../src/tools.ts';

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

const PAINTER = { provider: 'openrouter', id: 'google/gemini-2.5-flash-image' } as ImageModel<ImageApi>;

/** generate_image, with an image model that answers with `output`, or as `result` says. */
function imageTool(result: Partial<AssistantImages>) {
  const calls: unknown[] = [];
  const models = {
    async generateImages(model: unknown, context: unknown) {
      calls.push({ model, context });
      return { stopReason: 'stop', output: [], ...result } as AssistantImages;
    },
  };
  const generated: GeneratedImage[] = [];
  let tool!: ToolDefinition;
  const pi = { registerTool: (t: ToolDefinition) => (tool = t) };
  imageGeneration(models, PAINTER, (image) => generated.push(image))(pi as unknown as ExtensionAPI);
  const run = (prompt: string) => tool.execute('t1', { prompt }, undefined, undefined, {} as never);
  return { calls, generated, run };
}

test('generate_image hands each image to the bot and the agent, numbered across the session', async () => {
  const png = { type: 'image' as const, data: 'cG5n', mimeType: 'image/png' };
  const webp = { type: 'image' as const, data: 'd2VicA==', mimeType: 'image/webp' };
  const { calls, generated, run } = imageTool({ output: [{ type: 'text', text: 'Here is a fox.' }, png, webp] });

  const result = await run('a red fox in the snow');
  assert.deepEqual(calls, [{ model: PAINTER, context: { input: [{ type: 'text', text: 'a red fox in the snow' }] } }]);
  assert.deepEqual(generated, [
    { name: 'image-1.png', mimeType: 'image/png', data: 'cG5n' },
    { name: 'image-2.webp', mimeType: 'image/webp', data: 'd2VicA==' },
  ]);
  assert.deepEqual(result.content, [
    { type: 'text', text: 'Generated image-1.png, image-2.webp, attached to your reply.\ngoogle/gemini-2.5-flash-image said: Here is a fox.' },
    png,
    webp,
  ]);

  await run('another');
  assert.deepEqual(generated.slice(2).map((i) => i.name), ['image-3.png', 'image-4.webp']);
});

test("generate_image fails when the image model does, or doesn't return an image", async () => {
  await assert.rejects(imageTool({ stopReason: 'error', errorMessage: 'No credits' }).run('a fox'), /No credits/);
  const refused = imageTool({ output: [{ type: 'text', text: 'I cannot draw that.' }] });
  await assert.rejects(refused.run('a fox'), /returned no image: I cannot draw that\./);
  assert.deepEqual(refused.generated, []);
});
