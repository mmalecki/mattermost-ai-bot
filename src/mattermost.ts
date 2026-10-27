import { Client4, WebSocketClient, type WebSocketMessage, type WebSocketMessages } from '@mattermost/client';
import type { Post } from '@mattermost/types/posts';
import type { Chat, IncomingPost, ThreadPost } from './threads.ts';

/** Mattermost's default MaxPostSize is 16383 characters; leave room for continuation. */
const MAX_POST_CHARS = 16_000;
/** Catching up starts this long before the last event, for clock skew; posts already seen are skipped. */
const CATCH_UP_MARGIN_MS = 60_000;
/** Older posts aren't caught up on: after a long outage, they're old news. */
const CATCH_UP_MAX_MS = 24 * 3_600_000;

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
  #loggedInAt = 0;

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
    this.#loggedInAt = Date.now();
    console.log(`Logged in to ${this.#url} as @${me.username}`);
  }

  /**
   * Starts delivering new posts to `onPost`, from those made since login(). Posts made while the
   * connection was down are delivered once it is back, up to a day's worth. Posts may come more than once.
   */
  listen(onPost: (post: IncomingPost) => void): void {
    let lastEventAt = Date.now();
    this.#ws.addMessageListener((msg) => {
      lastEventAt = Date.now();
      // Allowlists name users, so a rename has to reach the cache.
      const user = updatedUser(msg);
      if (user && this.#usernames.has(user.id)) this.#usernames.set(user.id, Promise.resolve(user.username));
      const post = incomingPost(msg, this.botUserId);
      if (post) onPost(post);
    });
    // Having a listener also makes the client resume its connection, so the server replays the events
    // it missed. This runs when the server can't, after a long outage or a restart of its own.
    this.#ws.addMissedMessageListener(() => {
      console.warn('WebSocket missed events the server could not replay');
      // Any user_updated among them too.
      this.#usernames.clear();
      this.#catchUp(lastEventAt, onPost);
    });
    // Once the first connection is up, posts made since login(), while the agent was created. It's a
    // reconnect if connecting failed before.
    let connected = false;
    const opened = (how: string) => {
      console.log(`WebSocket ${how}`);
      if (connected) return;
      connected = true;
      this.#catchUp(this.#loggedInAt, onPost);
    };
    this.#ws.addFirstConnectListener(() => opened('connected'));
    this.#ws.addReconnectListener(() => opened('reconnected'));
    this.#ws.addCloseListener((fails) => console.warn(`WebSocket closed (${fails} failed attempts)`));
    this.#ws.initialize(`${this.#url.replace(/^http/, 'ws')}/api/v4/websocket`, this.#token);
  }

  close(): void {
    this.#ws.close();
  }

  #catchUp(since: number, onPost: (post: IncomingPost) => void): void {
    const from = Math.max(since - CATCH_UP_MARGIN_MS, Date.now() - CATCH_UP_MAX_MS);
    this.#postsSince(from).then(
      (posts) => {
        console.log(`Caught up on ${posts.length} post(s) since ${new Date(from).toISOString()}`);
        posts.forEach(onPost);
      },
      (error: unknown) => console.error('Catching up on missed posts failed:', error),
    );
  }

  /** Posts made since `since` in every channel the bot is in, oldest first. */
  async #postsSince(since: number): Promise<IncomingPost[]> {
    const teams = await this.#client.getMyTeams();
    // Direct and group channels are listed for every team.
    const channels = new Map((await Promise.all(teams.map((t) => this.#client.getMyChannels(t.id)))).flat().map((c) => [c.id, c]));
    const posts: Post[] = [];
    for (const channel of channels.values()) {
      // Edited posts come too, whenever they were made.
      const { posts: byId } = await this.#client.getPostsSince(channel.id, since);
      posts.push(...Object.values(byId).filter((p) => p.create_at > since && !p.delete_at));
    }
    return posts
      .sort((a, b) => a.create_at - b.create_at)
      .map((p) => toIncoming(p, channels.get(p.channel_id)?.type === 'D', mentions(p.message, this.botUsername)));
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
  const mentioned = data.mentions ? (JSON.parse(data.mentions) as string[]) : [];
  return toIncoming(post, data.channel_type === 'D', mentioned.includes(botUserId));
}

export function updatedUser(msg: WebSocketMessage): { id: string; username: string } | undefined {
  if ((msg.event as string) !== 'user_updated') return undefined;
  const { user } = (msg as WebSocketMessages.UserUpdated).data;
  return { id: user.id, username: user.username };
}

function toIncoming(post: Post, direct: boolean, mentioned: boolean): IncomingPost {
  return { id: post.id, rootId: post.root_id, channelId: post.channel_id, userId: post.user_id, type: post.type, direct, mentioned };
}

/**
 * Whether `message` mentions `@username`, for posts fetched without the server's list of mentions. A
 * `.` ending a sentence doesn't make it another name, but one followed by more of a name does.
 */
export function mentions(message: string, username: string): boolean {
  const escaped = username.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  return new RegExp(`(?<![\\w@.-])@${escaped}(?![\\w-]|\\.[\\w-])`, 'i').test(message);
}

/**
 * Splits at paragraph, then line, then hard boundaries, keeping each part under `max`. A code block
 * split across parts is closed at the end of one and reopened at the start of the next.
 */
export function splitMessage(message: string, max: number): string[] {
  const parts: string[] = [];
  let rest = message;
  while (rest.length > max) {
    let { part, next } = cut(rest, max);
    let fence = openFence(part);
    if (fence) {
      // Again, leaving room to close it.
      const room = Math.max(1, max - fence.marker.length - 1);
      ({ part, next } = cut(rest, room));
      fence = openFence(part);
      const opener = fence?.line.trimEnd();
      if (fence && part === opener) {
        // Only the opening line fits before a line of code too long for a part, so that line is cut.
        ({ part, next } = cut(rest, room, true));
      } else if (fence && opener !== undefined && part.endsWith(`\n${opener}`)) {
        // The block would open empty at the end of this part, so it starts the next one instead.
        part = part.slice(0, -opener.length).trimEnd();
        next = `${fence.line}\n${next}`;
        fence = undefined;
      }
    }
    // Carried over only when that still shortens what's left, so the loop ends.
    if (fence && part.length + fence.marker.length + 1 <= max && part.length > fence.line.length + 1) {
      part = `${part}\n${fence.marker}`;
      next = `${fence.line}\n${next}`;
    }
    if (part) parts.push(part);
    rest = next;
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Cuts within `limit` at the last paragraph or line break, or else, or when `hard`, anywhere outside a
 * surrogate pair.
 */
function cut(text: string, limit: number, hard = false): { part: string; next: string } {
  const window = text.slice(0, limit);
  let at = hard ? -1 : window.lastIndexOf('\n\n');
  if (at <= 0 && !hard) at = window.lastIndexOf('\n');
  // Only the break goes, so the next line keeps its indentation.
  if (at > 0) return { part: text.slice(0, at).trimEnd(), next: text.slice(at).replace(/^\n+/, '') };
  at = limit;
  const code = text.charCodeAt(at - 1);
  if (at > 1 && code >= 0xd800 && code <= 0xdbff) at--;
  return { part: text.slice(0, at), next: text.slice(at) };
}

/** The code block still open at the end of `text`: its opening line, and the fence that closes it. */
function openFence(text: string): { line: string; marker: string } | undefined {
  let open: { line: string; marker: string } | undefined;
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!marker) continue;
    if (!open) open = { line, marker };
    else if (line.trim() === marker && marker[0] === open.marker[0] && marker.length >= open.marker.length) open = undefined;
  }
  return open;
}
