import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImageContent } from '@earendil-works/pi-ai';
import {
  type AgentSession,
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  type SessionEntry,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { type Config, type ModelChoice, parseModel } from './config.ts';
import { errorMessage } from './error.ts';
import { toolGuard } from './guard.ts';
import { imageGeneration, toolImages } from './image-tools.ts';
import { imageFiles, ThreadImages } from './images.ts';
import { mcpImages, mcpServers } from './mcp.ts';
import { buildSystemPrompt, threadPrompt } from './prompt.ts';
import { type ScheduledJob, scheduler } from './scheduler.ts';
import { imageCrop, VISION_TOOLS, vision } from './vision.ts';

// Published as TypeScript, which Node won't strip under node_modules, so pi loads it like any
// installed pi package.
const FEATHER_PI_WEB = dirname(fileURLToPath(import.meta.resolve('@mmalecki/feather-pi-web/package.json')));

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
  // Keys come from pi's own variables, such as MISTRAL_API_KEY, or from models.json.
  const requireKey = (provider: string) => {
    if (!modelRuntime.getProviderAuthStatus(provider).configured) {
      throw new Error(`No API key for ${provider}: set its variable, such as ${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`);
    }
  };
  /** The catalog's model, with its output capped. `what` names it in errors. */
  const findModel = (what: string, provider: string, id: string) => {
    const found = modelRuntime.getModel(provider, id);
    if (!found) throw new Error(`${what} ${provider}/${id} is neither in pi's catalog nor in ${llm.modelsPath}`);
    requireKey(provider);
    return { ...found, maxTokens: Math.min(found.maxTokens, llm.maxTokens) };
  };
  const model = findModel('MODEL', llm.provider, llm.model);
  console.log(
    `Model: ${llm.provider}/${llm.model} (${model.api}, thinking ${llm.thinkingLevel}, max ${model.maxTokens} tokens${model.input.includes('image') ? ', images' : ''})`,
  );

  /**
   * The model a session runs on: the one it was created with, as pi records it, or for a new session
   * `choice`. A recorded model that is gone since, or has lost its key, gives way to MODEL.
   */
  const sessionModel = (rootId: string, sessionManager: SessionManager, choice: ModelChoice | undefined) => {
    const recorded = sessionManager.buildSessionContext();
    if (recorded.model) {
      const { provider, modelId } = recorded.model;
      try {
        return { model: findModel('Model', provider, modelId), thinkingLevel: recorded.thinkingLevel as ModelChoice['thinkingLevel'] };
      } catch (error) {
        console.warn(`Thread ${rootId}: ${errorMessage(error)}; running it on MODEL instead`);
        return { model, thinkingLevel: llm.thinkingLevel };
      }
    }
    if (!choice) return { model, thinkingLevel: llm.thinkingLevel };
    return { model: findModel('Model', choice.provider, choice.model), thinkingLevel: choice.thinkingLevel };
  };

  const imageModel = config.imageModel && modelRuntime.getModelOfType('image', config.imageModel.provider, config.imageModel.model);
  if (config.imageModel) {
    const { provider, model: id } = config.imageModel;
    if (!imageModel) throw new Error(`IMAGE_MODEL ${provider}/${id} is neither an image model in pi's catalog nor in ${llm.modelsPath}`);
    requireKey(provider);
    console.log(`Image model: ${provider}/${id}${imageModel.input.includes('image') ? ', edits images' : ''}`);
  }

  const visionModel = config.visionModel && findModel('VISION_MODEL', config.visionModel.provider, config.visionModel.model);
  if (visionModel) {
    if (!visionModel.input.includes('image')) throw new Error(`VISION_MODEL ${visionModel.provider}/${visionModel.id} doesn't take images`);
    console.log(`Vision model: ${visionModel.provider}/${visionModel.id} (thinking ${config.visionModel!.thinkingLevel})`);
  }

  if (config.scheduler) console.log('Scheduler: on');

  /** A thread's directory, which holds its session and its images. */
  const threadDir = (rootId: string) => join(sessionDir, rootId);
  const sessionFile = (rootId: string) => join(threadDir(rootId), 'session.jsonl');
  // Threads with a session file, kept here rather than looked up on every post. pi writes the file
  // with the first prompt, so a thread counts from then on.
  const sessions = new Set(existsSync(sessionDir) ? readdirSync(sessionDir).filter((rootId) => existsSync(sessionFile(rootId))) : []);

  async function closeSession(session: AgentSession): Promise<void> {
    // As pi's own runtime does: dispose() alone leaves the extensions running.
    try {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    } catch (error) {
      console.error('Session shutdown failed:', error);
    }
    session.dispose();
  }

  const imageEdits = !!imageModel?.input.includes('image');
  const { serverImages } = config.tools;
  /** Whether some tool takes images, such as generate_image to change them, so posts' images are kept for it. */
  const imageTools = imageEdits || !!visionModel || Object.keys(serverImages).length > 0;

  return {
    hasSession: (rootId) => sessions.has(rootId),

    pickModel(ref) {
      let choice;
      try {
        choice = parseModel(ref);
      } catch {
        return undefined;
      }
      const { provider, model: id } = choice;
      if (!modelRuntime.getProvider(provider)) return undefined;
      // Said in the thread, so without the paths and variables of findModel's errors.
      if (!modelRuntime.getModel(provider, id)) throw new Error(`there is no model ${provider}/${id}`);
      if (!modelRuntime.getProviderAuthStatus(provider).configured) throw new Error(`there is no API key for ${provider}`);
      return choice;
    },

    async openSession(rootId, { model: choice, allowTools, onScheduled }) {
      mkdirSync(threadDir(rootId), { recursive: true });
      const sessionManager = SessionManager.open(sessionFile(rootId), threadDir(rootId), config.dataDir);
      const { model, thinkingLevel } = sessionModel(rootId, sessionManager, choice);
      const images = model.input.includes('image');
      const imageStore = new ThreadImages(imageFiles(join(threadDir(rootId), 'images')));
      const keepsImages = images || imageTools;
      const promptOptions = {
        botUsername,
        servers: config.tools.mcpServers,
        images,
        imageEdits,
        imageServers: Object.fromEntries(Object.entries(serverImages).map(([name, args]) => [name, Object.keys(args)])),
        serverUrl: config.mattermost.publicUrl,
        rootId,
      };
      const prompt = (tools: ReadonlySet<string>) => buildSystemPrompt({ ...promptOptions, tools });
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
          ...(config.scheduler ? [scheduler(rootId, onScheduled)] : []),
          ...(imageModel ? [imageGeneration(modelRuntime, imageModel, imageStore)] : []),
          ...(visionModel ? [vision(modelRuntime, visionModel, config.visionModel!.thinkingLevel, imageStore, images)] : []),
          // A model that sees images crops them to look closer, as pi scales them down.
          ...(images || visionModel ? [imageCrop(imageStore, images)] : []),
          ...(keepsImages ? [toolImages(imageStore, ['generate_image', ...VISION_TOOLS]), mcpImages(serverImages, imageStore)] : []),
          threadPrompt(allowTools, prompt),
        ],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        // threadPrompt replaces it before every run, once the thread's tools are known.
        systemPrompt: prompt(new Set()),
        // Read on every session open, so edits reach new threads. pi would take a missing path as
        // the text itself, and would look for its own APPEND_SYSTEM.md without an explicit list.
        appendSystemPrompt: existsSync(config.appendSystemPromptPath) ? [config.appendSystemPromptPath] : [],
      });
      await resourceLoader.reload();

      const { session } = await createAgentSession({
        cwd: config.dataDir,
        agentDir,
        model,
        thinkingLevel,
        modelRuntime,
        resourceLoader,
        // No file or shell access: the bot only gets the extensions' tools.
        noTools: 'builtin',
        // pi ignores its `defaultTools` setting under `noTools`, but still applies `+name` entries here.
        ...(config.codemode ? { tools: ['+codemode'] } : {}),
        // pi's readers for MCP resources, declared even for servers without any.
        excludeTools: ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'],
        sessionManager,
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } }),
      });
      // Starts the extensions, which connects the MCP servers. pi catches what their handlers throw and
      // only reports it here; anything else that fails shuts the session down again.
      try {
        await session.bindExtensions({
          onError: (e) => console.error(`Extension ${e.extensionPath} failed on ${e.event}: ${e.error}`),
        });
      } catch (error) {
        await closeSession(session);
        throw error;
      }
      return {
        model: { provider: model.provider, model: model.id, thinkingLevel },
        takesImages: images,
        images: imageStore,
        keepsImages,
        get messages() {
          return session.messages;
        },
        prompt: (text, images = []) => {
          sessions.add(rootId);
          return session.prompt(text, { expandPromptTemplates: false, images });
        },
        abort: () => session.abort(),
        entries: () => session.sessionManager.getEntries(),
        appendEntry: (customType, data) => session.sessionManager.appendCustomEntry(customType, data),
        close: () => closeSession(session),
      };
    },
  };
}
