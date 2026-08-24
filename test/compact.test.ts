/** Compaction must never cut between an assistant tool_use and the tool turn
 *  that answers it — the next request would reference a tool_use id that is no
 *  longer in the transcript, and the API rejects it. */
import { compactTurns, safeSplitIndex, isSummaryTurn } from '../src/agent/compact.ts';
import type { Turn } from '../src/providers/types.ts';

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS  ' + name);
  else {
    failures.push(name);
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
}

const turns: Turn[] = [
  { role: 'user', text: 'first request' },
  { role: 'assistant', text: '', toolCalls: [{ id: 'a1', name: 'bash', input: {} }] },
  { role: 'tool', callId: 'a1', name: 'bash', output: 'out', isError: false },
  { role: 'assistant', text: 'done one', toolCalls: [] },
  { role: 'user', text: 'second request' },
  { role: 'assistant', text: '', toolCalls: [{ id: 'a2', name: 'grep', input: {} }] },
  { role: 'tool', callId: 'a2', name: 'grep', output: 'hits', isError: false },
  { role: 'assistant', text: 'done two', toolCalls: [] },
];

// Index 2 is a tool turn — cutting there orphans a1, so it steps back to the
// assistant turn that owns it rather than forward past the recent history.
check('split steps back off a tool turn', safeSplitIndex(turns, 2) === 1,
  'got ' + safeSplitIndex(turns, 2));
check('split on a user turn stays put', safeSplitIndex(turns, 4) === 4);
check('split on an assistant turn stays put', safeSplitIndex(turns, 5) === 5);
check('split past the end clamps to length', safeSplitIndex(turns, 99) === turns.length);
check('split never returns a tool index', ![2, 6].includes(safeSplitIndex(turns, 6)) || safeSplitIndex(turns, 6) === 5,
  'got ' + safeSplitIndex(turns, 6));

const orphanCheck = (ts: Turn[]) => {
  const ids = new Set<string>();
  for (const t of ts) if (t.role === 'assistant') for (const c of t.toolCalls) ids.add(c.id);
  return ts.filter((t) => t.role === 'tool' && !ids.has(t.callId)).length;
};

const summarize = async () => 'SUMMARY: user asked for two things; both done.';

const r1 = await compactTurns(turns, 4, summarize);
check('compacts when there is history', r1.compacted);
check('no orphaned tool results after compaction', orphanCheck(r1.turns) === 0,
  orphanCheck(r1.turns) + ' orphaned');
check('summary turn is marked', isSummaryTurn(r1.turns[0]));
check('recent turns kept verbatim', r1.turns[r1.turns.length - 1].role === 'assistant' &&
  (r1.turns[r1.turns.length - 1] as any).text === 'done two');
check('dropped count reported', r1.droppedTurns === 4, 'got ' + r1.droppedTurns);
check('recent turns actually survive', r1.turns.length === 1 + (turns.length - r1.droppedTurns),
  r1.turns.length + ' turns kept from ' + turns.length);

// Keeping more turns than exist must be a no-op, not a crash or an empty transcript.
const r2 = await compactTurns(turns, 50, summarize);
check('no-op when nothing to compact', !r2.compacted && r2.turns.length === turns.length);

const r3 = await compactTurns([{ role: 'user', text: 'hi' }], 6, summarize);
check('no-op on a single turn', !r3.compacted);

console.log(failures.length ? '\n' + failures.length + ' FAILED' : '\nAll compaction checks passed');
process.exit(failures.length ? 1 : 0);
