import type { ImageContent } from '@earendil-works/pi-ai';
import type { Agent, RunOutcome, Seen, ThreadSession } from './agent.ts';
import type { Chat, IncomingPost, PostFile, ThreadPost } from './chat.ts';
import type { AllowedUsers, ModelChoice } from './config.ts';
import { errorMessage } from './error.ts';
import { download, imageSource } from './images.ts';
import type { ScheduledJob } from './scheduler.ts';
import { formatTime } from './time.ts';

export interface ThreadsOptions {
  botUserId: string;
  /** The tools each username may have the agent call. Unset lets everyone call every tool. */
  allowedUsers: AllowedUsers | undefined;
  /** Idle sessions are closed after this long, and reopened from their file on the next post. */
  idleMs: number;
  /** Whether the post that starts a thread may pick its model, with a trailing `/provider/model[:thinking]`. */
  pickModel: boolean;
}

/** What every thread shares. */
interface ThreadContext {
  agent: Agent;
  chat: Chat;
  options: ThreadsOptions;
}

const TYPING_INTERVAL_MS = 3_000;
/** Images handed to the agent with one batch of posts; any more are only named. */
const MAX_IMAGES = 8;

/**
 * One agent session per thread. Threads start with a DM or a mention of the bot, and from then on
 * every post in them reaches the agent, as do the thread's scheduled jobs when they come due. Runs are
 * serialized per thread: posts arriving during a run are handed over together once it ends.
 */
export class Threads {
  readonly #context: ThreadContext;
  readonly #threads = new Map<string, Thread>();
  /** Threads closing after idling, by root id. One started meanwhile waits for the close. */
  readonly #closing = new Map<string, Promise<void>>();
  #closed = false;

  constructor(agent: Agent, chat: Chat, options: ThreadsOptions) {
    this.#context = { agent, chat, options };
  }

  handle(post: IncomingPost): void {
    const { agent, options } = this.#context;
    if (this.#closed || post.userId === options.botUserId || post.type) return;
    const rootId = post.rootId || post.id;
    let thread = this.#threads.get(rootId);
    if (!thread) {
      if (!post.direct && !post.mentioned && !agent.hasSession(rootId)) return;
      const created = new Thread(this.#context, post.channelId, rootId, post.id, this.#closing.get(rootId), () => this.#retire(rootId, created));
      this.#threads.set(rootId, created);
      thread = created;
    }
    thread.wake();
  }

  /** Resolves once every running thread finishes. */
  async idle(): Promise<void> {
    await Promise.all([...this.#threads.values()].map((t) => t.running));
  }

  /** Stops taking posts and jobs, lets running threads finish their current run, and closes every session. */
  async close(): Promise<void> {
    this.#closed = true;
    const threads = [...this.#threads.values()];
    this.#threads.clear();
    await Promise.all([...threads.map((t) => t.close()), ...this.#closing.values()]);
  }

  /** Forgets the thread and closes it. A thread started in its place waits for the close. */
  #retire(rootId: string, thread: Thread): void {
    if (this.#threads.get(rootId) === thread) this.#threads.delete(rootId);
    const closing: Promise<void> = thread
      .close()
      .catch((error: unknown) => console.error(`Thread ${rootId}: closing failed:`, error))
      .finally(() => {
        if (this.#closing.get(rootId) === closing) this.#closing.delete(rootId);
      });
    this.#closing.set(rootId, closing);
  }
}

class Thread {
  readonly #context: ThreadContext;
  readonly #channelId: string;
  readonly #rootId: string;
  /** The post that brought the bot in, which may pick the thread's model. */
  readonly #firstPostId: string;
  /** The close of the thread's previous session, if it's still closing: both write to its file. */
  readonly #previous: Promise<void> | undefined;
  /** Has Threads forget this thread and close it. */
  readonly #retire: () => void;
  running: Promise<void> | undefined;
  #session: ThreadSession | undefined;
  #pending = false;
  /** Scheduled jobs that came due, run after any new posts. */
  readonly #jobs: ScheduledJob[] = [];
  /**
   * Whether the current run may call a tool, by its name. The session's tool guard asks it through
   * #open's allowTools, and it is set anew before each run. That's safe only because a thread's runs
   * never overlap: were a scheduled job to run during a post's run, each would get the other's tools.
   */
  #allowed: (toolName: string) => boolean = () => false;
  #idleTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(context: ThreadContext, channelId: string, rootId: string, firstPostId: string, previous: Promise<void> | undefined, retire: () => void) {
    this.#context = context;
    this.#channelId = channelId;
    this.#rootId = rootId;
    this.#firstPostId = firstPostId;
    this.#previous = previous;
    this.#retire = retire;
  }

  wake(): void {
    if (this.#closed) return;
    this.#pending = true;
    this.#start();
  }

  due(job: ScheduledJob): void {
    if (this.#closed) {
      // The scheduler has already taken it off, or moved it on to its next time, so this run of it is lost.
      console.warn(`Thread ${this.#rootId}: closing, so scheduled job ${job.id} is dropped`);
      return;
    }
    this.#jobs.push(job);
    this.#start();
  }

  /**
   * Lets the current run finish, then closes the session. Posts that came in meanwhile stay unseen, so
   * the thread's next run picks them up.
   */
  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#idleTimer);
    await this.running;
    const session = this.#session;
    this.#session = undefined;
    await session?.close();
  }

  #start(): void {
    this.running ??= this.#run().finally(() => {
      this.running = undefined;
      if (!this.#closed) this.#scheduleIdle();
    });
  }

  async #run(): Promise<void> {
    const { chat } = this.#context;
    clearTimeout(this.#idleTimer);
    chat.typing(this.#channelId, this.#rootId);
    const typing = setInterval(() => chat.typing(this.#channelId, this.#rootId), TYPING_INTERVAL_MS);
    try {
      await this.#previous;
      while (!this.#closed && (this.#pending || this.#jobs.length)) {
        const job = this.#pending ? undefined : this.#jobs.shift();
        this.#pending = false;
        try {
          await (job ? this.#runJob(await this.#open(), job) : this.#answerPosts());
        } catch (error) {
          console.error(`Thread ${this.#rootId} failed:`, error);
          await chat.reply(this.#channelId, this.#rootId, `Sorry, something went wrong: ${errorMessage(error)}`).catch(() => {});
        }
      }
    } finally {
      clearInterval(typing);
    }
  }

  /** The thread's session, opened on `model` if it is new. */
  async #open(model?: ModelChoice): Promise<ThreadSession> {
    return (this.#session ??= await this.#context.agent.openSession(this.#rootId, {
      model,
      allowTools: (toolName) => this.#allowed(toolName),
      onScheduled: (due) => this.due(due),
    }));
  }

  async #answerPosts(): Promise<void> {
    const { agent, chat } = this.#context;
    // A new thread's posts may pick its model, so its session waits for them.
    const isNew = !this.#session && !agent.hasSession(this.#rootId);
    const seen: Seen = isNew ? { createAt: 0, userIds: new Set() } : (await this.#open()).seen();
    const unseen = (await chat.threadPosts(this.#rootId)).filter((p) => p.createAt > seen.createAt);
    if (!unseen.length) return;
    let picked: { model?: ModelChoice; posts: ThreadPost[] };
    try {
      picked = isNew ? this.#pickModel(unseen) : { posts: unseen };
    } catch (error) {
      // Without a session, the thread is new again once it closes: the next post that brings the bot
      // in starts it afresh, and may pick another model.
      this.#retire();
      await chat.reply(this.#channelId, this.#rootId, `Sorry, I can't run on that model: ${errorMessage(error)}`);
      return;
    }
    const { model, posts } = picked;
    const session = await this.#open(model);

    // A post's author may be one no longer looked up, deleted since: the id stands in for the
    // name, and #allowTools turns tools off for them instead. Answering must not fail: that
    // would leave the posts unseen and retried, and reported, forever.
    const names = await Promise.all(posts.map((p) => chat.username(p.userId).catch(() => p.userId)));
    await this.#allowTools(seen, posts.map((p) => p.userId));
    // Recorded first, so a failing run doesn't send the same posts again.
    session.markSeen(posts.at(-1)!.createAt, posts.map((p) => p.userId));

    console.log(`Thread ${this.#rootId}: ${posts.length} new post(s) from ${[...new Set(names)].join(', ')}`);
    const { lines, images } = await this.#attachments(posts, session);
    await this.#answer(session, formatPosts(posts, names, lines), images);
  }

  /**
   * The model the first post picks, with a trailing `/provider/model[:thinking]`, and `posts` with
   * that word taken off it. A word naming no provider pi knows is left as it is. Throws for a model
   * that can't run.
   */
  #pickModel(posts: ThreadPost[]): { model?: ModelChoice; posts: ThreadPost[] } {
    const { agent, options } = this.#context;
    if (!options.pickModel) return { posts };
    const i = posts.findIndex((p) => p.id === this.#firstPostId);
    const picked = i >= 0 ? trailingModel(posts[i]!.message) : undefined;
    const model = picked && agent.pickModel(picked.ref);
    if (!model) return { posts };
    console.log(`Thread ${this.#rootId}: runs on ${model.provider}/${model.model} (thinking ${model.thinkingLevel})`);
    return { model, posts: posts.with(i, { ...posts[i]!, message: picked.message }) };
  }

  /**
   * The posts' files: lines naming each, and the images the model can see, in the order of their
   * lines, if it takes images. Images are kept in the thread when the session keeps them, and named
   * as they're kept. A file that can't be handed over is only named, so answering doesn't fail on it.
   */
  async #attachments(posts: ThreadPost[], session: ThreadSession): Promise<{ lines: string[][]; images: ImageContent[] }> {
    const images: ImageContent[] = [];
    const lines: string[][] = [];
    for (const post of posts) {
      const postLines: string[] = [];
      for (const file of post.files) {
        const image = file.mimeType.startsWith('image/');
        if (image && session.keepsImages) postLines.push(await this.#image(file, images, session));
        else postLines.push(fileLine(file));
      }
      lines.push(postLines);
    }
    return { lines, images };
  }

  /**
   * Keeps the image in the session's images, and returns its line, with the name it's kept under. When
   * the model takes images, adds it to `images` too.
   */
  async #image(file: PostFile, images: ImageContent[], session: ThreadSession): Promise<string> {
    const source = imageSource(file);
    if (!source) return `[image: ${file.name}, not shown: too large, or in a format you can't see]`;
    let image: ImageContent;
    let name: string;
    try {
      image = await download(this.#context.chat, file.id, source);
      name = await session.images.save(file.name, image);
    } catch (error) {
      console.warn(`Thread ${this.#rootId}: image ${file.id} couldn't be downloaded:`, errorMessage(error));
      return `[image: ${file.name}, not shown: it couldn't be downloaded]`;
    }
    // The model can't see it, but tools can still take it.
    if (!session.takesImages) return `[image: ${name}, which you can't see]`;
    if (images.length >= MAX_IMAGES) return `[image: ${name}, not shown: too many images at once]`;
    images.push(image);
    return `[image ${images.length}: ${name}]`;
  }

  async #runJob(session: ThreadSession, job: ScheduledJob): Promise<void> {
    // No thread fetch: posts are answered before jobs in a run, so their authors are in the session.
    await this.#allowTools(session.seen(), []);
    console.log(`Thread ${this.#rootId}: scheduled job ${job.id} is due`);
    await this.#answer(session, formatJob(job, Date.now()));
  }

  /**
   * Sets #allowed for this run: the tools everyone the agent has seen a post from may have it call, so
   * a single post from anyone with fewer tools takes the others away. `userIds` are this run's new
   * posts' authors; the session's recorded ones count too, deleted posts' included, as the agent has
   * seen what they wrote. An author who can no longer be looked up, or isn't in the allowlist, has none.
   */
  async #allowTools(seen: Seen, userIds: Iterable<string>): Promise<void> {
    const { chat, options } = this.#context;
    const { allowedUsers } = options;
    if (!allowedUsers) {
      this.#allowed = () => true;
      return;
    }
    const ids = new Set([...seen.userIds, ...userIds]);
    const names = await Promise.all([...ids].map((id) => chat.username(id).catch(() => undefined)));
    const patterns = names.map((name) => (name === undefined ? undefined : allowedUsers.get(name)));
    this.#allowed = patterns.every((may) => may !== undefined) ? (toolName) => patterns.every((may) => may(toolName)) : () => false;
  }

  async #answer(session: ThreadSession, prompt: string, images: ImageContent[] = []): Promise<void> {
    session.images.startRun();
    const outcome = await session.prompt(prompt, images);
    const reply = replyText(outcome);
    const files = await session.images.takeAttached();
    if (outcome.stop === 'no answer') console.warn(`Thread ${this.#rootId}: the run added no answer`);
    if (reply || files.length) {
      await this.#context.chat.reply(this.#channelId, this.#rootId, reply ?? '', files);
    }
    console.log(`Thread ${this.#rootId}: replied (${reply?.length ?? 0} chars${files.length ? `, ${files.length} image(s)` : ''})`);
  }

  #scheduleIdle(): void {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      // Scheduled jobs live in the session, so it stays open while it has some.
      if (this.#session?.hasPendingJobs()) return this.#scheduleIdle();
      this.#retire();
    }, this.#context.options.idleMs);
    this.#idleTimer.unref();
  }
}

/**
 * `message` without its last word, when that is `/provider/model[:thinking]`, and the word without
 * its slash. Whether it names a model is the agent's to say.
 */
export function trailingModel(message: string): { message: string; ref: string } | undefined {
  const match = /(?:^|\s)\/(\S+\/\S+)\s*$/.exec(message);
  if (!match) return undefined;
  return { message: message.slice(0, match.index).trimEnd(), ref: match[1]! };
}

/** A file the model only learns the name of. */
function fileLine(file: PostFile): string {
  return `[file: ${file.name} (${file.mimeType || 'unknown type'}), which you can't open]`;
}

/** `attachments` are each post's lines for its files, so a post with only a file isn't empty. */
export function formatPosts(posts: ThreadPost[], names: string[], attachments: string[][] = []): string {
  return posts
    .map((p, i) => {
      const text = [p.message, ...(attachments[i] ?? [])].filter(Boolean).join('\n');
      return `@${names[i]} (${formatTime(p.createAt)}, post ${p.id}): ${text}`;
    })
    .join('\n\n');
}

export function formatJob(job: ScheduledJob, now: number): string {
  return `Scheduled job ${job.id} is due (${formatTime(now)}): ${job.prompt}`;
}

/** What's posted for how a run ended: its answer, or what went wrong. Nothing, for an empty answer. */
function replyText(outcome: RunOutcome): string | undefined {
  switch (outcome.stop) {
    case 'answered':
      return outcome.text || undefined;
    case 'cut off':
      return outcome.text ? `${outcome.text}\n\n_(Cut off at the output limit.)_` : "Sorry, I couldn't finish: I reached the output limit.";
    case 'failed':
      return `Sorry, I couldn't finish: ${outcome.error}`;
    case 'no answer':
      return "Sorry, I couldn't come up with an answer.";
  }
}
