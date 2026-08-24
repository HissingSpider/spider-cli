import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.tsx';
import { CheckpointStore } from '../src/checkpoint.ts';
import type { Agent } from '../src/agent/loop.ts';
import type { AgentEvents } from '../src/agent/loop.ts';

// biome-ignore lint/suspicious/noExplicitAny: a deliberate partial double of
// Agent — typing every member would restate the class without testing anything.
const stub: any = {
  lastSignal: undefined as AbortSignal | undefined,
  model: 'gpt-5',
  mode: 'default',
  turns: [],
  settings: {
    allow: ['bash(git status:*)'],
    deny: ['bash(rm:*)'],
    autoCompactAt: 100000,
    hooks: {},
    search: undefined,
  },
  tools: { bash: {}, read_file: {} },
  // App snapshots the transcript on submit so /rewind has something to restore.
  checkpoints: new CheckpointStore(),
  // Mirrors the CostTracker surface the footer reads.
  cost: {
    input: 0,
    output: 0,
    summary: () => '0 in / 0 out tokens across 0 model calls',
    estimateUSD: () => 0,
  },
  contextTokens: () => 0,
  setModel(m: string) {
    stub.model = m;
  },
  async run(_text: string, events: AgentEvents, signal?: AbortSignal) {
    if (signal) stub.lastSignal = signal;
    // Drive one permission round-trip through the UI.
    const answer = await events.requestPermission(
      { id: 'c1', name: 'bash', input: { command: 'ls -la' } },
      'bash(ls:*)',
      '$ ls -la',
    );
    events.onToolEnd({ id: 'c1', name: 'bash', input: {} }, 'answer=' + answer, false);
    events.onAssistantEnd();
  },
} as unknown as Agent;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[a-zA-Z]', 'g');
const strip = (s: string | undefined) => (s ?? '').replace(ANSI, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CR = String.fromCharCode(13);

async function type(stdin: { write: (s: string) => void }, text: string) {
  stdin.write(text);
  await sleep(60);
  stdin.write(CR);
  await sleep(180);
}

const UP = ESC + '[A';
const _DOWN = ESC + '[B';
const SHIFT_TAB = ESC + '[Z';

const failures: string[] = [];
function check(name: string, cond: boolean, got?: string) {
  if (cond) {
    console.log('  PASS  ' + name);
  } else {
    failures.push(name);
    console.log('  FAIL  ' + name + (got ? '\n        got: ' + got.slice(0, 400) : ''));
  }
}

const { lastFrame, stdin } = render(
  <App agent={stub} cwd="/tmp" sessionId="test" initialTurns={0} />,
);

await sleep(150);
check('mounts with a status line', strip(lastFrame()).includes('gpt-5'), strip(lastFrame()));

await type(stdin, '/help');
check('/help lists commands', strip(lastFrame()).includes('/permissions'));

await type(stdin, '/model gpt-4.1');
check('/model switches', strip(lastFrame()).includes('Model set to gpt-4.1'));

await type(stdin, '/mode plan');
check('/mode switches', strip(lastFrame()).includes('Permission mode: plan'));

await type(stdin, '/permissions');
check('/permissions shows rules', strip(lastFrame()).includes('bash(rm:*)'));

await type(stdin, '/nonsense');
check('unknown command errors', strip(lastFrame()).includes('Unknown command'));

await type(stdin, 'do a thing');
const promptFrame = strip(lastFrame());
check(
  'approval prompt renders',
  promptFrame.includes('Permission required') && promptFrame.includes('$ ls -la'),
  promptFrame,
);
check(
  'approval offers the remember option',
  promptFrame.includes('ask again for bash(ls:*)'),
  promptFrame,
);

stdin.write('2');
await sleep(300);
check(
  'choosing 2 resolves as allow-always',
  strip(lastFrame()).includes('answer=allow-always'),
  strip(lastFrame()),
);

// --- ctrl+c behaviour -----------------------------------------------------
const CTRL_C = String.fromCharCode(3);

// Typing then ctrl+c clears the line instead of exiting.
stdin.write('some half-typed thing');
await sleep(120);
check('typed text is shown', strip(lastFrame()).includes('some half-typed thing'));
stdin.write(CTRL_C);
await sleep(150);
check(
  'ctrl+c clears the input line',
  !strip(lastFrame()).includes('some half-typed thing'),
  strip(lastFrame()),
);
check('clearing does not arm an exit', !strip(lastFrame()).includes('again to exit'));

// On an empty line the first ctrl+c only warns.
stdin.write(CTRL_C);
await sleep(150);
check(
  'ctrl+c on an empty line warns instead of exiting',
  strip(lastFrame()).includes('Press ctrl+c again to exit'),
  strip(lastFrame()),
);

// And the warning lapses rather than leaving a live hair trigger.
await sleep(2300);
check(
  'the exit confirmation times out',
  !strip(lastFrame()).includes('again to exit'),
  strip(lastFrame()),
);

// --- shift+tab cycles the permission mode (card #19) ---
stub.mode = 'default';
stdin.write(SHIFT_TAB);
await sleep(150);
check('shift+tab moves to acceptEdits', stub.mode === 'acceptEdits', 'mode=' + stub.mode);
check(
  'the mode banner appears',
  strip(lastFrame()).includes('accept edits on'),
  strip(lastFrame()),
);
stdin.write(SHIFT_TAB);
await sleep(150);
check('shift+tab moves on to auto', stub.mode === 'auto', 'mode=' + stub.mode);
stdin.write(SHIFT_TAB);
await sleep(150);
stdin.write(SHIFT_TAB);
await sleep(150);
check('the cycle wraps back to default', stub.mode === 'default', 'mode=' + stub.mode);
check('no banner in default mode', !strip(lastFrame()).includes('accept edits on'));

// --- prompt history (card #37) ---
stdin.write(UP);
await sleep(150);
check(
  'up-arrow recalls an earlier prompt',
  strip(lastFrame()).includes('do a thing'),
  strip(lastFrame()).slice(-300),
);
stdin.write(CTRL_C);
await sleep(150);

// --- the footer carries a context meter and a running cost (cards #42, #43) ---
const footer = strip(lastFrame());
check('footer shows a context meter', /\d+%/.test(footer), footer.slice(-200));
check('footer shows a running cost', footer.includes('$0.0000'), footer.slice(-200));

// --- input queues instead of being dropped while busy (card #32) ---
let release: (() => void) | null = null;
stub.run = async (_text: string, events: AgentEvents) => {
  await new Promise<void>((r) => {
    release = r;
  });
  events.onAssistantEnd();
};
await type(stdin, 'first');
await sleep(200);
check(
  'the input line stays usable while working',
  strip(lastFrame()).includes('working'),
  strip(lastFrame()).slice(-300),
);
await type(stdin, 'second');
await sleep(200);
check(
  'a message typed mid-turn is queued, not lost',
  strip(lastFrame()).includes('queued: second'),
  strip(lastFrame()).slice(-300),
);

stub.run = async (_text: string, events: AgentEvents) => {
  events.onToolEnd({ id: 'c2', name: 'bash', input: { command: 'x' } }, 'ran second', false);
  events.onAssistantEnd();
};
release!();
await sleep(500);
check(
  'the queued message runs once the turn ends',
  strip(lastFrame()).includes('ran second'),
  strip(lastFrame()).slice(-400),
);

// --- collapsible tool output (card #29) ---
stub.run = async (_text: string, events: AgentEvents) => {
  const many = Array.from({ length: 30 }, (_, i) => 'line ' + i).join('\n');
  events.onToolEnd({ id: 'c3', name: 'bash', input: { command: 'big' } }, many, false);
  events.onAssistantEnd();
};
await type(stdin, 'big output');
await sleep(400);
check(
  'long tool output is collapsed',
  strip(lastFrame()).includes('30 lines total') && !strip(lastFrame()).includes('line 29'),
  strip(lastFrame()).slice(-400),
);
stdin.write(String.fromCharCode(15)); // ctrl+o
await sleep(250);
check('ctrl+o expands it', strip(lastFrame()).includes('line 29'), strip(lastFrame()).slice(-500));

// --- multi-line input via a trailing backslash (card #36) ---
stub.run = async (_text: string, events: AgentEvents) => {
  events.onToolEnd({ id: 'ml', name: 'bash', input: { command: 'x' } }, 'saw:' + _text, false);
  events.onAssistantEnd();
};
stdin.write('first line\\');
await sleep(80);
stdin.write(CR);
await sleep(120);
check(
  'a trailing backslash continues onto a new line',
  !strip(lastFrame()).includes('saw:'),
  strip(lastFrame()).slice(-200),
);
stdin.write('second line');
await sleep(80);
stdin.write(CR);
await sleep(300);
check(
  'the continued buffer submits as one multi-line message',
  strip(lastFrame()).includes('first line') && strip(lastFrame()).includes('second line'),
  strip(lastFrame()).slice(-300),
);

// --- reverse search (card #38) ---
stdin.write(String.fromCharCode(18)); // ctrl+r
await sleep(150);
check(
  'ctrl+r opens reverse search',
  strip(lastFrame()).includes('reverse-i-search'),
  strip(lastFrame()).slice(-300),
);
stdin.write('thing');
await sleep(150);
check(
  'it finds a matching earlier prompt',
  strip(lastFrame()).includes('do a thing'),
  strip(lastFrame()).slice(-300),
);
stdin.write(ESC);
await sleep(150);
check(
  'esc leaves reverse search',
  !strip(lastFrame()).includes('reverse-i-search'),
  strip(lastFrame()).slice(-200),
);

// --- vim modal editing (card #49) ---
await type(stdin, '/vim');
await sleep(150);
check(
  '/vim reports it is on',
  strip(lastFrame()).includes('Vim keys on'),
  strip(lastFrame()).slice(-200),
);
check(
  'the mode indicator shows INSERT',
  strip(lastFrame()).includes('-- INSERT --'),
  strip(lastFrame()).slice(-200),
);
stdin.write(ESC);
await sleep(150);
check(
  'esc switches to normal mode',
  strip(lastFrame()).includes('-- NORMAL --'),
  strip(lastFrame()).slice(-200),
);
stdin.write('i');
await sleep(120);
check(
  'i returns to insert mode',
  strip(lastFrame()).includes('-- INSERT --'),
  strip(lastFrame()).slice(-200),
);
await type(stdin, '/vim');
await sleep(150);

// --- /status and /doctor (card #50) ---
await type(stdin, '/status');
check(
  '/status reports the model and mode',
  strip(lastFrame()).includes('model') && strip(lastFrame()).includes('gpt-4.1'),
  strip(lastFrame()).slice(-400),
);
await type(stdin, '/doctor');
check(
  '/doctor runs its checks',
  strip(lastFrame()).includes('node') && strip(lastFrame()).includes('workspace'),
  strip(lastFrame()).slice(-400),
);

// --- /theme (card #41) ---
await type(stdin, '/theme mono');
check(
  '/theme switches',
  strip(lastFrame()).includes('Theme: mono'),
  strip(lastFrame()).slice(-200),
);
await type(stdin, '/theme dark');

console.log(failures.length ? '\n' + failures.length + ' FAILED' : '\nAll UI checks passed');
process.exit(failures.length ? 1 : 0);
