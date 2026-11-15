import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeText } from '../src/input.ts';

test('decoding text cut off mid-character leaves the character out', () => {
  assert.deepEqual(decodeText(new TextEncoder().encode('zażółć'), 5), { text: 'zaż', bytes: 4 });
  assert.deepEqual(decodeText(new TextEncoder().encode('ż'), 1), { text: '', bytes: 0 });
});

test('decoding text cut off cuts it at the last line end, if there is one', () => {
  assert.deepEqual(decodeText(new TextEncoder().encode('a\nb'), 2), { text: 'a', bytes: 2 });
  assert.deepEqual(decodeText(new TextEncoder().encode('abc'), 2), { text: 'ab', bytes: 2 });
});

test('decoding text counts a byte order mark, and takes bytes that are not UTF-8 text for no text', () => {
  assert.deepEqual(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]), 10), { text: 'A', bytes: 4 });
  assert.equal(decodeText(new Uint8Array([0x41, 0]), 10), undefined);
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x41]), 10), undefined);
});
