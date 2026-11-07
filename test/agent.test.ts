import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
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

const promptOptions = { botUsername: 'sailor', servers: {}, scheduler: false, images: false, imageGeneration: false, imageEdits: false, serverUrl: 'https://chat.example', rootId: 'r1' };

test('links posts without their team, and gives the model the thread\'s link', () => {
  assert.equal(permalink('https://chat.example', 'p1'), 'https://chat.example/_redirect/pl/p1');
  assert.match(buildSystemPrompt(promptOptions), /This thread's link is https:\/\/chat\.example\/_redirect\/pl\/r1, and a post's is https:\/\/chat\.example\/_redirect\/pl\/<id>/);
});

test('tells the model how images come only when it takes them', () => {
  assert.match(buildSystemPrompt({ ...promptOptions, images: true }), /\[image <n>: name\]/);
  assert.doesNotMatch(buildSystemPrompt(promptOptions), /\[image/);
});

test('tells the model its generated images are attached only when it can generate them', () => {
  assert.match(buildSystemPrompt({ ...promptOptions, imageGeneration: true }), /generate_image is attached to your reply/);
  assert.doesNotMatch(buildSystemPrompt(promptOptions), /generate_image/);
});

test('tells the model how to give generate_image images only when it takes them', () => {
  assert.match(buildSystemPrompt({ ...promptOptions, imageGeneration: true, imageEdits: true }), /pass it to generate_image in images/);
  assert.doesNotMatch(buildSystemPrompt({ ...promptOptions, imageGeneration: true }), /pass it to generate_image/);
});

/** An agent on `local/small`, from a models.json that also has `local/large`, which takes images. */
const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/**
 * An OpenAI-compatible endpoint that answers every request with "hello", streamed as pi asks for it.
 * `models` are the models asked for, in order, and `tools` the names of the tools each request declared.
 */
async function fakeLlm() {
  const models: string[] = [];
  const tools: string[][] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const request = JSON.parse(body) as { model: string; tools?: { function: { name: string } }[] };
      models.push(request.model);
      tools.push((request.tools ?? []).map((t) => t.function.name));
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`${chunk({ role: 'assistant', content: 'hello' }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, models, tools, close: () => server.close() };
}

/** An agent in `dir` on `local/small`, from a models.json that also has `local/large`, which takes images. */
async function localAgent(baseUrl = 'http://127.0.0.1:1/v1', dir = mkdtempSync(join(tmpdir(), 'mattermost-ai-bot-'))) {
  dirs.push(dir);
  const models = [
    { id: 'small', contextWindow: 8192, reasoning: true },
    { id: 'large', contextWindow: 8192, reasoning: true, input: ['text', 'image'] },
  ];
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { local: { baseUrl, api: 'openai-completions', apiKey: 'none', models } } }));
  writeFileSync(join(dir, 'mcp.json'), '{}');
  const env = { MATTERMOST_URL: 'http://mm.local', MATTERMOST_TOKEN: 'mm', MODEL: 'local/small', MCP_CONFIG: join(dir, 'mcp.json'), DATA_DIR: dir };
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
  const { agent, dir } = await localAgent(llm.url);
  const options = { allowTools: () => false };
  const large = { provider: 'local', model: 'large', thinkingLevel: 'high' } as const;

  let session = await agent.openSession('r1', { ...options, model: large });
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

  session = await agent.openSession('r1', options);
  assert.deepEqual([session.model, session.takesImages], [large, true]);
  await session.close();

  session = await agent.openSession('r2', options);
  assert.deepEqual([session.model, session.takesImages], [{ provider: 'local', model: 'small', thinkingLevel: 'off' }, false]);
  await session.close();
  assert.deepEqual(llm.models, ['large']);

  // A restarted bot finds the threads that have sessions on disk.
  const { agent: restarted } = await localAgent(llm.url, dir);
  assert.deepEqual([restarted.hasSession('r1'), restarted.hasSession('r2')], [true, false]);
});

test('the model is declared only the tools the thread may use, which stay away until the session is reopened', async (t) => {
  const llm = await fakeLlm();
  t.after(llm.close);
  const { agent } = await localAgent(llm.url);
  let allowed = (_name: string) => true;
  const session = await agent.openSession('r1', { allowTools: (name) => allowed(name) });
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
  const reopened = await agent.openSession('r1', { allowTools: (name) => allowed(name) });
  await reopened.prompt('now?');
  assert.deepEqual(llm.tools[3], llm.tools[0]);
  allowed = (name) => name !== 'webfetch';
  await reopened.prompt('and now?');
  assert.deepEqual(llm.tools[4], llm.tools[1]);
  await reopened.close();
});
