import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { imageFiles } from '../src/images.ts';

const PNG = { type: 'image' as const, data: Buffer.from('png').toString('base64'), mimeType: 'image/png' };
const JPEG = { type: 'image' as const, data: Buffer.from('jpeg').toString('base64'), mimeType: 'image/jpeg' };

function setup() {
  const dir = join(mkdtempSync(join(tmpdir(), 'mattermost-ai-bot-')), 'images');
  return { dir, files: imageFiles(dir) };
}

test('keeps images under names new to the thread, with the extension of their type', async () => {
  const { dir, files } = setup();
  assert.equal(await files.save('garage.png', PNG), 'garage.png');
  assert.equal(await files.save('garage.png', PNG), 'garage-2.png');
  assert.equal(await files.save('garage.PNG', PNG), 'garage.PNG');
  // A preview of another format is a JPEG.
  assert.equal(await files.save('scan.tiff', JPEG), 'scan.jpg');
  assert.equal(await files.save('photo.jpeg', JPEG), 'photo.jpeg');
  assert.equal(await files.save('fetched', JPEG), 'fetched.jpg');
  assert.ok(existsSync(join(dir, 'garage-2.png')));
  assert.deepEqual(await files.get(['garage-2.png', 'scan.jpg']), [PNG, JPEG]);
});

test('names saved at the same time are each new', async () => {
  const { files } = setup();
  const names = await Promise.all(Array.from({ length: 5 }, () => files.save('image', PNG)));
  assert.deepEqual(names.sort(), ['image-2.png', 'image-3.png', 'image-4.png', 'image-5.png', 'image.png']);
});

test('keeps names to the directory', async () => {
  const { files } = setup();
  assert.equal(await files.save('../../etc/passwd.png', PNG), '_.._etc_passwd.png');
  assert.equal(await files.save('..\\up.png', PNG), '_up.png');
  assert.equal(await files.save('.hidden.png', PNG), 'hidden.png');
  assert.equal(await files.save('', PNG), 'image.png');
  assert.equal(await files.save('line\nbreak.png', PNG), 'line_break.png');
});

test('gets only images kept in the directory, by the names they were kept under', async () => {
  const { dir, files } = setup();
  await files.save('garage.png', PNG);
  writeFileSync(join(dir, 'notes.txt'), 'hi');
  assert.equal(await files.path('garage.png'), join(dir, 'garage.png'));
  for (const name of ['nope.png', 'notes.txt', '../images/garage.png', '.', '']) {
    await assert.rejects(files.get([name]), { message: `${name} is not an image in this thread: give the name on an [image] line, or of an image you generated or a tool returned` });
  }
});
