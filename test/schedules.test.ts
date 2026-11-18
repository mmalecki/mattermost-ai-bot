import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, type TestContext, test } from 'node:test';
import type { ScheduleChat } from '../src/chat.ts';
import { parseModel, type Schedule } from '../src/config.ts';
import { Schedules } from '../src/schedules.ts';
import type { ScheduledRun } from '../src/threads.ts';

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mattermost-ai-bot-'));
  dirs.push(dir);
  return dir;
}

/** A server with the users alice and bob, the channel home/town-square, and the post p2 in the thread r1. */
class FakeChat implements ScheduleChat {
  users: Record<string, string> = { alice: 'u1', bob: 'u2' };
  posted: { channelId: string; message: string }[] = [];

  async userId(username: string) {
    const id = this.users[username];
    if (!id) throw new Error(`no user ${username}`);
    return id;
  }
  async directChannel(userId: string) {
    return `dm-${userId}`;
  }
  async channelId(team: string, channel: string) {
    if (`${team}/${channel}` !== 'home/town-square') throw new Error(`no channel ${team}/${channel}`);
    return 'town';
  }
  async thread(postId: string) {
    return { channelId: 'town', rootId: postId === 'p2' ? 'r1' : postId };
  }
  async post(channelId: string, message: string) {
    this.posted.push({ channelId, message });
    return `root${this.posted.length}`;
  }
}

/** A weekday morning brief, at 7:00 in Warsaw, in alice's direct channel. */
function brief(fields: Partial<Schedule> = {}): Schedule {
  return {
    name: 'brief',
    cron: '0 7 * * 1-5',
    timezone: 'Europe/Warsaw',
    target: { user: 'alice' },
    owner: 'alice',
    title: 'Morning brief',
    prompt: { text: 'What is on today?' },
    model: undefined,
    catchUpMs: 0,
    ...fields,
  };
}

// Friday, 2026-10-23, 6:00 in Warsaw (CEST). Summer time ends on Sunday the 25th.
const FRIDAY_6 = Date.parse('2026-10-23T04:00:00Z');
const HOUR = 3_600_000;

/**
 * Schedules for `schedules`, with time standing still at `now` until ticked, and the state file in
 * `statePath`. Each run waits for `hold`, when set.
 */
function setup(t: TestContext, schedules: Schedule[], { now = FRIDAY_6, statePath = join(tempDir(), 'schedules-state.json') } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  t.mock.method(console, 'log', () => {});
  const warnings = t.mock.method(console, 'warn', () => {});
  const errors = t.mock.method(console, 'error', () => {});
  const chat = new FakeChat();
  const runs: { channelId: string; rootId: string; run: ScheduledRun }[] = [];
  const control: { hold?: Promise<void> } = {};
  const threads = {
    async runScheduled(channelId: string, rootId: string, run: ScheduledRun) {
      runs.push({ channelId, rootId, run });
      await control.hold;
    },
  };
  const agent = {
    pickModel(ref: string) {
      const choice = parseModel(ref);
      if (choice.model === 'missing') throw new Error(`there is no model \`${ref}\``);
      return choice;
    },
  };
  const make = () => new Schedules(schedules, { chat, threads, agent, statePath });
  return { chat, runs, control, statePath, warnings, errors, make };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Moves time on by `ms`, firing the timers due, and lets the runs they start get going. */
async function tick(t: TestContext, ms: number) {
  t.mock.timers.tick(ms);
  await settle();
}

const lastDue = (statePath: string) => JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, { lastDue: string }>;

test("runs a job at its times, in its time zone, as its owner, in a new thread in the owner's direct channel", async (t) => {
  const { chat, runs, statePath, make } = setup(t, [brief()]);
  const schedules = make();
  schedules.start();
  await tick(t, HOUR - 1);
  assert.equal(runs.length, 0);

  await tick(t, 1);
  assert.deepEqual(chat.posted, [{ channelId: 'dm-u1', message: '**Morning brief** for @alice' }]);
  assert.deepEqual(runs, [{ channelId: 'dm-u1', rootId: 'root1', run: { name: 'brief', owner: { id: 'u1', name: 'alice' }, prompt: 'What is on today?', model: undefined } }]);
  assert.deepEqual(lastDue(statePath), { brief: { lastDue: '2026-10-23T05:00:00.000Z' } });

  // Not on the weekend, and on Monday at 7:00 in winter time, an hour later in UTC.
  await tick(t, 3 * 24 * HOUR);
  assert.equal(runs.length, 1);
  await tick(t, HOUR);
  assert.equal(runs.length, 2);
  assert.deepEqual(lastDue(statePath), { brief: { lastDue: '2026-10-26T06:00:00.000Z' } });
  schedules.stop();
});

test("a job runs in a team's channel, as its owner, or in the thread of the post it names, with its model", async (t) => {
  const { chat, runs, make } = setup(t, [
    brief({ name: 'digest', target: { team: 'home', channel: 'town-square' }, owner: 'bob', title: 'Digest', model: 'anthropic/claude-haiku-5-5:low' }),
    brief({ name: 'follow-up', target: { thread: 'p2' }, owner: 'bob' }),
  ]);
  const schedules = make();
  schedules.start();
  await tick(t, HOUR);

  assert.deepEqual(chat.posted, [{ channelId: 'town', message: '**Digest** for @bob' }]);
  assert.deepEqual(
    // By name, as they start in the order their lookups end.
    runs.map(({ channelId, rootId, run }) => [channelId, rootId, run.name, run.owner.id, run.model]).sort((a, b) => String(a[2]).localeCompare(String(b[2]))),
    [
      ['town', 'root1', 'digest', 'u2', { provider: 'anthropic', model: 'claude-haiku-5-5', thinkingLevel: 'low' }],
      ['town', 'r1', 'follow-up', 'u2', undefined],
    ],
  );
  schedules.stop();
});

test('a run missed while the bot was down goes at start only within catchUp, and only the latest', async (t) => {
  const statePath = join(tempDir(), 'schedules-state.json');
  // Last run on Wednesday; the bot starts again on Friday at 7:10.
  writeFileSync(statePath, JSON.stringify({ brief: { lastDue: '2026-10-21T05:00:00.000Z' } }));
  const now = Date.parse('2026-10-23T05:10:00Z');
  const { runs, warnings, make } = setup(t, [brief({ catchUpMs: 30 * 60_000 })], { now, statePath });
  const schedules = make();
  schedules.start();
  await settle();
  assert.deepEqual(runs.length, 1);
  assert.deepEqual(lastDue(statePath), { brief: { lastDue: '2026-10-23T05:00:00.000Z' } });

  // Started again, it doesn't run it twice.
  schedules.stop();
  make().start();
  await settle();
  assert.equal(runs.length, 1);
  assert.equal(warnings.mock.callCount(), 0);
});

test('a run missed while the bot was down is skipped without catchUp, and nothing is missed on the first start', async (t) => {
  const statePath = join(tempDir(), 'schedules-state.json');
  writeFileSync(statePath, JSON.stringify({ brief: { lastDue: '2026-10-22T05:00:00.000Z' } }));
  const now = Date.parse('2026-10-23T05:10:00Z');
  const { runs, warnings, make } = setup(t, [brief(), brief({ name: 'new', catchUpMs: HOUR })], { now, statePath });
  const schedules = make();
  schedules.start();
  await settle();
  assert.equal(runs.length, 0);
  assert.match(String(warnings.mock.calls[0]!.arguments[0]), /Schedule "brief": skipping the run due 2026-10-2\d \d\d:00 \S+, which is 10 minutes late/);
  // Recorded, so the next start doesn't look at it again.
  assert.deepEqual(lastDue(statePath), { brief: { lastDue: '2026-10-23T05:00:00.000Z' } });
  schedules.stop();
});

test("a run is skipped while the job's last one is still going", async (t) => {
  const { runs, control, warnings, make } = setup(t, [brief({ cron: '* * * * *' })]);
  let release!: () => void;
  control.hold = new Promise((resolve) => (release = resolve));
  const schedules = make();
  schedules.start();
  await tick(t, 60_000);
  await tick(t, 60_000);
  assert.equal(runs.length, 1);
  assert.match(String(warnings.mock.calls[0]!.arguments[0]), /skipping the run due .*, as the last one is still going/);

  release();
  await settle();
  await tick(t, 60_000);
  assert.equal(runs.length, 2);
  schedules.stop();
});

test('a run that fails before it starts posts nothing, and the job runs again at its next time', async (t) => {
  const { chat, runs, errors, make } = setup(t, [brief({ owner: 'carol' })]);
  const schedules = make();
  schedules.start();
  await tick(t, HOUR);
  assert.deepEqual(chat.posted, []);
  assert.equal(runs.length, 0);
  assert.match(String(errors.mock.calls[0]!.arguments[0]), /Schedule "brief": its run due 2026-10-2\d \d\d:00 \S+ failed/);
  assert.match(String(errors.mock.calls[0]!.arguments[1]), /no user carol/);

  chat.users.carol = 'u3';
  await tick(t, 3 * 24 * HOUR + HOUR);
  assert.equal(runs.length, 1);
  schedules.stop();
});

test('a prompt file is read at every run, and an empty one posts nothing', async (t) => {
  const file = join(tempDir(), 'brief.md');
  writeFileSync(file, 'What is on today?\n');
  const { chat, runs, errors, make } = setup(t, [brief({ prompt: { file } })]);
  const schedules = make();
  schedules.start();
  await tick(t, HOUR);
  assert.equal(runs[0]!.run.prompt, 'What is on today?');

  writeFileSync(file, 'And the weather?');
  await tick(t, 3 * 24 * HOUR + HOUR);
  assert.equal(runs[1]!.run.prompt, 'And the weather?');

  writeFileSync(file, '\n');
  await tick(t, 24 * HOUR);
  assert.equal(runs.length, 2);
  assert.equal(chat.posted.length, 2);
  assert.match(String(errors.mock.calls[0]!.arguments[1]), /brief\.md is empty/);
  schedules.stop();
});

test("a job whose model can't run keeps the bot from starting", (t) => {
  const { make } = setup(t, [brief({ model: 'anthropic/missing' })]);
  assert.throws(make, /Schedule "brief": there is no model `anthropic\/missing`/);
});

test('stopping disarms every job', async (t) => {
  const { runs, make } = setup(t, [brief()]);
  const schedules = make();
  schedules.start();
  schedules.stop();
  await tick(t, 24 * HOUR);
  assert.equal(runs.length, 0);
});
