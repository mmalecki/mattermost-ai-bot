import type { ImageContent } from '@earendil-works/pi-ai';
import type { ThreadSession } from './agent.ts';
import type { Chat, OutgoingFile, PostFile } from './threads.ts';
import type { ImageStore } from './tools.ts';

/** The image formats models take, with the file extension each is posted under. */
const IMAGE_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const IMAGE_TYPES = new Set(Object.keys(IMAGE_EXTENSIONS));
/**
 * Larger images, and those in other formats, are handed over as the server's preview, or not at all
 * without one. pi scales them all down to the model's limits.
 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Session entry recording an image the agent generated, under its name. Not part of the model's context. */
const GENERATED_ENTRY = 'generated-image';

interface GeneratedEntry {
  name: string;
  mimeType: string;
  /** Recorded again with this once the image is posted. */
  fileId?: string;
}

/**
 * Session entry naming an image another tool returned, which stays in the session as part of its result.
 * Not part of the model's context.
 */
const FETCHED_ENTRY = 'fetched-image';

interface FetchedEntry {
  name: string;
  toolCallId: string;
  /** Among the result's images. */
  index: number;
}

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
  if (IMAGE_TYPES.has(file.mimeType) && file.size <= MAX_IMAGE_BYTES) return { preview: false, mimeType: file.mimeType };
  return file.hasPreview ? { preview: true, mimeType: 'image/jpeg' } : undefined;
}

/** A posted image, downloaded as `source` says, for a model. */
export async function download(chat: Pick<Chat, 'file'>, fileId: string, { preview, mimeType }: ImageSource): Promise<ImageContent> {
  return { type: 'image', data: Buffer.from(await chat.file(fileId, preview)).toString('base64'), mimeType };
}

/**
 * A thread's images, for generate_image: the ones it generates, posted with the run's reply, and the
 * ones it is given. Those are this run's generated ones as the image model returned them, earlier ones
 * from their posts, fetched ones from their tool results as pi stored them, and the thread's posted ones
 * by file id. Only the thread's, so a reference can't reach files in other channels.
 */
export class ThreadImages implements ImageStore {
  readonly #chat: Pick<Chat, 'file' | 'threadPosts'>;
  readonly #rootId: string;
  /** The thread's session, which is open whenever generate_image runs. */
  readonly #session: () => ThreadSession;
  /** Images generated in the current run, as the image model returned them. */
  #generated: { name: string; image: ImageContent }[] = [];

  constructor(chat: Pick<Chat, 'file' | 'threadPosts'>, rootId: string, session: () => ThreadSession) {
    this.#chat = chat;
    this.#rootId = rootId;
    this.#session = session;
  }

  /** Keeps an image the agent generated for this run's reply, under a name new to the thread. */
  add(image: ImageContent): string {
    const session = this.#session();
    const name = `image-${namedImages(session, GENERATED_ENTRY).size + 1}.${extension(image.mimeType)}`;
    session.appendEntry(GENERATED_ENTRY, { name, mimeType: image.mimeType } satisfies GeneratedEntry);
    this.#generated.push({ name, image });
    return name;
  }

  /** Names an image another tool returned, with a name new to the thread. */
  addFetched(toolCallId: string, index: number, mimeType: string): string {
    const session = this.#session();
    const name = `fetched-${namedImages(session, FETCHED_ENTRY).size + 1}.${extension(mimeType)}`;
    session.appendEntry(FETCHED_ENTRY, { name, toolCallId, index } satisfies FetchedEntry);
    return name;
  }

  async get(refs: string[]): Promise<ImageContent[]> {
    const session = this.#session();
    const generated = namedImages<GeneratedEntry>(session, GENERATED_ENTRY);
    const fetched = namedImages<FetchedEntry>(session, FETCHED_ENTRY);
    const posted = refs.some((ref) => !generated.has(ref) && !fetched.has(ref))
      ? new Map((await this.#chat.threadPosts(this.#rootId)).flatMap((p) => p.files).map((f) => [f.id, f]))
      : new Map<string, PostFile>();
    return Promise.all(
      refs.map(async (ref): Promise<ImageContent> => {
        const current = this.#generated.find((g) => g.name === ref);
        if (current) return current.image;
        const earlier = generated.get(ref);
        if (earlier) {
          if (!earlier.fileId) throw new Error(`${ref} was never posted, so it can't be used`);
          return download(this.#chat, earlier.fileId, { preview: false, mimeType: earlier.mimeType });
        }
        const result = fetched.get(ref);
        if (result) {
          const image = toolResultImage(session, result);
          if (!image) throw new Error(`${ref} is no longer in this thread's history, so it can't be used`);
          return image;
        }
        const file = posted.get(ref);
        if (!file?.mimeType.startsWith('image/')) {
          throw new Error(
            `${ref} is not an image posted in this thread: give the file id from an [image] line, or the name of an image you generated or a tool returned`,
          );
        }
        const source = imageSource(file);
        if (!source) throw new Error(`${file.name} (${ref}) is too large, or in a format that can't be used`);
        return download(this.#chat, file.id, source);
      }),
    );
  }

  /** Starts a run. Images from a run that threw were never posted, and aren't now. */
  startRun(): void {
    this.#generated = [];
  }

  /** The images this run generated, decoded, to post with its reply. */
  takeGenerated(): OutgoingFile[] {
    const files = this.#generated.map(({ name, image }) => ({ name, mimeType: image.mimeType, data: Buffer.from(image.data, 'base64') }));
    this.#generated = [];
    return files;
  }

  /** Records the file ids `files` were posted under, undefined for one that wasn't, so later runs can have them changed. */
  posted(files: OutgoingFile[], fileIds: (string | undefined)[]): void {
    const session = this.#session();
    fileIds.forEach((fileId, i) => {
      const { name, mimeType } = files[i]!;
      if (fileId) session.appendEntry(GENERATED_ENTRY, { name, mimeType, fileId } satisfies GeneratedEntry);
    });
  }
}

function extension(mimeType: string): string {
  return IMAGE_EXTENSIONS[mimeType] ?? 'png';
}

/** The images recorded in the session's `customType` entries, by name, the latest entry for each. */
function namedImages<T extends { name: string }>(session: ThreadSession, customType: string): Map<string, T> {
  const images = new Map<string, T>();
  for (const entry of session.entries()) {
    if (entry.type === 'custom' && entry.customType === customType) {
      const image = entry.data as T;
      images.set(image.name, image);
    }
  }
  return images;
}

/**
 * A fetched image, from its tool result in the session. That's pi's copy, scaled down to the model's
 * limits. Undefined when the result isn't in the session any more.
 */
function toolResultImage(session: ThreadSession, { toolCallId, index }: FetchedEntry): ImageContent | undefined {
  for (const entry of session.entries()) {
    if (entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === toolCallId) {
      return entry.message.content.filter((c): c is ImageContent => c.type === 'image')[index];
    }
  }
  return undefined;
}
