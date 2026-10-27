import { createAgent } from './agent.ts';
import { loadConfig } from './config.ts';
import { Mattermost } from './mattermost.ts';
import { Threads } from './threads.ts';

const config = loadConfig();
const servers = Object.keys(config.tools.mcpServers);
console.log(`MCP servers: ${servers.join(', ') || '(none)'}`);
if (servers.length && !config.tools.allowedUsers) console.warn('No allowedUsers in the MCP config: everyone can use every tool');

const mattermost = new Mattermost(config.mattermost.url, config.mattermost.token);
await mattermost.login();
const agent = await createAgent(config, mattermost.botUsername);
const threads = new Threads(agent, mattermost, {
  botUserId: mattermost.botUserId,
  allowedUsers: config.tools.allowedUsers,
  idleMs: 15 * 60_000,
});
mattermost.listen((post) => threads.handle(post));

// Running threads finish their current run first: its posts are already marked seen, so a run cut
// short would never be answered. A second signal exits at once.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`${signal}: shutting down once running threads finish; ${signal} again to exit now`);
    mattermost.close();
    threads
      .close()
      .catch((error: unknown) => console.error('Shutdown failed:', error))
      .finally(() => process.exit(0));
  });
}
