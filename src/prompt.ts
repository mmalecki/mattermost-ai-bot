// The system prompt: what the bot tells the model of itself, its thread, and the tools it has there.
import type { ExtensionFactory, McpServerConfig } from '@earendil-works/pi-coding-agent';
import { mcpNamespace } from './mcp.ts';

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

/**
 * Writes the system prompt for the tools the thread has. Before each run, `prompt` is given the tools
 * that are registered and `allowed`, so the prompt tells the model only how to use those, and it
 * replaces the prompt pi was given. Also drops the `<cwd>` section pi adds to every system prompt: the
 * bot has no file access, and a working directory invites the model to answer as if it were inside a
 * software project. Register it last: after the MCP extension, which registers direct servers' tools
 * before its own handler returns, and after the other extensions, so their sections are already in the
 * prompt it edits.
 */
export function threadPrompt(allowed: (toolName: string) => boolean, prompt: (tools: ReadonlySet<string>) => string): ExtensionFactory {
  return (pi) => {
    pi.on('before_agent_start', (event) => {
      // Set on the options rather than returned alone, so the sections pi records match what is sent.
      event.systemPromptOptions.customPrompt = prompt(new Set(pi.getAllTools().map((tool) => tool.name).filter(allowed)));
      return { systemPrompt: stripCwd(event.systemPrompt) };
    });
  };
}

export function stripCwd(systemPrompt: string): string {
  return systemPrompt.replace(/\n*<cwd>\n[\s\S]*?\n<\/cwd>/, '');
}
