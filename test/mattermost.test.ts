import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebSocketMessage } from '@mattermost/client';
import { incomingPost, mentions, splitMessage, updatedUser } from '../src/mattermost.ts';

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
