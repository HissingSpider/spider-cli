import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR } from './config.ts';
import type { PermissionMode } from './config.ts';
import type { Turn } from './providers/types.ts';

/**
 * Session persistence.
 *
 * Written as JSONL: a header line, then one line per turn, appended. Rewriting
 * the whole transcript after every turn is O(n²) over a session and loses
 * everything if the process dies mid-write — which is exactly when you most
 * want the transcript back.
 */

const DIR = path.join(HOME_DIR, 'sessions');

export type SavedSession = {
  id: string;
  cwd: string;
  model: string;
  updatedAt: string;
  turns: Turn[];
  /** Restored on --resume, so resuming does not silently drop you back to
   *  `default` after a session spent in plan or auto. */
  mode?: PermissionMode;
  /** Rules learned via "yes, and don't ask again" during the session. */
  allow?: string[];
  /** First user message, trimmed — what makes a session list readable. */
  title?: string;
};

type Header = Omit<SavedSession, 'turns'> & { kind: 'header' };

export function newSessionId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function fileFor(id: string): string {
  return path.join(DIR, id + '.jsonl');
}

/** Derive a title from the first thing the user actually asked for. */
function titleFrom(turns: Turn[]): string | undefined {
  for (const t of turns) {
    if (t.role !== 'user') continue;
    const text = t.text.trim();
    // Hook-injected context is not what the session is about.
    if (text.startsWith('[hook context]') || text.startsWith('[stop hook]')) continue;
    const line = text.split('\n')[0].trim();
    if (line) return line.length > 70 ? line.slice(0, 70) + '…' : line;
  }
  return undefined;
}

/** How many turns of a session are already on disk. */
const written = new Map<string, number>();

/**
 * Append whatever is new. The header is rewritten each time (it is one line at
 * the top and holds mutable fields like mode), but turns are only ever added.
 */
export function save(session: SavedSession): void {
  fs.mkdirSync(DIR, { recursive: true });
  const file = fileFor(session.id);
  const already = written.get(session.id) ?? 0;

  const header: Header = {
    kind: 'header',
    id: session.id,
    cwd: session.cwd,
    model: session.model,
    updatedAt: new Date().toISOString(),
    mode: session.mode,
    allow: session.allow,
    title: session.title ?? titleFrom(session.turns),
  };

  // A resumed or cleared transcript can be shorter than what is on disk; that
  // is a rewrite, not an append.
  if (already === 0 || session.turns.length < already || !fs.existsSync(file)) {
    const lines = [JSON.stringify(header), ...session.turns.map((t) => JSON.stringify(t))];
    fs.writeFileSync(file, lines.join('\n') + '\n');
    written.set(session.id, session.turns.length);
    return;
  }

  if (session.turns.length > already) {
    const fresh = session.turns.slice(already).map((t) => JSON.stringify(t));
    fs.appendFileSync(file, fresh.join('\n') + '\n');
    written.set(session.id, session.turns.length);
  }

  // Rewrite just the header line in place.
  try {
    const body = fs.readFileSync(file, 'utf8').split('\n');
    body[0] = JSON.stringify(header);
    fs.writeFileSync(file, body.join('\n'));
  } catch {
    /* the turns are safely on disk either way */
  }
}

function parseFile(file: string): SavedSession | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  if (!lines.length) return null;

  try {
    const header = JSON.parse(lines[0]) as Header;
    if (header.kind !== 'header') return null;
    const turns: Turn[] = [];
    // A truncated final line is what a crash looks like; keep what parses.
    for (const line of lines.slice(1)) {
      try {
        turns.push(JSON.parse(line) as Turn);
      } catch {
        break;
      }
    }
    const { kind, ...rest } = header;
    void kind;
    return { ...rest, turns };
  } catch {
    return null;
  }
}

export function list(cwd?: string): SavedSession[] {
  if (!fs.existsSync(DIR)) return [];
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => parseFile(path.join(DIR, f)))
    .filter((s): s is SavedSession => s !== null && (!cwd || s.cwd === cwd))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function mostRecent(cwd: string): SavedSession | null {
  return list(cwd)[0] ?? null;
}

/** Look up by full id, or by a unique prefix of one. */
export function byId(id: string, cwd?: string): SavedSession | null {
  const all = list(cwd);
  const exact = all.find((s) => s.id === id);
  if (exact) return exact;
  const partial = all.filter((s) => s.id.startsWith(id));
  return partial.length === 1 ? partial[0] : null;
}

/** Copy a session under a new id, so resuming can branch instead of overwrite. */
export function fork(id: string, cwd?: string): SavedSession | null {
  const source = byId(id, cwd);
  if (!source) return null;
  const copy: SavedSession = { ...source, id: newSessionId() };
  written.delete(copy.id);
  save(copy);
  return copy;
}

/** Forget the append bookkeeping — used when a transcript is replaced wholesale. */
export function resetAppendState(id: string): void {
  written.delete(id);
}

/** A session as markdown, for /export. */
export function toMarkdown(session: SavedSession): string {
  const out: string[] = [
    '# ' + (session.title ?? session.id),
    '',
    '- Session: `' + session.id + '`',
    '- Directory: `' + session.cwd + '`',
    '- Model: `' + session.model + '`',
    '- Updated: ' + session.updatedAt,
    '',
    '---',
    '',
  ];
  for (const turn of session.turns) {
    if (turn.role === 'user') out.push('## User', '', turn.text, '');
    else if (turn.role === 'assistant') {
      if (turn.text.trim()) out.push('## Assistant', '', turn.text, '');
      for (const call of turn.toolCalls) {
        out.push(
          '### Tool: `' + call.name + '`',
          '',
          '```json',
          JSON.stringify(call.input, null, 2),
          '```',
          '',
        );
      }
    } else {
      out.push(
        '### Result' + (turn.isError ? ' (error)' : ''),
        '',
        '```',
        turn.output.length > 2000 ? turn.output.slice(0, 2000) + '\n… truncated' : turn.output,
        '```',
        '',
      );
    }
  }
  return out.join('\n');
}
