import fs from 'node:fs';
import path from 'node:path';
import type { ToolSpec } from '../providers/types.ts';
import type { AgentEvents } from '../agent/loop.ts';
import { expandHome } from '../config.ts';
import { webFetchTool } from './web.ts';
import { todoTool } from './todo.ts';
import { killJob, listJobs, readJob, shellFor, startBackground } from './shell.ts';

const MAX_OUTPUT = 30_000;
const BASH_TIMEOUT_MS = 120_000;
// Directories never worth walking. The macOS entries matter because running
// from $HOME otherwise drags ~/Library and app bundles into every search.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__',
  'target', '.next', '.cache', 'Caches',
  'Library', 'Applications', 'Photos Library.photoslibrary', '.Trash',
]);

/** Walking $HOME reaches six figures of files; stop long before that. */
const MAX_WALK_FILES = 20_000;
/** Files larger than this are not worth grepping and blow up memory. */
const MAX_GREP_BYTES = 1_000_000;
/** Reading a multi-megabyte file into the transcript is never the intent. */
const MAX_READ_BYTES = 5_000_000;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf']);

/**
 * Files the agent has actually read this session.
 *
 * An edit is a claim about what a file currently contains. Writing one the
 * agent has never looked at is not an edit, it is a guess — and the failure
 * mode is silently destroying work.
 */
const readFiles = new Set<string>();

export function markRead(file: string): void {
  readFiles.add(path.resolve(file));
}

export function hasRead(file: string): boolean {
  return readFiles.has(path.resolve(file));
}

export function clearReadFiles(): void {
  readFiles.clear();
}

/** Mach-O binaries and images read as UTF-8 produce pages of mojibake. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export type ToolResult = { output: string; isError: boolean };

export type ToolImpl = {
  spec: ToolSpec;
  /** `events` is passed so composite tools (task) can narrate and request approval. */
  run: (
    input: Record<string, any>,
    cwd: string,
    events?: AgentEvents,
  ) => Promise<ToolResult>;
};

function truncate(s: string): string {
  return s.length > MAX_OUTPUT
    ? s.slice(0, MAX_OUTPUT) + `\n... [truncated, ${s.length - MAX_OUTPUT} more characters]`
    : s;
}

const ok = (output: string): ToolResult => ({ output: truncate(output), isError: false });
const fail = (output: string): ToolResult => ({ output: truncate(output), isError: true });

function resolve(cwd: string, p: string): string {
  const expanded = expandHome(p);
  return path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded);
}

/** Glob to RegExp: `**` crosses directories, `*` does not, `?` is one character. */
function globToRegExp(pattern: string): RegExp {
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          src += '(?:.*/)?';
        } else {
          src += '.*';
        }
      } else {
        src += '[^/]*';
      }
    } else if (c === '?') {
      src += '[^/]';
    } else if ('.+^${}()|[]\\/'.includes(c)) {
      src += '\\' + c;
    } else {
      src += c;
    }
  }
  return new RegExp('^' + src + '$');
}

function* walk(dir: string, root: string, budget = { n: 0 }): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (budget.n >= MAX_WALK_FILES) return;
    if (e.name.startsWith('.') && e.name !== '.env') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue; // symlinks can loop or escape the workspace
    if (e.isDirectory()) yield* walk(full, root, budget);
    else {
      budget.n++;
      yield path.relative(root, full);
    }
  }
}

export const TOOLS: Record<string, ToolImpl> = {
  read_file: {
    spec: {
      name: 'read_file',
      description:
        'Read a file from disk. Returns contents with 1-indexed line numbers prefixed. ' +
        'Use offset and limit for a large file rather than pulling all of it into context.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, absolute or relative to the cwd' },
          offset: { type: 'number', description: '1-indexed first line to return' },
          limit: { type: 'number', description: 'How many lines to return (default 2000)' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    async run(input, cwd) {
      const file = resolve(cwd, String(input.path ?? ''));
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        return fail('File not found: ' + input.path);
      }
      if (stat.isDirectory()) return fail(input.path + ' is a directory. Use list_dir.');
      if (stat.size > MAX_READ_BYTES) {
        return fail(
          input.path + ' is ' + Math.round(stat.size / 1e6) + ' MB. Read it in pieces with ' +
            'offset and limit, or search it with grep.',
        );
      }

      const buf = fs.readFileSync(file);
      if (looksBinary(buf)) {
        const kind = IMAGE_EXT.has(path.extname(file).toLowerCase()) ? 'image' : 'binary';
        return fail(
          input.path + ' is a ' + kind + ' file (' + stat.size + ' bytes), not text. ' +
            'This CLI cannot read ' + kind + ' content.',
        );
      }

      const lines = buf.toString('utf8').split('\n');
      const start = Math.max(1, Number(input.offset ?? 1));
      const limit = Math.max(1, Number(input.limit ?? 2000));
      const slice = lines.slice(start - 1, start - 1 + limit);
      if (!slice.length) {
        return fail(
          'Offset ' + start + ' is past the end of ' + input.path + ' (' + lines.length + ' lines).',
        );
      }

      const width = String(start + slice.length - 1).length;
      const body = slice
        .map((l, i) => String(start + i).padStart(width, ' ') + '\t' + l)
        .join('\n');
      const shownTo = start + slice.length - 1;
      const note =
        shownTo < lines.length
          ? '\n\n[showing lines ' + start + '-' + shownTo + ' of ' + lines.length + ']'
          : '';

      // Editing a file the agent has not read is how content gets clobbered.
      markRead(file);
      return ok(body + note);
    },
  },

  write_file: {
    spec: {
      name: 'write_file',
      description: 'Write a file, creating parent directories and overwriting if it exists.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    async run(input, cwd) {
      const file = resolve(cwd, input.path);
      // Overwriting a file nobody looked at destroys whatever was there.
      if (fs.existsSync(file) && !hasRead(file)) {
        return fail(
          input.path + ' already exists and has not been read this session. ' +
            'Read it first, then write — otherwise this silently discards its contents.',
        );
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, input.content);
      markRead(file);
      const n = String(input.content).split('\n').length;
      return ok('Wrote ' + n + ' line' + (n === 1 ? '' : 's') + ' to ' + input.path);
    },
  },

  edit_file: {
    spec: {
      name: 'edit_file',
      description:
        'Replace an exact string in a file. old_string must appear exactly once unless replace_all is true.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['path', 'old_string', 'new_string'],
        additionalProperties: false,
      },
    },
    async run(input, cwd) {
      const file = resolve(cwd, input.path);
      if (!fs.existsSync(file)) return fail('File not found: ' + input.path);
      if (!hasRead(file)) {
        return fail(
          input.path + ' has not been read this session. Read it before editing, so the ' +
            'replacement is based on what the file actually contains.',
        );
      }
      const before = fs.readFileSync(file, 'utf8');
      const count = before.split(input.old_string).length - 1;
      if (count === 0) return fail('old_string not found in ' + input.path);
      if (count > 1 && !input.replace_all) {
        return fail(
          'old_string appears ' + count + ' times in ' + input.path +
            '. Add more context to make it unique, or set replace_all.',
        );
      }
      const after = input.replace_all
        ? before.split(input.old_string).join(input.new_string)
        : before.replace(input.old_string, input.new_string);
      fs.writeFileSync(file, after);
      markRead(file);
      return ok('Replaced ' + (input.replace_all ? count : 1) + ' occurrence(s) in ' + input.path);
    },
  },

  bash: {
    spec: {
      name: 'bash',
      description:
        'Run a shell command. The shell persists between calls, so `cd` and exported ' +
        'variables carry over. Set run_in_background for long-running processes ' +
        '(dev servers, watchers) and poll them with bash_output.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_ms: { type: 'number', description: 'Defaults to 120000' },
          run_in_background: {
            type: 'boolean',
            description: 'Start it and return immediately with a job id',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    async run(input, cwd, events) {
      const command = String(input.command ?? '');

      if (input.run_in_background) {
        const job = startBackground(command, cwd);
        return ok(
          'Started in the background as ' + job.id + '.\n' +
            'Poll it with bash_output({ id: "' + job.id + '" }) and stop it with kill_shell.',
        );
      }

      // Streaming means a two-minute test run is visible while it runs rather
      // than arriving all at once at the end.
      let streamed = 0;
      const result = await shellFor(cwd).run(
        command,
        Number(input.timeout_ms ?? 0) || undefined,
        (chunk) => {
          if (streamed > 4000) return;
          streamed += chunk.length;
          events?.onToolProgress?.(chunk);
        },
      );

      const merged = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      if (result.code !== 0) {
        return fail(merged || 'Command failed with exit code ' + result.code);
      }
      return ok(merged || '(no output)');
    },
  },

  bash_output: {
    spec: {
      name: 'bash_output',
      description:
        'Read new output from a background job started with bash({ run_in_background: true }). ' +
        'Returns only what has appeared since the last read.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The job id, e.g. bg_1' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    async run(input) {
      const id = String(input.id ?? '');
      const result = readJob(id);
      if (!result) {
        const running = listJobs();
        return fail(
          'No background job "' + id + '".' +
            (running.length ? ' Known jobs: ' + running.map((j) => j.id).join(', ') : ''),
        );
      }
      const state = result.running
        ? '[still running]'
        : '[exited with code ' + result.exitCode + ']';
      return ok((result.text || '(no new output)') + '\n' + state);
    },
  },

  kill_shell: {
    spec: {
      name: 'kill_shell',
      description: 'Stop a background job started with bash({ run_in_background: true }).',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    async run(input) {
      const id = String(input.id ?? '');
      return killJob(id) ? ok('Sent SIGTERM to ' + id + '.') : fail('No background job "' + id + '".');
    },
  },

  glob: {
    spec: {
      name: 'glob',
      description: 'Find files by glob pattern, e.g. "src/**/*.ts". Returns matching paths.',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
    async run(input, cwd) {
      const re = globToRegExp(input.pattern);
      const hits = [...walk(cwd, cwd)].filter((f) => re.test(f)).slice(0, 500);
      return ok(hits.length ? hits.join('\n') : 'No files match ' + input.pattern);
    },
  },

  grep: {
    spec: {
      name: 'grep',
      description: 'Search file contents with a regular expression. Returns file:line:match.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          glob: { type: 'string', description: 'Optional file filter, e.g. "**/*.ts"' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
    async run(input, cwd) {
      let re: RegExp;
      try {
        re = new RegExp(input.pattern);
      } catch (e: any) {
        return fail('Invalid regex: ' + e.message);
      }
      const filter = input.glob ? globToRegExp(input.glob) : null;
      const hits: string[] = [];
      for (const rel of walk(cwd, cwd)) {
        if (filter && !filter.test(rel)) continue;
        let content: string;
        try {
          const full = path.join(cwd, rel);
          if (fs.statSync(full).size > MAX_GREP_BYTES) continue;
          const buf = fs.readFileSync(full);
          if (looksBinary(buf)) continue;
          content = buf.toString('utf8');
        } catch {
          continue;
        }
        content.split('\n').forEach((line, i) => {
          if (re.test(line)) hits.push(rel + ':' + (i + 1) + ':' + line.trim().slice(0, 200));
        });
        if (hits.length > 300) break;
      }
      return ok(hits.length ? hits.join('\n') : 'No matches for ' + input.pattern);
    },
  },

  list_dir: {
    spec: {
      name: 'list_dir',
      description: 'List the entries of a directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
    async run(input, cwd) {
      const dir = resolve(cwd, input.path || '.');
      if (!fs.existsSync(dir)) return fail('Not found: ' + input.path);
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
        .sort();
      return ok(entries.join('\n') || '(empty)');
    },
  },
};

TOOLS.web_fetch = webFetchTool;
TOOLS.todo_write = todoTool;

export const TOOL_SPECS: ToolSpec[] = Object.values(TOOLS).map((t) => t.spec);
