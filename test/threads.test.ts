import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { Agent } from '../src/agent.ts';
import type { ScheduledJob } from '../src/scheduler.ts';
import { type Chat, type IncomingPost, type ThreadPost, Threads } from '../src/threads.ts';

const BOT = 'bot';
const USERS: Record<string, string> = { u1: 'maciej', u2: 'guest', u3: 'carol' };

class FakeChat implements Chat {
  posts = new Map<string, ThreadPost[]>();
  replies: { channelId: string; rootId: string; message: string }[] = [];
  /** Posts ever added to each thread, deleted ones included. */
  #counts = new Map<string, number>();

  add(rootId: string, userId: string, message: string): ThreadPost {
    const thread = this.posts.get(rootId) ?? [];
    const n = this.#counts.get(rootId) ?? 0;
    this.#counts.set(rootId, n + 1);
    const post = { id: `p${n}`, userId, createAt: Date.UTC(2026, 9, 25, 16, n), message };
    thread.push(post);
    this.posts.set(rootId, thread);
    return post;
  }

  async threadPosts(rootId: string) {
    return [...(this.posts.get(rootId) ?? [])];
  }
  /** Users whose lookups fail, as for one deleted since. */
  gone = new Set<string>();

  async username(userId: string) {
    if (this.gone.has(userId)) throw new Error(`no user ${userId}`);
    return USERS[userId] ?? userId;
  }
  async reply(channelId: string, rootId: string, message: string) {
    this.replies.push({ channelId, rootId, message });
  }
  typing() {}
}

type Reply = string | { text: string; stopReason: string } | null;
type Answer = (prompt: string) => Promise<Reply> | Reply;

interface FakeSession {
  prompts: string[];
  allowed: boolean[];
  entries: unknown[];
  onScheduled: ((job: ScheduledJob) => void) | undefined;
  closed: boolean;
}

/**
 * An agent whose sessions answer each prompt with `answer(prompt)`, fail when it throws, and add no
 * message for `null`. An answer may give its stop reason.
 */
function fakeAgent(answer: Answer = () => 'ok') {
  const sessions = new Map<string, FakeSession>();
  const agent: Agent = {
    hasSession: (rootId) => sessions.has(rootId),
    async openSession(rootId, { allowTools, onScheduled }) {
      const entries: unknown[] = [];
      const record: FakeSession = { prompts: [], allowed: [], entries, onScheduled, closed: false };
      sessions.set(rootId, record);
      const messages: unknown[] = [];
      const session = {
        sessionManager: {
          getEntries: () => entries,
          appendCustomEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data }),
        },
        messages,
        async prompt(text: string) {
          record.prompts.push(text);
          record.allowed.push(allowTools('websearch'));
          try {
            const timestamp = Date.now();
            const reply = await answer(text);
            const { text: answered, stopReason } = typeof reply === 'string' ? { text: reply, stopReason: 'stop' } : (reply ?? {});
            if (reply !== null) messages.push({ role: 'assistant', stopReason, timestamp, content: [{ type: 'text', text: answered }] });
          } catch (error) {
            messages.push({ role: 'assistant', stopReason: 'error', timestamp: Date.now(), errorMessage: (error as Error).message, content: [] });
          }
        },
        dispose: () => (record.closed = true),
      };
      return session as unknown as AgentSession;
    },
    async closeSession(session) {
      session.dispose();
    },
  };
  return { agent, sessions };
}

/** `null` leaves out the allowlist. */
function setup(answer?: Answer, allowlist: string[] | null = ['maciej']) {
  const chat = new FakeChat();
  const { agent, sessions } = fakeAgent(answer);
  const threads = new Threads(agent, chat, { botUserId: BOT, allowedUsers: allowlist ? new Set(allowlist) : undefined, idleMs: 60_000 });
  return { chat, sessions, threads };
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
  assert.match(prompts[0]!, /^@maciej \(\d{4}-\d\d-\d\d \d\d:\d\d GMT[+-−]?\d*\): @sailor lights\?$/);
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

test('posts arriving during a run are handed over together afterwards', async () => {
  let release!: () => void;
  const first = new Promise<void>((resolve) => (release = resolve));
  const { chat, sessions, threads } = setup(async (prompt) => {
    if (prompt.includes('first')) await first;
    return 'ok';
  });
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
  const { chat, sessions, threads } = setup(undefined, ['maciej', 'carol']);
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
  const { chat, sessions, threads } = setup(undefined, ['maciej']);
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'hi'), { id: 'r1', direct: true }));
  await threads.idle();

  chat.gone.add('u2');
  threads.handle(incoming('r1', chat.add('r1', 'u2', 'and the heating?')));
  await threads.idle();

  // Answered, not failed and retried on every later post; tools off, as #mayUseTools says.
  assert.deepEqual(chat.replies.map((r) => r.message), ['ok', 'ok']);
  assert.deepEqual(sessions.get('r1')!.allowed, [true, false]);
  assert.match(sessions.get('r1')!.prompts[1]!, /^@u2 \(.+\): and the heating\?$/);
  await threads.close();
});

test('without an allowlist everyone may use tools', async () => {
  const { chat, sessions, threads } = setup(undefined, null);
  threads.handle(incoming('r1', chat.add('r1', 'u2', 'search this'), { id: 'r1', direct: true }));
  await threads.idle();
  assert.deepEqual(sessions.get('r1')!.allowed, [true]);
  await threads.close();
});

test('a failed run is reported in the thread', async () => {
  const { chat, threads } = setup(() => {
    throw new Error('rate limited');
  });
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'hi'), { id: 'r1', direct: true }));
  await threads.idle();
  assert.deepEqual(chat.replies.map((r) => r.message), ["Sorry, I couldn't finish: rate limited"]);
  await threads.close();
});

test("a run that adds no answer says so, and doesn't post the previous one again", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 25, 16) });
  const { chat, threads } = setup((prompt) => (prompt.includes('first') ? 'ok' : null));
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'first'), { id: 'r1', direct: true }));
  await threads.idle();
  t.mock.timers.tick(1_000);
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'second')));
  t.mock.method(console, 'warn', () => {});
  await threads.idle();
  assert.deepEqual(chat.replies.map((r) => r.message), ['ok', "Sorry, I couldn't come up with an answer."]);
  await threads.close();
});

test('an answer cut off at the output limit says so', async () => {
  const { chat, threads } = setup((prompt) => ({ text: prompt.includes('long') ? 'Part of it' : '', stopReason: 'length' }));
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
  const { chat, sessions, threads } = setup((prompt) => (prompt.startsWith('Scheduled') ? 'The garage is closed.' : 'ok'));
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
  const { chat, sessions, threads } = setup(async (prompt) => {
    if (prompt.includes('first')) await first;
    return 'ok';
  });
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
  const { chat, sessions, threads } = setup(async (prompt) => {
    if (prompt.includes('first')) await first;
    return 'ok';
  });
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
  const snapshot = (status: string) => ({
    type: 'custom',
    customType: 'scheduler',
    data: { timers: [{ id: 'j1', prompt: 'Remind', status, expiresAt: Date.now() + 2 * 3_600_000 }] },
  });

  session.entries.push(snapshot('active'));
  t.mock.timers.tick(60_000);
  assert.equal(session.closed, false);
  session.entries.push(snapshot('cancelled'));
  t.mock.timers.tick(60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.closed, true);
  await threads.close();
});
