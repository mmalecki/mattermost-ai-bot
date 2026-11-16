import type { ImageContent } from '@earendil-works/pi-ai';
import type { ImageStore } from '../src/images.ts';

export const PNG = { type: 'image' as const, data: 'cG5n', mimeType: 'image/png' };

/**
 * A store that holds `stored` images, under `/images/`, and keeps those saved to it under `<name>-<n>`.
 * Like the real one, it refuses names it has no image under.
 */
export function fakeStore(stored: Record<string, ImageContent> = {}) {
  const saved: { name: string; image: ImageContent }[] = [];
  const attached: string[] = [];
  const store: ImageStore = {
    async save(name, image) {
      saved.push({ name: `${name}-${saved.length + 1}`, image });
      return saved.at(-1)!.name;
    },
    async get(names) {
      return names.map((name) => {
        if (!stored[name]) throw new Error(`no ${name}`);
        return stored[name];
      });
    },
    async path(name) {
      if (!stored[name]) throw new Error(`no ${name}`);
      return `/images/${name}`;
    },
    attach: (name) => attached.push(name),
  };
  return { store, saved, attached };
}

/** EXIF data, in TIFF format, that says only `orientation`, in either byte order. */
export function exifOrientation(orientation: number, little = true): Buffer {
  const tiff = Buffer.alloc(26);
  const u16 = (value: number, at: number) => (little ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at));
  const u32 = (value: number, at: number) => (little ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at));
  tiff.write(little ? 'II' : 'MM', 'latin1');
  u16(42, 2);
  // The directory follows the header, with one entry: the tag, a short, one of them, its value.
  u32(8, 4);
  u16(1, 8);
  u16(0x0112, 10);
  u16(3, 12);
  u32(1, 14);
  u16(orientation, 18);
  return tiff;
}

/** `jpeg` with `orientation` as its EXIF orientation, in a segment after its first marker. */
export function orientedJpeg(jpeg: Uint8Array, orientation: number, little = true): Buffer {
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exifOrientation(orientation, little)]);
  const segment = Buffer.alloc(4);
  segment.writeUInt16BE(0xffe1, 0);
  segment.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), segment, exif, jpeg.subarray(2)]);
}
