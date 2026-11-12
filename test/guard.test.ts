import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { toolGuard } from '../src/guard.ts';

const blocked = (toolName: string) => ({ block: true, reason: `${toolName} is off in this thread: someone who has posted in it is not allowed to use it.` });

/** The tool guard's handlers, by event, on a pi whose active tools are `active`. */
function guard(allowed: (toolName: string) => boolean, active: string[] = []) {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const pi = {
    active,
    on: (event: string, handler: (event: unknown) => unknown) => void handlers.set(event, handler),
    getActiveTools: () => pi.active,
    setActiveTools(names: string[]) {
      pi.active = names;
      pi.sets++;
    },
    sets: 0,
  };
  toolGuard(allowed)(pi as unknown as ExtensionAPI);
  return { pi, onToolCall: (toolName: string) => handlers.get('tool_call')!({ toolName }), emit: (event: string) => handlers.get(event)!({ type: event }) };
}

test('blocks every tool call unless allowed', () => {
  let allowed = true;
  const { onToolCall } = guard(() => allowed);
  assert.equal(onToolCall('websearch'), undefined);
  allowed = false;
  for (const toolName of ['websearch', 'mcp__home__intent__HassTurnOn', 'codemode']) {
    assert.deepEqual(onToolCall(toolName), blocked(toolName));
  }
});

test('takes the tools that are not allowed off the declared ones, before each run and turn', () => {
  let allowed = (name: string) => name !== 'webfetch';
  const { pi, emit } = guard((name) => allowed(name), ['websearch', 'webfetch', 'mcp__home__HassTurnOn']);
  emit('before_agent_start');
  assert.deepEqual(pi.active, ['websearch', 'mcp__home__HassTurnOn']);
  // Nothing to take away: the loadout is left alone.
  emit('turn_start');
  assert.equal(pi.sets, 1);
  // A tool registered meanwhile is taken off at the next turn.
  pi.active = [...pi.active, 'mcp__slow__write'];
  allowed = (name) => name === 'websearch';
  emit('turn_start');
  assert.deepEqual(pi.active, ['websearch']);
});

test('tells the guard which tool is called', () => {
  const { onToolCall } = guard((name) => name === 'websearch');
  assert.equal(onToolCall('websearch'), undefined);
  assert.deepEqual(onToolCall('mcp__home__intent__HassTurnOn'), blocked('mcp__home__intent__HassTurnOn'));
});
