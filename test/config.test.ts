import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadTools, parseModel } from '../src/config.ts';

const base = { MATTERMOST_URL: 'http://mm.local/', MATTERMOST_TOKEN: 'mm', MODEL: 'mistral/mistral-small-2603' };

test('MODEL picks a pi provider and model; models.json sits next to the MCP config', () => {
  const { llm, mattermost } = loadConfig(base);
  assert.deepEqual(llm, {
    provider: 'mistral',
    model: 'mistral-small-2603',
    thinkingLevel: 'off',
    maxTokens: 8192,
    modelsPath: join(process.cwd(), 'models.json'),
  });
  assert.equal(mattermost.url, 'http://mm.local');
  assert.throws(() => loadConfig({ ...base, MODEL: undefined }), /MODEL is not set/);
});

test('parses provider/model[:thinking] as pi does', () => {
  assert.deepEqual(parseModel('anthropic/claude-haiku-5-5:low'), { provider: 'anthropic', model: 'claude-haiku-5-5', thinkingLevel: 'low' });
  // OpenRouter's models contain a slash, and a quantization tag looks like a suffix but isn't a level.
  assert.deepEqual(parseModel('openrouter/mistralai/mistral-small-2603'), { provider: 'openrouter', model: 'mistralai/mistral-small-2603', thinkingLevel: 'off' });
  assert.deepEqual(parseModel('local/bartowski/gemma-GGUF:Q4_K_M'), { provider: 'local', model: 'bartowski/gemma-GGUF:Q4_K_M', thinkingLevel: 'off' });
  for (const bad of ['mistral-small-2603', '/model', 'mistral/']) assert.throws(() => parseModel(bad), /MODEL must be provider\/model/);
});

test('APPEND_SYSTEM.md sits next to the MCP config', () => {
  const env = base;
  assert.equal(loadConfig(env).appendSystemPromptPath, join(process.cwd(), 'APPEND_SYSTEM.md'));
  const path = write({ mcpServers: {} });
  assert.equal(loadConfig({ ...env, MCP_CONFIG: path }).appendSystemPromptPath, join(path, '..', 'APPEND_SYSTEM.md'));
});

test('SCHEDULER is off unless set to true or 1', () => {
  const env = base;
  assert.equal(loadConfig(env).scheduler, false);
  assert.equal(loadConfig({ ...env, SCHEDULER: 'true' }).scheduler, true);
  assert.equal(loadConfig({ ...env, SCHEDULER: '1' }).scheduler, true);
  assert.equal(loadConfig({ ...env, SCHEDULER: '0' }).scheduler, false);
  assert.throws(() => loadConfig({ ...env, SCHEDULER: 'yes' }), /SCHEDULER must be true or false/);
});

test('MCP_CONFIG must exist when set; the default mcp.json may be missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mattermost-ai-bot-'));
  const env = { ...base, MCP_CONFIG: join(dir, 'missing.json') };
  assert.throws(() => loadConfig(env), /does not exist/);
  assert.deepEqual(loadTools(join(dir, 'mcp.json'), false), { allowedUsers: undefined, mcpServers: {} });
});

test("reads pi's mcp.json format with an allowedUsers list", () => {
  const path = write({ allowedUsers: ['@a', ' b', ''], mcpServers: { home: { url: 'http://ha/api/mcp', exposure: 'direct' } } });
  const tools = loadTools(path, true);
  assert.deepEqual([...tools.allowedUsers!], ['a', 'b']);
  assert.deepEqual(tools.mcpServers, { home: { url: 'http://ha/api/mcp', exposure: 'direct' } });
  assert.equal(loadTools(write({ mcpServers: {} }), true).allowedUsers, undefined);
});

test('rejects malformed tool configs', () => {
  assert.throws(() => loadTools(write([]), true), /expected an object with an "mcpServers" object/);
  assert.throws(() => loadTools(write({ mcpServers: [] }), true), /expected an object/);
  assert.throws(() => loadTools(write({ allowedUsers: 'a' }), true), /"allowedUsers" must be a list/);
});

function write(content: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'mattermost-ai-bot-')), 'mcp.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
}

test('caps output at 8192 tokens by default', () => {
  assert.equal(loadConfig(base).llm.maxTokens, 8192);
  assert.equal(loadConfig({ ...base, MAX_OUTPUT_TOKENS: '2048' }).llm.maxTokens, 2048);
});
