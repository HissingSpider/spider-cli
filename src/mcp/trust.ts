import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { HOME_DIR } from '../config.ts';
import type { McpServerConfig } from './client.ts';
import { isHttpConfig } from './client.ts';
import { writeFileAtomic } from '../atomic.ts';

/**
 * Trusting a server before running it.
 *
 * A configured MCP server is arbitrary code, or an arbitrary remote endpoint,
 * whose tool descriptions go straight into the model's prompt. Connecting to
 * one because it appeared in a JSON file — say, in a repo you just cloned — is
 * the same class of mistake as running its `postinstall`. Ask once, remember
 * the answer, and key the memory to what was actually approved: change the
 * command and it needs approving again.
 */

const TRUST_FILE = path.join(HOME_DIR, 'trusted-servers.json');
const TRUSTED_DIRS = path.join(HOME_DIR, 'trusted-dirs.json');

type TrustStore = Record<string, string>;

function read(): TrustStore {
  try {
    return JSON.parse(fs.readFileSync(TRUST_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function write(store: TrustStore): void {
  fs.mkdirSync(path.dirname(TRUST_FILE), { recursive: true });
  writeFileAtomic(TRUST_FILE, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
}

/** What we are actually trusting — not just the name it was filed under. */
export function fingerprint(cfg: McpServerConfig): string {
  return isHttpConfig(cfg)
    ? 'url:' + cfg.url
    : 'cmd:' + cfg.command + ' ' + (cfg.args ?? []).join(' ');
}

export function isTrusted(name: string, cfg: McpServerConfig): boolean {
  return read()[name] === fingerprint(cfg);
}

export function trust(name: string, cfg: McpServerConfig): void {
  const store = read();
  store[name] = fingerprint(cfg);
  write(store);
}

export function untrust(name: string): boolean {
  const store = read();
  if (!(name in store)) return false;
  delete store[name];
  write(store);
  return true;
}

/**
 * Working directories the user has agreed to run in.
 *
 * Opening a CLI in a directory you just cloned means its SPIDER.md goes into
 * the system prompt, its `.mcp.json` proposes servers, and its
 * `.spider/settings.json` proposes allow rules — all authored by whoever wrote
 * the repo. Asking once, per directory, is the difference between reading a
 * project and being configured by it.
 */
function readDirs(): string[] {
  try {
    return JSON.parse(fs.readFileSync(TRUSTED_DIRS, 'utf8'));
  } catch {
    return [];
  }
}

export function isTrustedDir(dir: string): boolean {
  const resolved = path.resolve(dir);
  return readDirs().some((d) => resolved === d || resolved.startsWith(d + path.sep));
}

export function trustDir(dir: string): void {
  const dirs = readDirs();
  const resolved = path.resolve(dir);
  if (!dirs.includes(resolved)) dirs.push(resolved);
  fs.mkdirSync(path.dirname(TRUSTED_DIRS), { recursive: true });
  writeFileAtomic(TRUSTED_DIRS, JSON.stringify(dirs, null, 2) + '\n', { mode: 0o600 });
}

export function untrustDir(dir: string): boolean {
  const resolved = path.resolve(dir);
  const dirs = readDirs();
  const next = dirs.filter((d) => d !== resolved);
  if (next.length === dirs.length) return false;
  writeFileAtomic(TRUSTED_DIRS, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return true;
}

/**
 * Ask about an unfamiliar directory. Declining is not an error — it starts the
 * session with the project's own configuration ignored.
 */
export async function gateDirectory(
  cwd: string,
  opts: { interactive: boolean } = { interactive: process.stdin.isTTY === true },
): Promise<{ trusted: boolean }> {
  if (isTrustedDir(cwd)) return { trusted: true };

  const findings: string[] = [];
  for (const f of ['SPIDER.md', '.mcp.json', '.spider/settings.json']) {
    if (fs.existsSync(path.join(cwd, f))) findings.push(f);
  }

  if (!opts.interactive) {
    if (findings.length) {
      process.stderr.write(
        'Untrusted directory with agent configuration (' +
          findings.join(', ') +
          ').\n' +
          'Its instructions and servers are ignored. Approve with: spider trust\n\n',
      );
    }
    return { trusted: false };
  }

  process.stdout.write(
    '\nFirst run in ' +
      cwd +
      '\n' +
      (findings.length
        ? 'It carries agent configuration: ' +
          findings.join(', ') +
          '.\n' +
          'Those files can direct the agent, so only continue if you trust this project.\n'
        : 'No agent configuration found here.\n'),
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((r) => rl.question('Trust this directory? [y/N] ', r));
  rl.close();
  process.stdout.write('\n');

  const yes = /^y(es)?$/i.test(answer.trim());
  if (yes) trustDir(cwd);
  return { trusted: yes };
}

export function describeServer(name: string, cfg: McpServerConfig): string {
  return isHttpConfig(cfg)
    ? '  ' + name + '  →  ' + cfg.url + '  (remote)'
    : '  ' + name + '  →  ' + cfg.command + ' ' + (cfg.args ?? []).join(' ') + '  (runs locally)';
}

/**
 * Ask about any server we have not seen before. Returns the servers cleared to
 * connect. Without a TTY there is nobody to ask, so untrusted servers are
 * skipped rather than silently trusted — `spider mcp trust <name>` is the way
 * to approve one for a scripted run.
 */
export async function gateUntrusted(
  servers: Record<string, McpServerConfig>,
  opts: { interactive: boolean } = { interactive: process.stdin.isTTY === true },
): Promise<{ approved: Record<string, McpServerConfig>; skipped: string[] }> {
  const entries = Object.entries(servers ?? {});
  const unknown = entries.filter(([name, cfg]) => cfg.enabled !== false && !isTrusted(name, cfg));
  if (!unknown.length) {
    return {
      approved: Object.fromEntries(entries.filter(([, c]) => c.enabled !== false)),
      skipped: [],
    };
  }

  if (!opts.interactive) {
    const skipped = unknown.map(([n]) => n);
    process.stderr.write(
      'Skipping unapproved MCP server' +
        (skipped.length === 1 ? '' : 's') +
        ': ' +
        skipped.join(', ') +
        '\n' +
        'Approve with: spider mcp trust <name>\n\n',
    );
    return {
      approved: Object.fromEntries(
        entries.filter(([n, c]) => c.enabled !== false && !skipped.includes(n)),
      ),
      skipped,
    };
  }

  process.stdout.write(
    '\nNew MCP server' +
      (unknown.length === 1 ? '' : 's') +
      ' in this configuration:\n' +
      unknown.map(([n, c]) => describeServer(n, c)).join('\n') +
      "\n\nA server runs with your permissions and its tool descriptions go into the model's\n" +
      'prompt. Only approve servers you recognise.\n',
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));
  const skipped: string[] = [];
  try {
    for (const [name, cfg] of unknown) {
      const answer = (await ask('Trust "' + name + '"? [y/N] ')).trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') trust(name, cfg);
      else skipped.push(name);
    }
  } finally {
    rl.close();
  }
  process.stdout.write('\n');

  return {
    approved: Object.fromEntries(
      entries.filter(([n, c]) => c.enabled !== false && !skipped.includes(n)),
    ),
    skipped,
  };
}
