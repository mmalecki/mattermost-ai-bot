import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { buildSystemPrompt, createAgent, directServers, permalink } from '../src/agent.ts';
import { loadConfig } from '../src/config.ts';

test("lists what directly exposed servers offer, in the format of pi's mcp_servers section", () => {
  assert.deepEqual(
    directServers({
      'home-assistant': { url: 'http://ha/api/mcp', exposure: 'direct', description: 'The home\nMore detail' },
      docs: { url: 'http://docs/mcp', description: 'Product docs' },
      off: { url: 'http://off/mcp', exposure: 'direct', enabled: false, description: 'Disabled' },
      bare: { url: 'http://bare/mcp', exposure: 'direct' },
    }),
    ['\nYour tools come from these MCP servers:', '- mcp__home_assistant (direct): The home'],
  );
  assert.deepEqual(directServers({}), []);
});

const promptOptions = { botUsername: 'sailor', servers: {}, scheduler: false, images: false, imageGeneration: false, serverUrl: 'https://chat.example', rootId: 'r1' };

test('links posts without their team, and gives the model the thread\'s link', () => {
  assert.equal(permalink('https://chat.example', 'p1'), 'https://chat.example/_redirect/pl/p1');
  assert.match(buildSystemPrompt(promptOptions), /This thread's link is https:\/\/chat\.example\/_redirect\/pl\/r1, and a post's is https:\/\/chat\.example\/_redirect\/pl\/<id>/);
});

test('tells the model how images come only when it takes them', () => {
  assert.match(buildSystemPrompt({ ...promptOptions, images: true }), /\[image <n>: name\]/);
  assert.doesNotMatch(buildSystemPrompt(promptOptions), /\[image/);
});

test("tells the model how text files' contents come", () => {
  assert.match(buildSystemPrompt(promptOptions), /between "\[file: name \(type\)\]" and "\[end of file: name\]"/);
});

test('tells the model its generated images are attached only when it can generate them', () => {
  assert.match(buildSystemPrompt({ ...promptOptions, imageGeneration: true }), /generate_image is attached to your reply/);
  assert.doesNotMatch(buildSystemPrompt(promptOptions), /generate_image/);
});

/** An agent on `local/small`, from a models.json that also has `local/large`, which takes images. */
async function localAgent() {
  const dir = mkdtempSync(join(tmpdir(), 'mattermost-ai-bot-'));
  const models = [
    { id: 'small', contextWindow: 8192, reasoning: true },
    { id: 'large', contextWindow: 8192, reasoning: true, input: ['text', 'image'] },
  ];
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { local: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'none', models } } }));
  writeFileSync(join(dir, 'mcp.json'), '{}');
  const env = { MATTERMOST_URL: 'http://mm.local', MATTERMOST_TOKEN: 'mm', MODEL: 'local/small', MCP_CONFIG: join(dir, 'mcp.json'), DATA_DIR: dir };
  return createAgent(loadConfig(env), 'sailor');
}

test('picks models pi knows, and only names providers it knows as models', async () => {
  const agent = await localAgent();
  assert.deepEqual(agent.pickModel('local/large:high'), { provider: 'local', model: 'large', thinkingLevel: 'high' });
  assert.equal(agent.pickModel('etc/hosts'), undefined);
  assert.equal(agent.pickModel('/local/large'), undefined);
  assert.throws(() => agent.pickModel('local/huge'), /^Error: there is no model local\/huge$/);
});

test('a session runs on the model it was created with, MODEL by default', async () => {
  const agent = await localAgent();
  const options = { allowTools: () => false };
  let session = await agent.openSession('r1', { ...options, model: { provider: 'local', model: 'large', thinkingLevel: 'high' } });
  assert.equal(session.model?.id, 'large');
  // pi writes the session file once it has an answer.
  session.sessionManager.appendMessage({ role: 'user', content: 'hi', timestamp: Date.now() });
  session.sessionManager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'hello' }],
    api: 'openai-completions',
    provider: 'local',
    model: 'large',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  } satisfies AssistantMessage);
  await agent.closeSession(session);

  session = await agent.openSession('r1', options);
  assert.deepEqual([session.model?.id, session.thinkingLevel, session.model?.input], ['large', 'high', ['text', 'image']]);
  await agent.closeSession(session);

  session = await agent.openSession('r2', options);
  assert.deepEqual([session.model?.id, session.thinkingLevel], ['small', 'off']);
  await agent.closeSession(session);
});
