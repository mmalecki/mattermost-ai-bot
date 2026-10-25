import { resolve } from 'node:path';

export interface Config {
  mattermost: { url: string; token: string };
  llm: { baseUrl: string; model: string; apiKey: string; contextWindow: number; maxTokens: number };
  /** Unset when HASS_SERVER or HASS_TOKEN is missing, which leaves the agent with web research only. */
  homeAssistant: { url: string; allowedUsers: Set<string> } | undefined;
  /** Thread sessions and pi's own state live here. */
  dataDir: string;
}

/** Anthropic's OpenAI-compatible endpoint, used when OPENAI_BASE_URL is unset. */
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

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

  return {
    mattermost: { url: trimSlash(required('MATTERMOST_URL')), token: required('MATTERMOST_TOKEN') },
    llm: {
      // The key follows the endpoint, so an OPENAI_API_KEY from the shell is never sent to Anthropic.
      ...(env.OPENAI_BASE_URL
        ? { baseUrl: trimSlash(env.OPENAI_BASE_URL), apiKey: required('OPENAI_API_KEY') }
        : { baseUrl: ANTHROPIC_BASE_URL, apiKey: required('ANTHROPIC_API_KEY') }),
      model: env.OPENAI_MODEL || 'claude-haiku-5-5',
      contextWindow: number('OPENAI_MODEL_CONTEXT_WINDOW', 200_000),
      maxTokens: number('OPENAI_MODEL_MAX_TOKENS', 16_384),
    },
    homeAssistant:
      env.HASS_SERVER && env.HASS_TOKEN
        ? {
            url: trimSlash(env.HASS_SERVER),
            allowedUsers: new Set((env.HASS_ALLOWED_USERS ?? '').split(',').map((u) => u.trim().replace(/^@/, '')).filter(Boolean)),
          }
        : undefined,
    dataDir: resolve(env.DATA_DIR || 'data'),
  };
}

// A trailing slash on the Mattermost URL makes every API call redirect.
function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
