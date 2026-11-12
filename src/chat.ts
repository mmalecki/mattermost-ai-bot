// What the bot needs of a chat server, which Mattermost provides, and the posts and files it deals in.

export interface ThreadPost {
  id: string;
  userId: string;
  createAt: number;
  message: string;
  files: PostFile[];
}

/** A file attached to a post. */
export interface PostFile {
  id: string;
  name: string;
  mimeType: string;
  /** In bytes. */
  size: number;
  /** Whether the server has a smaller JPEG of it, for images. */
  hasPreview: boolean;
}

/** A file to attach to a reply. */
export interface OutgoingFile {
  name: string;
  mimeType: string;
  /** Not a SharedArrayBuffer view, which Blob won't take. */
  data: Uint8Array<ArrayBuffer>;
}

/** What threads need of the chat server. */
export interface Chat {
  /** The thread's posts, oldest first, without the bot's own and system posts. */
  threadPosts(rootId: string): Promise<ThreadPost[]>;
  /** A file's contents, or with `preview`, the server's smaller JPEG of an image. */
  file(fileId: string, preview: boolean): Promise<Uint8Array>;
  username(userId: string): Promise<string>;
  /**
   * Posts `message`, which may be empty when there are files, with `files` attached. Returns their ids, in
   * order, with undefined for one that couldn't be attached.
   */
  reply(channelId: string, rootId: string, message: string, files?: OutgoingFile[]): Promise<(string | undefined)[]>;
  typing(channelId: string, rootId: string): void;
}

export interface IncomingPost {
  id: string;
  rootId: string;
  channelId: string;
  userId: string;
  /** System posts have a type; user posts don't. */
  type: string;
  direct: boolean;
  mentioned: boolean;
}
