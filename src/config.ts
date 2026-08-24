import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { OPENAI_MODELS } from './providers/openai.ts';
import { ANTHROPIC_MODELS } from './providers/anthropic.ts';
import type { McpServerConfig } from './mcp/client.ts';
import type { HooksConfig } from './agent/hooks.ts';
import type { SearchConfig } from './tools/search.ts';

export type PermissionMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  /** Edits and ordinary mutating commands run unprompted; destructive and
   *  unrecognized commands still stop for a human. See agent/risk.ts. */
  | 'auto'
  | 'bypassPermissions';

export type Settings = {
  model: string;
  permissionMode: PermissionMode;
  allow: string[];
  deny: string[];
  maxTokens: number;
  /** Compact once a request's input token count crosses this. 0 disables it. */
  autoCompactAt: number;
  /** How many recent turns compaction keeps verbatim. */
  keepRecentTurns: number;
  /** Stdio MCP servers to connect at startup. */
  mcpServers: Record<string, McpServerConfig>;
  /** Shell commands run at fixed points in a turn. See agent/hooks.ts. */
  hooks: HooksConfig;
  /** Cap on tool-use rounds within a single turn. */
  maxTurns?: number;
  /** Web search provider and key. Absent means web_search is unavailable. */
  search?: SearchConfig;
};

export const HOME_DIR = path.join(os.homedir(), '.spidercli');
const HOME_SETTINGS = path.join(HOME_DIR, 'settings.json');
const PROJECT_SETTINGS = '.spider/settings.json';
/** Personal overrides, git-ignored: rules you want but nobody else needs. */
const LOCAL_SETTINGS = '.spider/settings.local.json';
/** The conventional project-level server file, checked in alongside the code. */
const PROJECT_MCP = '.mcp.json';

const DEFAULTS: Settings = {
  model: 'gpt-5',
  permissionMode: 'default',
  allow: [],
  deny: [],
  maxTokens: 8192,
  autoCompactAt: 100_000,
  keepRecentTurns: 6,
  mcpServers: {},
  hooks: {},
};

function readJSON(file: string): Partial<Settings> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Expand a leading `~` to the home directory. The shell does this before a
 * command ever runs, so a model reasonably writes `~/.config/x` — but it
 * reaches us literally. Without this it joins onto the cwd as a directory
 * actually named "~", which silently does not exist, and worse, looks like an
 * in-workspace path to the permission check.
 */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function providerFor(model: string): 'openai' | 'anthropic' {
  if (ANTHROPIC_MODELS.includes(model)) return 'anthropic';
  if (OPENAI_MODELS.includes(model)) return 'openai';
  throw new Error(
    `Unknown model "${model}". Available: ${[...OPENAI_MODELS, ...ANTHROPIC_MODELS].join(', ')}`,
  );
}

export function allModels(): string[] {
  return [...OPENAI_MODELS, ...ANTHROPIC_MODELS];
}

/** Load a settings file named explicitly on the command line. */
export function loadSettingsFile(file: string): Partial<Settings> {
  return readJSON(path.resolve(expandHome(file)));
}

export function loadSettings(cwd: string): Settings {
  // Project settings win over home settings, which win over defaults — except
  // mcpServers, where a project adding a server should not drop the global ones.
  const home = readJSON(HOME_SETTINGS);
  const project = readJSON(path.join(cwd, PROJECT_SETTINGS));
  // `.mcp.json` holds only servers, and is the file people actually commit.
  const projectMcp = readJSON(path.join(cwd, PROJECT_MCP));
  const local = readJSON(path.join(cwd, LOCAL_SETTINGS));
  return {
    ...DEFAULTS,
    ...home,
    ...project,
    ...local,
    allow: [...(home.allow ?? []), ...(project.allow ?? []), ...(local.allow ?? [])],
    deny: [...(home.deny ?? []), ...(project.deny ?? []), ...(local.deny ?? [])],
    hooks: { ...home.hooks, ...project.hooks, ...local.hooks },
    mcpServers: {
      ...DEFAULTS.mcpServers,
      ...home.mcpServers,
      ...projectMcp.mcpServers,
      ...project.mcpServers,
      ...local.mcpServers,
    },
  };
}

/** Add or replace a server in the project's `.mcp.json`. */
export function addMcpServer(cwd: string, name: string, cfg: unknown): string {
  const file = path.join(cwd, PROJECT_MCP);
  const current = readJSON(file);
  const servers = { ...(current.mcpServers ?? {}), [name]: cfg } as Record<string, unknown>;
  fs.writeFileSync(file, JSON.stringify({ ...current, mcpServers: servers }, null, 2) + '\n');
  return file;
}

/** Remove a server from `.mcp.json`, reporting whether it was there. */
export function removeMcpServer(cwd: string, name: string): boolean {
  const file = path.join(cwd, PROJECT_MCP);
  const current = readJSON(file);
  const servers = { ...(current.mcpServers ?? {}) } as Record<string, unknown>;
  if (!(name in servers)) return false;
  delete servers[name];
  fs.writeFileSync(file, JSON.stringify({ ...current, mcpServers: servers }, null, 2) + '\n');
  return true;
}

/** Server definitions from a Claude Desktop config, for importing. */
export function readClaudeDesktopServers(): Record<string, unknown> {
  const candidates = [
    path.join(os.homedir(), 'Library/Application Support/Claude/claude_desktop_config.json'),
    path.join(os.homedir(), '.config/Claude/claude_desktop_config.json'),
    path.join(os.homedir(), 'AppData/Roaming/Claude/claude_desktop_config.json'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed?.mcpServers && typeof parsed.mcpServers === 'object') return parsed.mcpServers;
    } catch {
      /* a malformed config is the same as none */
    }
  }
  return {};
}

/**
 * Persist a session-learned allow rule.
 *
 * These go to `settings.local.json`, not the shared project file: a rule you
 * approved for yourself is not a decision to make on your colleagues' behalf,
 * and it should not arrive in a pull request. The file is git-ignored on
 * creation for the same reason.
 */
export function persistAllowRule(cwd: string, rule: string): void {
  const file = path.join(cwd, LOCAL_SETTINGS);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = readJSON(file);
  const allow = new Set(current.allow ?? []);
  allow.add(rule);
  fs.writeFileSync(file, JSON.stringify({ ...current, allow: [...allow] }, null, 2) + '\n');

  const ignore = path.join(cwd, '.spider', '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, 'settings.local.json\n');
}

export type Credentials = { apiKey: string; baseUrl: string };

export function loadCredentials(cwd: string): Credentials {
  // A .env in the working directory, then one in ~/.spidercli, then the ambient shell.
  dotenv.config({ path: path.join(cwd, '.env'), quiet: true });
  dotenv.config({ path: path.join(HOME_DIR, '.env'), quiet: true });

  const apiKey = process.env.SPIDERAI_API_KEY;
  const baseUrl = process.env.SPIDERAI_BASE_URL ?? 'https://spideraiapi.richmond.edu/v1';

  if (!apiKey) {
    throw new Error(
      'Missing SPIDERAI_API_KEY. Add it to .env or ~/.spidercli/.env.\n' +
        'Get your key from the My Account page on SpiderAI.',
    );
  }
  if (/spiderai\.richmond\.edu/.test(baseUrl) && !/spideraiapi/.test(baseUrl)) {
    throw new Error(
      `SPIDERAI_BASE_URL points at "${baseUrl}", which is the SpiderAI web UI, not the API.\n` +
        'Use https://spideraiapi.richmond.edu/v1 instead.',
    );
  }
  return { apiKey, baseUrl: baseUrl.replace(/\/$/, '') };
}

const MAX_IMPORT_DEPTH = 3;

/**
 * Resolve `@path` imports inside an instruction file.
 *
 * Splitting instructions across files is how a large one stays maintainable —
 * one section per concern, shared fragments referenced from several places.
 * Depth is bounded and every file is visited once, because two files importing
 * each other is a mistake people make, not a reason to hang.
 */
function resolveImports(text: string, baseDir: string, seen: Set<string>, depth = 0): string {
  if (depth >= MAX_IMPORT_DEPTH) return text;
  return text.replace(/^@([^\s]+)\s*$/gm, (whole, ref: string) => {
    const target = path.resolve(baseDir, expandHome(ref));
    if (seen.has(target)) return '[circular import: ' + ref + ']';
    if (!fs.existsSync(target)) return whole;
    seen.add(target);
    try {
      const body = fs.readFileSync(target, 'utf8');
      return resolveImports(body, path.dirname(target), seen, depth + 1);
    } catch {
      return whole;
    }
  });
}

function readInstructionFile(file: string, seen: Set<string>): string | null {
  if (seen.has(file) || !fs.existsSync(file)) return null;
  seen.add(file);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return resolveImports(raw, path.dirname(file), seen).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Project instructions, the SPIDER.md equivalent of CLAUDE.md.
 *
 * Collected from the user's own file first, then every SPIDER.md from the
 * repository root down to the working directory — so a monorepo can carry
 * house rules at the top and per-package rules further in, with the most
 * specific file read last and therefore winning.
 */
export function loadProjectInstructions(cwd: string): string | null {
  const seen = new Set<string>();
  const parts: string[] = [];

  const user = readInstructionFile(path.join(HOME_DIR, 'SPIDER.md'), seen);
  if (user) parts.push('# Personal instructions (~/.spidercli/SPIDER.md)\n\n' + user);

  // Walk up to the filesystem root (or a .git boundary), then read downwards.
  const chain: string[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    chain.unshift(dir);
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const d of chain) {
    for (const name of ['SPIDER.md', '.spider/SPIDER.md']) {
      const body = readInstructionFile(path.join(d, name), seen);
      if (body) parts.push(body);
    }
  }

  return parts.length ? parts.join('\n\n---\n\n') : null;
}
