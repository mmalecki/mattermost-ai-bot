import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { Chat, OutgoingFile, PostFile } from './threads.ts';

/** The image formats models take, with the file extension each is kept under. */
const IMAGE_EXTENSIONS: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
/** The formats, by file extension, of the images kept. */
const IMAGE_TYPES: Record<string, string> = { ...Object.fromEntries(Object.entries(IMAGE_EXTENSIONS).map(([type, extension]) => [extension, type])), '.jpeg': 'image/jpeg' };
/**
 * Larger images, and those in other formats, are handed over as the server's preview, or not at all
 * without one. pi scales them all down to the model's limits.
 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** How a posted image is downloaded: as it is, or as the server's preview of it. */
export interface ImageSource {
  preview: boolean;
  mimeType: string;
}

/**
 * How an image is handed over: as it is, or as the server's preview when it's too large or in a format
 * models don't take. Undefined when neither works.
 */
export function imageSource(file: PostFile): ImageSource | undefined {
  if (IMAGE_EXTENSIONS[file.mimeType] && file.size <= MAX_IMAGE_BYTES) return { preview: false, mimeType: file.mimeType };
  return file.hasPreview ? { preview: true, mimeType: 'image/jpeg' } : undefined;
}

/** A posted image, downloaded as `source` says, for a model. */
export async function download(chat: Pick<Chat, 'file'>, fileId: string, { preview, mimeType }: ImageSource): Promise<ImageContent> {
  return { type: 'image', data: Buffer.from(await chat.file(fileId, preview)).toString('base64'), mimeType };
}

/** A thread's images, as files in its directory, by name: the names the agent sees and passes to tools. */
export interface ImageFiles {
  /**
   * Keeps `image` under `name`, with the extension of its type, or under a name made from it that is
   * new to the thread. Returns the name it's kept under.
   */
  save(name: string, image: ImageContent): Promise<string>;
  /** The images `names` name, in order. Throws for a name the thread has no image under, naming it. */
  get(names: string[]): Promise<ImageContent[]>;
  /** Where the image `name` names is kept. Throws, as get() does, for a name the thread has no image under. */
  path(name: string): Promise<string>;
}

/** The thread's images, for the tools that make and take them. */
export interface ImageStore extends ImageFiles {
  /** Attaches the image `name` names, one kept in the thread, to the reply. */
  attach(name: string): void;
}

/** The images kept in `dir`, which is created once one is. */
export function imageFiles(dir: string): ImageFiles {
  const path = async (name: string) => {
    const file = join(dir, name);
    // Only names save() could have given, so a name can't reach outside the directory.
    const ok = name === safeName(name) && IMAGE_TYPES[extname(name).toLowerCase()];
    if (!ok || !(await isFile(file))) {
      throw new Error(`${name} is not an image in this thread: give the name on an [image] line, or of an image you generated or a tool returned`);
    }
    return file;
  };
  return {
    async save(name, image) {
      await mkdir(dir, { recursive: true });
      const { stem, extension } = splitName(safeName(name), image.mimeType);
      const data = Buffer.from(image.data, 'base64');
      for (let n = 1; ; n++) {
        const kept = `${n === 1 ? stem : `${stem}-${n}`}${extension}`;
        try {
          // `wx` fails for a name taken, by an earlier image or one saved at the same time.
          await writeFile(join(dir, kept), data, { flag: 'wx' });
          return kept;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
    },
    get: (names) =>
      Promise.all(
        names.map(async (name): Promise<ImageContent> => {
          const data = await readFile(await path(name));
          return { type: 'image', data: data.toString('base64'), mimeType: IMAGE_TYPES[extname(name).toLowerCase()]! };
        }),
      ),
    path,
  };
}

/**
 * A thread's images, for the tools that make and take them, kept in `files`. Images can be attached to
 * the run's reply, which posts them.
 */
export class ThreadImages implements ImageStore {
  readonly #files: ImageFiles;
  /** Names of the images attached to the current run's reply. */
  #attached: string[] = [];

  constructor(files: ImageFiles) {
    this.#files = files;
  }

  save(name: string, image: ImageContent): Promise<string> {
    return this.#files.save(name, image);
  }

  get(names: string[]): Promise<ImageContent[]> {
    return this.#files.get(names);
  }

  path(name: string): Promise<string> {
    return this.#files.path(name);
  }

  attach(name: string): void {
    this.#attached.push(name);
  }

  /** Starts a run. Images attached in a run that threw were never posted, and aren't now. */
  startRun(): void {
    this.#attached = [];
  }

  /** The images attached in this run, read back, to post with its reply. */
  async takeAttached(): Promise<OutgoingFile[]> {
    const names = this.#attached;
    this.#attached = [];
    const images = await this.#files.get(names);
    return images.map(({ mimeType, data }, i) => ({ name: names[i]!, mimeType, data: Buffer.from(data, 'base64') }));
  }
}

/**
 * `name` as a file name: no directories, control characters or leading dots, and not empty. Kept
 * otherwise, so the agent sees the name it was posted under.
 */
function safeName(name: string): string {
  const safe = name
    .replace(/[/\\\p{Cc}]/gu, '_')
    .replace(/^[.\s]+/, '')
    .trim();
  return safe || 'image';
}

/** `name`'s stem, and the extension of `mimeType`, which replaces `name`'s own unless it's one for the type. */
function splitName(name: string, mimeType: string): { stem: string; extension: string } {
  const own = extname(name);
  const extension = IMAGE_TYPES[own.toLowerCase()] === mimeType ? own : (IMAGE_EXTENSIONS[mimeType] ?? '.png');
  return { stem: (own ? name.slice(0, -own.length) : name) || 'image', extension };
}

async function isFile(file: string): Promise<boolean> {
  return stat(file).then(
    (s) => s.isFile(),
    () => false,
  );
}
