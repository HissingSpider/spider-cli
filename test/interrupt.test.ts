/** Interrupting mid-turn must leave a transcript the API will still accept:
 *  every assistant tool_use needs a matching tool result, even if the user
 *  killed the turn before it ran. */
import { Agent } from '../src/agent/loop.ts';
import type { Settings } from '../src/config.ts';
import type { Turn } from '../src/providers/types.ts';
const toolTurns = (ts: Turn[]) =>
  ts.filter((t): t is Extract<Turn, { role: 'tool' }> => t.role === 'tool');

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS  ' + name);
  else {
    failures.push(name);
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
}

const settings: Settings = {
  model: 'gpt-5',
  permissionMode: 'default',
  allow: [],
  deny: [],
  maxTokens: 8192,
  autoCompactAt: 100000,
  keepRecentTurns: 6,
  mcpServers: {},
  hooks: {},
};

// Credentials are never used: nothing here reaches the network.
const agent = new Agent('/tmp', settings, null, 'https://example.invalid/v1', 'unused');

const orphans = (ts: Turn[]) => {
  const answered = new Set(toolTurns(ts).map((t) => t.callId));
  const ids: string[] = [];
  for (const t of ts)
    if (t.role === 'assistant')
      for (const c of t.toolCalls) if (!answered.has(c.id)) ids.push(c.id);
  return ids;
};

// Interrupted after the model asked for two tools, before either ran.
agent.turns = [
  { role: 'user', text: 'do a thing' },
  {
    role: 'assistant',
    text: '',
    toolCalls: [
      { id: 'a1', name: 'bash', input: { command: 'sleep 60' } },
      { id: 'a2', name: 'read_file', input: { path: 'x.ts' } },
    ],
  },
];
check('starts with orphaned tool calls', orphans(agent.turns).length === 2);
agent.settleInterruptedCalls();
check(
  'both orphans are answered',
  orphans(agent.turns).length === 0,
  orphans(agent.turns).join(','),
);
check(
  'stubs say they were interrupted',
  agent.turns.filter((t) => t.role === 'tool').every((t) => /Interrupted by user/.test(t.output)),
);
check(
  'stubs are flagged as errors',
  toolTurns(agent.turns).every((t) => t.isError === true),
);

// Interrupted with one tool already done: the finished result must be preserved.
agent.turns = [
  { role: 'user', text: 'two tools' },
  {
    role: 'assistant',
    text: '',
    toolCalls: [
      { id: 'b1', name: 'bash', input: {} },
      { id: 'b2', name: 'bash', input: {} },
    ],
  },
  { role: 'tool', callId: 'b1', name: 'bash', output: 'REAL OUTPUT', isError: false },
];
agent.settleInterruptedCalls();
check('partially completed round is closed', orphans(agent.turns).length === 0);
const b1 = toolTurns(agent.turns).find((t) => t.callId === 'b1');
check(
  'completed result is not overwritten',
  b1?.output === 'REAL OUTPUT' && b1?.isError === false,
  b1?.output,
);
check('exactly one stub was added', agent.turns.filter((t) => t.role === 'tool').length === 2);

// Idempotent: interrupting twice must not pile up duplicate stubs.
const lengthBefore = agent.turns.length;
agent.settleInterruptedCalls();
check(
  'running it again changes nothing',
  agent.turns.length === lengthBefore,
  agent.turns.length + ' vs ' + lengthBefore,
);

// A clean transcript is left alone.
agent.turns = [
  { role: 'user', text: 'hi' },
  { role: 'assistant', text: 'hello', toolCalls: [] },
];
agent.settleInterruptedCalls();
check('a transcript with no tool calls is untouched', agent.turns.length === 2);

console.log(failures.length ? '\n' + failures.length + ' FAILED' : '\nAll interrupt checks passed');
process.exit(failures.length ? 1 : 0);
