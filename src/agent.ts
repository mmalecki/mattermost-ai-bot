import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Model } from '@earendil-works/pi-ai';
import {
  type AgentSession,
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { Config } from './config.ts';
import { homeAssistant } from './homeassistant.ts';

const PROVIDER = 'llm';

// Published as TypeScript, which Node won't strip under node_modules, so pi loads it like any
// installed pi package.
const FEATHER_PI_WEB = dirname(fileURLToPath(import.meta.resolve('@mmalecki/feather-pi-web/package.json')));

export interface Agent {
  /** Whether the thread has a session from an earlier run. */
  hasSession(rootId: string): boolean;
  /** Opens the thread's session, creating it on first use. */
  openSession(rootId: string, options: { allowHomeAssistant: () => boolean }): Promise<AgentSession>;
}

export async function createAgent(config: Config): Promise<Agent> {
  const agentDir = join(config.dataDir, 'pi');
  const sessionDir = join(config.dataDir, 'sessions');
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const model = registerModel(modelRuntime, config.llm);
  // A literal key would go through pi's `$VAR` interpolation; a runtime key is used as is.
  await modelRuntime.setRuntimeApiKey(PROVIDER, config.llm.apiKey);

  const systemPrompt = buildSystemPrompt(!!config.homeAssistant);
  const sessionFile = (rootId: string) => join(sessionDir, `${rootId}.jsonl`);

  return {
    hasSession: (rootId) => existsSync(sessionFile(rootId)),

    async openSession(rootId, { allowHomeAssistant }) {
      const extensionFactories: ExtensionFactory[] = [
        // Servers come only from the extensions below, never from an mcp.json.
        createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }), logPath: join(agentDir, 'mcp.log') }),
      ];
      if (config.homeAssistant) extensionFactories.push(homeAssistant({ url: config.homeAssistant.url, allowed: allowHomeAssistant }));

      const resourceLoader = new DefaultResourceLoader({
        cwd: config.dataDir,
        agentDir,
        additionalExtensionPaths: [FEATHER_PI_WEB],
        extensionFactories,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt,
      });
      await resourceLoader.reload();

      const { session } = await createAgentSession({
        cwd: config.dataDir,
        agentDir,
        model,
        thinkingLevel: 'off',
        modelRuntime,
        resourceLoader,
        // No file or shell access: the bot only gets the extensions' tools.
        noTools: 'builtin',
        sessionManager: SessionManager.open(sessionFile(rootId), sessionDir, config.dataDir),
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } }),
      });
      // Starts the extensions, which connects the MCP servers.
      await session.bindExtensions({});
      return session;
    },
  };
}

function registerModel(runtime: ModelRuntime, llm: Config['llm']): Model<'openai-completions'> {
  runtime.registerProvider(PROVIDER, {
    name: 'OpenAI-compatible endpoint',
    baseUrl: llm.baseUrl,
    api: 'openai-completions',
    models: [
      {
        id: llm.model,
        name: llm.model,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: llm.contextWindow,
        maxTokens: llm.maxTokens,
      },
    ],
  });
  const model = runtime.getModel(PROVIDER, llm.model);
  if (!model) throw new Error(`Model ${PROVIDER}/${llm.model} did not register`);
  return model as Model<'openai-completions'>;
}

function buildSystemPrompt(homeAssistant: boolean): string {
  return [
    homeAssistant
      ? 'You are a Mattermost bot that controls the home through Home Assistant and researches the web.'
      : 'You are a Mattermost bot that researches the web.',
    'Each user message holds one or more Mattermost posts from a thread, as "@username (time): text". Several people can take part in one thread.',
    'Your reply is posted to the thread as Mattermost markdown. Keep it short.',
    ...(homeAssistant ? ['Check the current state of the home before changing it, and say what you changed.'] : []),
    'Use websearch to find sources and webfetch to read the most promising pages. Cite URLs.',
  ].join('\n');
}
