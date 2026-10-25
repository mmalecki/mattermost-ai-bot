import { createAgent } from './agent.ts';
import { loadConfig } from './config.ts';
import { Mattermost } from './mattermost.ts';
import { Threads } from './threads.ts';

const config = loadConfig();
if (!config.homeAssistant) console.warn('HASS_SERVER or HASS_TOKEN is not set; Home Assistant is disabled');

const agent = await createAgent(config);
const mattermost = new Mattermost(config.mattermost.url, config.mattermost.token);
let threads: Threads | undefined;

await mattermost.connect((post) => threads?.handle(post));
threads = new Threads(agent, mattermost, {
  botUserId: mattermost.botUserId,
  allowedUsers: config.homeAssistant?.allowedUsers ?? new Set(),
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
