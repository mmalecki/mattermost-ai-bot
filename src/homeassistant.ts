import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

export const SERVER_NAME = 'homeassistant';
const TOOL_PREFIX = `mcp__${SERVER_NAME}__`;

export interface HomeAssistantOptions {
  url: string;
  /** Whoever the agent is currently answering may use Home Assistant. Asked on every tool call. */
  allowed: () => boolean;
}

/**
 * Home Assistant's MCP server (the "Model Context Protocol Server" integration), with its tools
 * declared to the model directly: there are few of them, and small models handle direct tools best.
 * The token is read from HASS_TOKEN when the connection opens, so it never enters the config.
 */
export function homeAssistant({ url, allowed }: HomeAssistantOptions): ExtensionFactory {
  return (pi) => {
    pi.registerMcpServer(SERVER_NAME, {
      url: `${url}/api/mcp`,
      headers: { Authorization: 'Bearer ${HASS_TOKEN}' },
      exposure: 'direct',
      description: 'Home Assistant: state and control of the devices in the home',
    });

    pi.on('tool_call', (event) => {
      if (!event.toolName.startsWith(TOOL_PREFIX) || allowed()) return;
      return { block: true, reason: 'This user is not allowed to use Home Assistant.' };
    });
  };
}
