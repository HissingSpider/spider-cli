/**
 * Shell portability. `/bin/zsh` was hardcoded, so every command failed with
 * ENOENT on any machine without it — Linux boxes, containers, CI runners.
 * CI caught it on the first run; these tests keep it caught.
 */
import { accessSync, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { SHELL } from '../src/tools/shell.ts';

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS  ' + name);
  else {
    failures.push(name);
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
}

check('a shell was resolved', typeof SHELL.path === 'string' && SHELL.path.length > 0, SHELL.path);

check('the resolved shell is executable', (() => {
  try {
    accessSync(SHELL.path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
})(), SHELL.path);

const name = SHELL.path.split('/').pop() ?? '';
check('startup files are skipped for zsh and bash', (() => {
  if (name === 'zsh') return SHELL.args.includes('-f');
  if (name === 'bash') return SHELL.args.includes('--noprofile');
  return SHELL.args.length === 0; // sh understands neither
})(), name + ' ' + JSON.stringify(SHELL.args));

check('sh is never given flags it cannot parse', !(name === 'sh' && SHELL.args.length > 0));

/** Load the module fresh with a given SPIDER_SHELL, and report what it picked. */
function resolveUnder(shell: string | undefined): { path: string; args: string[]; ranOk: boolean } {
  const script = `
    import { SHELL } from ${JSON.stringify(path.join(import.meta.dirname, '..', 'src', 'tools', 'shell.ts'))};
    import { spawnSync } from 'node:child_process';
    const out = spawnSync(SHELL.path, [...SHELL.args, '-c', 'echo SHELL_RAN'], { encoding: 'utf8' });
    console.log(JSON.stringify({ path: SHELL.path, args: SHELL.args, ranOk: /SHELL_RAN/.test(out.stdout ?? '') }));
  `;
  const env = { ...process.env };
  delete env.SPIDER_SHELL;
  if (shell) env.SPIDER_SHELL = shell;

  const res = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), '--eval', script],
    { encoding: 'utf8', env },
  );
  const line = (res.stdout ?? '').trim().split('\n').pop() ?? '{}';
  try {
    return JSON.parse(line);
  } catch {
    return { path: '', args: [], ranOk: false };
  }
}

// The three shells that actually matter, each genuinely executing a command.
for (const candidate of ['/bin/bash', '/bin/sh', '/bin/zsh']) {
  let present = true;
  try {
    accessSync(candidate, constants.X_OK);
  } catch {
    present = false;
  }
  if (!present) {
    console.log('  SKIP  ' + candidate + ' not on this machine');
    continue;
  }
  const r = resolveUnder(candidate);
  check('SPIDER_SHELL=' + candidate + ' is honoured', r.path === candidate, r.path);
  check('a command actually runs under ' + candidate, r.ranOk,
    JSON.stringify(r));
}

// An override pointing at nothing must fall back rather than crash the agent.
const bogus = resolveUnder('/nonexistent/shell/xyz');
check('a bogus SPIDER_SHELL falls back to a working shell', bogus.path !== '/nonexistent/shell/xyz' && bogus.ranOk,
  JSON.stringify(bogus));

console.log(failures.length ? '\n' + failures.length + ' FAILED' : '\nAll shell checks passed');
process.exit(failures.length ? 1 : 0);
