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
  type McpServerConfig,
  ModelRuntime,
  type SessionEntry,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { type Config, type ModelChoice, parseModel } from './config.ts';
import { errorMessage } from './error.ts';
import { type ScheduledJob, scheduler } from './scheduler.ts';
import { type ImageFiles, type ImageStore, imageFiles } from './images.ts';
import { imageGeneration, mcpImages, mcpNamespace, mcpServers, threadPrompt, toolGuard, toolImages } from './tools.ts';
import { imageCrop, VISION_TOOLS, vision } from './vision.ts';

// Published as TypeScript, which Node won't strip under node_modules, so pi loads it like any
// installed pi package.
const FEATHER_PI_WEB = dirname(fileURLToPath(import.meta.resolve('@mmalecki/feather-pi-web/package.json')));

export interface Agent {
  /** Whether some tool takes images, such as generate_image to change them, so posts' images are kept for it. */
  readonly imageTools: boolean;
  /** Whether the thread has a session from an earlier run. */
  hasSession(rootId: string): boolean;
  /** The thread's images, kept in its directory. */
  images(rootId: string): ImageFiles;
  /**
   * Parses `ref`, written `provider/model[:thinking]`, as a model to run a thread on. Returns
   * undefined when pi knows no such provider, so `ref` is ordinary text rather than a model. Throws
   * when the provider is known but lacks the model or an API key; the message is meant for the thread.
   */
  pickModel(ref: string): ModelChoice | undefined;
  /**
   * Opens the thread's session, creating it on first use. A new session runs on `model`, MODEL's by
   * default; an existing one on the model it was created with. With the scheduler on, `onScheduled`
   * gets the thread's scheduled jobs as they come due; without it, the session can't schedule any.
   * With some tool taking images, or IMAGE_MODEL set, `imageStore` keeps the images tools make and
   * return, and finds those they're given.
   */
  openSession(
    rootId: string,
    options: {
      model?: ModelChoice;
      allowTools: (toolName: string) => boolean;
      onScheduled?: (job: ScheduledJob) => void;
      imageStore?: ImageStore;
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
  const imageTools = imageEdits || !!visionModel || Object.keys(serverImages).length > 0;

  return {
    imageTools,
    hasSession: (rootId) => sessions.has(rootId),
    images: (rootId) => imageFiles(join(threadDir(rootId), 'images')),

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

    async openSession(rootId, { model: choice, allowTools, onScheduled, imageStore }) {
      mkdirSync(threadDir(rootId), { recursive: true });
      const sessionManager = SessionManager.open(sessionFile(rootId), threadDir(rootId), config.dataDir);
      const { model, thinkingLevel } = sessionModel(rootId, sessionManager, choice);
      const images = model.input.includes('image');
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
          ...(config.scheduler && onScheduled ? [scheduler(rootId, onScheduled)] : []),
          ...(imageModel && imageStore ? [imageGeneration(modelRuntime, imageModel, imageStore)] : []),
          ...(visionModel && imageStore ? [vision(modelRuntime, visionModel, config.visionModel!.thinkingLevel, imageStore, images)] : []),
          // A model that sees images crops them to look closer, as pi scales them down.
          ...((images || visionModel) && imageStore ? [imageCrop(imageStore, images)] : []),
          ...((images || imageTools) && imageStore ? [toolImages(imageStore, ['generate_image', ...VISION_TOOLS]), mcpImages(serverImages, imageStore)] : []),
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

export interface SystemPromptOptions {
  /** The bot's Mattermost username, so the model knows when it is addressed. */
  botUsername: string;
  servers: Record<string, McpServerConfig>;
  /**
   * The tools the thread has, by the names the model sees: lines about other tools, and about servers
   * none of whose tools are here, are left out.
   */
  tools: ReadonlySet<string>;
  /** Whether the model takes images. */
  images: boolean;
  /** Whether generate_image takes images to change. */
  imageEdits: boolean;
  /** The MCP servers that take images by name, with the arguments they take them in. */
  imageServers: Record<string, string[]>;
  /** Where people open the server, for links. */
  serverUrl: string;
  /** The thread's root post, so its link can be given. */
  rootId: string;
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const { botUsername, servers, tools, images, imageEdits, imageServers, serverUrl, rootId } = options;
  const has = (tool: string) => tools.has(tool);
  const imageArguments = Object.entries(imageServers)
    .filter(([name]) => hasServerTools(tools, name))
    .map(([name, args]) => `${mcpNamespace(name)} in ${args.join(' or ')}`);
  return [
    `You are @${botUsername}, a Mattermost bot that gets things done with your tools.`,
    'Each user message holds one or more Mattermost posts from a thread, as "@username (time, post <id>): text". Several people can take part in one thread.',
    `The files attached to a post are listed after its text.${images ? ' Images you can see are "[image <n>: name]", and come at the end of the message, in that order.' : ''}`,
    `This thread's link is ${permalink(serverUrl, rootId)}, and a post's is ${permalink(serverUrl, '<id>')}: use them to point to the thread or a post in it.`,
    'Your reply is posted to the thread as Mattermost markdown.',
    'What you change happens in the real world. Look before you change anything: get the current state first, and only change things in a later step, once you have seen it. Never send a change in the same batch as the look.',
    'Change only what the request covers: "the lights that are on" means those lights. Act on a whole group, such as every light, only when asked for all of it, and do not turn things on or off to get there.',
    'If a wrong guess would be hard to undo, ask first.',
    'If a tool call fails or is blocked, say so plainly. Never say you did something unless a tool result confirms it.',
    'Do only what you are asked. Do not take other actions on your own, such as announcing or notifying.',
    'Cite the URLs of web sources you use.',
    ...(has('schedule')
      ? [
          'You only act while answering a post. To do anything later or repeatedly ("in 10 minutes", "at 6", "every morning"), call schedule: without it, nothing happens later, so never promise it. Never do it right away instead. If schedule refuses, say why and do nothing.',
          'A due job reaches you as "Scheduled job <id> is due (time): <prompt>"; do what it says, and your reply is posted to the thread.',
        ]
      : []),
    ...(has('generate_image')
      ? ['Every image you make with generate_image is attached to your reply, in the order you made them. Do not link to them or write them out in your reply.']
      : []),
    ...(has('generate_image') && imageEdits
      ? [
          'To change an image, or make one from it, pass its name to generate_image in images: one posted in the thread by the name on its [image] line, one you generated or a tool returned by the name it was saved as. Say what to change in the prompt.',
        ]
      : []),
    // A model that sees images has no look_at_image: it looks for itself.
    ...(has('look_at_image') ? ['To learn what is in images in this thread, ask look_at_image, by their names.'] : []),
    ...(has('crop_image')
      ? [
          `To ${images ? 'look closer at' : 'work on'} a part of an image, such as a barcode, a label or small text, ${has('locate') ? 'find it with locate, and ' : ''}cut it out with crop_image, by the image's name${images ? '' : `: the new image can go to ${has('look_at_image') ? 'look_at_image, or to ' : ''}any tool that takes images`}.`,
        ]
      : []),
    ...(imageArguments.length
      ? [
          `These tools take images by name, in these arguments: ${imageArguments.join('; ')}. Give the name of an image in this thread there, from its [image] line or the name it was saved as, never in another argument, and the image is passed on as the tool takes it.`,
        ]
      : []),
    ...directServers(servers, tools),
  ].join('\n');
}

/**
 * What the servers with directly declared tools offer, from their `description`s, of those `tools` has
 * some of. pi lists only the other servers, in its `mcp_servers` section; this matches its format.
 */
export function directServers(servers: Record<string, McpServerConfig>, tools: ReadonlySet<string>): string[] {
  const lines = Object.entries(servers)
    .filter(([name, config]) => config.exposure === 'direct' && config.enabled !== false && config.description?.trim() && hasServerTools(tools, name))
    .map(([name, config]) => `- ${mcpNamespace(name)} (direct): ${config.description!.trim().split('\n', 1)[0]}`);
  return lines.length ? ['\nYour tools come from these MCP servers:', ...lines] : [];
}

/** Whether `tools` has some of `server`'s, which the model sees as `mcp__<server>__<tool>`. */
function hasServerTools(tools: ReadonlySet<string>, server: string): boolean {
  const prefix = `${mcpNamespace(server)}__`;
  return [...tools].some((tool) => tool.startsWith(prefix));
}

/**
 * A link to the post that works without its team's name, which Mattermost looks up. A thread's link
 * is its root post's.
 */
export function permalink(serverUrl: string, postId: string): string {
  return `${serverUrl}/_redirect/pl/${postId}`;
}
