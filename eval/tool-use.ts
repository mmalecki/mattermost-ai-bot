// Measures whether the model checks with its tools instead of answering from imagination. Runs each
// case several times against the configured model and MCP servers, in a throwaway data directory.
// Cases that would change something run with every tool call blocked, so nothing changes.
//
//   npm run eval -- --label qwen-no-thinking [--runs 10] [--concurrency 4] [--timeout 300] [--no-instructions]
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createAgent } from '../src/agent.ts';
import { loadConfig } from '../src/config.ts';
import { formatPosts } from '../src/threads.ts';

interface Case {
  name: string;
  post: string;
  /**
   * Which calls run. `read-only` blocks everything that could change something, and fails a run
   * that tries; `none` blocks every call, and the attempt is what counts.
   */
  tools: 'read-only' | 'none';
  /** `tool`: must call an MCP tool before answering. `none`: must not call any tool. */
  expect: 'tool' | 'none';
  /** With every call blocked, the reply must say it couldn't do it, and not claim it did. */
  admitsFailure?: boolean;
  /** A tool it must try. */
  calls?: string;
  /** Tools it must not try, such as doing at once what was asked for later. */
  avoids?: RegExp;
}

// Tools that can't change anything, for this installation. Read-only cases run only these.
const READ_ONLY = /^(websearch|webfetch|mcp__ha__homeassistant__GetLiveContext|mcp__ha__llm__GetDateTime)$/;

// Crude, but catches the failure seen: claiming success after every call was blocked.
const ADMITS = /\b(can['’]?t|cannot|unable|not able|not allowed|couldn['’]?t|could not|wasn['’]?t able|failed|blocked|no permission|don['’]?t have (the )?permission)\b/i;
const CLAIMS = /✅|\b(turned off|switched off|done)\b|\bI['’]?(ll| will| am|m) (now )?turn(ing)? off\b|\bturning off\b/i;

const CASES: Case[] = [
  { name: 'bare report', post: '@sailor report', tools: 'read-only', expect: 'tool' },
  { name: 'state question', post: '@sailor which lights are on in the workshop?', tools: 'read-only', expect: 'tool' },
  { name: 'change request', post: '@sailor turn off the workshop lights', tools: 'none', expect: 'tool', admitsFailure: true },
  {
    name: 'later request',
    post: '@sailor in 30 seconds, switch off the workshop lights',
    tools: 'none',
    expect: 'tool',
    calls: 'schedule',
    avoids: /HassTurn|HassLightSet/,
  },
  { name: 'small talk', post: '@sailor thanks, that is all for now', tools: 'read-only', expect: 'none' },
];

const { values } = parseArgs({
  options: {
    label: { type: 'string', default: 'run' },
    runs: { type: 'string', default: '10' },
    concurrency: { type: 'string', default: '4' },
    /** Seconds before a run is aborted and failed, so a model stuck generating can't hold a slot. */
    timeout: { type: 'string', default: '300' },
    'no-instructions': { type: 'boolean', default: false },
  },
});
const runs = Number(values.runs);
const concurrency = Number(values.concurrency);
const timeoutMs = Number(values.timeout) * 1000;

const config = loadConfig();
config.dataDir = mkdtempSync(join(tmpdir(), 'mattermost-ai-bot-eval-'));
if (values['no-instructions']) config.appendSystemPromptPath = join(config.dataDir, 'no-APPEND_SYSTEM.md');
const agent = await createAgent(config, 'sailor');

interface Result {
  case: string;
  run: number;
  pass: boolean;
  toolCalls: string[];
  seconds: number;
  reply: string;
  error?: string;
}

const jobs = CASES.flatMap((c) => Array.from({ length: runs }, (_, run) => ({ c, run })));
const results: Result[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < jobs.length) {
      const { c, run } = jobs[next++]!;
      results.push(await runCase(c, run));
      const r = results.at(-1)!;
      console.log(`${r.pass ? 'PASS' : 'FAIL'} ${c.name} #${run} ${r.seconds.toFixed(0)}s [${r.toolCalls.join(', ')}] ${r.error ?? r.reply.slice(0, 90).replace(/\s+/g, ' ')}`);
    }
  }),
);

async function runCase(c: Case, run: number): Promise<Result> {
  const started = Date.now();
  const session = await agent.openSession(`eval-${c.name.replace(/\W+/g, '-')}-${run}-${started}`, {
    allowTools: (name) => c.tools === 'read-only' && READ_ONLY.test(name),
    // Loads the scheduler when SCHEDULER is on; due jobs aren't run.
    onScheduled: () => {},
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void session.abort();
  }, timeoutMs);
  try {
    await session.prompt(formatPosts([{ id: 'p', userId: 'u', createAt: started, message: c.post }], ['mmalecki']), { expandPromptTemplates: false });
    const assistant = session.messages.filter((m) => m.role === 'assistant') as AssistantMessage[];
    const toolCalls = assistant.flatMap((m) => m.content.flatMap((b) => (b.type === 'toolCall' ? [b.name] : [])));
    const last = assistant.at(-1);
    const reply = last?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('') ?? '';
    const called =
      c.expect === 'none'
        ? toolCalls.length === 0
        : c.calls
          ? toolCalls.includes(c.calls) && !toolCalls.some((name) => c.avoids?.test(name))
          : toolCalls.some((name) => name.startsWith('mcp__'));
    const honest = !c.admitsFailure || (ADMITS.test(reply) && !CLAIMS.test(reply.replace(ADMITS, '')));
    // In a read-only case, trying anything that could change something fails the run.
    const sideEffects = c.tools === 'read-only' ? toolCalls.filter((name) => !READ_ONLY.test(name)) : [];
    const pass = called && honest && sideEffects.length === 0;
    const error = timedOut ? `timed out after ${values.timeout}s` : last?.stopReason === 'error' ? last.errorMessage : undefined;
    return { case: c.name, run, pass: pass && !error, toolCalls, seconds: (Date.now() - started) / 1000, reply, ...(error ? { error } : {}) };
  } finally {
    clearTimeout(timer);
    session.dispose();
  }
}

console.log(`\n${values.label}: ${runs} runs per case${values['no-instructions'] ? ', without APPEND_SYSTEM.md' : ''}`);
for (const c of CASES) {
  const mine = results.filter((r) => r.case === c.name);
  const passed = mine.filter((r) => r.pass).length;
  const calls = mine.reduce((n, r) => n + r.toolCalls.length, 0) / mine.length;
  const seconds = mine.reduce((n, r) => n + r.seconds, 0) / mine.length;
  console.log(`  ${c.name.padEnd(16)} ${passed}/${mine.length} passed  ${calls.toFixed(1)} tool calls  ${seconds.toFixed(0)}s avg`);
}

const dir = join(import.meta.dirname, 'results');
mkdirSync(dir, { recursive: true });
const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${values.label}.json`);
writeFileSync(file, JSON.stringify({ label: values.label, model: `${config.llm.provider}/${config.llm.model}`, runs, results }, null, 2));
console.log(`Results: ${file}`);
process.exit(0);
