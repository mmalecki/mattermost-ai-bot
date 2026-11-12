import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSystemPrompt, directServers, permalink, stripCwd } from '../src/prompt.ts';

test("lists what directly exposed servers the thread has tools of offer, in the format of pi's mcp_servers section", () => {
  const servers = {
    'home-assistant': { url: 'http://ha/api/mcp', exposure: 'direct', description: 'The home\nMore detail' },
    lights: { url: 'http://lights/mcp', exposure: 'direct', description: 'The lights' },
    docs: { url: 'http://docs/mcp', description: 'Product docs' },
    off: { url: 'http://off/mcp', exposure: 'direct', enabled: false, description: 'Disabled' },
    bare: { url: 'http://bare/mcp', exposure: 'direct' },
  } as const;
  // mcp__lights_extra's tool is another server's, not one of mcp__lights'.
  const tools = new Set(['mcp__home_assistant__HassTurnOn', 'mcp__lights_extra__on', 'mcp__docs__search', 'mcp__off__x', 'mcp__bare__y']);
  assert.deepEqual(directServers(servers, tools), ['\nYour tools come from these MCP servers:', '- mcp__home_assistant (direct): The home']);
  assert.deepEqual(directServers(servers, new Set()), []);
  assert.deepEqual(directServers({}, tools), []);
});

const promptOptions = { botUsername: 'sailor', servers: {}, tools: new Set<string>(), images: false, imageEdits: false, imageServers: {}, serverUrl: 'https://chat.example', rootId: 'r1' };
/** promptOptions, with the thread having `tools`. */
const withTools = (...tools: string[]) => ({ ...promptOptions, tools: new Set(tools) });

test('links posts without their team, and gives the model the thread\'s link', () => {
  assert.equal(permalink('https://chat.example', 'p1'), 'https://chat.example/_redirect/pl/p1');
  assert.match(buildSystemPrompt(promptOptions), /This thread's link is https:\/\/chat\.example\/_redirect\/pl\/r1, and a post's is https:\/\/chat\.example\/_redirect\/pl\/<id>/);
});

test('tells the model how images come only when it takes them', () => {
  assert.match(buildSystemPrompt({ ...promptOptions, images: true }), /\[image <n>: name\]/);
  assert.doesNotMatch(buildSystemPrompt(promptOptions), /\[image/);
});

test('tells the model about schedule only when the thread has it', () => {
  assert.match(buildSystemPrompt(withTools('schedule')), /call schedule/);
  assert.doesNotMatch(buildSystemPrompt(promptOptions), /schedule/);
});

test('tells the model its generated images are attached only when the thread has generate_image', () => {
  assert.match(buildSystemPrompt(withTools('generate_image')), /generate_image is attached to your reply/);
  assert.doesNotMatch(buildSystemPrompt(promptOptions), /generate_image/);
});

test('tells the model how to give generate_image images only when it takes them, and the thread has it', () => {
  assert.match(buildSystemPrompt({ ...withTools('generate_image'), imageEdits: true }), /pass its name to generate_image in images/);
  assert.doesNotMatch(buildSystemPrompt(withTools('generate_image')), /pass its name to generate_image/);
  assert.doesNotMatch(buildSystemPrompt({ ...promptOptions, imageEdits: true }), /generate_image/);
});

test('tells the model about the vision tools the thread has', () => {
  // A model that doesn't see images, with VISION_MODEL's tools.
  const blind = buildSystemPrompt(withTools('look_at_image', 'locate', 'crop_image'));
  assert.match(blind, /ask look_at_image/);
  assert.match(blind, /To work on a part of an image, .* find it with locate, and cut it out with crop_image, by the image's name: the new image can go to look_at_image, or to any tool that takes images\./);
  const withoutLookAt = buildSystemPrompt(withTools('locate', 'crop_image'));
  assert.doesNotMatch(withoutLookAt, /look_at_image/);
  assert.match(withoutLookAt, /cut it out with crop_image, by the image's name: the new image can go to any tool that takes images\./);

  // A model that sees images has no look_at_image.
  const seeing = buildSystemPrompt({ ...withTools('locate', 'crop_image'), images: true });
  assert.doesNotMatch(seeing, /look_at_image/);
  assert.match(seeing, /To look closer at a part of an image, .* find it with locate, and cut it out with crop_image, by the image's name\./);
  assert.match(buildSystemPrompt({ ...withTools('crop_image'), images: true }), /To look closer at a part of an image, such as a barcode, a label or small text, cut it out with crop_image/);

  assert.doesNotMatch(buildSystemPrompt({ ...promptOptions, images: true }), /look_at_image|locate|crop_image/);
  assert.doesNotMatch(buildSystemPrompt(withTools('locate')), /look_at_image|locate|crop_image/);
});

test('tells the model which servers the thread has tools of take images by name', () => {
  const imageServers = { 'bar-codes': ['base64'], vision: ['image', 'url'] };
  assert.match(
    buildSystemPrompt({ ...withTools('mcp__bar_codes__decode', 'mcp__vision__describe'), imageServers }),
    /take images by name, in these arguments: mcp__bar_codes in base64; mcp__vision in image or url\./,
  );
  assert.match(buildSystemPrompt({ ...withTools('mcp__bar_codes__decode'), imageServers }), /in these arguments: mcp__bar_codes in base64\./);
  assert.doesNotMatch(buildSystemPrompt({ ...promptOptions, imageServers }), /take images by name/);
});


test("drops only pi's cwd section from the system prompt", () => {
  const prompt = 'You are a bot.\n\n<mcp_servers>\n- docs: search\n</mcp_servers>\n\n<cwd>\n/srv/bot/data\n</cwd>';
  assert.equal(stripCwd(prompt), 'You are a bot.\n\n<mcp_servers>\n- docs: search\n</mcp_servers>');
  assert.equal(stripCwd('You are a bot.'), 'You are a bot.');
});
