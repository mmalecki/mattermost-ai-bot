import { randomBytes } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { type CustomEntry, defineTool, type ExtensionFactory, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { formatTime } from './time.ts';

/** A scheduled job that is due: its id, and the prompt it was set up with. */
export interface ScheduledJob {
  id: string;
  prompt: string;
}

/** A job the thread has pending, as its session file keeps it. */
export interface Job extends ScheduledJob {
  intervalMs: number;
  recurring: boolean;
  /** When it is next due. */
  expiresAt: number;
}

/**
 * The session entry with a snapshot of the thread's pending jobs, appended on every change. The bot
 * used pi-ate-scheduler before, whose snapshots look the same, but also list the jobs that are done,
 * by their `status`, so threads that have them keep their jobs.
 */
const SNAPSHOT_ENTRY = 'scheduler';
type Snapshot = CustomEntry<{ timers?: (Job & { status?: string })[] }>;

const MIN_INTERVAL_MS = 5_000;
// Each run of a recurring job is a model run and a post, so it may not repeat faster than this.
const MIN_RECURRING_MS = 60_000;
// Node fires longer timeouts at once, which would loop a recurring job.
const MAX_INTERVAL_MS = 2 ** 31 - 1;
const MAX_JOBS = 10;

/**
 * The `schedule` tool, for the thread `rootId`: jobs that give the agent a prompt later, once or every
 * so often. A due job goes to `onDue`, which runs it like posts are run. Jobs are kept in the session
 * file, and taken up again when the session is reopened: a recurring one that came due meanwhile at
 * its next time, a one-off one not at all, as it's late for whatever it was meant to do.
 */
export function scheduler(rootId: string, onDue: (job: ScheduledJob) => void): ExtensionFactory {
  return (pi) => {
    const jobs = new Map<string, Job>();
    const timers = new Map<string, NodeJS.Timeout>();

    // Copies, as pi keeps the entry, and the jobs change.
    const persist = () => pi.appendEntry(SNAPSHOT_ENTRY, { timers: [...jobs.values()].map((job) => ({ ...job })) });
    const arm = (job: Job) => timers.set(job.id, setTimeout(() => fire(job), Math.max(0, job.expiresAt - Date.now())));
    // Off the schedule, or on to its next time, before it's run, so a run that fails doesn't repeat it.
    const fire = (job: Job) => {
      timers.delete(job.id);
      if (job.recurring) {
        advance(job, Date.now());
        arm(job);
      } else {
        jobs.delete(job.id);
      }
      persist();
      onDue({ id: job.id, prompt: job.prompt });
    };

    const disarm = () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };

    pi.on('session_start', (_event, ctx) => {
      // From scratch, should it start again, so no job is armed twice.
      disarm();
      jobs.clear();
      const now = Date.now();
      let changed = false;
      for (const job of pendingJobs(ctx.sessionManager.getEntries())) {
        if (job.expiresAt <= now) {
          changed = true;
          if (!job.recurring) {
            console.warn(`Thread ${rootId}: scheduled job ${job.id} came due while the bot was down, so it's dropped`);
            continue;
          }
          advance(job, now);
        }
        jobs.set(job.id, job);
        arm(job);
      }
      // Otherwise the dropped jobs would still count as pending, and keep the session open.
      if (changed) persist();
    });
    pi.on('session_shutdown', disarm);

    pi.registerTool(
      defineTool({
        name: 'schedule',
        label: 'Schedule',
        description:
          'The only way to do something later: schedules a job in this thread, a prompt you get again after interval_ms, once or every interval_ms. ' +
          'When it is due, you do what the prompt says, and your reply is posted to the thread. Also lists and cancels jobs.',
        promptSnippet: 'Schedule, list and cancel jobs that run later in this thread',
        parameters: Type.Object({
          action: Type.Unsafe<'create' | 'list' | 'cancel'>({ type: 'string', enum: ['create', 'list', 'cancel'] }),
          interval_ms: Type.Optional(
            Type.Number({ description: 'For create: milliseconds until the job is due: at least 5000, or 60000 for a recurring job' }),
          ),
          prompt: Type.Optional(Type.String({ description: 'For create: what to do when the job is due, written as an instruction to yourself' })),
          recurring: Type.Optional(Type.Boolean({ description: 'For create: repeat every interval_ms. Default false' })),
          id: Type.Optional(Type.String({ description: 'For cancel: the job id' })),
        }),

        async execute(_toolCallId, { action, interval_ms: ms, prompt, recurring = false, id }) {
          const result = (text: string) => ({ content: [{ type: 'text' as const, text }], details: { jobs: [...jobs.values()].map((job) => ({ ...job })) } });
          if (action === 'list') {
            if (!jobs.size) return result('No jobs are scheduled in this thread.');
            return result([...jobs.values()].sort((a, b) => a.expiresAt - b.expiresAt).map(describe).join('\n'));
          }
          if (action === 'cancel') {
            if (!id) throw new Error('id must name the job to cancel.');
            if (!jobs.has(id)) throw new Error(`There is no job ${id} in this thread. List them for their ids.`);
            jobs.delete(id);
            clearTimeout(timers.get(id));
            timers.delete(id);
            persist();
            return result(`Cancelled job ${id}.`);
          }
          const [min, label] = recurring ? [MIN_RECURRING_MS, 'a minute, for a recurring job'] : [MIN_INTERVAL_MS, '5 seconds'];
          if (typeof ms !== 'number' || !(ms >= min && ms <= MAX_INTERVAL_MS)) {
            throw new Error(`interval_ms must be from ${min} (${label}) to ${MAX_INTERVAL_MS} (24 days).`);
          }
          if (!prompt?.trim()) throw new Error('prompt must say what to do when the job is due.');
          if (jobs.size >= MAX_JOBS) throw new Error(`This thread already has ${MAX_JOBS} scheduled jobs. Cancel one first.`);
          const job: Job = { id: randomBytes(4).toString('hex'), prompt, intervalMs: ms, recurring, expiresAt: Date.now() + ms };
          jobs.set(job.id, job);
          arm(job);
          persist();
          return result(`Scheduled: ${describe(job)}`);
        },
      }),
    );
  };
}

/** The jobs the thread has pending, from the session's latest snapshot of them. */
export function pendingJobs(entries: SessionEntry[]): Job[] {
  const latest = entries.findLast((e) => e.type === 'custom' && e.customType === SNAPSHOT_ENTRY) as Snapshot | undefined;
  return (latest?.data?.timers ?? [])
    .filter((job) => (job.status ?? 'active') === 'active')
    .map(({ id, prompt, intervalMs, recurring, expiresAt }) => ({ id, prompt, intervalMs, recurring, expiresAt }));
}

/** Moves a recurring `job` on to its first time after `now`, keeping to its times, such as 7:00 every day. */
function advance(job: Job, now: number): void {
  job.expiresAt += Math.max(1, Math.floor((now - job.expiresAt) / job.intervalMs) + 1) * job.intervalMs;
}

function describe(job: Job): string {
  return `job ${job.id}, due ${formatTime(job.expiresAt)}${job.recurring ? `, then every ${duration(job.intervalMs)}` : ''}: ${job.prompt}`;
}

const UNITS = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1_000],
] as const;

/** `ms` in the largest unit that it's a whole number of, such as `90 minutes`. */
function duration(ms: number): string {
  const [unit, size] = UNITS.find(([, size]) => ms % size === 0) ?? ['millisecond', 1];
  const n = ms / size;
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}
