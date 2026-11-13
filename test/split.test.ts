import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitMessage } from '../src/split.ts';

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
