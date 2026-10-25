import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { homeAssistant } from '../src/homeassistant.ts';

function load(allowed: boolean) {
  const servers: Record<string, unknown> = {};
  let onToolCall: ((event: { toolName: string }) => unknown) | undefined;
  const pi = {
    registerMcpServer: (name: string, config: unknown) => (servers[name] = config),
    on: (event: string, handler: typeof onToolCall) => event === 'tool_call' && (onToolCall = handler),
  };
  homeAssistant({ url: 'http://ha.local:8123', allowed: () => allowed })(pi as unknown as ExtensionAPI);
  return { servers, toolCall: (toolName: string) => onToolCall!({ toolName }) };
}

test("registers HA's MCP server with direct tools and the token from the environment", () => {
  const { servers } = load(true);
  assert.deepEqual(servers.homeassistant, {
    url: 'http://ha.local:8123/api/mcp',
    headers: { Authorization: 'Bearer ${HASS_TOKEN}' },
    exposure: 'direct',
    description: 'Home Assistant: state and control of the devices in the home',
  });
});

test('blocks Home Assistant tools for users off the allowlist', () => {
  assert.equal(load(true).toolCall('mcp__homeassistant__intent__HassTurnOn'), undefined);
  assert.deepEqual(load(false).toolCall('mcp__homeassistant__intent__HassTurnOn'), {
    block: true,
    reason: 'This user is not allowed to use Home Assistant.',
  });
  assert.equal(load(false).toolCall('websearch'), undefined);
});
