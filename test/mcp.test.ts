import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { mcpImages, mcpServers } from '../src/mcp.ts';
import { fakeStore, PNG } from './fakes.ts';

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
  // Image data, or a path, already given in an image argument stays as it is, as does a name of no image here.
  for (const path of ['data:image/png;base64,cG5n', '/srv/scans/garage.png', 'other.png']) {
    assert.deepEqual(await call('mcp__files__open', { path }), { path });
  }
  // In another argument, it stays a name, as do names the thread has no image under, and other servers' tools' arguments.
  assert.deepEqual(await call('mcp__bar_codes__decode', { path: 'garage.png' }), { path: 'garage.png' });
  assert.deepEqual(await call('mcp__bar_codes__decode', { base64: 'other.png' }), { base64: 'other.png' });
  assert.deepEqual(await call('mcp__home__look', { base64: 'garage.png' }), { base64: 'garage.png' });
  assert.deepEqual(await call('mcp__vision_extra__look', { url: 'garage.png' }), { url: 'garage.png' });
});
