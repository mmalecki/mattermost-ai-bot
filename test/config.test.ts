import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadConfig, loadSchedules, loadTools, parseAllowedUsers, parseImageModel, parseModel } from '../src/config.ts';

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
  assert.equal(mattermost.publicUrl, 'http://mm.local');
  assert.equal(loadConfig({ ...base, MATTERMOST_PUBLIC_URL: 'https://chat.example/' }).mattermost.publicUrl, 'https://chat.example');
  assert.throws(() => loadConfig({ ...base, MODEL: undefined }), /MODEL is not set/);
});

test('parses provider/model[:thinking] as pi does', () => {
  assert.deepEqual(parseModel('anthropic/claude-haiku-5-5:low'), { provider: 'anthropic', model: 'claude-haiku-5-5', thinkingLevel: 'low' });
  // OpenRouter's models contain a slash, and a quantization tag looks like a suffix but isn't a level.
  assert.deepEqual(parseModel('openrouter/mistralai/mistral-small-2603'), { provider: 'openrouter', model: 'mistralai/mistral-small-2603', thinkingLevel: 'off' });
  assert.deepEqual(parseModel('local/bartowski/gemma-GGUF:Q4_K_M'), { provider: 'local', model: 'bartowski/gemma-GGUF:Q4_K_M', thinkingLevel: 'off' });
  for (const bad of ['mistral-small-2603', '/model', 'mistral/']) assert.throws(() => parseModel(bad), /^Error: MODEL must be provider\/model\[:thinking\], such as mistral\/mistral-small-2603/);
});

test('IMAGE_MODEL is a provider/model without a thinking level, and unset by default', () => {
  assert.equal(loadConfig(base).imageModel, undefined);
  assert.equal(loadConfig({ ...base, IMAGE_MODEL: ' ' }).imageModel, undefined);
  assert.deepEqual(loadConfig({ ...base, IMAGE_MODEL: 'openrouter/google/gemini-2.5-flash-image' }).imageModel, {
    provider: 'openrouter',
    model: 'google/gemini-2.5-flash-image',
  });
  assert.throws(() => parseImageModel('flux'), /IMAGE_MODEL must be provider\/model, such as openrouter\/bytedance-seed\/seedream-5-0-pro, not "flux"/);
  assert.throws(() => parseImageModel('openrouter/google/gemini-2.5-flash-image:high'), /IMAGE_MODEL takes no thinking level/);
});

test('APPEND_SYSTEM.md sits next to the MCP config', () => {
  assert.equal(loadConfig(base).appendSystemPromptPath, join(process.cwd(), 'APPEND_SYSTEM.md'));
  const path = write({ mcpServers: {} });
  assert.equal(loadConfig({ ...base, MCP_CONFIG: path }).appendSystemPromptPath, join(path, '..', 'APPEND_SYSTEM.md'));
});

for (const [name, key] of [['SCHEDULER', 'scheduler'], ['CODEMODE', 'codemode'], ['ALLOW_PICKING_MODEL', 'pickModel']] as const) {
  test(`${name} is off unless set to true or 1`, () => {
    assert.equal(loadConfig(base)[key], false);
    assert.equal(loadConfig({ ...base, [name]: 'true' })[key], true);
    assert.equal(loadConfig({ ...base, [name]: '1' })[key], true);
    assert.equal(loadConfig({ ...base, [name]: '0' })[key], false);
    assert.throws(() => loadConfig({ ...base, [name]: 'yes' }), new RegExp(`${name} must be true or false`));
  });
}

test('VISION_MODEL is a provider/model[:thinking], and unset by default', () => {
  assert.equal(loadConfig(base).visionModel, undefined);
  assert.deepEqual(loadConfig({ ...base, VISION_MODEL: 'openrouter/google/gemini-3.7-flash:low' }).visionModel, {
    provider: 'openrouter',
    model: 'google/gemini-3.7-flash',
    thinkingLevel: 'low',
  });
  assert.throws(() => loadConfig({ ...base, VISION_MODEL: 'gemini' }), /VISION_MODEL must be provider\/model\[:thinking\], such as openrouter\/qwen\/qwen3-vl-235b-a22b-instruct, not "gemini"/);
});

test('MCP_CONFIG must exist when set; the default mcp.json may be missing', () => {
  const dir = tempDir();
  const env = { ...base, MCP_CONFIG: join(dir, 'missing.json') };
  assert.throws(() => loadConfig(env), /does not exist/);
  assert.deepEqual(loadTools(join(dir, 'mcp.json'), false), { allowedUsers: undefined, mcpServers: {}, serverImages: {} });
});

test("reads pi's mcp.json format with an allowedUsers list, who may use every tool", () => {
  const path = write({ allowedUsers: ['@a', ' b', ''], mcpServers: { home: { url: 'http://ha/api/mcp', exposure: 'direct' } } });
  const tools = loadTools(path, true);
  assert.deepEqual([...tools.allowedUsers!.keys()], ['a', 'b']);
  assert.ok(tools.allowedUsers!.get('a')!('mcp__home__HassTurnOn'));
  assert.deepEqual(tools.mcpServers, { home: { url: 'http://ha/api/mcp', exposure: 'direct' } });
  assert.equal(loadTools(write({ mcpServers: {} }), true).allowedUsers, undefined);
});

test('allowedUsers can give each user their tools, by name or glob', () => {
  const users = parseAllowedUsers({
    '@alice': '*',
    mail: ['mcp__parcels__add_*', 'websearch'],
    'mail ': 'web.fetch',
    home: 'mcp__home__{HassTurnOn,HassTurnOff}',
    guest: [],
    ' ': '*',
  });
  const TOOLS = ['websearch', 'webfetch', 'web.fetch', '.hidden', 'mcp__parcels__add_observations', 'mcp__parcels__read_graph', 'mcp__home__HassTurnOn', 'xwebsearch'];
  const may = (user: string) => TOOLS.filter((t) => users.get(user)!(t));
  assert.deepEqual([...users.keys()], ['alice', 'mail', 'home', 'guest']);
  assert.deepEqual(may('alice'), TOOLS);
  // `.` is no wildcard, and a username given twice gets both entries' tools.
  assert.deepEqual(may('mail'), ['websearch', 'web.fetch', 'mcp__parcels__add_observations']);
  assert.deepEqual(may('home'), ['mcp__home__HassTurnOn']);
  assert.deepEqual(may('guest'), []);
});

test('a negated pattern in allowedUsers only takes tools away', () => {
  const users = parseAllowedUsers({
    bob: ['mcp__home__*', '!mcp__home__HassLockUnlock', ' !mcp__home__HassTurn* '],
    carol: ['*', '!schedule'],
    dave: '!schedule',
    erin: ['!schedule', 'websearch', 'schedule'],
    // Not negated: an extglob, for every name but these.
    frank: '!(schedule|codemode)',
  });
  const TOOLS = ['websearch', 'codemode', 'schedule', 'mcp__home__GetLiveContext', 'mcp__home__HassLockUnlock', 'mcp__home__HassTurnOn'];
  const may = (user: string) => TOOLS.filter((t) => users.get(user)!(t));
  assert.deepEqual(may('bob'), ['mcp__home__GetLiveContext']);
  assert.deepEqual(may('carol'), TOOLS.filter((t) => t !== 'schedule'));
  // Nothing to take away from, rather than every other tool.
  assert.deepEqual(may('dave'), []);
  // Wherever it is in the list.
  assert.deepEqual(may('erin'), ['websearch']);
  assert.deepEqual(may('frank'), TOOLS.filter((t) => t !== 'schedule' && t !== 'codemode'));
});

test('reads how enabled servers take images', () => {
  const servers = {
    barcodes: { command: 'barcoding-mcp', images: { base64: 'base64' } },
    vision: { url: 'http://vision/mcp', images: { file: 'path', url: 'dataUrl' } },
    off: { url: 'http://off/mcp', images: { url: 'dataUrl' }, enabled: false },
    home: { url: 'http://ha/api/mcp' },
  };
  assert.deepEqual(loadTools(write({ mcpServers: servers }), true).serverImages, { barcodes: { base64: 'base64' }, vision: { file: 'path', url: 'dataUrl' } });
  for (const images of ['base64', {}, { image: 'url' }]) {
    assert.throws(() => loadTools(write({ mcpServers: { x: { command: 'x', images } } }), true), /server "x": "images" must map the arguments that take images to one of base64, dataUrl, path/);
  }
});

test('rejects malformed tool configs', () => {
  assert.throws(() => loadTools(write([]), true), /expected an object with an "mcpServers" object/);
  assert.throws(() => loadTools(write({ mcpServers: [] }), true), /expected an object/);
  assert.throws(() => loadTools(write({ allowedUsers: 'a' }), true), /"allowedUsers" must be a list of usernames, or an object/);
  assert.throws(() => loadTools(write({ allowedUsers: { a: 1 } }), true), /the tools of "a" must be a name or pattern/);
});

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mattermost-ai-bot-'));
  dirs.push(dir);
  return dir;
}

function write(content: unknown): string {
  const path = join(tempDir(), 'mcp.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
}

test('caps output at 8192 tokens by default', () => {
  assert.equal(loadConfig(base).llm.maxTokens, 8192);
  assert.equal(loadConfig({ ...base, MAX_OUTPUT_TOKENS: '2048' }).llm.maxTokens, 2048);
});

/** schedules.json, holding `jobs`, next to an mcp.json, with the files in `files`. */
function writeSchedules(jobs: unknown, files: Record<string, string> = {}): { dir: string; path: string } {
  const dir = tempDir();
  writeFileSync(join(dir, 'mcp.json'), '{}');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  const path = join(dir, 'schedules.json');
  writeFileSync(path, JSON.stringify(jobs));
  return { dir, path };
}

test('reads the jobs in schedules.json, next to the MCP config, if there is one', () => {
  const { dir } = writeSchedules(
    {
      'morning-brief': { cron: '0 7 * * 1-5', timezone: 'Europe/Warsaw', to: '@alice', title: 'Morning brief', promptFile: 'brief.md', catchUp: '30m' },
      digest: { cron: '@daily', to: 'home/town-square', owner: '@bob', prompt: ' Sum up the day. ', model: 'anthropic/claude-haiku-5-5:low' },
      follow_up: { cron: '*/15 * * * *', thread: 'p1', owner: 'carol', prompt: 'Anything new?', catchUp: '2h' },
      off: { cron: '0 7 * * *', to: '@alice', prompt: 'Not now', enabled: false },
    },
    { 'brief.md': 'What is on today?' },
  );
  assert.deepEqual(loadConfig({ ...base, MCP_CONFIG: join(dir, 'mcp.json') }).schedules, [
    {
      name: 'morning-brief',
      cron: '0 7 * * 1-5',
      timezone: 'Europe/Warsaw',
      target: { user: 'alice' },
      owner: 'alice',
      title: 'Morning brief',
      prompt: { file: join(dir, 'brief.md') },
      model: undefined,
      catchUpMs: 30 * 60_000,
    },
    {
      name: 'digest',
      cron: '@daily',
      timezone: undefined,
      target: { team: 'home', channel: 'town-square' },
      owner: 'bob',
      title: 'digest',
      prompt: { text: 'Sum up the day.' },
      model: 'anthropic/claude-haiku-5-5:low',
      catchUpMs: 0,
    },
    {
      name: 'follow_up',
      cron: '*/15 * * * *',
      timezone: undefined,
      target: { thread: 'p1' },
      owner: 'carol',
      title: 'follow_up',
      prompt: { text: 'Anything new?' },
      model: undefined,
      catchUpMs: 2 * 3_600_000,
    },
  ]);
  assert.deepEqual(loadConfig(base).schedules, []);
});

test('rejects malformed jobs in schedules.json, naming them', () => {
  const job = { cron: '0 7 * * *', to: '@alice', prompt: 'Brief me' };
  const rejects = (jobs: unknown, message: RegExp) => assert.throws(() => loadSchedules(writeSchedules(jobs).path), message);
  rejects([], /expected an object with a job under each name/);
  rejects({ 'morning brief': job }, /"morning brief": a name is letters, digits/);
  rejects({ brief: 'daily' }, /"brief": expected an object/);
  rejects({ brief: { ...job, promt: 'x' } }, /"brief": unknown "promt"; a job takes cron, timezone, to/);
  rejects({ brief: { ...job, cron: undefined } }, /"cron" must give its times/);
  rejects({ brief: { ...job, cron: '0 0 7 * * *' } }, /"cron" must be five fields, or a nickname/);
  rejects({ brief: { ...job, cron: '61 7 * * *' } }, /"cron" must be five fields/);
  rejects({ brief: { ...job, cron: '0 7 30 2 *' } }, /"cron" "0 7 30 2 \*" never comes due/);
  rejects({ brief: { ...job, timezone: 'Mars/Olympus' } }, /"timezone" must be an IANA time zone, such as "Europe\/Warsaw", not "Mars\/Olympus"/);
  rejects({ brief: { ...job, to: undefined } }, /give either "to", a "@user" or a "team\/channel"/);
  rejects({ brief: { ...job, thread: 'p1' } }, /give either "to"/);
  rejects({ brief: { ...job, to: 'town-square' } }, /"to" must be a "@user" or a "team\/channel"/);
  rejects({ brief: { ...job, to: 'home/town/square' } }, /"to" must be a "@user" or a "team\/channel"/);
  rejects({ brief: { ...job, to: 'home/town-square' } }, /"owner" must name the user the job runs as/);
  rejects({ brief: { ...job, prompt: ' ' } }, /"prompt" must be a non-empty string/);
  rejects({ brief: { ...job, promptFile: 'brief.md' } }, /give either "prompt", what to ask the agent, or "promptFile"/);
  rejects({ brief: { ...job, prompt: undefined, promptFile: 'missing.md' } }, /"promptFile" .*missing\.md does not exist/);
  rejects({ brief: { ...job, model: 'haiku' } }, /"model" must be provider\/model\[:thinking\]/);
  rejects({ brief: { ...job, catchUp: '1d' } }, /"catchUp" must be minutes or hours, such as "30m" or "2h", not "1d"/);
  rejects({ brief: { ...job, enabled: 'no' } }, /"enabled" must be true or false/);
});
