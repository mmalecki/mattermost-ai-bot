// What the agent is prompted with: a thread's new posts, with the files on them, or a due job.
import type { ImageContent } from '@earendil-works/pi-ai';
import type { ThreadSession } from './agent.ts';
import type { Chat, PostFile, ThreadPost } from './chat.ts';
import { errorMessage } from './error.ts';
import { isImageType } from './images.ts';
import type { ScheduledJob } from './scheduler.ts';
import { formatTime } from './time.ts';

/** Images handed to the agent with one batch of posts; any more are only named. */
const MAX_IMAGES = 8;
/**
 * Larger images, and those in other formats, are handed over as the server's preview, or not at all
 * without one. pi scales them all down to the model's limits.
 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/**
 * Text handed to the agent with one batch of posts, in bytes, and no more than the model's context
 * window in tokens: a token is some 4 bytes of text, so that is up to a quarter of it. Files past it
 * are cut off, or only named once it's used up.
 */
const MAX_TEXT_BYTES = 256 * 1024;
/** Larger text files are only named: they're downloaded whole, to be cut off. */
const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024;
/** Besides text/*. Files with no type, or a generic one, are taken for text if they decode as such. */
const TEXT_TYPES = /^application\/(json|xml|yaml|x-yaml|toml|sql|javascript|x-sh|x-ndjson|[\w.-]+\+(json|xml))$/;
const UNKNOWN_TYPES = new Set(['', 'application/octet-stream']);

/** `attachments` are each post's lines for its files, so a post with only a file isn't empty. */
export function formatPosts(posts: ThreadPost[], names: string[], attachments: string[][] = []): string {
  return posts
    .map((p, i) => {
      const text = [p.message, ...(attachments[i] ?? [])].filter(Boolean).join('\n');
      return `@${names[i]} (${formatTime(p.createAt)}, post ${p.id}): ${text}`;
    })
    .join('\n\n');
}

export function formatJob(job: ScheduledJob, now: number): string {
  return `Scheduled job ${job.id} is due (${formatTime(now)}): ${job.prompt}`;
}

/**
 * `message` without a trailing `/model provider/model[:thinking]` on its last line, and the ref. Only
 * a ref written so is one, so `what does /model do?` is no pick. Whether it names a model is the
 * agent's to say.
 */
export function trailingModel(message: string): { message: string; ref: string } | undefined {
  const match = /(?:^|\s)\/model[ \t]+([^\s/]\S*\/\S+)\s*$/.exec(message);
  if (!match) return undefined;
  return { message: message.slice(0, match.index).trimEnd(), ref: match[1]! };
}

type Session = Pick<ThreadSession, 'images' | 'keepsImages' | 'takesImages' | 'contextWindow'>;

/**
 * The posts' files: lines naming each, with the contents of text files, as much of them as
 * MAX_TEXT_BYTES and the model's context window let in all, and the images the model can see, in the
 * order of their lines, if it takes images. Images are kept in the thread when the session keeps
 * them, and named as they're kept. A file that can't be handed over is only named, so answering
 * doesn't fail on it. `rootId` names the thread in the log.
 */
export async function attachments(
  chat: Pick<Chat, 'file'>,
  session: Session,
  posts: ThreadPost[],
  rootId: string,
): Promise<{ lines: string[][]; images: ImageContent[] }> {
  const images: ImageContent[] = [];
  const lines: string[][] = [];
  const text = { left: Math.min(MAX_TEXT_BYTES, session.contextWindow) };
  for (const post of posts) {
    const postLines: string[] = [];
    for (const file of post.files) {
      const image = file.mimeType.startsWith('image/');
      if (image && session.keepsImages) postLines.push(await keepImage(chat, session, file, images, rootId));
      else if (mayBeText(file)) postLines.push(await readText(chat, file, text, rootId));
      else postLines.push(fileLine(file));
    }
    lines.push(postLines);
  }
  return { lines, images };
}

/**
 * Keeps the image in the session's images, and returns its line, with the name it's kept under. When
 * the model takes images, adds it to `images` too.
 */
async function keepImage(chat: Pick<Chat, 'file'>, session: Session, file: PostFile, images: ImageContent[], rootId: string): Promise<string> {
  const source = imageSource(file);
  if (!source) return `[image: ${file.name}, not shown: too large, or in a format you can't see]`;
  let image: ImageContent;
  try {
    image = { type: 'image', data: Buffer.from(await chat.file(file.id, source.preview)).toString('base64'), mimeType: source.mimeType };
  } catch (error) {
    console.warn(`Thread ${rootId}: image ${file.id} couldn't be downloaded:`, errorMessage(error));
    return `[image: ${file.name}, not shown: it couldn't be downloaded]`;
  }
  let name: string;
  try {
    name = await session.images.save(file.name, image);
  } catch (error) {
    // Such as with the disk full, or a name too long for a file's.
    console.warn(`Thread ${rootId}: image ${file.id} couldn't be saved:`, errorMessage(error));
    return `[image: ${file.name}, not shown: it couldn't be saved]`;
  }
  // The model can't see it, but tools can still take it.
  if (!session.takesImages) return `[image: ${name}, which you can't see]`;
  if (images.length >= MAX_IMAGES) return `[image: ${name}, not shown: too many images at once]`;
  images.push(image);
  return `[image ${images.length}: ${name}]`;
}

/**
 * How an image is handed over: as it is, or as the server's preview when it's too large or in a format
 * models don't take. Undefined when neither works.
 */
function imageSource(file: PostFile): { preview: boolean; mimeType: string } | undefined {
  if (isImageType(file.mimeType) && file.size <= MAX_IMAGE_BYTES) return { preview: false, mimeType: file.mimeType };
  return file.hasPreview ? { preview: true, mimeType: 'image/jpeg' } : undefined;
}

/** The file's contents, between lines naming it, taking what they use from `text.left`. */
async function readText(chat: Pick<Chat, 'file'>, file: PostFile, text: { left: number }, rootId: string): Promise<string> {
  const type = mediaType(file.mimeType);
  const name = `${file.name} (${type || 'unknown type'})`;
  if (file.size > MAX_TEXT_FILE_BYTES) return `[file: ${name}, not shown: too large]`;
  if (text.left <= 0) return `[file: ${name}, not shown: too much text at once]`;
  let bytes;
  try {
    bytes = await chat.file(file.id, false);
  } catch (error) {
    console.warn(`Thread ${rootId}: file ${file.id} couldn't be downloaded:`, errorMessage(error));
    return `[file: ${name}, not shown: it couldn't be downloaded]`;
  }
  const contents = decodeText(bytes, text.left);
  // A file of an unknown type that isn't text is one the model couldn't read anyway.
  if (contents === undefined) return UNKNOWN_TYPES.has(type) ? fileLine(file) : `[file: ${name}, not shown: it isn't text]`;
  // What's left may end before the file's first character does.
  if (!contents.bytes && bytes.length) return `[file: ${name}, not shown: too much text at once]`;
  text.left -= contents.bytes;
  const end = contents.bytes < bytes.length ? `, cut off after ${formatBytes(contents.bytes)} of ${formatBytes(bytes.length)}` : '';
  return `[file: ${name}]\n${contents.text}\n[end of file: ${file.name}${end}]`;
}

/** A type without its parameters, such as the `; charset=utf-8` Mattermost gives text. */
function mediaType(mimeType: string): string {
  return mimeType.split(';')[0]!.trim().toLowerCase();
}

function mayBeText(file: PostFile): boolean {
  const type = mediaType(file.mimeType);
  return type.startsWith('text/') || TEXT_TYPES.test(type) || UNKNOWN_TYPES.has(type);
}

/**
 * Up to `max` of `bytes` as UTF-8, cut off at the end of a line when there is one in it, with how many
 * bytes that kept. Undefined when they aren't text.
 */
export function decodeText(bytes: Uint8Array, max: number): { text: string; bytes: number } | undefined {
  let kept = bytes.subarray(0, max);
  if (kept.length < bytes.length) {
    const newline = kept.lastIndexOf(0x0a);
    if (newline >= 0) kept = kept.subarray(0, newline + 1);
  }
  if (kept.includes(0)) return undefined;
  const cut = kept.length < bytes.length;
  let text;
  try {
    // Streaming, a character split at the cut is left out instead of failing, and not counted as kept.
    text = new TextDecoder('utf-8', { fatal: true }).decode(kept, { stream: cut });
  } catch {
    return undefined;
  }
  // Uncut, the count is the file's, with any byte order mark the decoder drops.
  return { text: text.trimEnd(), bytes: cut ? Buffer.byteLength(text) : bytes.length };
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A file the model only learns the name of. */
function fileLine(file: PostFile): string {
  return `[file: ${file.name} (${file.mimeType || 'unknown type'}), which you can't open]`;
}
