import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI, SessionEntry } from '@earendil-works/pi-coding-agent';
import { pendingJobs, type ScheduledJob, scheduler } from '../src/scheduler.ts';

const NOW = Date.UTC(2026, 9, 25, 16);

interface Tool {
  description: string;
  execute(id: string, params: Record<string, unknown>): Promise<{ content: { text: string }[] }>;
}

/** The scheduler for one session, whose entries persist as JSON, as in a session file. */
function start(entries: SessionEntry[] = []) {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  let tool: Tool | undefined;
  const due: ScheduledJob[] = [];
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool: (registered: Tool) => (tool = registered),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data: structuredClone(data) } as SessionEntry),
  };
  scheduler('r1', (job) => due.push(job))(pi as unknown as ExtensionAPI);

  const emit = async (type: string) => {
    for (const handler of handlers.get(type) ?? []) await handler({ type }, { sessionManager: { getEntries: () => entries } });
  };
  const schedule = async (params: Record<string, unknown>) => (await tool!.execute('call', params)).content[0]!.text;
  const create = async (interval_ms: number, prompt: string, recurring = false) =>
    /job (\w+)/.exec(await schedule({ action: 'create', interval_ms, prompt, recurring }))![1]!;
  return { entries, tool: () => tool!, due, emit, schedule, create };
}

test('a due job goes to the thread, and then is no longer pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const { tool, due, emit, schedule, create, entries } = start();
  await emit('session_start');
  assert.match(tool().description, /schedules a job in this thread/i);

  const id = await create(120_000, 'Check the garage');
  assert.deepEqual(pendingJobs(entries).map((j) => j.id), [id]);
  assert.match(await schedule({ action: 'list' }), new RegExp(`^job ${id}, due 2026-10-25 \\d\\d:02 GMT[+-]?\\d*: Check the garage$`));
  t.mock.timers.tick(119_000);
  assert.deepEqual(due, []);
  t.mock.timers.tick(1_000);
  assert.deepEqual(due, [{ id, prompt: 'Check the garage' }]);
  assert.deepEqual(pendingJobs(entries), []);
  assert.equal(await schedule({ action: 'list' }), 'No jobs are scheduled in this thread.');
});

test('a recurring job comes due every interval until cancelled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const { due, emit, schedule, create, entries } = start();
  await emit('session_start');

  const id = await create(3_600_000, 'Check the weather', true);
  assert.match(await schedule({ action: 'list' }), /, then every 1 hour: Check the weather$/);
  for (let i = 0; i < 3; i++) t.mock.timers.tick(3_600_000);
  assert.equal(due.length, 3);
  assert.deepEqual(pendingJobs(entries).map((j) => j.expiresAt), [NOW + 4 * 3_600_000]);

  assert.equal(await schedule({ action: 'cancel', id }), `Cancelled job ${id}.`);
  t.mock.timers.tick(3_600_000);
  assert.equal(due.length, 3);
  assert.deepEqual(pendingJobs(entries), []);
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

  const reopened = start(first.entries);
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
  assert.deepEqual(pendingJobs(reopened.entries).map((j) => [j.id, j.expiresAt]), [[daily, NOW + 3 * 86_400_000]]);
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
