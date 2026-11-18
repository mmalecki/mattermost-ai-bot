#!/usr/bin/env node
import './env.ts';
import { join } from 'node:path';
import { createAgent } from './pi.ts';
import { loadConfig } from './config.ts';
import { Mattermost } from './mattermost.ts';
import { Schedules } from './schedules.ts';
import { Threads } from './threads.ts';

const config = loadConfig();
const servers = Object.keys(config.tools.mcpServers);
console.log(`MCP servers: ${servers.join(', ') || '(none)'}`);
if (servers.length && !config.tools.allowedUsers) console.warn('No allowedUsers in the MCP config: everyone can use every tool');
if (config.pickModel) console.log('Model picking: on');
for (const { name, owner } of config.schedules) {
  if (config.tools.allowedUsers && !config.tools.allowedUsers.has(owner)) {
    console.warn(`Schedule "${name}": its owner @${owner} isn't in allowedUsers, so its runs get no tools`);
  }
}

const mattermost = await Mattermost.connect(config.mattermost.url, config.mattermost.token);
const agent = await createAgent(config, mattermost.botUsername);
const threads = new Threads(agent, mattermost, {
  botUserId: mattermost.botUserId,
  allowedUsers: config.tools.allowedUsers,
  idleMs: config.idleMs,
  pickModel: config.pickModel,
});
// Made first, as it checks the jobs' models.
const schedules = new Schedules(config.schedules, {
  chat: mattermost,
  threads,
  agent,
  statePath: join(config.dataDir, 'schedules-state.json'),
});
mattermost.listen((post) => threads.handle(post));
schedules.start();

// Running threads finish their current run first: its posts are already marked seen, so a run cut
// short would never be answered. A second signal exits at once.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`${signal}: shutting down once running threads finish; ${signal} again to exit now`);
    mattermost.close();
    schedules.stop();
    threads.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('Shutdown failed:', error);
        process.exit(1);
      },
    );
  });
}
