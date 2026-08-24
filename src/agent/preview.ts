import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from '../config.ts';
import type { ToolCall } from '../providers/types.ts';

/**
 * Approval previews.
 *
 * An edit used to be shown as `edit_file → src/foo.ts`, which asks the user to
 * approve a change they cannot see. Showing the actual diff is the difference
 * between consent and a rubber stamp.
 *
 * Lines come back marked in `diff` style (`+`, `-`, ` `, `@@`) so the caller can
 * colour them without needing a structured type across the permission boundary.
 */

const CONTEXT = 3;
const MAX_DIFF_LINES = 60;

/** Longest common subsequence table, walked back into an edit script. */
function lcsDiff(a: string[], b: string[]): Array<{ tag: ' ' | '-' | '+'; text: string }> {
  const n = a.length;
  const m = b.length;
  // Guard against pathological inputs: a 5k-line rewrite is not worth O(n*m).
  if (n * m > 4_000_000) {
    return [
      ...a.map((t) => ({ tag: '-' as const, text: t })),
      ...b.map((t) => ({ tag: '+' as const, text: t })),
    ];
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: Array<{ tag: ' ' | '-' | '+'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ tag: ' ', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ tag: '-', text: a[i++] });
    } else {
      out.push({ tag: '+', text: b[j++] });
    }
  }
  while (i < n) out.push({ tag: '-', text: a[i++] });
  while (j < m) out.push({ tag: '+', text: b[j++] });
  return out;
}

/** A unified diff, trimmed to the neighbourhoods that actually changed. */
export function unifiedDiff(before: string, after: string): string[] {
  const script = lcsDiff(before.split('\n'), after.split('\n'));
  const changed = script.map((s) => s.tag !== ' ');
  const keep = new Set<number>();
  for (let i = 0; i < script.length; i++) {
    if (!changed[i]) continue;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(script.length - 1, i + CONTEXT); k++) {
      keep.add(k);
    }
  }
  if (!keep.size) return ['(no change)'];

  const lines: string[] = [];
  let prev = -1;
  let emitted = 0;
  for (let i = 0; i < script.length; i++) {
    if (!keep.has(i)) continue;
    if (prev !== -1 && i > prev + 1) lines.push('@@');
    if (emitted >= MAX_DIFF_LINES) {
      const rest = [...keep].filter((k) => k > i).length;
      if (rest) lines.push('@@ ... ' + rest + ' more changed line' + (rest === 1 ? '' : 's'));
      break;
    }
    lines.push(script[i].tag + script[i].text);
    emitted++;
    prev = i;
  }
  return lines;
}

function resolveIn(cwd: string, p: string): string {
  const expanded = expandHome(p);
  return path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded);
}

/** Apply an `edit_file` call in memory so the diff shows what would land. */
function projectedEdit(current: string, input: Record<string, any>): string | null {
  const oldStr = String(input.old_string ?? '');
  const newStr = String(input.new_string ?? '');
  if (!oldStr || !current.includes(oldStr)) return null;
  return input.replace_all
    ? current.split(oldStr).join(newStr)
    : current.replace(oldStr, newStr);
}

/**
 * The diff a write or edit would produce, or null when there is nothing useful
 * to show (unreadable file, binary, a pattern that does not match).
 */
export function editDiff(call: ToolCall, cwd: string): string[] | null {
  const target = String((call.input as any).path ?? '');
  if (!target) return null;
  const file = resolveIn(cwd, target);

  let current = '';
  let exists = false;
  try {
    if (fs.existsSync(file)) {
      const buf = fs.readFileSync(file);
      // A diff of a binary is noise; fall back to the short preview.
      if (buf.includes(0)) return null;
      current = buf.toString('utf8');
      exists = true;
    }
  } catch {
    return null;
  }

  if (call.name === 'write_file') {
    const next = String((call.input as any).content ?? '');
    if (!exists) {
      const lines = next.split('\n');
      const shown = lines.slice(0, MAX_DIFF_LINES).map((l) => '+' + l);
      if (lines.length > MAX_DIFF_LINES) {
        shown.push('@@ ... ' + (lines.length - MAX_DIFF_LINES) + ' more lines');
      }
      return shown;
    }
    return unifiedDiff(current, next);
  }

  if (call.name === 'edit_file') {
    if (!exists) return null;
    const next = projectedEdit(current, call.input as Record<string, any>);
    if (next === null) return null;
    return unifiedDiff(current, next);
  }

  return null;
}
