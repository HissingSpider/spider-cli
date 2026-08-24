import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR } from './config.ts';

/**
 * Custom slash commands, from markdown files.
 *
 * A prompt you retype every day should live in a file. `/review` is a command
 * because someone wrote `.spider/commands/review.md`, not because the CLI
 * shipped one — which means the useful ones can be committed with the project
 * and shared, rather than living in everyone's head.
 */

export type CustomCommand = {
  name: string;
  description: string;
  /** The prompt body, before argument substitution. */
  body: string;
  source: string;
};

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

function parse(file: string, name: string): CustomCommand {
  const raw = fs.readFileSync(file, 'utf8');
  const m = FRONTMATTER.exec(raw);
  let description = '';
  let body = raw;

  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split('\n')) {
      const kv = /^\s*([a-zA-Z_-]+)\s*:\s*(.*)$/.exec(line);
      if (kv && kv[1].toLowerCase() === 'description') {
        description = kv[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }

  if (!description) {
    // Fall back to the first non-empty line, so a bare file still gets a label.
    description = body.split('\n').find((l) => l.trim())?.trim().slice(0, 60) ?? name;
  }

  return { name, description, body: body.trim(), source: file };
}

function loadFrom(dir: string, into: Map<string, CustomCommand>): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const name = entry.slice(0, -3);
    try {
      into.set(name, parse(path.join(dir, entry), name));
    } catch {
      /* an unreadable command file is simply not a command */
    }
  }
}

/**
 * Project commands win over personal ones with the same name, so a repo can
 * define what `/review` means for that repo.
 */
export function loadCommands(cwd: string): CustomCommand[] {
  const found = new Map<string, CustomCommand>();
  loadFrom(path.join(HOME_DIR, 'commands'), found);
  loadFrom(path.join(cwd, '.spider', 'commands'), found);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Substitute arguments into a command body.
 *
 * `$ARGUMENTS` is everything, `$1`..`$9` are positional. A command that
 * references neither gets the arguments appended, so `/review src/a.ts` does
 * something sensible even when the author did not plan for arguments.
 */
export function expand(command: CustomCommand, args: string[]): string {
  const all = args.join(' ');
  const usesPlaceholders = /\$ARGUMENTS|\$[1-9]/.test(command.body);

  let out = command.body.replace(/\$ARGUMENTS/g, all);
  out = out.replace(/\$([1-9])/g, (_, d: string) => args[Number(d) - 1] ?? '');

  if (!usesPlaceholders && all) out += '\n\n' + all;
  return out;
}
