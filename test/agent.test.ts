import assert from 'node:assert/strict';
import { test } from 'node:test';
import { directServers } from '../src/agent.ts';

test("lists what directly exposed servers offer, in the format of pi's mcp_servers section", () => {
  assert.deepEqual(
    directServers({
      'home-assistant': { url: 'http://ha/api/mcp', exposure: 'direct', description: 'The home\nMore detail' },
      docs: { url: 'http://docs/mcp', description: 'Product docs' },
      off: { url: 'http://off/mcp', exposure: 'direct', enabled: false, description: 'Disabled' },
      bare: { url: 'http://bare/mcp', exposure: 'direct' },
    }),
    ['\nYour tools come from these MCP servers:', '- mcp__home_assistant (direct): The home'],
  );
  assert.deepEqual(directServers({}), []);
});
