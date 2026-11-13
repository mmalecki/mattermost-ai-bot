import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

/** Why a call is blocked. Every tool may be off, so this doesn't say others are left. */
const blocked = (toolName: string) => `${toolName} is off in this thread: someone who has posted in it is not allowed to use it.`;

/**
 * Keeps the model to the tools everyone in the thread may use. Before each run and turn, tools that
 * aren't allowed are taken off the ones declared to the model, which also keeps codemode scripts from
 * calling `direct` ones. A thread's tools only shrink while its session is open, so this only takes
 * tools away: a reopened session declares them afresh, and has them taken away again. And it
 * blocks every tool call, nested ones from codemode scripts included, unless allowed: tools reached
 * through codemode or tool_search are never declared, and a tool registered during a run, such as one
 * of an MCP server still connecting, is declared until the next turn. Asked with each tool's name.
 */
export function toolGuard(allowed: (toolName: string) => boolean): ExtensionFactory {
  return (pi) => {
    const narrow = () => {
      const active = pi.getActiveTools();
      const kept = active.filter((name) => allowed(name));
      if (kept.length < active.length) pi.setActiveTools(kept);
    };
    pi.on('before_agent_start', narrow);
    pi.on('turn_start', narrow);
    pi.on('tool_call', (event) => (allowed(event.toolName) ? undefined : { block: true, reason: blocked(event.toolName) }));
  };
}
