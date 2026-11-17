// How a photo's pixels are turned upright, from its EXIF orientation. Cameras store a photo as the
// sensor took it and note how it was held, and pi turns the images the models see upright by it.

/**
 * How an image's stored pixels become the upright image: mirrored along the diagonal first, which
 * swaps its width and height, then left to right, then top to bottom.
 */
export interface Orientation {
  transpose: boolean;
  flipX: boolean;
  flipY: boolean;
}

const ORIENTATION_TAG = 0x0112;
/** By EXIF orientation, from 1, for an image stored upright, to 8. */
const ORIENTATIONS: Orientation[] = [
  { transpose: false, flipX: false, flipY: false },
  { transpose: false, flipX: true, flipY: false },
  { transpose: false, flipX: true, flipY: true },
  { transpose: false, flipX: false, flipY: true },
  { transpose: true, flipX: false, flipY: false },
  { transpose: true, flipX: true, flipY: false },
  { transpose: true, flipX: true, flipY: true },
  { transpose: true, flipX: false, flipY: true },
];

/**
 * The orientation of the image in `bytes`: a JPEG's or a WebP's EXIF one, which are those pi reads.
 * Upright for any other image, and for one without it, or whose EXIF data can't be read.
 */
export function orientation(bytes: Uint8Array): Orientation {
  const upright = ORIENTATIONS[0]!;
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tiff = jpegExif(view) ?? webpExif(view);
    return (tiff && ORIENTATIONS[tiffOrientation(tiff) - 1]) || upright;
  } catch {
    // Cut short, so a read went past its end.
    return upright;
  }
}

/** The EXIF data of a JPEG, in TIFF format, from the segments before its image data. */
function jpegExif(view: DataView): DataView | undefined {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return undefined;
  let at = 2;
  // Each a marker, 0xff and its kind, and a length that counts itself.
  while (at + 4 <= view.byteLength && view.getUint8(at) === 0xff) {
    const marker = view.getUint8(at + 1);
    if (marker === 0xff) {
      // Padding before a marker.
      at++;
      continue;
    }
    // The image data starts.
    if (marker === 0xda) return undefined;
    const length = view.getUint16(at + 2);
    // APP1, which XMP uses too.
    if (marker === 0xe1 && hasExifHeader(view, at + 4)) return slice(view, at + 10, at + 2 + length);
    at += 2 + length;
  }
  return undefined;
}

/** The EXIF data of a WebP, in TIFF format, from its `EXIF` chunk. */
function webpExif(view: DataView): DataView | undefined {
  const fourCC = (at: number) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  if (view.byteLength < 12 || fourCC(0) !== 'RIFF' || fourCC(8) !== 'WEBP') return undefined;
  let at = 12;
  while (at + 8 <= view.byteLength) {
    const size = view.getUint32(at + 4, true);
    const data = at + 8;
    // Some writers keep the header a JPEG has before it.
    if (fourCC(at) === 'EXIF') return slice(view, size >= 6 && hasExifHeader(view, data) ? data + 6 : data, data + size);
    // Chunks are padded to an even size.
    at = data + size + (size % 2);
  }
  return undefined;
}

/** Whether `Exif\0\0` is at `at`. */
function hasExifHeader(view: DataView, at: number): boolean {
  return view.getUint32(at) === 0x45786966 && view.getUint16(at + 4) === 0;
}

/** The EXIF orientation in `tiff`, from its first directory, or 1 without one. */
function tiffOrientation(tiff: DataView): number {
  // `II`, for Intel's byte order, or `MM`, for Motorola's.
  const little = tiff.getUint16(0) === 0x4949;
  const directory = tiff.getUint32(4, little);
  const entries = tiff.getUint16(directory, little);
  for (let i = 0; i < entries; i++) {
    // A tag, a type, a count and a value, which a short one starts.
    const entry = directory + 2 + i * 12;
    if (tiff.getUint16(entry, little) === ORIENTATION_TAG) return tiff.getUint16(entry + 8, little);
  }
  return 1;
}

/** `view` from `start` to `end`, or to its own end if that comes first. */
function slice(view: DataView, start: number, end: number): DataView {
  return new DataView(view.buffer, view.byteOffset + start, Math.min(end, view.byteLength) - start);
}
