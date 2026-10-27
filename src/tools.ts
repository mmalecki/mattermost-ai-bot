import type { ExtensionFactory, McpServerConfig } from '@earendil-works/pi-coding-agent';

const BLOCKED = 'Tools are off in this thread: someone who has posted in it is not allowed to use them.';

/**
 * Registers the configured MCP servers with pi's MCP extension, which validates each config and
 * resolves `${VAR}` references in it when connecting. An invalid server is reported and skipped.
 */
export function mcpServers(servers: Record<string, McpServerConfig>): ExtensionFactory {
  return (pi) => {
    for (const [name, config] of Object.entries(servers)) {
      try {
        pi.registerMcpServer(name, config);
      } catch (error) {
        console.error(`MCP server "${name}" skipped:`, error instanceof Error ? error.message : error);
      }
    }
  };
}

/**
 * Drops the `<cwd>` section pi adds to every system prompt. The bot has no file access, and a working
 * directory invites the model to answer as if it were inside a software project. Register it last,
 * so the other extensions' sections are already in the prompt it edits.
 */
export function withoutCwd(): ExtensionFactory {
  return (pi) => {
    pi.on('before_agent_start', (event) => ({ systemPrompt: stripCwd(event.systemPrompt) }));
  };
}

export function stripCwd(systemPrompt: string): string {
  return systemPrompt.replace(/\n*<cwd>\n[\s\S]*?\n<\/cwd>/, '');
}

/**
 * Blocks every tool call, nested ones from codemode scripts included, unless everyone in the thread
 * may use tools. Asked on every call, with the tool's name.
 */
export function toolGuard(allowed: (toolName: string) => boolean): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', (event) => (allowed(event.toolName) ? undefined : { block: true, reason: BLOCKED }));
  };
}
