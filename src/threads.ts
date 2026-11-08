import type { AssistantMessage, ImageContent } from '@earendil-works/pi-ai';
import type { Agent, ThreadSession } from './agent.ts';
import type { AllowedUsers, ModelChoice } from './config.ts';
import { textOf } from './content.ts';
import { errorMessage } from './error.ts';
import { download, imageSource, ThreadImages } from './images.ts';
import { pendingJobs, type ScheduledJob } from './scheduler.ts';

export interface ThreadPost {
  id: string;
  userId: string;
  createAt: number;
  message: string;
  files: PostFile[];
}

/** A file attached to a post. */
export interface PostFile {
  id: string;
  name: string;
  mimeType: string;
  /** In bytes. */
  size: number;
  /** Whether the server has a smaller JPEG of it, for images. */
  hasPreview: boolean;
}

/** A file to attach to a reply. */
export interface OutgoingFile {
  name: string;
  mimeType: string;
  /** Not a SharedArrayBuffer view, which Blob won't take. */
  data: Uint8Array<ArrayBuffer>;
}

/** What threads need of the chat server. */
export interface Chat {
  /** The thread's posts, oldest first, without the bot's own and system posts. */
  threadPosts(rootId: string): Promise<ThreadPost[]>;
  /** A file's contents, or with `preview`, the server's smaller JPEG of an image. */
  file(fileId: string, preview: boolean): Promise<Uint8Array>;
  username(userId: string): Promise<string>;
  /**
   * Posts `message`, which may be empty when there are files, with `files` attached. Returns their ids, in
   * order, with undefined for one that couldn't be attached.
   */
  reply(channelId: string, rootId: string, message: string, files?: OutgoingFile[]): Promise<(string | undefined)[]>;
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

/** Session entry recording the posts handed to the agent. Not part of the model's context. */
const SEEN_ENTRY = 'mattermost';

interface SeenEntry {
  /** The newest post's. */
  createAt: number;
  /** The posts' authors. */
  userIds: string[];
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
  /** The thread's images: posted ones, and those tools made and returned. */
  readonly #images: ThreadImages;
  /** Whether the current run may call a tool, by its name. */
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
    this.#images = new ThreadImages(context.agent.images(rootId));
  }

  wake(): void {
    if (this.#closed) return;
    this.#pending = true;
    this.#start();
  }

  due(job: ScheduledJob): void {
    if (this.#closed) {
      // The extension has already counted it as run, so it won't come due again.
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
      imageStore: this.#images,
    }));
  }

  async #answerPosts(): Promise<void> {
    const { agent, chat } = this.#context;
    // A new thread's posts may pick its model, so its session waits for them.
    const isNew = !this.#session && !agent.hasSession(this.#rootId);
    const seen = isNew ? { createAt: 0, userIds: new Set<string>() } : seenPosts(await this.#open());
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
    const entry: SeenEntry = { createAt: posts.at(-1)!.createAt, userIds: [...new Set(posts.map((p) => p.userId))] };
    session.appendEntry(SEEN_ENTRY, entry);

    console.log(`Thread ${this.#rootId}: ${posts.length} new post(s) from ${[...new Set(names)].join(', ')}`);
    const { lines, images } = await this.#attachments(posts, session.takesImages);
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
   * lines, if it takes `images`. Images are kept in the thread when the model or some tool takes them,
   * and named as they're kept. A file that can't be handed over is only named, so answering doesn't
   * fail on it.
   */
  async #attachments(posts: ThreadPost[], takesImages: boolean): Promise<{ lines: string[][]; images: ImageContent[] }> {
    const { agent } = this.#context;
    const images: ImageContent[] = [];
    const lines: string[][] = [];
    for (const post of posts) {
      const postLines: string[] = [];
      for (const file of post.files) {
        const image = file.mimeType.startsWith('image/');
        if (image && (takesImages || agent.imageTools)) postLines.push(await this.#image(file, images, takesImages));
        else postLines.push(fileLine(file));
      }
      lines.push(postLines);
    }
    return { lines, images };
  }

  /**
   * Keeps the image in the thread, and returns its line, with the name it's kept under. When the model
   * `takesImages`, adds it to `images` too.
   */
  async #image(file: PostFile, images: ImageContent[], takesImages: boolean): Promise<string> {
    const source = imageSource(file);
    if (!source) return `[image: ${file.name}, not shown: too large, or in a format you can't see]`;
    let image: ImageContent;
    let name: string;
    try {
      image = await download(this.#context.chat, file.id, source);
      name = await this.#images.save(file.name, image);
    } catch (error) {
      console.warn(`Thread ${this.#rootId}: image ${file.id} couldn't be downloaded:`, errorMessage(error));
      return `[image: ${file.name}, not shown: it couldn't be downloaded]`;
    }
    // The model can't see it, but tools can still take it.
    if (!takesImages) return `[image: ${name}, which you can't see]`;
    if (images.length >= MAX_IMAGES) return `[image: ${name}, not shown: too many images at once]`;
    images.push(image);
    return `[image ${images.length}: ${name}]`;
  }

  async #runJob(session: ThreadSession, job: ScheduledJob): Promise<void> {
    // No thread fetch: posts are answered before jobs in a run, so their authors are in the session.
    await this.#allowTools(seenPosts(session), []);
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
    const startedAt = Date.now();
    this.#images.startRun();
    await session.prompt(prompt, images);
    const reply = replyText(session, startedAt);
    const files = await this.#images.takeAttached();
    // pi drops an answer cut off at the output limit to compact and retry, and the retry may not happen.
    if (reply === NO_ANSWER) console.warn(`Thread ${this.#rootId}: the run added no answer`);
    if (reply || files.length) {
      await this.#context.chat.reply(this.#channelId, this.#rootId, reply ?? '', files);
    }
    console.log(`Thread ${this.#rootId}: replied (${reply?.length ?? 0} chars${files.length ? `, ${files.length} image(s)` : ''})`);
  }

  #scheduleIdle(): void {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      // Scheduled jobs live in the session, so it stays open while it has some.
      if (this.#session && pendingJobs(this.#session.entries()).length) return this.#scheduleIdle();
      this.#retire();
    }, this.#context.options.idleMs);
    this.#idleTimer.unref();
  }
}

/** The posts handed to the agent so far, as seenPosts() reads them back. */
interface Seen {
  createAt: number;
  userIds: Set<string>;
}

function seenPosts(session: ThreadSession): Seen {
  let createAt = 0;
  const userIds = new Set<string>();
  for (const entry of session.entries()) {
    if (entry.type !== 'custom' || entry.customType !== SEEN_ENTRY) continue;
    const seen = entry.data as SeenEntry;
    createAt = Math.max(createAt, seen.createAt);
    for (const id of seen.userIds) userIds.add(id);
  }
  return { createAt, userIds };
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
      return `@${names[i]} (${timeFormat.format(p.createAt)}, post ${p.id}): ${text}`;
    })
    .join('\n\n');
}

export function formatJob(job: ScheduledJob, now: number): string {
  return `Scheduled job ${job.id} is due (${timeFormat.format(now)}): ${job.prompt}`;
}

const NO_ANSWER = "Sorry, I couldn't come up with an answer.";

/**
 * The text of the final answer of the run started at `startedAt`, or what went wrong. Messages are
 * stamped with when their request started, so an earlier run's answer is never taken for this one's.
 */
function replyText(session: ThreadSession, startedAt: number): string | undefined {
  const message = session.messages.findLast((m) => m.role === 'assistant') as AssistantMessage | undefined;
  if (!message || !(message.timestamp >= startedAt)) return NO_ANSWER;
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    return `Sorry, I couldn't finish: ${message.errorMessage ?? message.stopReason}`;
  }
  const text = textOf(message.content).trim();
  if (message.stopReason === 'length') {
    return text ? `${text}\n\n_(Cut off at the output limit.)_` : "Sorry, I couldn't finish: I reached the output limit.";
  }
  return text || undefined;
}
