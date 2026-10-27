import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { mcpServers, stripCwd, toolGuard } from '../src/tools.ts';

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
