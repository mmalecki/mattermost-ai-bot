// Jobs people set up in schedules.json, which the bot runs on its own, at the times their cron
// expressions give, such as a morning brief. Unlike the agent's own scheduled jobs, they don't live
// in a thread's session: each run starts a thread of its own, or goes to the one thread it names.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Cron } from 'croner';
import type { Agent } from './agent.ts';
import type { ScheduleChat } from './chat.ts';
import type { ModelChoice, Schedule } from './config.ts';
import { errorMessage } from './error.ts';
import type { Threads } from './threads.ts';
import { formatTime } from './time.ts';

// Node fires longer timeouts at once.
const MAX_DELAY_MS = 2 ** 31 - 1;
/** A timer can fire this late, as when the event loop was busy, and its run still count as on time. */
const LATE_MS = 60_000;

export interface SchedulesOptions {
  chat: ScheduleChat;
  threads: Pick<Threads, 'runScheduled'>;
  /** Checks each job's model. */
  agent: Pick<Agent, 'pickModel'>;
  /** The file that keeps when each job last came due, so a restart knows which runs it missed. */
  statePath: string;
}

interface Job extends Schedule {
  times: Cron;
  modelChoice: ModelChoice | undefined;
}

/**
 * Runs the jobs in schedules.json at their times. A run that the bot was down for, or late for,
 * goes only if it is no more than its `catchUpMs` late, and only the latest one missed. A run that
 * comes due while the job's last one is still going is skipped.
 */
export class Schedules {
  readonly #jobs: Job[];
  readonly #options: SchedulesOptions;
  readonly #timers = new Map<string, NodeJS.Timeout>();
  /** The jobs with a run going, by name. */
  readonly #running = new Set<string>();
  /** When each job last came due, or was first armed, by name. */
  #lastDue: Record<string, number> = {};
  #stopped = false;

  /** Throws for a job whose model can't run, so that the bot doesn't start, as for MODEL's. */
  constructor(schedules: Schedule[], options: SchedulesOptions) {
    this.#options = options;
    this.#jobs = schedules.map((schedule) => {
      let modelChoice;
      try {
        modelChoice = schedule.model ? options.agent.pickModel(schedule.model) : undefined;
      } catch (error) {
        throw new Error(`Schedule "${schedule.name}": ${errorMessage(error)}`);
      }
      return { ...schedule, times: new Cron(schedule.cron, { mode: '5-part', timezone: schedule.timezone }), modelChoice };
    });
  }

  /** Arms every job, and runs those that missed a run they may still catch up on. */
  start(): void {
    this.#lastDue = readState(this.#options.statePath);
    const now = Date.now();
    // A job new to the file has missed nothing so far, and from now on, it can.
    const added = this.#jobs.filter((job) => this.#lastDue[job.name] === undefined);
    for (const job of added) this.#lastDue[job.name] = now;
    if (added.length) this.#save();
    for (const job of this.#jobs) {
      // The latest time before now, with now included.
      const missed = job.times.previousRuns(1, new Date(now + 1))[0]?.getTime();
      if (missed !== undefined && missed > this.#lastDue[job.name]!) this.#due(job, missed);
      this.#arm(job);
    }
  }

  /** Stops arming jobs. Runs going on finish, as Threads closes. */
  stop(): void {
    this.#stopped = true;
    this.#timers.forEach(clearTimeout);
    this.#timers.clear();
  }

  /** Arms `job` for its next time after now. */
  #arm(job: Job): void {
    const at = job.times.nextRun(new Date())?.getTime();
    if (at === undefined) {
      console.warn(`Schedule "${job.name}": no more times to run`);
      return;
    }
    console.log(`Schedule "${job.name}": next run ${formatTime(at)}`);
    this.#wait(job, at);
  }

  /** Waits for `at` in steps no longer than Node's timers wait, then runs `job` and arms it again. */
  #wait(job: Job, at: number): void {
    const timer = setTimeout(() => {
      this.#timers.delete(job.name);
      if (this.#stopped) return;
      if (at > Date.now()) return void this.#wait(job, at);
      this.#arm(job);
      this.#due(job, at);
    }, Math.min(MAX_DELAY_MS, Math.max(0, at - Date.now())));
    this.#timers.set(job.name, timer);
  }

  /** Runs `job`, which came due `at`, unless it's too late for it or its last run is still going. */
  #due(job: Job, at: number): void {
    // Before it's run, so a run that fails, or a restart during it, doesn't repeat it. A run that's
    // skipped is recorded too, so a restart doesn't look at it again.
    this.#lastDue[job.name] = at;
    this.#save();
    const late = Date.now() - at;
    if (late > Math.max(LATE_MS, job.catchUpMs)) {
      console.warn(`Schedule "${job.name}": skipping the run due ${formatTime(at)}, which is ${Math.round(late / 60_000)} minutes late`);
      return;
    }
    if (this.#running.has(job.name)) {
      console.warn(`Schedule "${job.name}": skipping the run due ${formatTime(at)}, as the last one is still going`);
      return;
    }
    this.#running.add(job.name);
    this.#run(job)
      .catch((error: unknown) => console.error(`Schedule "${job.name}": its run due ${formatTime(at)} failed:`, error))
      .finally(() => this.#running.delete(job.name));
  }

  /** Saves #lastDue. In a timer, where an error would end the bot, so it's only logged. */
  #save(): void {
    try {
      writeState(this.#options.statePath, this.#lastDue);
    } catch (error) {
      console.error(`Saving when the schedules came due, to ${this.#options.statePath}, failed:`, error);
    }
  }

  /**
   * Starts a thread for the run, with a root post that names the job and mentions its owner, so they
   * follow the thread, or finds the thread it runs in, and has Threads run it there.
   */
  async #run(job: Job): Promise<void> {
    const { chat, threads } = this.#options;
    // Read now, so the file can be edited between runs. Before anything is posted, should it fail.
    const prompt = 'text' in job.prompt ? job.prompt.text : readFileSync(job.prompt.file, 'utf8').trim();
    if (!prompt) throw new Error(`${'file' in job.prompt ? job.prompt.file : 'its prompt'} is empty`);
    const owner = { id: await chat.userId(job.owner), name: job.owner };
    const { target } = job;
    let channelId: string;
    let rootId: string;
    if ('thread' in target) {
      ({ channelId, rootId } = await chat.thread(target.thread));
    } else {
      channelId = 'user' in target ? await chat.directChannel(target.user === job.owner ? owner.id : await chat.userId(target.user)) : await chat.channelId(target.team, target.channel);
      // Threads would drop the run, and leave the thread with nothing but this post.
      if (this.#stopped) {
        console.warn(`Schedule "${job.name}": shutting down, so its run is dropped`);
        return;
      }
      rootId = await chat.post(channelId, `**${job.title}** for @${job.owner}`);
    }
    await threads.runScheduled(channelId, rootId, { name: job.name, owner, prompt, model: job.modelChoice });
  }
}

/** When each job last came due, or was first armed, by name, from the state file. A file that can't be read is taken for none. */
function readState(path: string): Record<string, number> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const state: Record<string, number> = {};
    for (const [name, job] of Object.entries(parsed as Record<string, { lastDue?: unknown }>)) {
      const at = typeof job?.lastDue === 'string' ? Date.parse(job.lastDue) : NaN;
      if (Number.isFinite(at)) state[name] = at;
    }
    return state;
  } catch (error) {
    console.warn(`${path} can't be read, so no missed runs are caught up on: ${errorMessage(error)}`);
    return {};
  }
}

/** Writes the state file whole, through a temporary one, so a crash never leaves half of it. */
function writeState(path: string, lastDue: Record<string, number>): void {
  mkdirSync(dirname(path), { recursive: true });
  const state = Object.fromEntries(Object.entries(lastDue).map(([name, at]) => [name, { lastDue: new Date(at).toISOString() }]));
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}
