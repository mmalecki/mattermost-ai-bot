import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI, SessionEntry } from '@earendil-works/pi-coding-agent';
import { savedJobs, type ScheduledJob, scheduler } from '../src/scheduler.ts';

const NOW = Date.UTC(2026, 9, 25, 16);

interface Tool {
  description: string;
  execute(id: string, params: Record<string, unknown>): Promise<{ content: { text: string }[] }>;
}

/**
 * The scheduler for one session, whose entries persist as JSON, as in a session file. Saving fails
 * while `saving.fails` is set.
 */
function start(entries: SessionEntry[] = []) {
  const saving = { fails: false };
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  let tool: Tool | undefined;
  const due: ScheduledJob[] = [];
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool: (registered: Tool) => (tool = registered),
    appendEntry(customType: string, data: unknown) {
      if (saving.fails) throw new Error('ENOSPC: no space left on device');
      entries.push({ type: 'custom', customType, data: structuredClone(data) } as SessionEntry);
    },
  };
  const { extension, hasPendingJobs } = scheduler('r1', (job) => due.push(job));
  extension(pi as unknown as ExtensionAPI);

  const emit = async (type: string) => {
    for (const handler of handlers.get(type) ?? []) await handler({ type }, { sessionManager: { getEntries: () => entries } });
  };
  const schedule = async (params: Record<string, unknown>) => (await tool!.execute('call', params)).content[0]!.text;
  const create = async (interval_ms: number, prompt: string, recurring = false) =>
    /job (\w+)/.exec(await schedule({ action: 'create', interval_ms, prompt, recurring }))![1]!;
  return { entries, tool: () => tool!, due, emit, schedule, create, hasPendingJobs, saving };
}

test('a due job goes to the thread, and then is no longer pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const { tool, due, emit, schedule, create, entries, hasPendingJobs } = start();
  await emit('session_start');
  assert.match(tool().description, /schedules a job in this thread/i);
  assert.equal(hasPendingJobs(), false);

  const id = await create(120_000, 'Check the garage');
  assert.deepEqual(savedJobs(entries).map((j) => j.id), [id]);
  assert.equal(hasPendingJobs(), true);
  assert.match(await schedule({ action: 'list' }), new RegExp(`^job ${id}, due 2026-10-25 \\d\\d:02:00 GMT[+-]?\\d*: Check the garage$`));
  t.mock.timers.tick(119_000);
  assert.deepEqual(due, []);
  t.mock.timers.tick(1_000);
  assert.deepEqual(due, [{ id, prompt: 'Check the garage' }]);
  assert.deepEqual(savedJobs(entries), []);
  assert.equal(hasPendingJobs(), false);
  assert.equal(await schedule({ action: 'list' }), 'No jobs are scheduled in this thread.');
});

test('says when a job is due to the second, as one may be due in seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW + 40_000 });
  const { emit, schedule } = start();
  await emit('session_start');
  assert.match(await schedule({ action: 'create', interval_ms: 30_000, prompt: 'Soon' }), /^Scheduled: job \w+, due 2026-10-25 \d\d:01:10 GMT[+-]?\d*: Soon$/);
  await emit('session_shutdown');
});

test('a recurring job comes due every interval until cancelled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const { due, emit, schedule, create, entries } = start();
  await emit('session_start');

  const id = await create(3_600_000, 'Check the weather', true);
  assert.match(await schedule({ action: 'list' }), /, then every 1 hour: Check the weather$/);
  const saved = entries.length;
  for (let i = 0; i < 3; i++) t.mock.timers.tick(3_600_000);
  assert.equal(due.length, 3);
  // Its runs aren't saved, as a reopened session works out its next time.
  assert.equal(entries.length, saved);
  await emit('session_shutdown');

  const reopened = start(entries);
  await reopened.emit('session_start');
  t.mock.timers.tick(3_600_000 - 1);
  assert.equal(reopened.due.length, 0);
  t.mock.timers.tick(1);
  assert.equal(reopened.due.length, 1);

  assert.equal(await reopened.schedule({ action: 'cancel', id }), `Cancelled job ${id}.`);
  t.mock.timers.tick(3_600_000);
  assert.equal(reopened.due.length, 1);
  assert.deepEqual(savedJobs(entries), []);
});

test('a reopened session gets back its pending jobs, but not cancelled ones', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const first = start();
  await first.emit('session_start');
  const cancelled = await first.create(120_000, 'Every 2 minutes', true);
  const kept = await first.create(600_000, 'In 10 minutes');
  await first.schedule({ action: 'cancel', id: cancelled });
  await first.emit('session_shutdown');
  t.mock.timers.tick(60_000);
  assert.deepEqual(first.due, []);

  // Starting twice still runs the job once.
  const reopened = start(first.entries);
  await reopened.emit('session_start');
  await reopened.emit('session_start');
  t.mock.timers.tick(540_000);
  assert.deepEqual(reopened.due, [{ id: kept, prompt: 'In 10 minutes' }]);
});

test("after a restart, a one-off job that came due is dropped, and a recurring one keeps to its times", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const first = start();
  await first.emit('session_start');
  await first.create(600_000, 'In 10 minutes');
  const daily = await first.create(86_400_000, 'Every day at this time', true);
  await first.emit('session_shutdown');

  // Down for two and a half days.
  t.mock.timers.setTime(NOW + 2.5 * 86_400_000);
  const warn = t.mock.method(console, 'warn', () => {});
  const reopened = start(first.entries);
  await reopened.emit('session_start');
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(savedJobs(reopened.entries).map((j) => [j.id, j.expiresAt]), [[daily, NOW + 3 * 86_400_000]]);
  t.mock.timers.tick(0.5 * 86_400_000);
  assert.deepEqual(reopened.due, [{ id: daily, prompt: 'Every day at this time' }]);
});

test("takes up pi-ate-scheduler's jobs, which the bot used before", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const timer = (id: string, status: string) => ({ id, prompt: id, intervalMs: 60_000, createdAt: NOW, expiresAt: NOW + 60_000, recurring: false, firedCount: 0, status });
  const old = { type: 'custom', customType: 'scheduler', data: { timers: [timer('done', 'completed'), timer('dropped', 'cancelled'), timer('kept', 'active')] } };
  const { due, emit } = start([old as SessionEntry]);
  await emit('session_start');
  t.mock.timers.tick(60_000);
  assert.deepEqual(due, [{ id: 'kept', prompt: 'kept' }]);
});

test("refuses intervals Node's timers can't keep, jobs past the limit, and unknown jobs", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const { emit, schedule, create } = start();
  await emit('session_start');
  const refused = (params: Record<string, unknown>, message: string | RegExp) =>
    assert.rejects(schedule({ action: 'create', prompt: 'x', ...params }), { message });

  const outOfRange = 'interval_ms must be from 5000 (5 seconds) to 2147483647 (24 days).';
  for (const interval_ms of [undefined, 0, 4_999, 2 ** 31]) await refused({ interval_ms }, outOfRange);
  await create(5_000, 'x');
  await create(2 ** 31 - 1, 'x');
  // A recurring job runs the model each time, so it repeats at most every minute.
  await refused({ interval_ms: 30_000, recurring: true }, 'interval_ms must be from 60000 (a minute, for a recurring job) to 2147483647 (24 days).');
  await create(60_000, 'x', true);
  await refused({ interval_ms: 60_000, prompt: ' ' }, /prompt must say what to do/);

  for (let i = 0; i < 7; i++) await create(3_600_000, `job ${i}`);
  await refused({ interval_ms: 60_000 }, 'This thread already has 10 scheduled jobs. Cancel one first.');
  await assert.rejects(schedule({ action: 'cancel', id: 'nope' }), { message: /There is no job nope in this thread/ });
  await emit('session_shutdown');
});

test("a job that couldn't be saved isn't scheduled, and one that comes due runs though saving fails", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const error = t.mock.method(console, 'error', () => {});
  const { due, emit, schedule, create, hasPendingJobs, saving } = start();
  await emit('session_start');
  const kept = await create(60_000, 'Kept');

  saving.fails = true;
  await assert.rejects(schedule({ action: 'create', interval_ms: 60_000, prompt: 'Lost' }), /ENOSPC/);
  await assert.rejects(schedule({ action: 'cancel', id: kept }), /ENOSPC/);
  assert.match(await schedule({ action: 'list' }), new RegExp(`^job ${kept}, .*: Kept$`));

  t.mock.timers.tick(60_000);
  assert.deepEqual(due, [{ id: kept, prompt: 'Kept' }]);
  assert.equal(hasPendingJobs(), false);
  assert.equal(error.mock.callCount(), 1);
});

test('leaves out saved jobs schedule could not have made', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const job = { id: 'j', prompt: 'x', intervalMs: 60_000, recurring: true, expiresAt: NOW + 60_000 };
  const broken = [{ ...job, intervalMs: 0 }, { ...job, intervalMs: undefined }, { ...job, expiresAt: Number.NaN }, { ...job, id: 7 }, { ...job, recurring: 'yes' }];
  const { due, emit, hasPendingJobs } = start([{ type: 'custom', customType: 'scheduler', data: { timers: [...broken, job] } } as SessionEntry]);
  await emit('session_start');
  t.mock.timers.tick(60_000);
  assert.deepEqual(due, [{ id: 'j', prompt: 'x' }]);
  assert.equal(hasPendingJobs(), true);
  await emit('session_shutdown');
});

test("a job due further off than Node's timers can wait, such as after the clock was set back, comes due once, on time", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const day = 86_400_000;
  const daily = { id: 'd', prompt: 'Daily', intervalMs: day, recurring: true, expiresAt: NOW + 30 * day };
  const { due, emit } = start([{ type: 'custom', customType: 'scheduler', data: { timers: [daily] } } as SessionEntry]);
  await emit('session_start');
  t.mock.timers.tick(1);
  t.mock.timers.tick(2 ** 31 - 1);
  assert.deepEqual(due, []);
  t.mock.timers.tick(30 * day - 2 ** 31);
  assert.deepEqual(due, [{ id: 'd', prompt: 'Daily' }]);
  t.mock.timers.tick(day);
  assert.equal(due.length, 2);
  await emit('session_shutdown');
});
