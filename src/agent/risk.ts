/**
 * Shell command segmentation and risk classification.
 *
 * This exists because a permission rule written against a command string is
 * only as good as the parse behind it. `bash(git status:*)` used to be matched
 * with `command.startsWith('git status')`, which approves `git status && rm -rf ~`
 * on the strength of its first two words. Splitting into segments and judging
 * each one independently is what makes a saved rule mean what the user thought
 * it meant.
 *
 * The same classification decides what `auto` mode may run unprompted and what
 * `plan` mode may read, so the three concerns share one implementation.
 */

export type Risk =
  /** Observes only: no filesystem writes, no network, no process control. */
  | 'read'
  /** Ordinary mutation — writes files, installs, commits, runs the test suite. */
  | 'write'
  /** Removes data, escalates privilege, rewrites history, or executes a script. */
  | 'destructive'
  /** Verb not recognized. Treated as risky: unknown is never auto-approved. */
  | 'unknown';

const RANK: Record<Risk, number> = { read: 0, write: 1, unknown: 2, destructive: 3 };

/** Find the index of the `)` matching the `(` at `open`. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return s.length;
}

/**
 * Split a shell command into independently-judged segments.
 *
 * Separators are `&&`, `||`, `;`, `|`, `&` and newlines. Command substitutions
 * (`$(...)` and backticks) are lifted out as their own segments, because the
 * command inside one runs with the same authority as the command around it.
 * Quoting is respected, so `echo "a && b"` is a single segment.
 */
export function splitCommand(command: string): string[] {
  const segments: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let i = 0;

  const push = () => {
    const t = cur.trim();
    if (t) segments.push(t);
    cur = '';
  };

  while (i < command.length) {
    const c = command[i];
    const next = command[i + 1];

    if (quote) {
      // Only double quotes honour a backslash escape; inside single quotes a
      // backslash is a literal character.
      if (c === '\\' && quote === '"' && next !== undefined) {
        cur += c + next;
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      cur += c;
      i++;
      continue;
    }

    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      i++;
      continue;
    }

    if (c === '\\' && next !== undefined) {
      cur += c + next;
      i += 2;
      continue;
    }

    if (c === '$' && next === '(') {
      const end = matchParen(command, i + 1);
      segments.push(...splitCommand(command.slice(i + 2, end)));
      // The substitution's *result* is still an argument to the surrounding
      // command, so leave a space rather than gluing the neighbours together.
      cur += ' ';
      i = end + 1;
      continue;
    }

    if (c === '`') {
      const end = command.indexOf('`', i + 1);
      const stop = end === -1 ? command.length : end;
      segments.push(...splitCommand(command.slice(i + 1, stop)));
      cur += ' ';
      i = stop + 1;
      continue;
    }

    if ((c === '&' && next === '&') || (c === '|' && next === '|')) {
      push();
      i += 2;
      continue;
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      push();
      i++;
      continue;
    }

    cur += c;
    i++;
  }

  push();
  return segments;
}

/** Tokenize one segment, dropping quotes and leading `VAR=value` assignments. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      started = true;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (c === ' ' || c === '\t') {
      if (started) tokens.push(cur);
      cur = '';
      started = false;
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) tokens.push(cur);

  // `FOO=bar cmd` and `env FOO=bar cmd` — the verb is what follows.
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  return tokens;
}

/** An unquoted `>` or `>>` turns any verb into a write. */
function hasRedirect(segment: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '>') return true;
  }
  return false;
}

const READ_VERBS = new Set([
  'ls', 'cat', 'head', 'tail', 'pwd', 'echo', 'printf', 'which', 'type', 'file',
  'stat', 'wc', 'sort', 'uniq', 'cut', 'tr', 'column', 'grep', 'egrep', 'fgrep',
  'rg', 'ag', 'find', 'fd', 'tree', 'diff', 'cmp', 'basename', 'dirname',
  'realpath', 'readlink', 'date', 'whoami', 'hostname', 'uname', 'id', 'groups',
  'printenv', 'df', 'du', 'ps', 'top', 'uptime', 'jq', 'yq', 'awk', 'less',
  'more', 'man', 'help', 'history', 'md5', 'md5sum', 'shasum', 'sha256sum',
  'true', 'false', 'test', 'nl', 'seq', 'expr',
]);

/** Ordinary mutation. Recoverable, expected during normal work. */
const WRITE_VERBS = new Set([
  'mkdir', 'touch', 'cp', 'ln', 'tee', 'sed', 'patch', 'tar', 'zip', 'unzip',
  'gzip', 'gunzip', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'deno',
  'python', 'python3', 'pip', 'pip3', 'ruby', 'go', 'cargo', 'rustc', 'make',
  'tsc', 'tsx', 'jest', 'vitest', 'pytest', 'eslint', 'prettier', 'black',
  'curl', 'wget', 'open', 'code', 'defaults', 'brew', 'docker', 'mv',
]);

/**
 * Removes data, escalates privilege, rewrites shared history, or hands the
 * segment to an interpreter. Never auto-approved, in any mode.
 *
 * Bare shells are here on purpose: splitting on `|` turns `curl url | sh` into
 * `curl url` and `sh`, and the second segment is what makes it dangerous.
 */
const DESTRUCTIVE_VERBS = new Set([
  'rm', 'rmdir', 'shred', 'truncate', 'dd', 'mkfs', 'fdisk', 'diskutil',
  'sudo', 'su', 'doas', 'chown', 'chmod', 'chgrp', 'chflags',
  'kill', 'killall', 'pkill', 'shutdown', 'reboot', 'halt', 'launchctl',
  'systemctl', 'crontab', 'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'eval',
  'exec', 'source', '.', 'nc', 'ncat', 'ssh', 'scp', 'rsync', 'mount', 'umount',
]);

/** `git <sub>` that only ever reports. */
const GIT_READ_ALWAYS = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'describe', 'rev-parse', 'ls-files',
  'ls-tree', 'shortlog', 'whatchanged', 'cat-file', 'grep', 'reflog', 'bisect',
]);

/** `git <sub>` that reports when bare and mutates when given an operand. */
const GIT_READ_IF_BARE = new Set(['branch', 'remote', 'tag', 'config', 'stash']);

/** `git <sub>` that can discard work or rewrite what others have pulled. */
const GIT_DESTRUCTIVE = new Set([
  'push', 'reset', 'clean', 'rebase', 'filter-branch', 'gc', 'prune',
  'update-ref', 'reflog-delete',
]);

function classifyGit(tokens: string[]): Risk {
  const rest = tokens.slice(1).filter((t) => t !== '--no-pager' && !t.startsWith('-c'));
  const sub = rest[0];
  if (!sub) return 'read';
  if (GIT_DESTRUCTIVE.has(sub)) return 'destructive';
  if (GIT_READ_ALWAYS.has(sub)) return 'read';
  if (GIT_READ_IF_BARE.has(sub)) {
    // `git branch -a` lists; `git branch feature` creates. Any non-flag operand
    // after the subcommand means it is doing something.
    const operands = rest.slice(1).filter((t) => !t.startsWith('-'));
    if (sub === 'config' && rest.includes('--list')) return 'read';
    if (sub === 'stash') return operands[0] === 'list' || operands[0] === 'show' ? 'read' : 'write';
    return operands.length === 0 ? 'read' : 'write';
  }
  // checkout/switch/restore can discard uncommitted work.
  if (sub === 'checkout' || sub === 'restore') {
    return rest.includes('--') || rest.includes('--hard') ? 'destructive' : 'write';
  }
  return 'write';
}

/** Classify one already-split segment. */
export function classifySegment(segment: string): Risk {
  const tokens = tokenize(segment);
  if (!tokens.length) return 'read';

  const verb = tokens[0].split('/').pop() ?? tokens[0];

  if (DESTRUCTIVE_VERBS.has(verb)) return 'destructive';
  if (verb === 'git') {
    const git = classifyGit(tokens);
    return git === 'read' && hasRedirect(segment) ? 'write' : git;
  }
  // `sed -i` edits in place; `sed -n '1,20p' file` prints.
  if (verb === 'sed') return tokens.some((t) => t.startsWith('-i')) ? 'write' : 'read';
  if (verb === 'find') {
    return tokens.includes('-delete') || tokens.includes('-exec') ? 'destructive' : 'read';
  }

  if (READ_VERBS.has(verb)) return hasRedirect(segment) ? 'write' : 'read';
  if (WRITE_VERBS.has(verb)) return 'write';
  return 'unknown';
}

/**
 * The risk of a whole command is the risk of its riskiest segment. A command
 * is only as safe as the most dangerous thing it can reach.
 */
export function classifyCommand(command: string): Risk {
  const segments = splitCommand(command);
  if (!segments.length) return 'read';
  let worst: Risk = 'read';
  for (const seg of segments) {
    const r = classifySegment(seg);
    if (RANK[r] > RANK[worst]) worst = r;
  }
  return worst;
}

/** True when every segment only observes — the bar for plan mode. */
export function isReadOnlyCommand(command: string): boolean {
  return classifyCommand(command) === 'read';
}
