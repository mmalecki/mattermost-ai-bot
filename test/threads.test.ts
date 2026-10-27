import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { Agent } from '../src/agent.ts';
import type { ScheduledJob } from '../src/scheduler.ts';
import { type Chat, type IncomingPost, type ThreadPost, Threads } from '../src/threads.ts';

const BOT = 'bot';
const USERS: Record<string, string> = { u1: 'maciej', u2: 'guest' };

class FakeChat implements Chat {
  posts = new Map<string, ThreadPost[]>();
  replies: { channelId: string; rootId: string; message: string }[] = [];

  add(rootId: string, userId: string, message: string): ThreadPost {
    const thread = this.posts.get(rootId) ?? [];
    const post = { id: `p${thread.length}`, userId, createAt: Date.UTC(2026, 9, 25, 16, thread.length), message };
    thread.push(post);
    this.posts.set(rootId, thread);
    return post;
  }

  async threadPosts(rootId: string) {
    return [...(this.posts.get(rootId) ?? [])];
  }
  async username(userId: string) {
    return USERS[userId] ?? userId;
  }
  async reply(channelId: string, rootId: string, message: string) {
    this.replies.push({ channelId, rootId, message });
  }
  typing() {}
}

interface FakeSession {
  prompts: string[];
  allowed: boolean[];
  entries: unknown[];
  onScheduled: ((job: ScheduledJob) => void) | undefined;
  closed: boolean;
}

/** An agent whose sessions answer each prompt with `answer(prompt)`, or fail when it throws. */
function fakeAgent(answer: (prompt: string) => Promise<string> | string = () => 'ok') {
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
            const reply = await answer(text);
            messages.push({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: reply }] });
          } catch (error) {
            messages.push({ role: 'assistant', stopReason: 'error', errorMessage: (error as Error).message, content: [] });
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
function setup(answer?: (prompt: string) => Promise<string> | string, allowlist: string[] | null = ['maciej']) {
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

test('tools are allowed only when every author is on the allowlist', async () => {
  const { chat, sessions, threads } = setup();
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'lights on'), { id: 'r1', direct: true }));
  await threads.idle();
  threads.handle(incoming('r1', chat.add('r1', 'u2', 'lights off')));
  await threads.idle();
  assert.deepEqual(sessions.get('r1')!.allowed, [true, false]);
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

test('a scheduled job that comes due is run with tools, and its answer posted to the thread', async () => {
  const { chat, sessions, threads } = setup((prompt) => (prompt.startsWith('Scheduled') ? 'The garage is closed.' : 'ok'));
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'check the garage at 6'), { id: 'r1', direct: true }));
  await threads.idle();
  threads.handle(incoming('r1', chat.add('r1', 'u2', 'thanks')));
  await threads.idle();

  const session = sessions.get('r1')!;
  session.onScheduled!({ id: 'j1', prompt: 'Check the garage' });
  await threads.idle();
  assert.match(session.prompts[2]!, /^Scheduled job j1 is due \(\d{4}-\d\d-\d\d \d\d:\d\d .+\): Check the garage$/);
  // Only a run allowed tools could have scheduled it, whoever posted last.
  assert.deepEqual(session.allowed, [true, false, true]);
  assert.deepEqual(chat.replies.at(-1), { channelId: 'c1', rootId: 'r1', message: 'The garage is closed.' });
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
