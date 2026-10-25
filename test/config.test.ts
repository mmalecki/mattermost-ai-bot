import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';

const base = { MATTERMOST_URL: 'http://mm.local/', MATTERMOST_TOKEN: 'mm' };

test("defaults to Anthropic's endpoint with ANTHROPIC_API_KEY, ignoring OPENAI_API_KEY", () => {
  const { llm, mattermost } = loadConfig({ ...base, ANTHROPIC_API_KEY: 'ant', OPENAI_API_KEY: 'oai' });
  assert.equal(llm.baseUrl, 'https://api.anthropic.com/v1');
  assert.equal(llm.apiKey, 'ant');
  assert.equal(llm.model, 'claude-haiku-5-5');
  assert.equal(mattermost.url, 'http://mm.local');
});

test('OPENAI_BASE_URL takes OPENAI_API_KEY', () => {
  const { llm } = loadConfig({ ...base, OPENAI_BASE_URL: 'http://127.0.0.1:8080/v1/', OPENAI_API_KEY: 'none', OPENAI_MODEL: 'qwen' });
  assert.deepEqual([llm.baseUrl, llm.apiKey, llm.model], ['http://127.0.0.1:8080/v1', 'none', 'qwen']);
  assert.throws(() => loadConfig({ ...base, OPENAI_BASE_URL: 'http://127.0.0.1:8080/v1', ANTHROPIC_API_KEY: 'ant' }), /OPENAI_API_KEY is not set/);
});

test('Home Assistant needs HASS_SERVER and HASS_TOKEN; the allowlist tolerates @ and spaces', () => {
  assert.equal(loadConfig({ ...base, ANTHROPIC_API_KEY: 'ant', HASS_SERVER: 'http://ha' }).homeAssistant, undefined);
  const { homeAssistant } = loadConfig({ ...base, ANTHROPIC_API_KEY: 'ant', HASS_SERVER: 'http://ha/', HASS_TOKEN: 't', HASS_ALLOWED_USERS: '@a, b,' });
  assert.equal(homeAssistant?.url, 'http://ha');
  assert.deepEqual([...homeAssistant!.allowedUsers], ['a', 'b']);
});
