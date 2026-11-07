import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CreateAgentSessionOptions, McpServerConfig } from '@earendil-works/pi-coding-agent';
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
  tools: ToolsConfig;
  /** Whether the agent can schedule jobs in its threads, with pi-ate-scheduler. */
  scheduler: boolean;
  /** Whether the agent always has `codemode`, not only with servers of `codemode` exposure. */
  codemode: boolean;
  /** Whether a thread's first post may pick the model the thread runs on, instead of `llm`'s. */
  pickModel: boolean;
  /** Operator instructions added to the system prompt, used when the file exists. */
  appendSystemPromptPath: string;
  /** Thread sessions and pi's own state live here. */
  dataDir: string;
}

export interface ToolsConfig {
  /** The tools each Mattermost username may have the agent call. Unset lets everyone call every tool. */
  allowedUsers: AllowedUsers | undefined;
  /** MCP servers in pi's `mcp.json` format, validated by pi when registered. */
  mcpServers: Record<string, McpServerConfig>;
}

/** Usernames, and for each, a pattern matching the names of the tools they may have the agent call. */
export type AllowedUsers = Map<string, RegExp>;

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
  const flag = (name: string) => {
    const value = env[name]?.trim().toLowerCase() || 'false';
    if (!['1', 'true', '0', 'false'].includes(value)) throw new Error(`${name} must be true or false`);
    return value === '1' || value === 'true';
  };

  const mcpConfig = resolve(env.MCP_CONFIG || 'mcp.json');
  const url = trimSlash(required('MATTERMOST_URL'));
  return {
    mattermost: { url, publicUrl: env.MATTERMOST_PUBLIC_URL?.trim() ? trimSlash(env.MATTERMOST_PUBLIC_URL.trim()) : url, token: required('MATTERMOST_TOKEN') },
    llm: {
      ...parseModel(required('MODEL')),
      // Low enough that a model stuck repeating itself stops soon; reasoning counts towards it.
      maxTokens: number('MAX_OUTPUT_TOKENS', 8_192),
      // pi's own file for custom providers, kept next to the tools like APPEND_SYSTEM.md.
      modelsPath: join(dirname(mcpConfig), 'models.json'),
    },
    imageModel: env.IMAGE_MODEL?.trim() ? parseImageModel(env.IMAGE_MODEL.trim()) : undefined,
    // A missing default file means no MCP servers; a missing file that was asked for is an error.
    tools: loadTools(mcpConfig, !!env.MCP_CONFIG),
    scheduler: flag('SCHEDULER'),
    codemode: flag('CODEMODE'),
    pickModel: flag('ALLOW_PICKING_MODEL'),
    // pi's name for instructions added to its system prompt, kept next to the tools they're about.
    appendSystemPromptPath: join(dirname(mcpConfig), 'APPEND_SYSTEM.md'),
    dataDir: resolve(env.DATA_DIR || 'data'),
  };
}

/**
 * `provider/model[:thinking]`, as pi's `--model` takes it. The model may contain `/` itself, as
 * OpenRouter's do, and `:` too, so only a known thinking level after the last `:` counts as one.
 */
export function parseModel(ref: string): ModelChoice {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) throw new Error(`MODEL must be provider/model, such as mistral/mistral-small-2603, not "${ref}"`);
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
  let parsed;
  try {
    parsed = parseModel(ref);
  } catch {
    throw new Error(`IMAGE_MODEL must be provider/model, such as openrouter/google/gemini-2.5-flash-image, not "${ref}"`);
  }
  if (parsed.thinkingLevel !== 'off') throw new Error(`IMAGE_MODEL takes no thinking level, as in "${ref}"`);
  return { provider: parsed.provider, model: parsed.model };
}

/**
 * Reads pi's `mcp.json` format, plus a top-level `allowedUsers` that gates every tool call: a list of
 * usernames who may use every tool, or an object giving each username the tools they may use.
 */
export function loadTools(path: string, required: boolean): ToolsConfig {
  if (!existsSync(path)) {
    if (required) throw new Error(`${path} does not exist`);
    return { allowedUsers: undefined, mcpServers: {} };
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
  return { allowedUsers, mcpServers: (parsed.mcpServers ?? {}) as Record<string, McpServerConfig> };
}

/**
 * `allowedUsers` from `mcp.json`: `["alice", "bob"]`, who may use every tool, or
 * `{ "alice": "*", "mail": ["mcp__parcels__*"] }`, with each user's tools as a name or pattern, or a
 * list of them. In a pattern, `*` matches any characters. Usernames may start with `@`.
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
  return new Map([...tools].map(([user, patterns]) => [user, toolPattern(patterns)]));
}

/** Matches tool names that are one of `patterns`, where `*` matches any characters. None matches nothing. */
function toolPattern(patterns: string[]): RegExp {
  const alternatives = patterns
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'));
  return new RegExp(alternatives.length ? `^(?:${alternatives.join('|')})$` : '(?!)');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A trailing slash on the Mattermost URL makes every API call redirect.
function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
