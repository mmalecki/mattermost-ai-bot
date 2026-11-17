import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orientation } from '../src/orientation.ts';
import { exifOrientation, orientedJpeg } from './fakes.ts';

const UPRIGHT = { transpose: false, flipX: false, flipY: false };
/** A JPEG's first marker, and the start of its image data, with none. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]);

/** A WebP's container, with `chunks`, each a name and its data. */
function webp(...chunks: [string, Buffer][]): Buffer {
  const body = Buffer.concat(
    chunks.flatMap(([name, data]) => {
      const size = Buffer.alloc(4);
      size.writeUInt32LE(data.length);
      return [Buffer.from(name, 'latin1'), size, data, Buffer.alloc(data.length % 2)];
    }),
  );
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length + 4);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), size, Buffer.from('WEBP', 'latin1'), body]);
}

test("reads a JPEG's EXIF orientation, in either byte order", () => {
  assert.deepEqual(orientation(orientedJpeg(JPEG, 1)), UPRIGHT);
  assert.deepEqual(orientation(orientedJpeg(JPEG, 3)), { transpose: false, flipX: true, flipY: true });
  assert.deepEqual(orientation(orientedJpeg(JPEG, 6)), { transpose: true, flipX: true, flipY: false });
  assert.deepEqual(orientation(orientedJpeg(JPEG, 8, false)), { transpose: true, flipX: false, flipY: true });
  // After other segments, such as JFIF's and XMP's, which is in an APP1 too.
  const others = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xe1, 0x00, 0x06, 0x68, 0x74, 0x74, 0x70]);
  assert.deepEqual(orientation(Buffer.concat([others, orientedJpeg(JPEG, 6).subarray(2)])), { transpose: true, flipX: true, flipY: false });
});

test("reads a WebP's EXIF orientation, with a JPEG's header before it or not", () => {
  const image: [string, Buffer] = ['VP8 ', Buffer.from([1, 2, 3])];
  assert.deepEqual(orientation(webp(image, ['EXIF', exifOrientation(6)])), { transpose: true, flipX: true, flipY: false });
  assert.deepEqual(orientation(webp(image, ['EXIF', Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exifOrientation(2, false)])])), { transpose: false, flipX: true, flipY: false });
  assert.deepEqual(orientation(webp(image)), UPRIGHT);
});

test('takes an image for upright when it says nothing else that can be read', () => {
  const oriented = orientedJpeg(JPEG, 6);
  assert.deepEqual(orientation(JPEG), UPRIGHT);
  // An orientation there is none of, and one in the image data, which isn't looked into.
  assert.deepEqual(orientation(orientedJpeg(JPEG, 9)), UPRIGHT);
  assert.deepEqual(orientation(Buffer.concat([JPEG, oriented.subarray(2)])), UPRIGHT);
  // Cut short anywhere before the orientation ends, a PNG, and nothing at all.
  for (let length = 0; length < 32; length++) assert.deepEqual(orientation(oriented.subarray(0, length)), UPRIGHT, `cut at ${length}`);
  assert.deepEqual(orientation(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1')), UPRIGHT);
  // In a larger buffer, as Buffer.from() gives small ones.
  assert.deepEqual(orientation(Buffer.concat([Buffer.alloc(7), oriented]).subarray(7)), { transpose: true, flipX: true, flipY: false });
});
