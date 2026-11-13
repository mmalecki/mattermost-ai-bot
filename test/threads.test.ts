import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { Agent, RunOutcome, ThreadSession } from '../src/agent.ts';
import { type ModelChoice, parseAllowedUsers, parseModel } from '../src/config.ts';
import { type ImageStore, imageFiles, ThreadImages } from '../src/images.ts';
import type { ScheduledJob } from '../src/scheduler.ts';
import type { Chat, IncomingPost, OutgoingFile, PostFile, ThreadPost } from '../src/chat.ts';
import { Threads } from '../src/threads.ts';

const BOT = 'bot';
const USERS: Record<string, string> = { u1: 'maciej', u2: 'guest', u3: 'carol' };

class FakeChat implements Chat {
  posts = new Map<string, ThreadPost[]>();
  /** `files` only when the reply has some. */
  replies: { channelId: string; rootId: string; message: string; files?: OutgoingFile[] }[] = [];
  /** Posts ever added to each thread, deleted ones included. */
  #counts = new Map<string, number>();

  add(rootId: string, userId: string, message: string, files: PostFile[] = []): ThreadPost {
    const thread = this.posts.get(rootId) ?? [];
    const n = this.#counts.get(rootId) ?? 0;
    this.#counts.set(rootId, n + 1);
    const post = { id: `p${n}`, userId, createAt: Date.UTC(2026, 9, 25, 16, n), message, files };
    thread.push(post);
    this.posts.set(rootId, thread);
    return post;
  }

  async threadPosts(rootId: string) {
    return [...(this.posts.get(rootId) ?? [])];
  }
  /** Files' contents by id; any other fails to download. */
  files = new Map<string, Uint8Array>();
  downloads: { fileId: string; preview: boolean }[] = [];

  async file(fileId: string, preview: boolean) {
    this.downloads.push({ fileId, preview });
    const bytes = this.files.get(fileId);
    if (!bytes) throw new Error(`no file ${fileId}`);
    return bytes;
  }
  /** Users whose lookups fail, as for one deleted since. */
  gone = new Set<string>();

  async username(userId: string) {
    if (this.gone.has(userId)) throw new Error(`no user ${userId}`);
    return USERS[userId] ?? userId;
  }
  async reply(channelId: string, rootId: string, message: string, files: OutgoingFile[] = []) {
    this.replies.push({ channelId, rootId, message, ...(files.length ? { files } : {}) });
  }
  typing() {}
}

/** An answer's text, or how the run ended. */
type Reply = string | RunOutcome;
type Answer = (prompt: string) => Promise<Reply> | Reply;

interface FakeSession {
  /** What the session was opened on, if not MODEL. */
  model: ModelChoice | undefined;
  prompts: string[];
  images: ImageContent[][];
  /** Whether each run could call websearch. */
  allowed: boolean[];
  /** Which of TOOLS each run could call. */
  tools: string[][];
  /** The posts marked seen, as the session would record them. */
  seen: { createAt: number; userIds: Set<string> };
  onScheduled: (job: ScheduledJob) => void;
  imageStore: ImageStore;
  /** Whether the session says it has scheduled jobs pending. */
  pendingJobs: boolean;
  closed: boolean;
}

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const MODEL: ModelChoice = { provider: 'local', model: 'default', thinkingLevel: 'off' };
const TOOLS = ['websearch', 'mcp__parcels__add_observations', 'mcp__parcels__read_graph', 'mcp__home__HassTurnOn'];

/**
 * An agent whose sessions answer each prompt with `answer(prompt)`, and fail when it throws. Its providers are `anthropic` and `local`,
 * which have every model but `missing`. Closing a session waits for `closing`, when given. Threads'
 * images are kept in a directory of their own.
 */
function fakeAgent(answer: Answer, images: boolean, imageTools: boolean, closing?: () => Promise<void>) {
  const sessions = new Map<string, FakeSession>();
  const dir = mkdtempSync(join(tmpdir(), 'mattermost-ai-bot-'));
  dirs.push(dir);
  const prompted = new Set<string>();
  /** What happened to sessions, in order. */
  const events: string[] = [];
  const agent: Agent = {
    hasSession: (rootId) => prompted.has(rootId),
    pickModel(ref) {
      const choice = parseModel(ref);
      if (!['anthropic', 'local'].includes(choice.provider)) return undefined;
      if (choice.model === 'missing') throw new Error(`there is no model ${choice.provider}/missing`);
      return choice;
    },
    async openSession(rootId, { model, allowTools, onScheduled }) {
      events.push(`open ${rootId}`);
      const imageStore = new ThreadImages(imageFiles(join(dir, rootId, 'images')));
      const record: FakeSession = { model, prompts: [], images: [], allowed: [], tools: [], seen: { createAt: 0, userIds: new Set() }, onScheduled, imageStore, pendingJobs: false, closed: false };
      sessions.set(rootId, record);
      const session: ThreadSession = {
        model: model ?? MODEL,
        takesImages: images,
        images: imageStore,
        keepsImages: images || imageTools,
        hasPendingJobs: () => record.pendingJobs,
        messages: [],
        async prompt(text, images = []) {
          prompted.add(rootId);
          record.prompts.push(text);
          record.images.push(images);
          record.allowed.push(allowTools('websearch'));
          record.tools.push(TOOLS.filter(allowTools));
          try {
            const reply = await answer(text);
            return typeof reply === 'string' ? { stop: 'answered', text: reply } : reply;
          } catch (error) {
            return { stop: 'failed', error: (error as Error).message };
          }
        },
        abort: async () => {},
        seen: () => record.seen,
        markSeen(createAt, userIds) {
          record.seen = { createAt: Math.max(record.seen.createAt, createAt), userIds: new Set([...record.seen.userIds, ...userIds]) };
        },
        async close() {
          events.push(`closing ${rootId}`);
          await closing?.();
          record.closed = true;
          events.push(`closed ${rootId}`);
        },
      };
      return session;
    },
  };
  return { agent, sessions, events };
}

interface SetupOptions {
  answer?: Answer;
  /** As `allowedUsers` in mcp.json; `null` leaves it out. */
  allowlist?: string[] | Record<string, string | string[]> | null;
  /** Whether the model takes images. */
  images?: boolean;
  /** Whether some tool takes images. */
  imageTools?: boolean;
  pickModel?: boolean;
  /** Closing a session waits for this. */
  closing?: () => Promise<void>;
}

function setup({ answer = () => 'ok', allowlist = ['maciej'], images = true, imageTools = false, pickModel = false, closing }: SetupOptions = {}) {
  const chat = new FakeChat();
  const { agent, sessions, events } = fakeAgent(answer, images, imageTools, closing);
  const threads = new Threads(agent, chat, { botUserId: BOT, allowedUsers: allowlist ? parseAllowedUsers(allowlist) : undefined, idleMs: 60_000, pickModel });
  return { chat, sessions, events, threads };
}

function incoming(rootId: string, post: ThreadPost, extra: Partial<IncomingPost> = {}): IncomingPost {
  return { id: post.id, rootId: post.id === 'p0' ? '' : rootId, channelId: 'c1', userId: post.userId, type: '', direct: false, mentioned: false, ...extra };
}

test('a channel post starts a thread only when it mentions the bot', async () => {
  const { chat, sessions, threads } = setup();
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'hello')));
  await threads.idle();
  assert.equal(sessions.size, 0);

  threads.handle(incoming('r2', chat.add('r2', 'u1', '@sailor hello'), { id: 'r2', mentioned: true }));
  await threads.idle();
  assert.deepEqual(chat.replies, [{ channelId: 'c1', rootId: 'r2', message: 'ok' }]);
  await threads.close();
});

test('a direct message starts a thread without a mention', async () => {
  const { chat, threads } = setup();
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'hi'), { id: 'r1', direct: true }));
  await threads.idle();
  assert.equal(chat.replies.length, 1);
  await threads.close();
});

test("the bot's own posts and system posts are ignored", async () => {
  const { chat, sessions, threads } = setup();
  threads.handle(incoming('r1', chat.add('r1', BOT, 'mine'), { id: 'r1', direct: true }));
  threads.handle(incoming('r2', chat.add('r2', 'u1', 'joined'), { id: 'r2', direct: true, type: 'system_join_channel' }));
  await threads.idle();
  assert.equal(sessions.size, 0);
  await threads.close();
});

test('follow-ups in a known thread need no mention and carry only unseen posts', async () => {
  const { chat, sessions, threads } = setup();
  threads.handle(incoming('r1', chat.add('r1', 'u1', '@sailor lights?'), { id: 'r1', mentioned: true }));
  await threads.idle();

  threads.handle(incoming('r1', chat.add('r1', 'u2', 'and the heating?')));
  await threads.idle();

  const { prompts } = sessions.get('r1')!;
  assert.equal(prompts.length, 2);
  assert.match(prompts[0]!, /^@maciej \(\d{4}-\d\d-\d\d \d\d:\d\d GMT[+-−]?\d*, post p\d+\): @sailor lights\?$/);
  assert.match(prompts[1]!, /^@guest \(.+\): and the heating\?$/);
  assert.equal(chat.replies.length, 2);
  await threads.close();
});

test('a mention mid-thread hands the agent the whole thread so far', async () => {
  const { chat, sessions, threads } = setup();
  chat.add('r1', 'u1', 'is the garage open?');
  chat.add('r1', 'u2', 'no idea');
  threads.handle(incoming('r1', chat.add('r1', 'u1', '@sailor can you check?'), { mentioned: true }));
  await threads.idle();
  assert.equal(sessions.get('r1')!.prompts[0]!.split('\n\n').length, 3);
  await threads.close();
});

test("a post's files are named, so one with only a file isn't empty", async () => {
  const { chat, sessions, threads } = setup();
  const pdf = { id: 'f1', name: 'invoice.pdf', mimeType: 'application/pdf', size: 1000, hasPreview: false };
  threads.handle(incoming('r1', chat.add('r1', 'u1', '', [pdf]), { id: 'r1', direct: true }));
  await threads.idle();
  assert.match(sessions.get('r1')!.prompts[0]!, /^@maciej \(.+\): \[file: invoice\.pdf \(application\/pdf\), which you can't open\]$/);
  await threads.close();
});

function image(id: string, name: string, extra: Partial<PostFile> = {}): PostFile {
  return { id, name, mimeType: 'image/png', size: 1000, hasPreview: true, ...extra };
}

test('images are handed to the agent after the text, in the order of their lines', async () => {
  const { chat, sessions, threads } = setup();
  chat.files.set('f1', new Uint8Array([1])).set('f2', new Uint8Array([2]));
  chat.add('r1', 'u1', 'look', [image('f1', 'garage.png')]);
  threads.handle(incoming('r1', chat.add('r1', 'u2', '', [image('f2', 'gate.jpg', { mimeType: 'image/jpeg' })]), { mentioned: true }));
  await threads.idle();
  const session = sessions.get('r1')!;
  assert.match(session.prompts[0]!, /: look\n\[image 1: garage\.png\]\n\n@guest .*: \[image 2: gate\.jpg\]$/);
  assert.deepEqual(session.images[0], [
    { type: 'image', data: 'AQ==', mimeType: 'image/png' },
    { type: 'image', data: 'Ag==', mimeType: 'image/jpeg' },
  ]);
  await threads.close();
});

test("large images, and those in other formats, are handed over as the server's preview", async () => {
  const { chat, sessions, threads } = setup();
  chat.files.set('f1', new Uint8Array([1])).set('f2', new Uint8Array([2]));
  const files = [
    image('f1', 'huge.png', { size: 50 * 1024 * 1024 }),
    image('f2', 'scan.tiff', { mimeType: 'image/tiff' }),
    image('f3', 'odd.heic', { mimeType: 'image/heic', hasPreview: false }),
  ];
  threads.handle(incoming('r1', chat.add('r1', 'u1', '', files), { id: 'r1', direct: true }));
  await threads.idle();
  assert.deepEqual(chat.downloads, [
    { fileId: 'f1', preview: true },
    { fileId: 'f2', preview: true },
  ]);
  const session = sessions.get('r1')!;
  assert.deepEqual(session.images[0]!.map((i) => i.mimeType), ['image/jpeg', 'image/jpeg']);
  // Named as they're kept, as JPEG.
  assert.match(session.prompts[0]!, /: \[image 1: huge\.jpg\]\n\[image 2: scan\.jpg\]\n\[image: odd\.heic, not shown: too large, or in a format you can't see\]$/);
  await threads.close();
});

test("an image that can't be downloaded is only named, and the posts still answered", async () => {
  const { chat, sessions, threads } = setup();
  chat.files.set('f2', new Uint8Array([2]));
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'hm', [image('f1', 'gone.png'), image('f2', 'here.png')]), { id: 'r1', direct: true }));
  await threads.idle();
  const session = sessions.get('r1')!;
  assert.match(session.prompts[0]!, /\[image: gone\.png, not shown: it couldn't be downloaded\]\n\[image 1: here\.png\]$/);
  assert.equal(session.images[0]!.length, 1);
  assert.deepEqual(chat.replies.map((r) => r.message), ['ok']);
  await threads.close();
});

test('images past the limit for one batch of posts are only named', async () => {
  const { chat, sessions, threads } = setup();
  const files = Array.from({ length: 10 }, (_, i) => image(`f${i}`, `${i}.png`));
  for (const file of files) chat.files.set(file.id, new Uint8Array([1]));
  threads.handle(incoming('r1', chat.add('r1', 'u1', '', files), { id: 'r1', direct: true }));
  await threads.idle();
  const session = sessions.get('r1')!;
  assert.equal(session.images[0]!.length, 8);
  assert.match(session.prompts[0]!, /\[image 8: 7\.png\]\n\[image: 8\.png, not shown: too many images at once\]\n/);
  await threads.close();
});

test("a model that doesn't take images gets their names only", async () => {
  const { chat, sessions, threads } = setup({ images: false });
  chat.files.set('f1', new Uint8Array([1]));
  threads.handle(incoming('r1', chat.add('r1', 'u1', '', [image('f1', 'garage.png')]), { id: 'r1', direct: true }));
  await threads.idle();
  assert.equal(chat.downloads.length, 0);
  assert.match(sessions.get('r1')!.prompts[0]!, /: \[file: garage\.png \(image\/png\), which you can't open\]$/);
  await threads.close();
});

test('posts arriving during a run are handed over together afterwards', async () => {
  let release!: () => void;
  const first = new Promise<void>((resolve) => (release = resolve));
  const { chat, sessions, threads } = setup({ answer: async (prompt) => {
    if (prompt.includes('first')) await first;
    return 'ok';
  } });
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'first'), { id: 'r1', direct: true }));
  await new Promise((resolve) => setImmediate(resolve));
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'second')));
  threads.handle(incoming('r1', chat.add('r1', 'u2', 'third')));
  release();
  await threads.idle();

  const { prompts } = sessions.get('r1')!;
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /second\n\n@guest .*third$/);
  await threads.close();
});

test('a thread has tools only while everyone who has posted in it is on the allowlist', async () => {
  const { chat, sessions, threads } = setup();
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'lights on'), { id: 'r1', direct: true }));
  await threads.idle();
  threads.handle(incoming('r1', chat.add('r1', 'u2', 'lights off')));
  await threads.idle();
  // An allowed user's post doesn't bring them back: the guest's request is still in the context.
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'ok, do it')));
  await threads.idle();
  assert.deepEqual(sessions.get('r1')!.allowed, [true, false, false]);
  await threads.close();
});

test('a deleted post still keeps tools off in its thread', async () => {
  const { chat, sessions, threads } = setup();
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'lights on'), { id: 'r1', direct: true }));
  await threads.idle();
  threads.handle(incoming('r1', chat.add('r1', 'u2', 'lights off')));
  await threads.idle();
  chat.posts.get('r1')!.splice(1, 1);
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'ok, do it')));
  await threads.idle();
  assert.deepEqual(sessions.get('r1')!.allowed, [true, false, false]);
  await threads.close();
});

test('posts from before the bot was mentioned count too', async () => {
  const { chat, sessions, threads } = setup();
  chat.add('r1', 'u2', 'turn everything off');
  threads.handle(incoming('r1', chat.add('r1', 'u1', '@sailor go ahead'), { mentioned: true }));
  await threads.idle();
  assert.deepEqual(sessions.get('r1')!.allowed, [false]);
  await threads.close();
});

test("an author who can't be looked up any more turns tools off, and the thread still gets answers", async () => {
  const { chat, sessions, threads } = setup({ allowlist: ['maciej', 'carol'] });
  threads.handle(incoming('r1', chat.add('r1', 'u3', 'lights on'), { id: 'r1', direct: true }));
  await threads.idle();
  chat.gone.add('u3');
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'and the heating')));
  await threads.idle();
  assert.deepEqual(sessions.get('r1')!.allowed, [true, false]);
  assert.deepEqual(chat.replies.map((r) => r.message), ['ok', 'ok']);
  await threads.close();
});

test("a post whose author can't be looked up any more is answered by id, not retried forever", async () => {
  const { chat, sessions, threads } = setup();
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'hi'), { id: 'r1', direct: true }));
  await threads.idle();

  chat.gone.add('u2');
  threads.handle(incoming('r1', chat.add('r1', 'u2', 'and the heating?')));
  await threads.idle();

  // Answered, not failed and retried on every later post; tools off, as #allowTools says.
  assert.deepEqual(chat.replies.map((r) => r.message), ['ok', 'ok']);
  assert.deepEqual(sessions.get('r1')!.allowed, [true, false]);
  assert.match(sessions.get('r1')!.prompts[1]!, /^@u2 \(.+\): and the heating\?$/);
  await threads.close();
});

test("a thread has only the tools everyone who has posted in it may use", async () => {
  const { chat, sessions, threads } = setup({
    allowlist: { maciej: '*', carol: ['websearch', 'mcp__parcels__*'], guest: 'mcp__parcels__add_observations' },
  });
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'hi'), { id: 'r1', direct: true }));
  await threads.idle();
  threads.handle(incoming('r1', chat.add('r1', 'u3', 'what is new?')));
  await threads.idle();
  threads.handle(incoming('r1', chat.add('r1', 'u2', 'parcel shipped')));
  await threads.idle();
  // Their tools don't come back with a post from someone who has more.
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'and the lights')));
  await threads.idle();
  assert.deepEqual(sessions.get('r1')!.tools, [
    TOOLS,
    ['websearch', 'mcp__parcels__add_observations', 'mcp__parcels__read_graph'],
    ['mcp__parcels__add_observations'],
    ['mcp__parcels__add_observations'],
  ]);
  await threads.close();
});

test('a user with no tools in the allowlist turns them all off', async () => {
  const { chat, sessions, threads } = setup({ allowlist: { maciej: '*', guest: [] } });
  threads.handle(incoming('r1', chat.add('r1', 'u2', 'hi'), { id: 'r1', direct: true }));
  await threads.idle();
  assert.deepEqual(sessions.get('r1')!.tools, [[]]);
  await threads.close();
});

test('without an allowlist everyone may use tools', async () => {
  const { chat, sessions, threads } = setup({ allowlist: null });
  threads.handle(incoming('r1', chat.add('r1', 'u2', 'search this'), { id: 'r1', direct: true }));
  await threads.idle();
  assert.deepEqual(sessions.get('r1')!.allowed, [true]);
  await threads.close();
});

test('a failed run is reported in the thread', async () => {
  const { chat, threads } = setup({ answer: () => {
    throw new Error('rate limited');
  } });
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'hi'), { id: 'r1', direct: true }));
  await threads.idle();
  assert.deepEqual(chat.replies.map((r) => r.message), ["Sorry, I couldn't finish: rate limited"]);
  await threads.close();
});

test('a run that adds no answer says so', async (t) => {
  const { chat, threads } = setup({ answer: (prompt) => (prompt.includes('first') ? 'ok' : { stop: 'no answer' }) });
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'first'), { id: 'r1', direct: true }));
  await threads.idle();
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'second')));
  t.mock.method(console, 'warn', () => {});
  await threads.idle();
  assert.deepEqual(chat.replies.map((r) => r.message), ['ok', "Sorry, I couldn't come up with an answer."]);
  await threads.close();
});

test('an answer cut off at the output limit says so', async () => {
  const { chat, threads } = setup({ answer: (prompt) => ({ stop: 'cut off', text: prompt.includes('long') ? 'Part of it' : '' }) });
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'a long answer'), { id: 'r1', direct: true }));
  await threads.idle();
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'all reasoning')));
  await threads.idle();
  assert.deepEqual(chat.replies.map((r) => r.message), [
    'Part of it\n\n_(Cut off at the output limit.)_',
    "Sorry, I couldn't finish: I reached the output limit.",
  ]);
  await threads.close();
});

test('a scheduled job that comes due is run, and its answer posted to the thread', async () => {
  const { chat, sessions, threads } = setup({ answer: (prompt) => (prompt.startsWith('Scheduled') ? 'The garage is closed.' : 'ok') });
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'check the garage at 6'), { id: 'r1', direct: true }));
  await threads.idle();

  const session = sessions.get('r1')!;
  session.onScheduled!({ id: 'j1', prompt: 'Check the garage' });
  await threads.idle();
  assert.match(session.prompts[1]!, /^Scheduled job j1 is due \(\d{4}-\d\d-\d\d \d\d:\d\d .+\): Check the garage$/);
  assert.deepEqual(session.allowed, [true, true]);
  assert.deepEqual(chat.replies.at(-1), { channelId: 'c1', rootId: 'r1', message: 'The garage is closed.' });
  await threads.close();
});

test('a scheduled job gets no tools once someone not on the allowlist has posted', async () => {
  const { chat, sessions, threads } = setup();
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'check the garage at 6'), { id: 'r1', direct: true }));
  await threads.idle();
  threads.handle(incoming('r1', chat.add('r1', 'u2', 'and open it')));
  await threads.idle();

  const session = sessions.get('r1')!;
  session.onScheduled!({ id: 'j1', prompt: 'Check the garage' });
  await threads.idle();
  assert.deepEqual(session.allowed, [true, false, false]);
  await threads.close();
});

test('closing lets the current run finish, then closes the session and takes no more posts', async () => {
  let release!: () => void;
  const first = new Promise<void>((resolve) => (release = resolve));
  const { chat, sessions, threads } = setup({ answer: async (prompt) => {
    if (prompt.includes('first')) await first;
    return 'ok';
  } });
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'first'), { id: 'r1', direct: true }));
  await new Promise((resolve) => setImmediate(resolve));
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'second')));
  const closed = threads.close();
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'third')));
  const session = sessions.get('r1')!;
  assert.equal(session.closed, false);
  release();
  await closed;

  assert.equal(session.prompts.length, 1);
  assert.deepEqual(chat.replies.map((r) => r.message), ['ok']);
  assert.equal(session.closed, true);
  // Not reopened, which would leave a session nothing closes.
  assert.equal(sessions.get('r1'), session);
});

test('a job that comes due during a run waits for it, and for posts that came in meanwhile', async () => {
  let release!: () => void;
  const first = new Promise<void>((resolve) => (release = resolve));
  const { chat, sessions, threads } = setup({ answer: async (prompt) => {
    if (prompt.includes('first')) await first;
    return 'ok';
  } });
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'first'), { id: 'r1', direct: true }));
  await new Promise((resolve) => setImmediate(resolve));
  sessions.get('r1')!.onScheduled!({ id: 'j1', prompt: 'Report' });
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'second')));
  release();
  await threads.idle();

  const { prompts } = sessions.get('r1')!;
  assert.equal(prompts.length, 3);
  assert.match(prompts[1]!, /second$/);
  assert.match(prompts[2]!, /^Scheduled job j1 is due .*: Report$/);
  assert.equal(chat.replies.length, 3);
  await threads.close();
});

test('a thread stays open while its session has scheduled jobs pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { chat, sessions, threads } = setup();
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'remind me in 2 hours'), { id: 'r1', direct: true }));
  await threads.idle();
  const session = sessions.get('r1')!;

  session.pendingJobs = true;
  t.mock.timers.tick(60_000);
  assert.equal(session.closed, false);
  session.pendingJobs = false;
  t.mock.timers.tick(60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.closed, true);
  await threads.close();
});

test('a thread that idled closes its session before a new post opens it again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish!: () => void;
  const closing = new Promise<void>((resolve) => (finish = resolve));
  const { chat, events, threads } = setup({ closing: () => closing });
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'hi'), { id: 'r1', direct: true }));
  await threads.idle();
  t.mock.timers.tick(60_000);

  // Both sessions would write to the thread's file.
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'again')));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['open r1', 'closing r1']);
  finish();
  await threads.idle();
  assert.deepEqual(events, ['open r1', 'closing r1', 'closed r1', 'open r1']);
  assert.deepEqual(chat.replies.map((r) => r.message), ['ok', 'ok']);
  await threads.close();
});

const FOX = { type: 'image' as const, mimeType: 'image/png', data: Buffer.from('fox').toString('base64') };
const OWL = { type: 'image' as const, mimeType: 'image/webp', data: Buffer.from('owl').toString('base64') };

/** Keeps `image` in the thread's store, as generate_image does, and attaches it to the reply. */
async function generate(session: FakeSession, image: ImageContent): Promise<string> {
  const name = await session.imageStore.save('image', image);
  session.imageStore.attach(name);
  return name;
}

test("images the agent generates are posted with the run's reply, decoded", async () => {
  const { chat, sessions, threads } = setup({ answer: async (prompt) => {
    if (prompt.includes('thanks')) return 'ok';
    assert.equal(await generate(sessions.get('r1')!, FOX), 'image.png');
    assert.equal(await generate(sessions.get('r1')!, OWL), 'image.webp');
    return 'A fox and an owl.';
  } });
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'draw a fox and an owl'), { id: 'r1', direct: true }));
  await threads.idle();
  assert.deepEqual(chat.replies, [
    {
      channelId: 'c1',
      rootId: 'r1',
      message: 'A fox and an owl.',
      files: [
        { name: 'image.png', mimeType: 'image/png', data: Buffer.from('fox') },
        { name: 'image.webp', mimeType: 'image/webp', data: Buffer.from('owl') },
      ],
    },
  ]);

  // The next run's reply carries only its own.
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'thanks')));
  await threads.idle();
  assert.deepEqual(chat.replies[1], { channelId: 'c1', rootId: 'r1', message: 'ok' });
  await threads.close();
});

test('generated images are posted without text, and with a run that fails, named anew across the thread', async () => {
  let fail = false;
  const { chat, sessions, threads } = setup({ answer: async () => {
    await generate(sessions.get('r1')!, FOX);
    if (fail) throw new Error('rate limited');
    return '';
  } });
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'draw a fox'), { id: 'r1', direct: true }));
  await threads.idle();
  fail = true;
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'again')));
  await threads.idle();
  assert.deepEqual(
    chat.replies.map((r) => [r.message, r.files?.map((f) => f.name)]),
    [
      ['', ['image.png']],
      ["Sorry, I couldn't finish: rate limited", ['image-2.png']],
    ],
  );
  await threads.close();
});

// A root post's id is its thread's: incoming() gives p0 no root id.
// A root post's id is its thread's: incoming() gives p0 no root id.
test('the post that starts a thread picks its model with a trailing /provider/model, taken off it', async () => {
  const { chat, sessions, threads } = setup({ pickModel: true });
  threads.handle(incoming('p0', chat.add('p0', 'u1', 'draw a lighthouse /anthropic/claude-opus-5-5:high'), { direct: true }));
  await threads.idle();
  const session = sessions.get('p0')!;
  assert.deepEqual(session.model, { provider: 'anthropic', model: 'claude-opus-5-5', thinkingLevel: 'high' });
  assert.match(session.prompts[0]!, /: draw a lighthouse$/);

  // Later posts can't change it, and keep the word.
  threads.handle(incoming('p0', chat.add('p0', 'u1', 'again /local/qwen')));
  await threads.idle();
  assert.equal(sessions.get('p0'), session);
  assert.match(session.prompts[1]!, /: again \/local\/qwen$/);
  await threads.close();
});

test('in a thread the bot is brought into, the post that mentions it picks the model', async () => {
  const { chat, sessions, threads } = setup({ pickModel: true });
  chat.add('r1', 'u2', 'what about /local/earlier');
  threads.handle(incoming('r1', chat.add('r1', 'u1', '@sailor check /local/qwen'), { mentioned: true }));
  await threads.idle();
  const session = sessions.get('r1')!;
  assert.deepEqual(session.model, { provider: 'local', model: 'qwen', thinkingLevel: 'off' });
  assert.match(session.prompts[0]!, /: what about \/local\/earlier\n\n.*: @sailor check$/);
  await threads.close();
});

test('a trailing word naming no provider is ordinary text, as is every word without ALLOW_PICKING_MODEL', async () => {
  const { chat, sessions, threads } = setup({ pickModel: true });
  threads.handle(incoming('r1', chat.add('r1', 'u1', "what's in /etc/hosts"), { id: 'r1', direct: true }));
  await threads.idle();
  assert.equal(sessions.get('r1')!.model, undefined);
  assert.match(sessions.get('r1')!.prompts[0]!, /: what's in \/etc\/hosts$/);
  await threads.close();

  const off = setup();
  off.threads.handle(incoming('r1', off.chat.add('r1', 'u1', 'hi /anthropic/claude-opus-5-5'), { id: 'r1', direct: true }));
  await off.threads.idle();
  assert.equal(off.sessions.get('r1')!.model, undefined);
  assert.match(off.sessions.get('r1')!.prompts[0]!, /: hi \/anthropic\/claude-opus-5-5$/);
  await off.threads.close();
});

test("a model that can't run is refused, and the next post that brings the bot in starts the thread afresh", async () => {
  const { chat, sessions, threads } = setup({ pickModel: true });
  threads.handle(incoming('p0', chat.add('p0', 'u1', 'hi /anthropic/missing'), { direct: true }));
  await threads.idle();
  assert.equal(sessions.size, 0);
  assert.equal(chat.replies[0]!.message, "Sorry, I can't run on that model: there is no model anthropic/missing");

  threads.handle(incoming('p0', chat.add('p0', 'u1', 'hi /local/qwen'), { direct: true }));
  await threads.idle();
  assert.deepEqual(sessions.get('p0')!.model, { provider: 'local', model: 'qwen', thinkingLevel: 'off' });
  assert.equal(chat.replies[1]!.message, 'ok');
  await threads.close();
});

test('with some tool taking images, posted ones are kept, and named as kept, seen or not', async () => {
  const { chat, sessions, threads } = setup({ imageTools: true });
  chat.files.set('f1', new Uint8Array([1])).set('f2', new Uint8Array([2]));
  const files = [image('f1', 'image.png'), image('f2', 'image.png'), image('f3', 'odd.heic', { mimeType: 'image/heic', hasPreview: false })];
  threads.handle(incoming('r1', chat.add('r1', 'u1', '', files), { id: 'r1', direct: true }));
  await threads.idle();
  assert.match(sessions.get('r1')!.prompts[0]!, /: \[image 1: image\.png\]\n\[image 2: image-2\.png\]\n\[image: odd\.heic, not shown: too large, or in a format you can't see\]$/);

  const blind = setup({ images: false, imageTools: true });
  blind.chat.files.set('f1', new Uint8Array([1]));
  blind.threads.handle(incoming('r1', blind.chat.add('r1', 'u1', '', [image('f1', 'garage.png')]), { id: 'r1', direct: true }));
  await blind.threads.idle();
  assert.match(blind.sessions.get('r1')!.prompts[0]!, /: \[image: garage\.png, which you can't see\]$/);
  await Promise.all([threads.close(), blind.threads.close()]);
});

test("tools get the thread's images by name, posted and generated ones, in this run or a later one", async () => {
  let got: unknown[] = [];
  const { chat, sessions, threads } = setup({ answer: async (prompt) => {
    const session = sessions.get('r1')!;
    if (prompt.includes('draw')) {
      await generate(session, FOX);
      got = await session.imageStore.get(['image.png', 'garage.png', 'scan.jpg']);
    } else {
      got = await session.imageStore.get(['image.png']);
    }
    return 'ok';
  }, imageTools: true });
  chat.files.set('f1', new Uint8Array([1])).set('f2', new Uint8Array([2]));
  const files = [image('f1', 'garage.png'), image('f2', 'scan.tiff', { mimeType: 'image/tiff' })];
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'draw on these', files), { id: 'r1', direct: true }));
  await threads.idle();
  assert.deepEqual(got, [
    FOX,
    { type: 'image', data: 'AQ==', mimeType: 'image/png' },
    // Only the server's preview of a format models don't take.
    { type: 'image', data: 'Ag==', mimeType: 'image/jpeg' },
  ]);

  threads.handle(incoming('r1', chat.add('r1', 'u1', 'darker')));
  await threads.idle();
  assert.deepEqual(got, [FOX]);
  assert.equal(chat.downloads.length, 2);
  await threads.close();
});

test("tools get nothing from outside the thread's images", async () => {
  const errors: string[] = [];
  const { chat, sessions, threads } = setup({ answer: async (prompt) => {
    if (!prompt.includes('draw')) return 'ok';
    for (const name of ['secret.png', '../../r2/images/secret.png', 'notes.pdf', '.']) {
      await sessions.get('r1')!.imageStore.get([name]).then(
        () => errors.push('none'),
        (error: Error) => errors.push(error.message),
      );
    }
    return 'ok';
  }, imageTools: true });
  chat.files.set('secret', new Uint8Array([1]));
  threads.handle(incoming('r2', chat.add('r2', 'u1', '', [image('secret', 'secret.png')]), { id: 'r2', direct: true }));
  await threads.idle();
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'draw', [{ id: 'f1', name: 'notes.pdf', mimeType: 'application/pdf', size: 10, hasPreview: false }]), { id: 'r1', direct: true }));
  await threads.idle();
  const notHere = "is not an image in this thread: give the name on an [image] line, or of an image you generated or a tool returned";
  assert.deepEqual(errors, ['secret.png', '../../r2/images/secret.png', 'notes.pdf', '.'].map((name) => `${name} ${notHere}`));
  await threads.close();
});
