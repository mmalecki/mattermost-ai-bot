import { createAgent } from './agent.ts';
import { loadConfig } from './config.ts';
import { Mattermost } from './mattermost.ts';
import { Threads } from './threads.ts';

const config = loadConfig();
const servers = Object.keys(config.tools.mcpServers);
console.log(`MCP servers: ${servers.join(', ') || '(none)'}`);
if (servers.length && !config.tools.allowedUsers) console.warn('No allowedUsers in the MCP config: everyone can use every tool');

const mattermost = new Mattermost(config.mattermost.url, config.mattermost.token);
let threads: Threads | undefined;

await mattermost.connect((post) => threads?.handle(post));
const agent = await createAgent(config, mattermost.botUsername);
threads = new Threads(agent, mattermost, {
  botUserId: mattermost.botUserId,
  allowedUsers: config.tools.allowedUsers,
  idleMs: 15 * 60_000,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.log(`${signal}: shutting down`);
    mattermost.close();
    threads?.dispose();
    process.exit(0);
  });
}
