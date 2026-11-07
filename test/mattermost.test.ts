import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import type { WebSocketMessage } from '@mattermost/client';
import type { Post } from '@mattermost/types/posts';
import { type Client, incomingPost, Mattermost, mentions, replyPosts, type Socket, splitMessage, updatedUser } from '../src/mattermost.ts';
import type { IncomingPost } from '../src/threads.ts';

function posted(post: object, data: object = {}): WebSocketMessage {
  return {
    event: 'posted',
    data: { channel_type: 'O', post: JSON.stringify(post), ...data },
    broadcast: { omit_users: {}, user_id: '', channel_id: 'c1', team_id: 't1' },
    seq: 1,
  } as unknown as WebSocketMessage;
}

test('posted events become incoming posts', () => {
  const msg = posted({ id: 'p1', root_id: 'r1', channel_id: 'c1', user_id: 'u1', type: '' }, { mentions: JSON.stringify(['bot']) });
  assert.deepEqual(incomingPost(msg, 'bot'), {
    id: 'p1',
    rootId: 'r1',
    channelId: 'c1',
    userId: 'u1',
    type: '',
    direct: false,
    mentioned: true,
  });
});

test('direct channels are marked, mentions of others are not ours', () => {
  const msg = posted({ id: 'p1', root_id: '', channel_id: 'c1', user_id: 'u1', type: '' }, { channel_type: 'D', mentions: JSON.stringify(['someone']) });
  const post = incomingPost(msg, 'bot');
  assert.equal(post?.direct, true);
  assert.equal(post?.mentioned, false);
});

test('other events are ignored', () => {
  assert.equal(incomingPost({ event: 'typing', data: {} } as unknown as WebSocketMessage, 'bot'), undefined);
});

test('user updates give the new username', () => {
  const msg = { event: 'user_updated', data: { user: { id: 'u1', username: 'alice2', email: '' } }, seq: 1 } as unknown as WebSocketMessage;
  assert.deepEqual(updatedUser(msg), { id: 'u1', username: 'alice2' });
  assert.equal(updatedUser(posted({ id: 'p1' })), undefined);
});

test('finds mentions of the bot in fetched posts, as Mattermost does', () => {
  for (const message of ['@sailor hi', 'hi @sailor', 'thanks, @Sailor.', '(@sailor)', 'hey @sailor: lights?']) {
    assert.equal(mentions(message, 'sailor'), true, message);
  }
  for (const message of ['sailor hi', '@sailors', '@sailor-bot', '@sailor.bot', 'me@sailor.dev', '@@sailor']) {
    assert.equal(mentions(message, 'sailor'), false, message);
  }
  assert.equal(mentions('@sea.bot hi', 'sea.bot'), true);
  assert.equal(mentions('@seaXbot hi', 'sea.bot'), false);
});

test('long messages split at paragraphs, then lines, then anywhere', () => {
  assert.deepEqual(splitMessage('short', 10), ['short']);
  assert.deepEqual(splitMessage('aaaa\n\nbbbb\n\ncccc', 9), ['aaaa', 'bbbb', 'cccc']);
  assert.deepEqual(splitMessage('aaaa\nbbbb\ncccc', 10), ['aaaa\nbbbb', 'cccc']);
  assert.deepEqual(splitMessage('a'.repeat(25), 10), ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
  // A break right at the limit is still a break, not the start of the next part.
  assert.deepEqual(splitMessage('aaaa\n\nbb', 4), ['aaaa', 'bb']);
  assert.deepEqual(splitMessage('aaaa\nbb', 4), ['aaaa', 'bb']);
});

test('a code block split across messages is closed and reopened', () => {
  const parts = splitMessage('Here:\n\n```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```\n\nDone.', 30);
  assert.deepEqual(parts, ['Here:', '```ts\nconst a = 1;\n```', '```ts\nconst b = 2;\n```', '```ts\nconst c = 3;\n```\n\nDone.']);
  assert.ok(parts.every((p) => p.length <= 30));
  // A closed block, and one with a longer fence.
  assert.deepEqual(splitMessage('```\na\n```\n\n~~~~\nbbbb\ncccc\n~~~~', 16), ['```\na\n```', '~~~~\nbbbb\n~~~~', '~~~~\ncccc\n~~~~']);
  // A line of code too long for a part is cut inside the block.
  assert.deepEqual(splitMessage(`intro\n\n\`\`\`json\n${'x'.repeat(30)}\n\`\`\`\n\nend`, 20), [
    'intro',
    '```json\nxxxxxxxx\n```',
    '```json\nxxxxxxxx\n```',
    '```json\nxxxxxxxx\n```',
    '```json\nxxxxxx\n```',
    'end',
  ]);
  // A block that would open empty at the end of a part starts the next one.
  assert.deepEqual(splitMessage('abc\n```ts\n' + 'y'.repeat(30) + '\n```', 20), ['abc', '```ts\nyyyyyyyyyy\n```', '```ts\nyyyyyyyyyy\n```', '```ts\nyyyyyyyyyy\n```']);
});

test('splitting keeps indentation, whitespace at hard cuts, and surrogate pairs', () => {
  assert.deepEqual(splitMessage('aaaa\n\n  bb', 8), ['aaaa', '  bb']);
  assert.deepEqual(splitMessage('abcd efgh', 5), ['abcd ', 'efgh']);
  assert.deepEqual(splitMessage('😀😀😀', 3), ['😀', '😀', '😀']);
});

test('a reply\'s files go on its first posts, and any left over on posts of their own', () => {
  assert.deepEqual(replyPosts('hi', [], 10, 2), [{ message: 'hi', file_ids: [] }]);
  assert.deepEqual(replyPosts('', ['f1'], 10, 2), [{ message: '', file_ids: ['f1'] }]);
  assert.deepEqual(replyPosts('one\n\ntwo', ['f1', 'f2', 'f3', 'f4', 'f5'], 5, 2), [
    { message: 'one', file_ids: ['f1', 'f2'] },
    { message: 'two', file_ids: ['f3', 'f4'] },
    { message: '', file_ids: ['f5'] },
  ]);
  assert.deepEqual(replyPosts('', [], 10, 2), []);
});

const LOGIN = Date.UTC(2026, 9, 25, 16);

function post(fields: Partial<Post> & { id: string; channel_id: string; create_at: number }): Post {
  return { root_id: '', user_id: 'u1', type: '', message: '', delete_at: 0, update_at: fields.create_at, metadata: {}, ...fields } as Post;
}

/**
 * A Mattermost server with teams t1 and t2, the channels `town` (t1) and `ops` (t2), and a direct
 * channel `dm`, which is listed for both teams as the server does. The bot is @sailor.
 */
function fakeServer() {
  const channels: Record<string, { id: string; type: string }[]> = {
    t1: [{ id: 'town', type: 'O' }, { id: 'dm', type: 'D' }],
    t2: [{ id: 'ops', type: 'P' }, { id: 'dm', type: 'D' }],
  };
  const posts: Post[] = [];
  const users = new Map([['u1', 'maciej']]);
  const lookups: string[] = [];
  const created: unknown[] = [];
  const byId = (list: Post[]) => Object.fromEntries(list.map((p) => [p.id, p]));
  const client = {
    getMe: async () => ({ id: 'bot', username: 'sailor' }),
    getMyTeams: async () => [{ id: 't1' }, { id: 't2' }],
    getMyChannels: async (teamId: string) => channels[teamId],
    // Edited posts come too, as they do from the server.
    getPostsSince: async (channelId: string, since: number) => ({ posts: byId(posts.filter((p) => p.channel_id === channelId && p.update_at >= since)) }),
    getPaginatedPostThread: async (rootId: string) => ({ posts: byId(posts.filter((p) => p.id === rootId || p.root_id === rootId)), has_next: false }),
    async getUser(userId: string) {
      lookups.push(userId);
      const username = users.get(userId);
      if (!username) throw new Error(`no user ${userId}`);
      return { id: userId, username };
    },
    getFileRoute: (fileId: string) => `http://mm.local/api/v4/files/${fileId}`,
    async uploadFile(form: FormData) {
      const file = form.get('files') as File;
      if (file.name.startsWith('bad')) throw new Error('too large');
      return { file_infos: [{ id: `f-${file.name}` }] };
    },
    createPost: async (p: unknown) => void created.push(p),
  };
  const listeners: Record<string, (arg?: unknown) => void> = {};
  let initialized: unknown;
  const ws = {
    addMessageListener: (l: (msg: unknown) => void) => void (listeners.message = l),
    addMissedMessageListener: (l: () => void) => void (listeners.missed = l),
    addFirstConnectListener: (l: () => void) => void (listeners.connected = l),
    addReconnectListener: (l: () => void) => void (listeners.reconnected = l),
    addCloseListener: (l: () => void) => void (listeners.closed = l),
    initialize: (url: string, token: string) => void (initialized = { url, token }),
    close() {},
    userTyping() {},
  };
  return { posts, users, lookups, created, listeners, initialized: () => initialized, client: client as unknown as Client, ws: ws as unknown as Socket };
}

/** Logged in to `server`, listening, with what it delivered. */
async function listening(t: TestContext, server = fakeServer()) {
  t.mock.method(console, 'log', () => {});
  const mattermost = await Mattermost.connect('http://mm.local', 'tok', { client: server.client, ws: server.ws });
  const delivered: IncomingPost[] = [];
  mattermost.listen((p) => delivered.push(p));
  return { mattermost, server, delivered };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('connects as the bot, and its WebSocket to the same server', async (t) => {
  const { mattermost, server } = await listening(t);
  assert.deepEqual([mattermost.botUserId, mattermost.botUsername], ['bot', 'sailor']);
  assert.deepEqual(server.initialized(), { url: 'ws://mm.local/api/v4/websocket', token: 'tok' });
});

test('once connected, catches up on posts made since logging in, in every channel, oldest first', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: LOGIN });
  const server = fakeServer();
  server.posts.push(
    post({ id: 'mention', channel_id: 'town', create_at: LOGIN + 2_000, message: '@sailor hi' }),
    post({ id: 'direct', channel_id: 'dm', create_at: LOGIN + 1_000 }),
    // Within the margin for clock skew.
    post({ id: 'skewed', channel_id: 'ops', create_at: LOGIN - 30_000 }),
    post({ id: 'old', channel_id: 'town', create_at: LOGIN - 3_600_000 }),
    post({ id: 'edited', channel_id: 'town', create_at: LOGIN - 3_600_000, update_at: LOGIN + 500 }),
    post({ id: 'deleted', channel_id: 'town', create_at: LOGIN + 3_000, delete_at: LOGIN + 4_000 }),
  );
  const { server: s, delivered } = await listening(t, server);
  s.listeners.connected!();
  await settle();
  assert.deepEqual(
    delivered.map((p) => [p.id, p.direct, p.mentioned]),
    [
      ['skewed', false, false],
      ['direct', true, false],
      ['mention', false, true],
    ],
  );

  // Only once: a reconnect resumes the connection, and the server replays what it missed.
  s.listeners.reconnected!();
  await settle();
  assert.equal(delivered.length, 3);
});

test("when the server can't replay missed events, catches up from the last one, and looks usernames up again", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: LOGIN });
  t.mock.method(console, 'warn', () => {});
  const { mattermost, server, delivered } = await listening(t);
  server.listeners.connected!();
  await settle();
  assert.equal(await mattermost.username('u1'), 'maciej');
  assert.equal(await mattermost.username('u1'), 'maciej');
  assert.deepEqual(server.lookups, ['u1']);

  t.mock.timers.tick(600_000);
  server.listeners.message!({ event: 'typing', data: {} });
  server.posts.push(
    post({ id: 'delivered', channel_id: 'town', create_at: LOGIN + 300_000 }),
    post({ id: 'missed', channel_id: 'town', create_at: LOGIN + 605_000 }),
  );
  t.mock.timers.tick(10_000);
  server.listeners.missed!();
  await settle();
  assert.deepEqual(delivered.map((p) => p.id), ['missed']);
  await mattermost.username('u1');
  assert.deepEqual(server.lookups, ['u1', 'u1']);
});

test("a cached user's new name replaces the old one", async (t) => {
  const { mattermost, server } = await listening(t);
  await mattermost.username('u1');
  server.listeners.message!({ event: 'user_updated', data: { user: { id: 'u1', username: 'maciej2' } } });
  assert.equal(await mattermost.username('u1'), 'maciej2');
  assert.deepEqual(server.lookups, ['u1']);
});

test("a thread's posts are others', oldest first, without system or deleted ones", async (t) => {
  const { mattermost, server } = await listening(t);
  const file = { id: 'f1', name: 'garage.png', mime_type: 'image/png', size: 10, has_preview_image: true };
  server.posts.push(
    post({ id: 'later', channel_id: 'town', root_id: 'r1', create_at: 5, message: 'look', metadata: { files: [file] } as Post['metadata'] }),
    post({ id: 'r1', channel_id: 'town', create_at: 1, message: 'hi' }),
    post({ id: 'mine', channel_id: 'town', root_id: 'r1', user_id: 'bot', create_at: 2 }),
    post({ id: 'joined', channel_id: 'town', root_id: 'r1', type: 'system_join_channel', create_at: 3 }),
    post({ id: 'gone', channel_id: 'town', root_id: 'r1', create_at: 4, delete_at: 6 }),
  );
  assert.deepEqual(await mattermost.threadPosts('r1'), [
    { id: 'r1', userId: 'u1', createAt: 1, message: 'hi', files: [] },
    { id: 'later', userId: 'u1', createAt: 5, message: 'look', files: [{ id: 'f1', name: 'garage.png', mimeType: 'image/png', size: 10, hasPreview: true }] },
  ]);
});

test("a reply names the files that couldn't be uploaded, attaches the rest, and splits long text", async (t) => {
  const { mattermost, server } = await listening(t);
  t.mock.method(console, 'error', () => {});
  const file = (name: string) => ({ name, mimeType: 'image/png', data: new Uint8Array([1]) });
  assert.deepEqual(await mattermost.reply('dm', 'r1', 'Here.', [file('a.png'), file('bad.png')]), ['f-a.png', undefined]);
  assert.deepEqual(server.created, [{ channel_id: 'dm', root_id: 'r1', message: "Here.\n\n_(bad.png couldn't be attached: too large)_", file_ids: ['f-a.png'] }]);

  await mattermost.reply('dm', 'r1', `${'a'.repeat(16_000)}\n\nb`);
  assert.deepEqual(server.created.slice(1), [
    { channel_id: 'dm', root_id: 'r1', message: 'a'.repeat(16_000), file_ids: [] },
    { channel_id: 'dm', root_id: 'r1', message: 'b', file_ids: [] },
  ]);
});

test("downloads a file, or its preview, with the bot's token", async (t) => {
  const { mattermost } = await listening(t);
  const requests: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push([url, init.headers]);
    return url.includes('missing') ? new Response('', { status: 404, statusText: 'Not Found' }) : new Response(new Uint8Array([1, 2]));
  });
  assert.deepEqual(await mattermost.file('f1', true), new Uint8Array([1, 2]));
  assert.deepEqual(requests, [['http://mm.local/api/v4/files/f1/preview', { Authorization: 'Bearer tok' }]]);
  await assert.rejects(mattermost.file('missing', false), /files\/missing: 404 Not Found/);
});
