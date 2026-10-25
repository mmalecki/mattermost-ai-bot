import { fileURLToPath } from 'node:url';
import type { CustomEntry, ExtensionAPI, ExtensionFactory, SessionEntry } from '@earendil-works/pi-coding-agent';
import { createJiti } from 'jiti';

/** A scheduled job that is due: the extension's id for it, and the prompt it was set up with. */
export interface ScheduledJob {
  id: string;
  prompt: string;
}

/** What the bot reads of the extension's timers. */
interface Timer {
  id: string;
  status: 'active' | 'completed' | 'cancelled' | 'error';
  expiresAt: number;
}

/** The extension's session entry, a snapshot of all its timers appended on every change. */
const SNAPSHOT_ENTRY = 'scheduler';
const MIN_INTERVAL_MS = 5_000;
// Each run of a recurring job is a model run and a post, so it may not repeat faster than this.
const MIN_RECURRING_MS = 60_000;
// Node fires longer timeouts at once, which would loop a recurring job.
const MAX_INTERVAL_MS = 2 ** 31 - 1;
const MAX_JOBS = 10;
// A job still counts as pending this long after its time, while the extension gets to it.
const DUE_GRACE_MS = 60_000;

/**
 * Loads pi-ate-scheduler. Published as TypeScript, which Node won't strip under node_modules, so it
 * goes through jiti as pi does with installed packages. Its pi imports resolve to the bot's own copy.
 */
export async function loadScheduler(): Promise<ExtensionFactory> {
  const jiti = createJiti(import.meta.url);
  return jiti.import<ExtensionFactory>(fileURLToPath(import.meta.resolve('pi-ate-scheduler')), { default: true });
}

/**
 * pi-ate-scheduler for one thread, adapted to the bot:
 * - A due job goes to `onDue`, which runs it like posts are run, instead of starting a run in the session.
 * - Timers are restored from the latest snapshot only. The extension replays every snapshot, which
 *   brings back cancelled jobs, and also reads a state file from the home directory, which this skips.
 * - `schedule` is described in English, and calls with an interval Node can't keep, or past
 *   MAX_JOBS pending jobs, are blocked.
 * Its commands (/loop, /remind, /tasks) are never run: the bot doesn't dispatch commands.
 */
export function scheduler(extension: ExtensionFactory, onDue: (job: ScheduledJob) => void): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', (event, ctx) => {
      if (event.toolName !== 'schedule') return undefined;
      const input = event.input as Record<string, unknown>;
      if (input.action !== 'create') return undefined;
      const ms = input.interval_ms;
      const [min, label] = input.recurring === true ? [MIN_RECURRING_MS, 'a minute, for a recurring job'] : [MIN_INTERVAL_MS, '5 seconds'];
      if (typeof ms !== 'number' || !(ms >= min && ms <= MAX_INTERVAL_MS)) {
        return { block: true, reason: `interval_ms must be from ${min} (${label}) to ${MAX_INTERVAL_MS} (24 days).` };
      }
      if (pendingJobs(ctx.sessionManager.getEntries()).length >= MAX_JOBS) {
        return { block: true, reason: `This thread already has ${MAX_JOBS} scheduled jobs. Cancel one first.` };
      }
      return undefined;
    });

    const on = pi.on.bind(pi) as unknown as On;
    const adapted = override(pi, {
      sendMessage: ((message, options) => {
        if (message.customType === SNAPSHOT_ENTRY) onDue(parseJob(message.content));
        else pi.sendMessage(message, options);
      }) satisfies ExtensionAPI['sendMessage'],
      registerTool: (tool: ToolDefinition) => pi.registerTool({ ...tool, ...SCHEDULE_TOOL } as ToolDefinition),
      on: ((event, handler) =>
        on(event, (e, ctx) => handler(e, override(ctx, { sessionManager: latestSnapshotOnly(ctx.sessionManager) })))) satisfies On,
    });
    return extension(adapted);
  };
}

/** Jobs the extension still has to run, from its latest snapshot. */
export function pendingJobs(entries: SessionEntry[], now = Date.now()): Timer[] {
  const timers = (latestSnapshot(entries) as CustomEntry<{ timers?: Timer[] }> | undefined)?.data?.timers ?? [];
  return timers.filter((t) => t.status === 'active' && t.expiresAt > now - DUE_GRACE_MS);
}

const SCHEDULE_TOOL = {
  description:
    'The only way to do something later: schedules a job in this thread, a prompt you get again after interval_ms, once or every interval_ms. ' +
    'When it is due, you do what the prompt says, and your reply is posted to the thread. Also lists and cancels jobs.',
  promptSnippet: 'Schedule, list and cancel jobs that run later in this thread',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'list', 'cancel'] },
      interval_ms: { type: 'number', description: 'For create: milliseconds until the job is due: at least 5000, or 60000 for a recurring job' },
      prompt: { type: 'string', description: 'For create: what to do when the job is due, written as an instruction to yourself' },
      recurring: { type: 'boolean', description: 'For create: repeat every interval_ms. Default false' },
      id: { type: 'string', description: 'For cancel: the job id' },
    },
    required: ['action'],
  },
};

type ToolDefinition = Parameters<ExtensionAPI['registerTool']>[0];
type On = (event: string, handler: (event: unknown, ctx: { sessionManager: SessionManagerView }) => unknown) => () => void;

interface SessionManagerView {
  getEntries(): SessionEntry[];
  getSessionId(): string;
}

function latestSnapshotOnly(sessionManager: SessionManagerView): SessionManagerView {
  return override(sessionManager, {
    getEntries: () => {
      const entries = sessionManager.getEntries();
      const latest = latestSnapshot(entries);
      return entries.filter((e) => !isSnapshot(e) || e === latest);
    },
    // Only names the extension's state file in the home directory.
    getSessionId: () => '',
  });
}

function latestSnapshot(entries: SessionEntry[]): CustomEntry | undefined {
  return entries.findLast(isSnapshot);
}

function isSnapshot(entry: SessionEntry): entry is CustomEntry {
  return entry.type === 'custom' && entry.customType === SNAPSHOT_ENTRY;
}

/** The extension's message for a due job is "[定时任务 <id>] <prompt>" ("scheduled task"). */
function parseJob(content: unknown): ScheduledJob {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const match = /^\[定时任务 (\w+)\] ([\s\S]*)$/.exec(text);
  return match ? { id: match[1]!, prompt: match[2]! } : { id: '?', prompt: text };
}

/** `target` with some properties replaced. Its other methods stay bound to it. */
function override<T extends object>(target: T, replaced: Record<string, unknown>): T {
  return new Proxy(target, {
    get(t, key) {
      if (typeof key === 'string' && Object.hasOwn(replaced, key)) return replaced[key];
      const value: unknown = Reflect.get(t, key);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
}
