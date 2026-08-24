import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR } from './config.ts';

/**
 * Named subagents, from markdown files.
 *
 * One generic subagent means every delegation gets the same instructions and
 * the same toolset. A definition file lets a project say "a `reviewer` reads
 * and reports, and cannot write" — which is both more useful and more
 * containable than handing every child the parent's full authority.
 */

export type AgentDefinition = {
  name: string;
  description: string;
  /** Extra system prompt for this agent. */
  prompt: string;
  /** If set, the child sees only these tools. */
  tools?: string[];
  source: string;
};

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

function parse(file: string, fallbackName: string): AgentDefinition {
  const raw = fs.readFileSync(file, 'utf8');
  const m = FRONTMATTER.exec(raw);
  const meta: Record<string, string> = {};
  let body = raw;

  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split('\n')) {
      const kv = /^\s*([a-zA-Z_-]+)\s*:\s*(.*)$/.exec(line);
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }

  const tools = meta.tools
    ? meta.tools
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined;

  return {
    name: meta.name || fallbackName,
    description: meta.description || 'Custom subagent: ' + fallbackName,
    prompt: body.trim(),
    tools,
    source: file,
  };
}

function loadFrom(dir: string, into: Map<string, AgentDefinition>): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    try {
      const def = parse(path.join(dir, entry), entry.slice(0, -3));
      into.set(def.name, def);
    } catch {
      /* an unreadable definition is simply not an agent */
    }
  }
}

/** Project definitions win over personal ones of the same name. */
export function loadAgents(cwd: string): AgentDefinition[] {
  const found = new Map<string, AgentDefinition>();
  loadFrom(path.join(HOME_DIR, 'agents'), found);
  loadFrom(path.join(cwd, '.spider', 'agents'), found);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
