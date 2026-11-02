import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSystemPrompt, directServers, permalink } from '../src/agent.ts';

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

const promptOptions = { botUsername: 'sailor', servers: {}, scheduler: false, images: false, serverUrl: 'https://chat.example', rootId: 'r1' };

test('links posts without their team, and gives the model the thread\'s link', () => {
  assert.equal(permalink('https://chat.example', 'p1'), 'https://chat.example/_redirect/pl/p1');
  assert.match(buildSystemPrompt(promptOptions), /This thread's link is https:\/\/chat\.example\/_redirect\/pl\/r1, and a post's is https:\/\/chat\.example\/_redirect\/pl\/<id>/);
});

test('tells the model how images come only when it takes them', () => {
  assert.match(buildSystemPrompt({ ...promptOptions, images: true }), /\[image <n>: name\]/);
  assert.doesNotMatch(buildSystemPrompt(promptOptions), /\[image/);
});
