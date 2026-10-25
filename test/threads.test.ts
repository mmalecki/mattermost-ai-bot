import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { Agent } from '../src/agent.ts';
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
}

/** An agent whose sessions answer each prompt with `answer(prompt)`, or fail when it throws. */
function fakeAgent(answer: (prompt: string) => Promise<string> | string = () => 'ok') {
  const sessions = new Map<string, FakeSession>();
  const agent: Agent = {
    hasSession: (rootId) => sessions.has(rootId),
    async openSession(rootId, { allowHomeAssistant }) {
      const record: FakeSession = { prompts: [], allowed: [] };
      sessions.set(rootId, record);
      const entries: unknown[] = [];
      const messages: unknown[] = [];
      const session = {
        sessionManager: {
          getEntries: () => entries,
          appendCustomEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data }),
        },
        messages,
        async prompt(text: string) {
          record.prompts.push(text);
          record.allowed.push(allowHomeAssistant());
          try {
            const reply = await answer(text);
            messages.push({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: reply }] });
          } catch (error) {
            messages.push({ role: 'assistant', stopReason: 'error', errorMessage: (error as Error).message, content: [] });
          }
        },
        dispose() {},
      };
      return session as unknown as AgentSession;
    },
  };
  return { agent, sessions };
}

function setup(answer?: (prompt: string) => Promise<string> | string) {
  const chat = new FakeChat();
  const { agent, sessions } = fakeAgent(answer);
  const threads = new Threads(agent, chat, { botUserId: BOT, allowedUsers: new Set(['maciej']), idleMs: 60_000 });
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
  threads.dispose();
});

test('a direct message starts a thread without a mention', async () => {
  const { chat, threads } = setup();
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'hi'), { id: 'r1', direct: true }));
  await threads.idle();
  assert.equal(chat.replies.length, 1);
  threads.dispose();
});

test("the bot's own posts and system posts are ignored", async () => {
  const { chat, sessions, threads } = setup();
  threads.handle(incoming('r1', chat.add('r1', BOT, 'mine'), { id: 'r1', direct: true }));
  threads.handle(incoming('r2', chat.add('r2', 'u1', 'joined'), { id: 'r2', direct: true, type: 'system_join_channel' }));
  await threads.idle();
  assert.equal(sessions.size, 0);
  threads.dispose();
});

test('follow-ups in a known thread need no mention and carry only unseen posts', async () => {
  const { chat, sessions, threads } = setup();
  threads.handle(incoming('r1', chat.add('r1', 'u1', '@sailor lights?'), { id: 'r1', mentioned: true }));
  await threads.idle();

  threads.handle(incoming('r1', chat.add('r1', 'u2', 'and the heating?')));
  await threads.idle();

  const { prompts } = sessions.get('r1')!;
  assert.equal(prompts.length, 2);
  assert.match(prompts[0]!, /^@maciej \(.+\): @sailor lights\?$/);
  assert.match(prompts[1]!, /^@guest \(.+\): and the heating\?$/);
  assert.equal(chat.replies.length, 2);
  threads.dispose();
});

test('a mention mid-thread hands the agent the whole thread so far', async () => {
  const { chat, sessions, threads } = setup();
  chat.add('r1', 'u1', 'is the garage open?');
  chat.add('r1', 'u2', 'no idea');
  threads.handle(incoming('r1', chat.add('r1', 'u1', '@sailor can you check?'), { mentioned: true }));
  await threads.idle();
  assert.equal(sessions.get('r1')!.prompts[0]!.split('\n\n').length, 3);
  threads.dispose();
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
  threads.dispose();
});

test('Home Assistant is allowed only when every author is on the allowlist', async () => {
  const { chat, sessions, threads } = setup();
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'lights on'), { id: 'r1', direct: true }));
  await threads.idle();
  threads.handle(incoming('r1', chat.add('r1', 'u2', 'lights off')));
  await threads.idle();
  assert.deepEqual(sessions.get('r1')!.allowed, [true, false]);
  threads.dispose();
});

test('a failed run is reported in the thread', async () => {
  const { chat, threads } = setup(() => {
    throw new Error('rate limited');
  });
  threads.handle(incoming('r1', chat.add('r1', 'u1', 'hi'), { id: 'r1', direct: true }));
  await threads.idle();
  assert.deepEqual(chat.replies.map((r) => r.message), ["Sorry, I couldn't finish: rate limited"]);
  threads.dispose();
});
