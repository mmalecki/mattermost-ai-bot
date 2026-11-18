import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CreateAgentSessionOptions, McpServerConfig } from '@earendil-works/pi-coding-agent';
import { Cron } from 'croner';
import micromatch from 'micromatch';
import { errorMessage } from './error.ts';

export interface Config {
  /** `publicUrl` is where people open the server, for links: `url` may be one only the bot reaches. */
  mattermost: { url: string; publicUrl: string; token: string };
  llm: {
    /** A pi provider: built in, such as `mistral` or `anthropic`, or defined in `modelsPath`. */
    provider: string;
    model: string;
    thinkingLevel: ThinkingLevel;
    /** Output is capped at this or the model's own limit, whichever is lower. */
    maxTokens: number;
    /** pi's `models.json`, for endpoints its catalog doesn't know. Used when the file exists. */
    modelsPath: string;
  };
  /** The model the agent generates images with, from pi's catalog or `modelsPath`. Unset: no images. */
  imageModel: { provider: string; model: string } | undefined;
  /** The chat model the agent's vision tools look at images with, which must take them. Unset: no vision tools. */
  visionModel: ModelChoice | undefined;
  tools: ToolsConfig;
  /** Whether the agent can schedule jobs in its threads. */
  scheduler: boolean;
  /** Jobs people set up in schedules.json, next to the MCP config, which the bot runs on its own. */
  schedules: Schedule[];
  /** Whether the agent always has `codemode`, not only with servers of `codemode` exposure. */
  codemode: boolean;
  /** Whether a thread's first post may pick the model the thread runs on, instead of `llm`'s. */
  pickModel: boolean;
  /** Operator instructions added to the system prompt, used when the file exists. */
  appendSystemPromptPath: string;
  /** Thread sessions and pi's own state live here. */
  dataDir: string;
  /** Idle thread sessions are closed after this long, unless they have scheduled jobs pending. */
  idleMs: number;
}

export interface ToolsConfig {
  /** The tools each Mattermost username may have the agent call. Unset lets everyone call every tool. */
  allowedUsers: AllowedUsers | undefined;
  /** MCP servers in pi's `mcp.json` format, validated by pi when registered. */
  mcpServers: Record<string, McpServerConfig>;
  /**
   * The arguments the enabled servers with an `images` setting take images in, which the agent gives them
   * by name, and how each takes them.
   */
  serverImages: Record<string, ImageArguments>;
}

/** A job set up in schedules.json, which the bot runs on its own, at the times its cron expression gives. */
export interface Schedule {
  /** Its key in schedules.json. */
  name: string;
  /** Five fields, or a nickname such as `@daily`, as croner reads them. */
  cron: string;
  /** The IANA time zone `cron` is read in. Unset: the bot's own, as TZ sets it. */
  timezone: string | undefined;
  /**
   * Where its runs go: a new thread each, in the direct channel with a user or in a team's channel,
   * both by their names, or one thread, by a post in it.
   */
  target: { user: string } | { team: string; channel: string } | { thread: string };
  /** The username it runs as, whose tools it gets. */
  owner: string;
  /** What a new thread's root post says, with a mention of the owner. */
  title: string;
  /** What the agent is asked: given, or read from a file at every run. */
  prompt: { text: string } | { file: string };
  /** The model a new thread runs on, written like MODEL. Unset: MODEL. */
  model: string | undefined;
  /** How late a run may still go, as when the bot was down at its time, in ms. 0: only on time. */
  catchUpMs: number;
}

const SCHEDULE_KEYS = new Set(['cron', 'timezone', 'to', 'thread', 'owner', 'title', 'prompt', 'promptFile', 'model', 'catchUp', 'enabled']);

/** Usernames, and for each, whether they may have the agent call a tool, by its name. */
export type AllowedUsers = Map<string, (toolName: string) => boolean>;

/** How a server's tools take an image: its base64 data, as a `data:` URL, or the path of its file. */
export type ImageForm = 'base64' | 'dataUrl' | 'path';
/** A server's arguments that take images, by name, at any depth, and how each takes them. */
export type ImageArguments = Record<string, ImageForm>;
const IMAGE_FORMS: readonly string[] = ['base64', 'dataUrl', 'path'] satisfies ImageForm[];

/** A model a thread can run on, as MODEL names one. */
export type ModelChoice = Pick<Config['llm'], 'provider' | 'model' | 'thinkingLevel'>;

type ThinkingLevel = NonNullable<CreateAgentSessionOptions['thinkingLevel']>;
const THINKING_LEVELS: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] satisfies ThinkingLevel[];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const number = (name: string, fallback: number) => {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const optional = (name: string) => env[name]?.trim() || undefined;
  const flag = (name: string) => {
    const value = env[name]?.trim().toLowerCase() || 'false';
    if (!['1', 'true', '0', 'false'].includes(value)) throw new Error(`${name} must be true or false`);
    return value === '1' || value === 'true';
  };

  const mcpConfig = resolve(env.MCP_CONFIG || 'mcp.json');
  const url = trimSlash(required('MATTERMOST_URL'));
  const publicUrl = optional('MATTERMOST_PUBLIC_URL');
  const imageModel = optional('IMAGE_MODEL');
  const visionModel = optional('VISION_MODEL');
  return {
    mattermost: { url, publicUrl: publicUrl ? trimSlash(publicUrl) : url, token: required('MATTERMOST_TOKEN') },
    llm: {
      ...parseModel(required('MODEL')),
      // Low enough that a model stuck repeating itself stops soon; reasoning counts towards it.
      maxTokens: number('MAX_OUTPUT_TOKENS', 8_192),
      // pi's own file for custom providers, kept next to the tools like APPEND_SYSTEM.md.
      modelsPath: join(dirname(mcpConfig), 'models.json'),
    },
    imageModel: imageModel ? parseImageModel(imageModel) : undefined,
    visionModel: visionModel ? parseModel(visionModel, { name: 'VISION_MODEL', example: 'openrouter/qwen/qwen3-vl-235b-a22b-instruct' }) : undefined,
    // A missing default file means no MCP servers; a missing file that was asked for is an error.
    tools: loadTools(mcpConfig, !!env.MCP_CONFIG),
    scheduler: flag('SCHEDULER'),
    schedules: loadSchedules(join(dirname(mcpConfig), 'schedules.json')),
    codemode: flag('CODEMODE'),
    pickModel: flag('ALLOW_PICKING_MODEL'),
    // pi's name for instructions added to its system prompt, kept next to the tools they're about.
    appendSystemPromptPath: join(dirname(mcpConfig), 'APPEND_SYSTEM.md'),
    dataDir: resolve(env.DATA_DIR || 'data'),
    idleMs: 15 * 60_000,
  };
}

/**
 * `provider/model[:thinking]`, as pi's `--model` takes it. The model may contain `/` itself, as
 * OpenRouter's do, and `:` too, so only a known thinking level after the last `:` counts as one. An
 * error names the variable `name`, and gives `example`, and the thinking level only if it takes one.
 */
export function parseModel(ref: string, { name = 'MODEL', example = 'mistral/mistral-small-2603', thinking = true } = {}): ModelChoice {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`${name} must be provider/model${thinking ? '[:thinking]' : ''}, such as ${example}, not "${ref}"`);
  }
  const provider = ref.slice(0, slash);
  let model = ref.slice(slash + 1);
  let thinkingLevel: ThinkingLevel = 'off';
  const colon = model.lastIndexOf(':');
  const suffix = model.slice(colon + 1);
  if (colon > 0 && THINKING_LEVELS.includes(suffix)) {
    thinkingLevel = suffix as ThinkingLevel;
    model = model.slice(0, colon);
  }
  return { provider, model, thinkingLevel };
}

/** `provider/model`, as MODEL takes it, without a thinking level: image models don't think. */
export function parseImageModel(ref: string): NonNullable<Config['imageModel']> {
  const { provider, model, thinkingLevel } = parseModel(ref, { name: 'IMAGE_MODEL', example: 'openrouter/bytedance-seed/seedream-5-0-pro', thinking: false });
  if (thinkingLevel !== 'off') throw new Error(`IMAGE_MODEL takes no thinking level, as in "${ref}"`);
  return { provider, model };
}

/**
 * Reads pi's `mcp.json` format, plus a top-level `allowedUsers` that gates every tool call: a list of
 * usernames who may use every tool, or an object giving each username the tools they may use. And an
 * `images` setting on a server, which pi ignores.
 */
export function loadTools(path: string, required: boolean): ToolsConfig {
  if (!existsSync(path)) {
    if (required) throw new Error(`${path} does not exist`);
    return { allowedUsers: undefined, mcpServers: {}, serverImages: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    throw new Error(`${path}: expected an object with an "mcpServers" object`);
  }
  let allowedUsers;
  try {
    allowedUsers = parsed.allowedUsers === undefined ? undefined : parseAllowedUsers(parsed.allowedUsers);
  } catch (error) {
    throw new Error(`${path}: ${errorMessage(error)}`);
  }
  const mcpServers = (parsed.mcpServers ?? {}) as Record<string, McpServerConfig & { images?: unknown }>;
  const serverImages: Record<string, ImageArguments> = {};
  for (const [name, server] of Object.entries(mcpServers)) {
    if (!isRecord(server) || server.images === undefined) continue;
    const { images } = server;
    if (!isRecord(images) || !Object.keys(images).length || !Object.values(images).every((form) => IMAGE_FORMS.includes(form as string))) {
      throw new Error(`${path}: server "${name}": "images" must map the arguments that take images to one of ${IMAGE_FORMS.join(', ')}`);
    }
    if (server.enabled !== false) serverImages[name] = images as ImageArguments;
  }
  return { allowedUsers, mcpServers, serverImages };
}

/**
 * Reads schedules.json, if there is one: an object with a job under each name, each with a `cron`
 * expression, and its `timezone`; where it posts, `to` a `@user` or a `team/channel`, or in a
 * `thread`, by a post in it; its `owner`, the `to` user by default; a `title`, the name by default;
 * a `prompt`, or a `promptFile` next to schedules.json; a `model`; how late it may `catchUp`, such
 * as `30m`; and whether it's `enabled`.
 */
export function loadSchedules(path: string): Schedule[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) throw new Error(`${path}: expected an object with a job under each name`);
  const schedules: Schedule[] = [];
  for (const [name, job] of Object.entries(parsed)) {
    try {
      if (!/^[\w.-]+$/.test(name)) throw new Error('a name is letters, digits, ".", "_" and "-"');
      if (!isRecord(job)) throw new Error('expected an object');
      const schedule = parseSchedule(name, job, dirname(path));
      if (schedule) schedules.push(schedule);
    } catch (error) {
      throw new Error(`${path}: "${name}": ${errorMessage(error)}`);
    }
  }
  return schedules;
}

/** The job `name`, or nothing when it isn't `enabled`. A `promptFile` is relative to `dir`. */
function parseSchedule(name: string, job: Record<string, unknown>, dir: string): Schedule | undefined {
  const unknown = Object.keys(job).filter((key) => !SCHEDULE_KEYS.has(key));
  if (unknown.length) throw new Error(`unknown ${unknown.map((key) => `"${key}"`).join(', ')}; a job takes ${[...SCHEDULE_KEYS].join(', ')}`);
  const string = (key: string): string | undefined => {
    const value = job[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim()) throw new Error(`"${key}" must be a non-empty string`);
    return value.trim();
  };
  if (job.enabled !== undefined && typeof job.enabled !== 'boolean') throw new Error('"enabled" must be true or false');
  if (job.enabled === false) return undefined;

  const cron = string('cron');
  if (!cron) throw new Error('"cron" must give its times, such as "0 7 * * 1-5"');
  const timezone = string('timezone');
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch {
      throw new Error(`"timezone" must be an IANA time zone, such as "Europe/Warsaw", not "${timezone}"`);
    }
  }
  let next: Date | null;
  try {
    next = new Cron(cron, { mode: '5-part', timezone }).nextRun();
  } catch (error) {
    throw new Error(`"cron" must be five fields, or a nickname such as "@daily": ${errorMessage(error)}`);
  }
  if (!next) throw new Error(`"cron" "${cron}" never comes due`);

  const to = string('to');
  const thread = string('thread');
  if (!to === !thread) throw new Error('give either "to", a "@user" or a "team/channel" to start a thread in each run, or "thread", the id of a post in the thread to run in');
  let target: Schedule['target'];
  if (to?.startsWith('@')) target = { user: to.slice(1) };
  else if (to) {
    const [team, channel, ...rest] = to.split('/');
    if (!team || !channel || rest.length) throw new Error(`"to" must be a "@user" or a "team/channel", by the names in their URLs, not "${to}"`);
    target = { team, channel };
  } else target = { thread: thread! };
  const owner = string('owner')?.replace(/^@/, '') ?? ('user' in target ? target.user : undefined);
  if (!owner) throw new Error('"owner" must name the user the job runs as, unless it goes "to" a "@user"');

  const text = string('prompt');
  const file = string('promptFile');
  if (!text === !file) throw new Error('give either "prompt", what to ask the agent, or "promptFile", a file with it');
  const promptPath = file && resolve(dir, file);
  if (promptPath && !existsSync(promptPath)) throw new Error(`"promptFile" ${promptPath} does not exist`);

  const model = string('model');
  if (model) parseModel(model, { name: '"model"' });
  const catchUp = string('catchUp');
  const duration = catchUp === undefined ? undefined : /^(\d+)\s*(m|h)$/.exec(catchUp);
  if (catchUp !== undefined && !duration) throw new Error(`"catchUp" must be minutes or hours, such as "30m" or "2h", not "${catchUp}"`);
  const catchUpMs = duration ? Number(duration[1]) * (duration[2] === 'h' ? 3_600_000 : 60_000) : 0;

  return {
    name,
    cron,
    timezone,
    target,
    owner,
    title: string('title') ?? name,
    prompt: promptPath ? { file: promptPath } : { text: text! },
    model,
    catchUpMs,
  };
}

/**
 * `allowedUsers` from `mcp.json`: `["alice", "bob"]`, who may use every tool, or
 * `{ "alice": "*", "mail": ["mcp__parcels__*"] }`, with each user's tools as a name or glob, or a
 * list of them, as micromatch takes them. A pattern starting with `!` takes tools away from those the
 * user's other patterns give. Usernames may start with `@`.
 */
export function parseAllowedUsers(value: unknown): AllowedUsers {
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
  let entries: [string, string[]][];
  if (strings(value)) {
    entries = value.map((user) => [user, ['*']]);
  } else if (isRecord(value)) {
    entries = Object.entries(value).map(([user, tools]) => {
      if (typeof tools === 'string') return [user, [tools]];
      if (strings(tools)) return [user, tools];
      throw new Error(`"allowedUsers": the tools of "${user}" must be a name or pattern, or a list of them`);
    });
  } else {
    throw new Error('"allowedUsers" must be a list of usernames, or an object giving each username their tools');
  }
  const tools = new Map<string, string[]>();
  for (const [user, patterns] of entries) {
    const name = user.trim().replace(/^@/, '');
    if (name) tools.set(name, [...(tools.get(name) ?? []), ...patterns]);
  }
  return new Map([...tools].map(([user, patterns]) => [user, toolMatcher(patterns)]));
}

/**
 * Whether a tool name matches one of `patterns`, globs as micromatch takes them, and none of those
 * negated with a leading `!`, which only take tools away: on its own, a negated pattern matches every
 * other name, so it would give them all. None matches nothing, as do only negated ones.
 */
function toolMatcher(patterns: string[]): (toolName: string) => boolean {
  const globs = patterns.map((p) => p.trim()).filter(Boolean);
  const negated = (glob: string) => micromatch.scan(glob).negated;
  // `dot`, so that `*` matches every name.
  const matcher = (glob: string) => micromatch.matcher(glob, { dot: true });
  const given = globs.filter((glob) => !negated(glob)).map(matcher);
  // As written, these match the names they leave.
  const left = globs.filter(negated).map(matcher);
  return (toolName) => given.some((matches) => matches(toolName)) && left.every((matches) => matches(toolName));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A trailing slash on the Mattermost URL makes every API call redirect.
function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
