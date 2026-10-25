import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebSocketMessage } from '@mattermost/client';
import { incomingPost, splitMessage } from '../src/mattermost.ts';

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

test('long messages split at paragraphs, then lines, then anywhere', () => {
  assert.deepEqual(splitMessage('short', 10), ['short']);
  assert.deepEqual(splitMessage('aaaa\n\nbbbb\n\ncccc', 9), ['aaaa', 'bbbb', 'cccc']);
  assert.deepEqual(splitMessage('aaaa\nbbbb\ncccc', 10), ['aaaa\nbbbb', 'cccc']);
  assert.deepEqual(splitMessage('a'.repeat(25), 10), ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
});
