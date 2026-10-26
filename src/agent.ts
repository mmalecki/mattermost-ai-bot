import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AgentSession,
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  type McpServerConfig,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { Config } from './config.ts';
import { loadScheduler, type ScheduledJob, scheduler } from './scheduler.ts';
import { mcpServers, toolGuard, withoutCwd } from './tools.ts';

// Published as TypeScript, which Node won't strip under node_modules, so pi loads it like any
// installed pi package.
const FEATHER_PI_WEB = dirname(fileURLToPath(import.meta.resolve('@mmalecki/feather-pi-web/package.json')));

export interface Agent {
  /** Whether the thread has a session from an earlier run. */
  hasSession(rootId: string): boolean;
  /**
   * Opens the thread's session, creating it on first use. With the scheduler on, `onScheduled` gets
   * the thread's scheduled jobs as they come due; without it, the session can't schedule any.
   */
  openSession(rootId: string, options: { allowTools: (toolName: string) => boolean; onScheduled?: (job: ScheduledJob) => void }): Promise<AgentSession>;
  /** Shuts down the session's extensions, which closes their connections and timers, and disposes it. */
  closeSession(session: AgentSession): Promise<void>;
}

/** `botUsername` is the bot's Mattermost username, so the model knows when it is addressed. */
export async function createAgent(config: Config, botUsername: string): Promise<Agent> {
  const agentDir = join(config.dataDir, 'pi');
  const sessionDir = join(config.dataDir, 'sessions');
  const { llm } = config;
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    // The bundled catalog: catalog updates over the network are off by default.
    modelsPath: existsSync(llm.modelsPath) ? llm.modelsPath : null,
  });
  const modelsError = modelRuntime.getError();
  if (modelsError) throw new Error(`${llm.modelsPath}: ${modelsError}`);
  const found = modelRuntime.getModel(llm.provider, llm.model);
  if (!found) throw new Error(`MODEL ${llm.provider}/${llm.model} is neither in pi's catalog nor in ${llm.modelsPath}`);
  // Keys come from pi's own variables, such as MISTRAL_API_KEY, or from models.json.
  if (!modelRuntime.getProviderAuthStatus(llm.provider).configured) {
    throw new Error(`No API key for ${llm.provider}: set its variable, such as ${llm.provider.toUpperCase().replace(/-/g, '_')}_API_KEY`);
  }
  const model = { ...found, maxTokens: Math.min(found.maxTokens, llm.maxTokens) };
  console.log(`Model: ${llm.provider}/${llm.model} (${model.api}, thinking ${llm.thinkingLevel}, max ${model.maxTokens} tokens)`);

  const schedulerExtension = config.scheduler ? await loadScheduler() : undefined;
  if (schedulerExtension) console.log('Scheduler: on');

  const systemPrompt = buildSystemPrompt(botUsername, config.tools.mcpServers, !!schedulerExtension);
  const sessionFile = (rootId: string) => join(sessionDir, `${rootId}.jsonl`);

  return {
    hasSession: (rootId) => existsSync(sessionFile(rootId)),

    async openSession(rootId, { allowTools, onScheduled }) {
      const resourceLoader = new DefaultResourceLoader({
        cwd: config.dataDir,
        agentDir,
        additionalExtensionPaths: [FEATHER_PI_WEB],
        extensionFactories: [
          // Servers come only from the configured list, never from pi's own mcp.json files.
          createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }), logPath: join(agentDir, 'mcp.log') }),
          mcpServers(config.tools.mcpServers),
          // Registered inactive. The MCP extension turns them on for servers with `codemode` or
          // `deferred` exposure.
          createCodemodeExtension(),
          createToolSearchExtension(),
          toolGuard(allowTools),
          ...(schedulerExtension && onScheduled ? [scheduler(schedulerExtension, onScheduled)] : []),
          withoutCwd(),
        ],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt,
        // Read on every session open, so edits reach new threads. pi would take a missing path as
        // the text itself, and would look for its own APPEND_SYSTEM.md without an explicit list.
        appendSystemPrompt: existsSync(config.appendSystemPromptPath) ? [config.appendSystemPromptPath] : [],
      });
      await resourceLoader.reload();

      const { session } = await createAgentSession({
        cwd: config.dataDir,
        agentDir,
        model,
        thinkingLevel: llm.thinkingLevel,
        modelRuntime,
        resourceLoader,
        // No file or shell access: the bot only gets the extensions' tools.
        noTools: 'builtin',
        // pi's readers for MCP resources, declared even for servers without any.
        excludeTools: ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'],
        sessionManager: SessionManager.open(sessionFile(rootId), sessionDir, config.dataDir),
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } }),
      });
      // Starts the extensions, which connects the MCP servers.
      await session.bindExtensions({});
      return session;
    },

    async closeSession(session) {
      // As pi's own runtime does: dispose() alone leaves the extensions running.
      try {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      } catch (error) {
        console.error('Session shutdown failed:', error);
      }
      session.dispose();
    },
  };
}

function buildSystemPrompt(botUsername: string, servers: Record<string, McpServerConfig>, scheduler: boolean): string {
  return [
    `You are @${botUsername}, a Mattermost bot that gets things done with your tools.`,
    'Each user message holds one or more Mattermost posts from a thread, as "@username (time): text". Several people can take part in one thread.',
    'Your reply is posted to the thread as Mattermost markdown.',
    'What you change happens in the real world. Look before you change anything: get the current state first, and only change things in a later step, once you have seen it. Never send a change in the same batch as the look.',
    'Change only what the request covers: "the lights that are on" means those lights. Act on a whole group, such as every light, only when asked for all of it, and do not turn things on or off to get there.',
    'If a wrong guess would be hard to undo, ask first.',
    'If a tool call fails or is blocked, say so plainly. Never say you did something unless a tool result confirms it.',
    'Do only what you are asked. Do not take other actions on your own, such as announcing or notifying.',
    'Cite the URLs of web sources you use.',
    ...(scheduler
      ? [
          'You only act while answering a post. To do anything later or repeatedly ("in 10 minutes", "at 6", "every morning"), call schedule: without it, nothing happens later, so never promise it. Never do it right away instead. If schedule refuses, say why and do nothing.',
          'A due job reaches you as "Scheduled job <id> is due (time): <prompt>"; do what it says, and your reply is posted to the thread.',
        ]
      : []),
    ...directServers(servers),
  ].join('\n');
}

/**
 * What the servers with directly declared tools offer, from their `description`s. pi lists only the
 * other servers, in its `mcp_servers` section; this matches its format.
 */
export function directServers(servers: Record<string, McpServerConfig>): string[] {
  const lines = Object.entries(servers)
    .filter(([, config]) => config.exposure === 'direct' && config.enabled !== false && config.description?.trim())
    .map(([name, config]) => `- ${mcpNamespace(name)} (direct): ${config.description!.trim().split('\n', 1)[0]}`);
  return lines.length ? ['\nYour tools come from these MCP servers:', ...lines] : [];
}

/** Tool names are `mcp__<server>__<tool>`, with `-` in the server name replaced by `_`. */
function mcpNamespace(server: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_]/g, '_')}`;
}
