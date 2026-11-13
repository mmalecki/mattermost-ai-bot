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
 * `message` without its last word, when that is `/provider/model[:thinking]`, and the word without
 * its slash. Whether it names a model is the agent's to say.
 */
export function trailingModel(message: string): { message: string; ref: string } | undefined {
  const match = /(?:^|\s)\/(\S+\/\S+)\s*$/.exec(message);
  if (!match) return undefined;
  return { message: message.slice(0, match.index).trimEnd(), ref: match[1]! };
}

type Session = Pick<ThreadSession, 'images' | 'keepsImages' | 'takesImages'>;

/**
 * The posts' files: lines naming each, and the images the model can see, in the order of their
 * lines, if it takes images. Images are kept in the thread when the session keeps them, and named
 * as they're kept. A file that can't be handed over is only named, so answering doesn't fail on it.
 * `rootId` names the thread in the log.
 */
export async function attachments(
  chat: Pick<Chat, 'file'>,
  session: Session,
  posts: ThreadPost[],
  rootId: string,
): Promise<{ lines: string[][]; images: ImageContent[] }> {
  const images: ImageContent[] = [];
  const lines: string[][] = [];
  for (const post of posts) {
    const postLines: string[] = [];
    for (const file of post.files) {
      const image = file.mimeType.startsWith('image/');
      if (image && session.keepsImages) postLines.push(await keepImage(chat, session, file, images, rootId));
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
  let name: string;
  try {
    image = { type: 'image', data: Buffer.from(await chat.file(file.id, source.preview)).toString('base64'), mimeType: source.mimeType };
    name = await session.images.save(file.name, image);
  } catch (error) {
    console.warn(`Thread ${rootId}: image ${file.id} couldn't be downloaded:`, errorMessage(error));
    return `[image: ${file.name}, not shown: it couldn't be downloaded]`;
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

/** A file the model only learns the name of. */
function fileLine(file: PostFile): string {
  return `[file: ${file.name} (${file.mimeType || 'unknown type'}), which you can't open]`;
}
