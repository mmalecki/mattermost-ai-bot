import { Client4, WebSocketClient, type WebSocketMessage, type WebSocketMessages } from '@mattermost/client';
import type { Post } from '@mattermost/types/posts';
import type { Chat, IncomingPost, ThreadPost } from './threads.ts';

/** Mattermost's default MaxPostSize is 16383 characters; leave room for continuation. */
const MAX_POST_CHARS = 16_000;

export class Mattermost implements Chat {
  readonly #client = new Client4();
  readonly #ws = new WebSocketClient();
  readonly #usernames = new Map<string, Promise<string>>();
  readonly #url: string;
  readonly #token: string;
  /** Set by login(). */
  botUserId = '';
  /** Set by login(). */
  botUsername = '';

  constructor(url: string, token: string) {
    this.#url = url;
    this.#token = token;
    this.#client.setUrl(url);
    this.#client.setToken(token);
  }

  async login(): Promise<void> {
    const me = await this.#client.getMe();
    this.botUserId = me.id;
    this.botUsername = me.username;
    console.log(`Logged in to ${this.#url} as @${me.username}`);
  }

  /** Starts delivering new posts to `onPost`. */
  listen(onPost: (post: IncomingPost) => void): void {
    this.#ws.addMessageListener((msg) => {
      const post = incomingPost(msg, this.botUserId);
      if (post) onPost(post);
    });
    this.#ws.addFirstConnectListener(() => console.log('WebSocket connected'));
    this.#ws.addReconnectListener(() => console.log('WebSocket reconnected'));
    this.#ws.addCloseListener((fails) => console.warn(`WebSocket closed (${fails} failed attempts)`));
    this.#ws.initialize(`${this.#url.replace(/^http/, 'ws')}/api/v4/websocket`, this.#token);
  }

  close(): void {
    this.#ws.close();
  }

  async threadPosts(rootId: string): Promise<ThreadPost[]> {
    // getPostThread stops at the first 60 posts, so a longer thread would never show new ones.
    const { posts, has_next } = await this.#client.getPaginatedPostThread(rootId, { fetchAll: true });
    if (has_next) console.warn(`Thread ${rootId}: the server held back some of its posts, so the newest may be missing`);
    return Object.values(posts)
      .filter((p) => p.user_id !== this.botUserId && !p.type && !p.delete_at)
      .sort((a, b) => a.create_at - b.create_at)
      .map((p) => ({ id: p.id, userId: p.user_id, createAt: p.create_at, message: p.message }));
  }

  username(userId: string): Promise<string> {
    let name = this.#usernames.get(userId);
    if (!name) {
      name = this.#client.getUser(userId).then((u) => u.username);
      name.catch(() => this.#usernames.delete(userId));
      this.#usernames.set(userId, name);
    }
    return name;
  }

  async reply(channelId: string, rootId: string, message: string): Promise<void> {
    for (const chunk of splitMessage(message, MAX_POST_CHARS)) {
      await this.#client.createPost({ channel_id: channelId, root_id: rootId, message: chunk });
    }
  }

  typing(channelId: string, rootId: string): void {
    this.#ws.userTyping(channelId, rootId);
  }
}

export function incomingPost(msg: WebSocketMessage, botUserId: string): IncomingPost | undefined {
  // WebSocketEvents is a const enum, which erasable TypeScript can't read.
  if ((msg.event as string) !== 'posted') return undefined;
  const { data } = msg as WebSocketMessages.Posted;
  const post = JSON.parse(data.post) as Post;
  const mentions = data.mentions ? (JSON.parse(data.mentions) as string[]) : [];
  return {
    id: post.id,
    rootId: post.root_id,
    channelId: post.channel_id,
    userId: post.user_id,
    type: post.type,
    direct: data.channel_type === 'D',
    mentioned: mentions.includes(botUserId),
  };
}

/** Splits at paragraph, then line, then hard boundaries, keeping each part under `max`. */
export function splitMessage(message: string, max: number): string[] {
  const parts: string[] = [];
  let rest = message;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut <= 0) cut = window.lastIndexOf('\n');
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
