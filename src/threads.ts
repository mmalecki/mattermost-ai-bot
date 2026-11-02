import type { AssistantMessage, ImageContent } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { Agent } from './agent.ts';
import type { ModelChoice } from './config.ts';
import { errorMessage } from './error.ts';
import { pendingJobs, type ScheduledJob } from './scheduler.ts';
import type { ImageStore } from './tools.ts';

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
  /** Usernames who may have the agent call tools. Unset lets everyone. */
  allowedUsers: Set<string> | undefined;
  /** Idle sessions are closed after this long, and reopened from their file on the next post. */
  idleMs: number;
  /** Whether the post that starts a thread may pick its model, with a trailing `/provider/model[:thinking]`. */
  pickModel: boolean;
}

/** Session entry recording the posts handed to the agent. Not part of the model's context. */
const SEEN_ENTRY = 'mattermost';

interface SeenEntry {
  /** The newest post's. */
  createAt: number;
  /** The posts' authors. */
  userIds: string[];
}

/** Session entry recording an image the agent generated, under its name. Not part of the model's context. */
const GENERATED_ENTRY = 'generated-image';

interface GeneratedEntry {
  name: string;
  mimeType: string;
  /** Recorded again with this once the image is posted. */
  fileId?: string;
}

/**
 * Session entry naming an image another tool returned, which stays in the session as part of its result.
 * Not part of the model's context.
 */
const FETCHED_ENTRY = 'fetched-image';

interface FetchedEntry {
  name: string;
  toolCallId: string;
  /** Among the result's images. */
  index: number;
}

const IMAGE_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const TYPING_INTERVAL_MS = 3_000;
/** Images handed to the agent with one batch of posts; any more are only named. */
const MAX_IMAGES = 8;
/**
 * Larger images, and those in other formats, are handed over as the server's preview, or only named
 * without one. pi scales them all down to the model's limits.
 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

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
  #closed = false;

  constructor(agent: Agent, chat: Chat, options: ThreadsOptions) {
    this.agent = agent;
    this.chat = chat;
    this.options = options;
  }

  handle(post: IncomingPost): void {
    if (this.#closed || post.userId === this.options.botUserId || post.type) return;
    const rootId = post.rootId || post.id;
    const known = this.#threads.has(rootId) || this.agent.hasSession(rootId);
    if (!known && !post.direct && !post.mentioned) return;

    let thread = this.#threads.get(rootId);
    if (!thread) {
      thread = new Thread(this, post.channelId, rootId, post.id, () => this.#threads.delete(rootId));
      this.#threads.set(rootId, thread);
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
    await Promise.all(threads.map((t) => t.close()));
  }
}

class Thread {
  readonly threads: Threads;
  readonly channelId: string;
  readonly rootId: string;
  /** The post that brought the bot in, which may pick the thread's model. */
  readonly firstPostId: string;
  readonly onClose: () => void;
  running: Promise<void> | undefined;
  #session: AgentSession | undefined;
  #pending = false;
  /** Scheduled jobs that came due, run after any new posts. */
  readonly #jobs: ScheduledJob[] = [];
  /** Images the agent generated in the current run, as the image model returned them, posted with its reply. */
  readonly #generated: { name: string; image: ImageContent }[] = [];
  readonly #imageStore: ImageStore = {
    add: (image) => this.#addImage(image),
    addFetched: (toolCallId, index, mimeType) => this.#addFetched(toolCallId, index, mimeType),
    get: (refs) => this.#images(refs),
  };
  /** Whether the current run may call tools. */
  #allowed = false;
  #idleTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(threads: Threads, channelId: string, rootId: string, firstPostId: string, onClose: () => void) {
    this.threads = threads;
    this.channelId = channelId;
    this.rootId = rootId;
    this.firstPostId = firstPostId;
    this.onClose = onClose;
  }

  wake(): void {
    if (this.#closed) return;
    this.#pending = true;
    this.#start();
  }

  due(job: ScheduledJob): void {
    if (this.#closed) {
      // The extension has already counted it as run, so it won't come due again.
      console.warn(`Thread ${this.rootId}: closing, so scheduled job ${job.id} is dropped`);
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
    if (session) await this.threads.agent.closeSession(session);
  }

  #start(): void {
    this.running ??= this.#run().finally(() => {
      this.running = undefined;
      if (!this.#closed) this.#scheduleIdle();
    });
  }

  async #run(): Promise<void> {
    const { chat } = this.threads;
    clearTimeout(this.#idleTimer);
    chat.typing(this.channelId, this.rootId);
    const typing = setInterval(() => chat.typing(this.channelId, this.rootId), TYPING_INTERVAL_MS);
    try {
      while (!this.#closed && (this.#pending || this.#jobs.length)) {
        const job = this.#pending ? undefined : this.#jobs.shift();
        this.#pending = false;
        try {
          await (job ? this.#runJob(await this.#open(), job) : this.#answerPosts());
        } catch (error) {
          console.error(`Thread ${this.rootId} failed:`, error);
          await chat.reply(this.channelId, this.rootId, `Sorry, something went wrong: ${errorMessage(error)}`).catch(() => {});
        }
      }
    } finally {
      clearInterval(typing);
    }
  }

  /** The thread's session, opened on `model` if it is new. */
  async #open(model?: ModelChoice): Promise<AgentSession> {
    return (this.#session ??= await this.threads.agent.openSession(this.rootId, {
      model,
      allowTools: () => this.#allowed,
      onScheduled: (due) => this.due(due),
      imageStore: this.#imageStore,
    }));
  }

  async #answerPosts(): Promise<void> {
    const { agent, chat } = this.threads;
    // A new thread's posts may pick its model, so its session waits for them.
    const isNew = !this.#session && !agent.hasSession(this.rootId);
    const seen = isNew ? { createAt: 0, userIds: new Set<string>() } : seenPosts(await this.#open());
    const thread = await chat.threadPosts(this.rootId);
    const posts = thread.filter((p) => p.createAt > seen.createAt);
    const last = posts.at(-1);
    if (!last) return;
    let model;
    try {
      model = isNew ? this.#pickModel(posts) : undefined;
    } catch (error) {
      // Without a session, the thread is new again once it closes: the next post that brings the bot
      // in starts it afresh, and may pick another model.
      this.#closed = true;
      this.onClose();
      await chat.reply(this.channelId, this.rootId, `Sorry, I can't run on that model: ${errorMessage(error)}`);
      return;
    }
    const session = await this.#open(model);

    // A post's author may be one no longer looked up, deleted since: the id stands in for the
    // name, and #allowTools turns tools off for them instead. Answering must not fail: that
    // would leave the posts unseen and retried, and reported, forever.
    const names = await Promise.all(posts.map((p) => chat.username(p.userId).catch(() => p.userId)));
    await this.#allowTools(seen, posts.map((p) => p.userId));
    // Recorded first, so a failing run doesn't send the same posts again.
    const entry: SeenEntry = { createAt: last.createAt, userIds: [...new Set(posts.map((p) => p.userId))] };
    session.sessionManager.appendCustomEntry(SEEN_ENTRY, entry);

    console.log(`Thread ${this.rootId}: ${posts.length} new post(s) from ${[...new Set(names)].join(', ')}`);
    const { lines, images } = await this.#attachments(posts, !!session.model?.input.includes('image'));
    await this.#answer(session, formatPosts(posts, names, lines), images);
  }

  /**
   * The model the first post picks, with a trailing `/provider/model[:thinking]` that is taken off it
   * in `posts`. A word naming no provider pi knows is left as it is. Throws for a model that can't run.
   */
  #pickModel(posts: ThreadPost[]): ModelChoice | undefined {
    if (!this.threads.options.pickModel) return undefined;
    const i = posts.findIndex((p) => p.id === this.firstPostId);
    const picked = i >= 0 ? trailingModel(posts[i]!.message) : undefined;
    const model = picked && this.threads.agent.pickModel(picked.ref);
    if (!model) return undefined;
    posts[i] = { ...posts[i]!, message: picked.message };
    console.log(`Thread ${this.rootId}: runs on ${model.provider}/${model.model} (thinking ${model.thinkingLevel})`);
    return model;
  }

  /**
   * The posts' files: lines naming each, and the images the model can see, in the order of their
   * lines, if it takes `images`. A file that can't be handed over is only named, so answering doesn't
   * fail on it.
   */
  async #attachments(posts: ThreadPost[], takesImages: boolean): Promise<{ lines: string[][]; images: ImageContent[] }> {
    const { agent } = this.threads;
    const images: ImageContent[] = [];
    const lines: string[][] = [];
    for (const post of posts) {
      const postLines: string[] = [];
      for (const file of post.files) {
        const image = file.mimeType.startsWith('image/');
        if (image && takesImages) postLines.push(await this.#image(file, images));
        // The model can't see it, but can still have it changed.
        else if (image && agent.imageEdits) postLines.push(`[image: ${file.name}, file ${file.id}, which you can't see]`);
        else postLines.push(fileLine(file));
      }
      lines.push(postLines);
    }
    return { lines, images };
  }

  /**
   * Adds the image to `images`, and returns its line. When generate_image takes images, the line gives
   * its file id, for the model to pass it on.
   */
  async #image(file: PostFile, images: ImageContent[]): Promise<string> {
    const name = this.threads.agent.imageEdits ? `${file.name}, file ${file.id}` : file.name;
    if (images.length >= MAX_IMAGES) return `[image: ${name}, not shown: too many images at once]`;
    const source = imageSource(file);
    if (!source) return `[image: ${name}, not shown: too large, or in a format you can't see]`;
    try {
      const bytes = await this.threads.chat.file(file.id, source.preview);
      images.push({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: source.mimeType });
      return `[image ${images.length}: ${name}]`;
    } catch (error) {
      console.warn(`Thread ${this.rootId}: image ${file.id} couldn't be downloaded:`, errorMessage(error));
      return `[image: ${name}, not shown: it couldn't be downloaded]`;
    }
  }

  /** Keeps an image the agent generated for this run's reply, under a name new to the thread. */
  #addImage(image: ImageContent): string {
    const session = this.#session!;
    const name = `image-${namedImages(session, GENERATED_ENTRY).size + 1}.${IMAGE_EXTENSIONS[image.mimeType] ?? 'png'}`;
    session.sessionManager.appendCustomEntry(GENERATED_ENTRY, { name, mimeType: image.mimeType } satisfies GeneratedEntry);
    this.#generated.push({ name, image });
    return name;
  }

  /** Names an image another tool returned, with a name new to the thread. */
  #addFetched(toolCallId: string, index: number, mimeType: string): string {
    const session = this.#session!;
    const name = `fetched-${namedImages(session, FETCHED_ENTRY).size + 1}.${IMAGE_EXTENSIONS[mimeType] ?? 'png'}`;
    session.sessionManager.appendCustomEntry(FETCHED_ENTRY, { name, toolCallId, index } satisfies FetchedEntry);
    return name;
  }

  /**
   * The images `refs` name, for generate_image: this run's generated ones as the image model returned
   * them, earlier ones from their posts, fetched ones from their tool results as pi stored them, and the
   * thread's posted ones by file id. Only the thread's, so a reference can't reach files in other channels.
   */
  async #images(refs: string[]): Promise<ImageContent[]> {
    const { chat } = this.threads;
    const session = this.#session!;
    const generated = namedImages<GeneratedEntry>(session, GENERATED_ENTRY);
    const fetched = namedImages<FetchedEntry>(session, FETCHED_ENTRY);
    const posted = refs.some((ref) => !generated.has(ref) && !fetched.has(ref))
      ? new Map((await chat.threadPosts(this.rootId)).flatMap((p) => p.files).map((f) => [f.id, f]))
      : new Map<string, PostFile>();
    return Promise.all(
      refs.map(async (ref): Promise<ImageContent> => {
        const current = this.#generated.find((g) => g.name === ref);
        if (current) return current.image;
        const earlier = generated.get(ref);
        if (earlier) {
          if (!earlier.fileId) throw new Error(`${ref} was never posted, so it can't be used`);
          return { type: 'image', data: Buffer.from(await chat.file(earlier.fileId, false)).toString('base64'), mimeType: earlier.mimeType };
        }
        const result = fetched.get(ref);
        if (result) {
          const image = toolResultImage(session, result);
          if (!image) throw new Error(`${ref} is no longer in this thread's history, so it can't be used`);
          return image;
        }
        const file = posted.get(ref);
        if (!file?.mimeType.startsWith('image/')) {
          throw new Error(
            `${ref} is not an image posted in this thread: give the file id from an [image] line, or the name of an image you generated or a tool returned`,
          );
        }
        const source = imageSource(file);
        if (!source) throw new Error(`${file.name} (${ref}) is too large, or in a format that can't be used`);
        return { type: 'image', data: Buffer.from(await chat.file(file.id, source.preview)).toString('base64'), mimeType: source.mimeType };
      }),
    );
  }

  async #runJob(session: AgentSession, job: ScheduledJob): Promise<void> {
    // No thread fetch: posts are answered before jobs in a run, so their authors are in the session.
    await this.#allowTools(seenPosts(session), []);
    console.log(`Thread ${this.rootId}: scheduled job ${job.id} is due`);
    await this.#answer(session, formatJob(job, Date.now()));
  }

  /**
   * Sets #allowed for this run: whether everyone the agent has seen a post from may have it call tools,
   * so a single post from anyone else turns them off. `userIds` are this run's new posts' authors; the
   * session's recorded ones count too, deleted posts' included, as the agent has seen what they wrote.
   * An author who can no longer be looked up isn't allowed.
   */
  async #allowTools(seen: Seen, userIds: Iterable<string>): Promise<void> {
    const { chat, options } = this.threads;
    const { allowedUsers } = options;
    if (!allowedUsers) {
      this.#allowed = true;
      return;
    }
    const ids = new Set([...seen.userIds, ...userIds]);
    const names = await Promise.all([...ids].map((id) => chat.username(id).catch(() => undefined)));
    this.#allowed = names.every((name) => name !== undefined && allowedUsers.has(name));
  }

  async #answer(session: AgentSession, prompt: string, images: ImageContent[] = []): Promise<void> {
    const startedAt = Date.now();
    // Only this run's: those of a run that threw were never posted, and aren't now.
    this.#generated.length = 0;
    await session.prompt(prompt, { expandPromptTemplates: false, images });
    const reply = replyText(session, startedAt);
    const generated = this.#generated.splice(0);
    const files = generated.map(({ name, image }) => ({ name, mimeType: image.mimeType, data: Buffer.from(image.data, 'base64') }));
    // pi drops an answer cut off at the output limit to compact and retry, and the retry may not happen.
    if (reply === NO_ANSWER) console.warn(`Thread ${this.rootId}: the run added no answer`);
    if (reply || files.length) {
      const fileIds = await this.threads.chat.reply(this.channelId, this.rootId, reply ?? '', files);
      // So later runs can have them changed.
      fileIds.forEach((fileId, i) => {
        const { name, mimeType } = files[i]!;
        if (fileId) session.sessionManager.appendCustomEntry(GENERATED_ENTRY, { name, mimeType, fileId } satisfies GeneratedEntry);
      });
    }
    console.log(`Thread ${this.rootId}: replied (${reply?.length ?? 0} chars${files.length ? `, ${files.length} image(s)` : ''})`);
  }

  #scheduleIdle(): void {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      // Scheduled jobs live in the session, so it stays open while it has some.
      if (this.#session && pendingJobs(this.#session.sessionManager.getEntries()).length) return this.#scheduleIdle();
      this.onClose();
      void this.close();
    }, this.threads.options.idleMs);
    this.#idleTimer.unref();
  }
}

/** The posts handed to the agent so far, as seenPosts() reads them back. */
interface Seen {
  createAt: number;
  userIds: Set<string>;
}

function seenPosts(session: AgentSession): Seen {
  let createAt = 0;
  const userIds = new Set<string>();
  for (const entry of session.sessionManager.getEntries()) {
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

/** The images recorded in the session's `customType` entries, by name, the latest entry for each. */
function namedImages<T extends { name: string }>(session: AgentSession, customType: string): Map<string, T> {
  const images = new Map<string, T>();
  for (const entry of session.sessionManager.getEntries()) {
    if (entry.type === 'custom' && entry.customType === customType) {
      const image = entry.data as T;
      images.set(image.name, image);
    }
  }
  return images;
}

/**
 * A fetched image, from its tool result in the session. That's pi's copy, scaled down to the model's
 * limits. Undefined when the result isn't in the session any more.
 */
function toolResultImage(session: AgentSession, { toolCallId, index }: FetchedEntry): ImageContent | undefined {
  for (const entry of session.sessionManager.getEntries()) {
    if (entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === toolCallId) {
      return entry.message.content.filter((c): c is ImageContent => c.type === 'image')[index];
    }
  }
  return undefined;
}

/**
 * How an image is handed over: as it is, or as the server's preview when it's too large or in a format
 * models don't take. Undefined when neither works.
 */
function imageSource(file: PostFile): { preview: boolean; mimeType: string } | undefined {
  if (IMAGE_TYPES.has(file.mimeType) && file.size <= MAX_IMAGE_BYTES) return { preview: false, mimeType: file.mimeType };
  return file.hasPreview ? { preview: true, mimeType: 'image/jpeg' } : undefined;
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
function replyText(session: AgentSession, startedAt: number): string | undefined {
  const message = session.messages.findLast((m) => m.role === 'assistant') as AssistantMessage | undefined;
  if (!message || !(message.timestamp >= startedAt)) return NO_ANSWER;
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    return `Sorry, I couldn't finish: ${message.errorMessage ?? message.stopReason}`;
  }
  const text = message.content
    .flatMap((c) => (c.type === 'text' ? [c.text] : []))
    .join('')
    .trim();
  if (message.stopReason === 'length') {
    return text ? `${text}\n\n_(Cut off at the output limit.)_` : "Sorry, I couldn't finish: I reached the output limit.";
  }
  return text || undefined;
}