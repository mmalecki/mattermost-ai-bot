import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { type Agent, createAgent } from '../src/agent.ts';
import { loadConfig } from '../src/config.ts';

/** Opens the thread's session, with every tool allowed and no scheduled jobs unless `options` say otherwise. */
function open(agent: Agent, rootId: string, options: Partial<Parameters<Agent['openSession']>[1]> = {}) {
  return agent.openSession(rootId, { allowTools: () => true, onScheduled: () => {}, ...options });
}

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/**
 * An OpenAI-compatible endpoint that answers every request with "hello", streamed as pi asks for it.
 * `models` are the models asked for, in order, `tools` the names of the tools each request declared, and
 * `prompts` each request's first message, the system prompt.
 */
async function fakeLlm() {
  const models: string[] = [];
  const tools: string[][] = [];
  const prompts: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const request = JSON.parse(body) as { model: string; tools?: { function: { name: string } }[]; messages: { content: unknown }[] };
      models.push(request.model);
      tools.push((request.tools ?? []).map((t) => t.function.name));
      prompts.push(JSON.stringify(request.messages[0]!.content));
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`${chunk({ role: 'assistant', content: 'hello' }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, models, tools, prompts, close: () => server.close() };
}

/**
 * An agent in `dir` on `local/small`, from a models.json that also has `local/large`, which takes images,
 * with `env` added to its environment.
 */
async function localAgent({ baseUrl = 'http://127.0.0.1:1/v1', dir = mkdtempSync(join(tmpdir(), 'mattermost-ai-bot-')), env: extraEnv = {} }: { baseUrl?: string; dir?: string; env?: Record<string, string> } = {}) {
  dirs.push(dir);
  const models = [
    { id: 'small', contextWindow: 8192, reasoning: true },
    { id: 'large', contextWindow: 8192, reasoning: true, input: ['text', 'image'] },
  ];
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { local: { baseUrl, api: 'openai-completions', apiKey: 'none', models } } }));
  writeFileSync(join(dir, 'mcp.json'), '{}');
  const env = { MATTERMOST_URL: 'http://mm.local', MATTERMOST_TOKEN: 'mm', MODEL: 'local/small', MCP_CONFIG: join(dir, 'mcp.json'), DATA_DIR: dir, ...extraEnv };
  return { agent: await createAgent(loadConfig(env), 'sailor'), dir };
}

test('picks models pi knows, and only names providers it knows as models', async () => {
  const { agent } = await localAgent();
  assert.deepEqual(agent.pickModel('local/large:high'), { provider: 'local', model: 'large', thinkingLevel: 'high' });
  assert.equal(agent.pickModel('etc/hosts'), undefined);
  assert.equal(agent.pickModel('/local/large'), undefined);
  assert.throws(() => agent.pickModel('local/huge'), /^Error: there is no model local\/huge$/);
});

test('a session runs on the model it was created with, MODEL by default', async (t) => {
  const llm = await fakeLlm();
  t.after(llm.close);
  const { agent, dir } = await localAgent({ baseUrl: llm.url });
  const options = { allowTools: () => false };
  const large = { provider: 'local', model: 'large', thinkingLevel: 'high' } as const;

  let session = await open(agent, 'r1', { ...options, model: large });
  assert.deepEqual([session.model, session.takesImages], [large, true]);
  // A thread has a session once it has been prompted, as pi writes its file then.
  assert.equal(agent.hasSession('r1'), false);
  await session.prompt('hi');
  assert.equal(agent.hasSession('r1'), true);
  // In the thread's own directory.
  assert.ok(existsSync(join(dir, 'sessions', 'r1', 'session.jsonl')));
  const answer = session.messages.at(-1) as AssistantMessage;
  assert.deepEqual([answer.role, answer.content], ['assistant', [{ type: 'text', text: 'hello' }]]);
  await session.close();

  session = await open(agent, 'r1', options);
  assert.deepEqual([session.model, session.takesImages], [large, true]);
  await session.close();

  session = await open(agent, 'r2', options);
  assert.deepEqual([session.model, session.takesImages], [{ provider: 'local', model: 'small', thinkingLevel: 'off' }, false]);
  await session.close();
  assert.deepEqual(llm.models, ['large']);

  // A restarted bot finds the threads that have sessions on disk.
  const { agent: restarted } = await localAgent({ baseUrl: llm.url, dir });
  assert.deepEqual([restarted.hasSession('r1'), restarted.hasSession('r2')], [true, false]);
});

test('the model is declared only the tools the thread may use, which stay away until the session is reopened', async (t) => {
  const llm = await fakeLlm();
  t.after(llm.close);
  const { agent } = await localAgent({ baseUrl: llm.url });
  let allowed = (_name: string) => true;
  const session = await open(agent, 'r1', { allowTools: (name) => allowed(name) });
  await session.prompt('hi');
  assert.ok(llm.tools[0]!.includes('webfetch'));

  allowed = (name) => name !== 'webfetch';
  await session.prompt('fetch this');
  assert.deepEqual(llm.tools[1], llm.tools[0]!.filter((name) => name !== 'webfetch'));

  allowed = () => true;
  await session.prompt('and again');
  assert.deepEqual(llm.tools[2], llm.tools[1]);
  await session.close();

  // A reopened session declares its tools afresh, and they are taken away again as needed.
  const reopened = await open(agent, 'r1', { allowTools: (name) => allowed(name) });
  await reopened.prompt('now?');
  assert.deepEqual(llm.tools[3], llm.tools[0]);
  allowed = (name) => name !== 'webfetch';
  await reopened.prompt('and now?');
  assert.deepEqual(llm.tools[4], llm.tools[1]);
  await reopened.close();
});

test('SCHEDULER gives sessions the schedule tool, and tells the model how due jobs reach it', async (t) => {
  const llm = await fakeLlm();
  t.after(llm.close);
  const { agent } = await localAgent({ baseUrl: llm.url, env: { SCHEDULER: 'true' } });
  const session = await open(agent, 'r1');
  await session.prompt('hi');
  assert.ok(llm.tools[0]!.includes('schedule'));
  assert.match(llm.prompts[0]!, /Scheduled job <id> is due/);
  await session.close();
});

test("the system prompt tells the model only about the tools the thread may use, and not pi's cwd", async (t) => {
  const llm = await fakeLlm();
  t.after(llm.close);
  const { agent } = await localAgent({ baseUrl: llm.url });
  let allowed = (_name: string) => true;
  const session = await open(agent, 'r1', { model: { provider: 'local', model: 'large', thinkingLevel: 'off' }, allowTools: (name) => allowed(name) });
  await session.prompt('hi');
  assert.ok(llm.tools[0]!.includes('crop_image'));
  assert.match(llm.prompts[0]!, /You are @sailor/);
  assert.match(llm.prompts[0]!, /cut it out with crop_image/);
  assert.doesNotMatch(llm.prompts[0]!, /<cwd>/);

  allowed = (name) => name !== 'crop_image';
  await session.prompt('crop this');
  assert.ok(!llm.tools[1]!.includes('crop_image'));
  assert.match(llm.prompts[1]!, /You are @sailor/);
  assert.doesNotMatch(llm.prompts[1]!, /crop_image|<cwd>/);
  await session.close();

  // A thread that never had the tool isn't told of it from its first request.
  const restricted = await open(agent, 'r2', { model: { provider: 'local', model: 'large', thinkingLevel: 'off' }, allowTools: (name) => name !== 'crop_image' });
  await restricted.prompt('hi');
  assert.ok(!llm.tools[2]!.includes('crop_image'));
  assert.match(llm.prompts[2]!, /You are @sailor/);
  assert.doesNotMatch(llm.prompts[2]!, /crop_image/);
  await restricted.close();
});

test('VISION_MODEL gives sessions the vision tools, and must take images', async (t) => {
  await assert.rejects(localAgent({ env: { VISION_MODEL: 'local/small' } }), /VISION_MODEL local\/small doesn't take images/);
  await assert.rejects(localAgent({ env: { VISION_MODEL: 'local/huge' } }), /VISION_MODEL local\/huge is neither in pi's catalog/);

  const llm = await fakeLlm();
  t.after(llm.close);
  const { agent } = await localAgent({ baseUrl: llm.url, env: { VISION_MODEL: 'local/large:low' } });
  const session = await open(agent, 'r1');
  // The model doesn't see images, but the vision tools take them.
  assert.equal(session.keepsImages, true);
  await session.prompt('hi');
  for (const tool of ['look_at_image', 'locate', 'crop_image']) assert.ok(llm.tools[0]!.includes(tool), tool);
  await session.close();

  // A model that sees images looks at them itself.
  const seeing = await open(agent, 'r2', { model: { provider: 'local', model: 'large', thinkingLevel: 'off' } });
  await seeing.prompt('hi');
  assert.deepEqual(['look_at_image', 'locate', 'crop_image'].map((tool) => llm.tools[1]!.includes(tool)), [false, true, true]);
  await seeing.close();

  const plain = await open((await localAgent()).agent, 'r1');
  assert.equal(plain.keepsImages, false);
  await plain.close();
});

test('a model that sees images can crop them without VISION_MODEL', async (t) => {
  const llm = await fakeLlm();
  t.after(llm.close);
  const { agent } = await localAgent({ baseUrl: llm.url });
  for (const model of ['large', 'small']) {
    const session = await open(agent, model, { model: { provider: 'local', model, thinkingLevel: 'off' } });
    await session.prompt('hi');
    await session.close();
  }
  assert.deepEqual(llm.tools.map((tools) => ['look_at_image', 'locate', 'crop_image'].filter((tool) => tools.includes(tool))), [['crop_image'], []]);
});
