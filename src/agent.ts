// What threads need of the agent, which pi provides: a session for each thread.
import type { ImageContent } from '@earendil-works/pi-ai';
import type { AgentSession, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { ModelChoice } from './config.ts';
import type { ThreadImages } from './images.ts';
import type { ScheduledJob } from './scheduler.ts';

export interface Agent {
  /** Whether the thread has a session from an earlier run. */
  hasSession(rootId: string): boolean;
  /**
   * Parses `ref`, written `provider/model[:thinking]`, as a model to run a thread on. Returns
   * undefined when pi knows no such provider, so `ref` is ordinary text rather than a model. Throws
   * when the provider is known but lacks the model or an API key; the message is meant for the thread.
   */
  pickModel(ref: string): ModelChoice | undefined;
  /**
   * Opens the thread's session, creating it on first use. A new session runs on `model`, MODEL's by
   * default; an existing one on the model it was created with. With the scheduler on, `onScheduled`
   * gets the thread's scheduled jobs as they come due.
   */
  openSession(
    rootId: string,
    options: {
      model?: ModelChoice;
      allowTools: (toolName: string) => boolean;
      onScheduled: (job: ScheduledJob) => void;
    },
  ): Promise<ThreadSession>;
}

type AgentMessage = AgentSession['messages'][number];

/** A thread's session: what the bot needs of pi's. */
export interface ThreadSession {
  /** The model it runs on. */
  readonly model: ModelChoice;
  /** Whether that model takes images. */
  readonly takesImages: boolean;
  /** The thread's images, kept in its directory: posted ones, and those tools made and returned. */
  readonly images: ThreadImages;
  /** Whether posts' images are kept in `images`: when the model or some tool takes them. */
  readonly keepsImages: boolean;
  /** Whether the thread has scheduled jobs still to come due, which keep the session open. */
  hasPendingJobs(): boolean;
  /** The conversation so far. */
  readonly messages: readonly AgentMessage[];
  /** Runs the agent on `text`, with `images`, until it is done answering. */
  prompt(text: string, images?: ImageContent[]): Promise<void>;
  /** Stops the run in progress. */
  abort(): Promise<void>;
  /** The session file's entries, oldest first. */
  entries(): SessionEntry[];
  /** Records `data` in the session file, outside the model's context. */
  appendEntry(customType: string, data: unknown): void;
  /** Shuts down the session's extensions, which closes their connections and timers, and disposes it. */
  close(): Promise<void>;
}
