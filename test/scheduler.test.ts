import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI, SessionEntry } from '@earendil-works/pi-coding-agent';
import { loadScheduler, pendingJobs, type ScheduledJob, scheduler } from '../src/scheduler.ts';

// The installed extension itself, run against a fake pi.
const extension = await loadScheduler();

interface Tool {
  name: string;
  description: string;
  execute(id: string, params: Record<string, unknown>): Promise<{ content: { text: string }[] }>;
}

/** The extension adapted for one session, whose entries persist as JSON, as in a session file. */
function start(entries: SessionEntry[] = []) {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const tools = new Map<string, Tool>();
  const due: ScheduledJob[] = [];
  const sent: unknown[] = [];
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand() {},
    sendMessage: (message: unknown) => sent.push(message),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data: structuredClone(data) } as SessionEntry),
  };
  const ctx = {
    ui: { notify() {}, setStatus() {} },
    sessionManager: { getEntries: () => entries, getSessionId: () => 'session-1' },
  };
  scheduler(extension, (job) => due.push(job))(pi as unknown as ExtensionAPI);

  const emit = async (type: string, event: object = {}) => {
    for (const handler of handlers.get(type) ?? []) {
      const result = await handler({ type, ...event }, ctx);
      if (result) return result;
    }
    return undefined;
  };
  const schedule = async (params: Record<string, unknown>) => (await tools.get('schedule')!.execute('call', params)).content[0]!.text;
  return { entries, tools, due, sent, emit, schedule };
}

const idOf = (text: string) => /id=(\w+)/.exec(text)![1]!;

test('a due job goes to the thread instead of starting a run in the session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 9, 25, 16) });
  const { tools, due, sent, emit, schedule, entries } = start();
  await emit('session_start');
  assert.match(tools.get('schedule')!.description, /schedules a job in this thread/i);

  const id = idOf(await schedule({ action: 'create', interval_ms: 120_000, prompt: 'Check the garage' }));
  assert.deepEqual(pendingJobs(entries).map((j) => j.id), [id]);
  t.mock.timers.tick(119_000);
  assert.deepEqual(due, []);
  t.mock.timers.tick(1_000);
  assert.deepEqual(due, [{ id, prompt: 'Check the garage' }]);
  assert.deepEqual(sent, []);
  assert.deepEqual(pendingJobs(entries), []);
});

test('a reopened session gets back its pending jobs, but not cancelled ones', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 9, 25, 16) });
  const first = start();
  await first.emit('session_start');
  const cancelled = idOf(await first.schedule({ action: 'create', interval_ms: 120_000, prompt: 'Every 2 minutes', recurring: true }));
  const kept = idOf(await first.schedule({ action: 'create', interval_ms: 600_000, prompt: 'In 10 minutes' }));
  await first.schedule({ action: 'cancel', id: cancelled });
  await first.emit('session_shutdown');

  // The extension restores on both events; the job must still run once.
  const reopened = start(first.entries);
  await reopened.emit('session_start');
  await reopened.emit('before_agent_start');
  t.mock.timers.tick(600_000);
  assert.deepEqual(reopened.due, [{ id: kept, prompt: 'In 10 minutes' }]);
});

test("blocks intervals Node's timers can't keep, and jobs past the limit", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 9, 25, 16) });
  const { emit, schedule } = start();
  await emit('session_start');
  const create = (input: Record<string, unknown>) => emit('tool_call', { toolName: 'schedule', input: { action: 'create', prompt: 'x', ...input } });

  const outOfRange = { block: true, reason: 'interval_ms must be from 5000 (5 seconds) to 2147483647 (24 days).' };
  for (const interval_ms of [undefined, 0, 4_999, 2 ** 31]) assert.deepEqual(await create({ interval_ms }), outOfRange);
  assert.equal(await create({ interval_ms: 5_000 }), undefined);
  assert.equal(await create({ interval_ms: 2 ** 31 - 1 }), undefined);
  // A recurring job runs the model each time, so it repeats at most every minute.
  assert.deepEqual(await create({ interval_ms: 30_000, recurring: true }), {
    block: true,
    reason: 'interval_ms must be from 60000 (a minute, for a recurring job) to 2147483647 (24 days).',
  });
  assert.equal(await create({ interval_ms: 60_000, recurring: true }), undefined);

  for (let i = 0; i < 10; i++) await schedule({ action: 'create', interval_ms: 3_600_000, prompt: `job ${i}` });
  assert.deepEqual(await create({ interval_ms: 60_000 }), { block: true, reason: 'This thread already has 10 scheduled jobs. Cancel one first.' });
  assert.equal(await emit('tool_call', { toolName: 'schedule', input: { action: 'list' } }), undefined);
  assert.equal(await emit('tool_call', { toolName: 'websearch', input: {} }), undefined);
  await emit('session_shutdown');
});
