import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { Agent } from './agent.ts';
import { pendingJobs, type ScheduledJob } from './scheduler.ts';

export interface ThreadPost {
  id: string;
  userId: string;
  createAt: number;
  message: string;
}

/** What threads need of the chat server. */
export interface Chat {
  /** The thread's posts, oldest first, without the bot's own and system posts. */
  threadPosts(rootId: string): Promise<ThreadPost[]>;
  username(userId: string): Promise<string>;
  reply(channelId: string, rootId: string, message: string): Promise<void>;
  typing(channelId: string, rootId: string): void;
}

export interface IncomingPost {
  id: string;
  rootId: string;
  channelId: string;
  userId: string;
  /** System posts have a type; user posts don't. */
  type: string;
  direct: boolean;
  mentioned: boolean;
}

export interface ThreadsOptions {
  botUserId: string;
  /** Usernames who may have the agent call tools. Unset lets everyone. */
  allowedUsers: Set<string> | undefined;
  /** Idle sessions are closed after this long, and reopened from their file on the next post. */
  idleMs: number;
}

/** Session entry recording the newest post the agent has seen. Not part of the model's context. */
const SEEN_ENTRY = 'mattermost';
const TYPING_INTERVAL_MS = 3_000;

/**
 * One agent session per thread. Threads start with a DM or a mention of the bot, and from then on
 * every post in them reaches the agent, as do the thread's scheduled jobs when they come due. Runs are
 * serialized per thread: posts arriving during a run are handed over together once it ends.
 */
export class Threads {
  readonly agent: Agent;
  readonly chat: Chat;
  readonly options: ThreadsOptions;
  readonly #threads = new Map<string, Thread>();

  constructor(agent: Agent, chat: Chat, options: ThreadsOptions) {
    this.agent = agent;
    this.chat = chat;
    this.options = options;
  }

  handle(post: IncomingPost): void {
    if (post.userId === this.options.botUserId || post.type) return;
    const rootId = post.rootId || post.id;
    const known = this.#threads.has(rootId) || this.agent.hasSession(rootId);
    if (!known && !post.direct && !post.mentioned) return;

    let thread = this.#threads.get(rootId);
    if (!thread) {
      thread = new Thread(this, post.channelId, rootId, () => this.#threads.delete(rootId));
      this.#threads.set(rootId, thread);
    }
    thread.wake();
  }

  /** Resolves once every running thread finishes. */
  async idle(): Promise<void> {
    await Promise.all([...this.#threads.values()].map((t) => t.running));
  }

  dispose(): void {
    for (const thread of this.#threads.values()) thread.dispose();
    this.#threads.clear();
  }
}

class Thread {
  readonly threads: Threads;
  readonly channelId: string;
  readonly rootId: string;
  readonly onDispose: () => void;
  running: Promise<void> | undefined;
  #session: AgentSession | undefined;
  #pending = false;
  /** Scheduled jobs that came due, run after any new posts. */
  readonly #jobs: ScheduledJob[] = [];
  /** Whether everyone the agent is answering may have it call tools. */
  #allowed = false;
  #idleTimer: NodeJS.Timeout | undefined;
  #disposed = false;

  constructor(threads: Threads, channelId: string, rootId: string, onDispose: () => void) {
    this.threads = threads;
    this.channelId = channelId;
    this.rootId = rootId;
    this.onDispose = onDispose;
  }

  wake(): void {
    this.#pending = true;
    this.#start();
  }

  due(job: ScheduledJob): void {
    if (this.#disposed) return;
    this.#jobs.push(job);
    this.#start();
  }

  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#idleTimer);
    if (this.#session) void this.threads.agent.closeSession(this.#session);
    this.#session = undefined;
  }

  #start(): void {
    this.running ??= this.#run().finally(() => {
      this.running = undefined;
      this.#scheduleIdle();
    });
  }

  async #run(): Promise<void> {
    const { agent, chat } = this.threads;
    clearTimeout(this.#idleTimer);
    chat.typing(this.channelId, this.rootId);
    const typing = setInterval(() => chat.typing(this.channelId, this.rootId), TYPING_INTERVAL_MS);
    try {
      while (this.#pending || this.#jobs.length) {
        const job = this.#pending ? undefined : this.#jobs.shift();
        this.#pending = false;
        try {
          const session = (this.#session ??= await agent.openSession(this.rootId, {
            allowTools: () => this.#allowed,
            onScheduled: (due) => this.due(due),
          }));
          await (job ? this.#runJob(session, job) : this.#answerPosts(session));
        } catch (error) {
          console.error(`Thread ${this.rootId} failed:`, error);
          await chat.reply(this.channelId, this.rootId, `Sorry, something went wrong: ${errorMessage(error)}`).catch(() => {});
        }
      }
    } finally {
      clearInterval(typing);
    }
  }

  async #answerPosts(session: AgentSession): Promise<void> {
    const { chat, options } = this.threads;
    const seen = lastSeen(session);
    const posts = (await chat.threadPosts(this.rootId)).filter((p) => p.createAt > seen);
    const last = posts.at(-1);
    if (!last) return;

    const names = await Promise.all(posts.map((p) => chat.username(p.userId)));
    const { allowedUsers } = options;
    this.#allowed = !allowedUsers || names.every((name) => allowedUsers.has(name));
    // Recorded first, so a failing run doesn't send the same posts again.
    session.sessionManager.appendCustomEntry(SEEN_ENTRY, { createAt: last.createAt });

    console.log(`Thread ${this.rootId}: ${posts.length} new post(s) from ${[...new Set(names)].join(', ')}`);
    await this.#answer(session, formatPosts(posts, names));
  }

  async #runJob(session: AgentSession, job: ScheduledJob): Promise<void> {
    // Only a run allowed tools can schedule jobs, as schedule is a tool, so its jobs are too.
    this.#allowed = true;
    console.log(`Thread ${this.rootId}: scheduled job ${job.id} is due`);
    await this.#answer(session, formatJob(job, Date.now()));
  }

  async #answer(session: AgentSession, prompt: string): Promise<void> {
    await session.prompt(prompt, { expandPromptTemplates: false });
    const reply = replyText(session);
    if (reply) await this.threads.chat.reply(this.channelId, this.rootId, reply);
    console.log(`Thread ${this.rootId}: replied (${reply?.length ?? 0} chars)`);
  }

  #scheduleIdle(): void {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      // Scheduled jobs live in the session, so it stays open while it has some.
      if (this.#session && pendingJobs(this.#session.sessionManager.getEntries()).length) return this.#scheduleIdle();
      this.dispose();
      this.onDispose();
    }, this.threads.options.idleMs);
    this.#idleTimer.unref();
  }
}

function lastSeen(session: AgentSession): number {
  const entries = session.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === 'custom' && entry.customType === SEEN_ENTRY) return (entry.data as { createAt: number }).createAt;
  }
  return 0;
}

// With its UTC offset, so the model can compare post times with tool results in other zones.
// Follows TZ.
const timeFormat = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'shortOffset',
});

export function formatPosts(posts: ThreadPost[], names: string[]): string {
  return posts.map((p, i) => `@${names[i]} (${timeFormat.format(p.createAt)}): ${p.message}`).join('\n\n');
}

export function formatJob(job: ScheduledJob, now: number): string {
  return `Scheduled job ${job.id} is due (${timeFormat.format(now)}): ${job.prompt}`;
}

/** The text of the run's final answer, or what went wrong. */
function replyText(session: AgentSession): string | undefined {
  const message = session.messages.findLast((m) => m.role === 'assistant') as AssistantMessage | undefined;
  if (!message) return undefined;
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    return `Sorry, I couldn't finish: ${message.errorMessage ?? message.stopReason}`;
  }
  return message.content
    .flatMap((c) => (c.type === 'text' ? [c.text] : []))
    .join('')
    .trim() || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
