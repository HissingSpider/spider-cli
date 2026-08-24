import type { Turn } from '../providers/types.ts';

/**
 * Rough token estimate for turns we have not sent yet. The real input count
 * comes back in each response's usage, so this is only used for the /compact
 * readout, never for the auto-compaction trigger.
 */
export function estimateTokens(turns: Turn[]): number {
  let chars = 0;
  for (const t of turns) {
    if (t.role === 'user') chars += t.text.length;
    else if (t.role === 'assistant') {
      chars += t.text.length;
      for (const c of t.toolCalls) chars += JSON.stringify(c.input).length + c.name.length;
    } else chars += t.output.length;
  }
  return Math.ceil(chars / 4);
}

/**
 * Pick a cut point at or before `desired` that does not orphan a tool_use from
 * its tool_result.
 *
 * Only a `tool` turn is an unsafe place to cut, because the assistant turn
 * holding its tool_use id sits earlier and would be dropped. Cutting at an
 * assistant turn is safe: the kept slice keeps that turn together with the tool
 * turns answering it. Searching backwards keeps slightly more history than
 * asked for, which is the safe direction to err — searching forwards can run
 * off the end and swallow the recent turns we were meant to preserve.
 */
export function safeSplitIndex(turns: Turn[], desired: number): number {
  let i = Math.min(Math.max(0, desired), turns.length);
  while (i > 0 && turns[i]?.role === 'tool') i--;
  return i;
}

const SUMMARY_MARKER = '[Earlier conversation, condensed]';

export function isSummaryTurn(turn: Turn): boolean {
  return turn.role === 'user' && turn.text.startsWith(SUMMARY_MARKER);
}

export const COMPACT_INSTRUCTION = [
  'Summarize the conversation so far for your own future reference.',
  'You are about to lose the raw transcript, so preserve what you would need to keep working:',
  '',
  '1. What the user asked for, including constraints and preferences they stated.',
  '2. What has been done: files created or edited (with paths), commands run, decisions made.',
  '3. What was learned: bugs found, how things are structured, anything surprising.',
  '4. What is still outstanding.',
  '',
  'Be specific — keep exact file paths, function names, and error text.',
  'Write it as notes to yourself, not as a message to the user.',
].join('\n');

export type Summarizer = (turns: Turn[], instruction: string) => Promise<string>;

/**
 * Replace the earlier part of the transcript with a summary, keeping the most
 * recent `keepRecent` turns verbatim. Returns the original turns unchanged if
 * there is not enough history to be worth compacting.
 */
export async function compactTurns(
  turns: Turn[],
  keepRecent: number,
  summarize: Summarizer,
): Promise<{ turns: Turn[]; compacted: boolean; droppedTurns: number }> {
  const desired = turns.length - keepRecent;
  if (desired <= 1) return { turns, compacted: false, droppedTurns: 0 };

  const cut = safeSplitIndex(turns, desired);
  const older = turns.slice(0, cut);
  const kept = turns.slice(cut);
  if (older.length === 0) return { turns, compacted: false, droppedTurns: 0 };

  const summary = await summarize(older, COMPACT_INSTRUCTION);

  const summaryTurn: Turn = {
    role: 'user',
    text: SUMMARY_MARKER + '\n\n' + summary.trim(),
  };

  return { turns: [summaryTurn, ...kept], compacted: true, droppedTurns: older.length };
}
