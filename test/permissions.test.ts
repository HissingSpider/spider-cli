/** Workspace scoping. An unscoped read_file is how a credential store ends up
 *  printed to the terminal, so "outside the workspace" must always prompt. */
import os from 'node:os';
import path from 'node:path';
import { decide, escapesWorkspace, matchesRule } from '../src/agent/permissions.ts';
import type { Settings } from '../src/config.ts';
import type { ToolCall } from '../src/providers/types.ts';

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS  ' + name);
  else {
    failures.push(name);
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
}

const CWD = '/Users/me/project';
const base: Settings = {
  model: 'gpt-5',
  permissionMode: 'default',
  allow: [],
  deny: [],
  maxTokens: 8192,
  autoCompactAt: 100000,
  keepRecentTurns: 6,
  mcpServers: {},
};

const read = (p: string): ToolCall => ({ id: 'c', name: 'read_file', input: { path: p } });
const bash = (c: string): ToolCall => ({ id: 'c', name: 'bash', input: { command: c } });

check('relative path inside the workspace does not escape',
  escapesWorkspace(read('src/index.ts'), CWD) === null);
check('absolute path inside the workspace does not escape',
  escapesWorkspace(read(CWD + '/src/a.ts'), CWD) === null);
check('parent traversal escapes',
  escapesWorkspace(read('../../.ssh/id_rsa'), CWD) === '/Users/.ssh/id_rsa',
  'got ' + escapesWorkspace(read('../../.ssh/id_rsa'), CWD));
check('absolute path elsewhere escapes',
  escapesWorkspace(read('/Users/me/Library/Application Support/Claude/config.json'), CWD) !== null);
// A `~` path must resolve to the home directory, not to a literal "~" folder
// under the cwd — otherwise it looks in-workspace and never prompts.
check('tilde path escapes the workspace',
  escapesWorkspace(read('~/.ssh/id_rsa'), CWD) === path.join(os.homedir(), '.ssh/id_rsa'),
  String(escapesWorkspace(read('~/.ssh/id_rsa'), CWD)));
check('bare tilde escapes', escapesWorkspace(read('~'), CWD) === os.homedir());
check('tilde inside the workspace is still in-workspace',
  escapesWorkspace(read('src/~notes.md'), CWD) === null);

check('the incident path escapes',
  escapesWorkspace(read('~/Library/x.json'.replace('~', '/Users/me')), CWD) !== null);

// The actual regression: a read outside the workspace must not be auto-allowed.
const outside = decide(
  read('/Users/me/Library/Application Support/Claude/config.json'),
  base, 'default', CWD,
);
check('read outside the workspace asks, despite being read-only',
  outside.kind === 'ask', 'got ' + outside.kind);

const inside = decide(read('src/index.ts'), base, 'default', CWD);
check('read inside the workspace stays unprompted', inside.kind === 'allow');

// Escaping in acceptEdits still asks — that mode relaxes edits, not scope.
const escAccept = decide(read('/etc/passwd'), base, 'acceptEdits', CWD);
check('acceptEdits does not relax workspace scope', escAccept.kind === 'ask');

// Deny rules outrank everything, including bypassPermissions.
const denied = decide(bash('rm -rf /'), { ...base, deny: ['bash(rm:*)'] }, 'bypassPermissions', CWD);
check('deny beats bypassPermissions', denied.kind === 'deny');

// bypassPermissions is explicitly no-prompts, including outside the workspace.
const bypass = decide(read('/etc/hosts'), base, 'bypassPermissions', CWD);
check('bypassPermissions allows an outside read (by design)', bypass.kind === 'allow');

// A stored rule for the specific outside path re-allows it without prompting.
const remembered = decide(
  read('/etc/hosts'),
  { ...base, allow: ['read_file(/etc/hosts)'] },
  'default', CWD,
);
check('an explicit allow rule re-permits an outside path', remembered.kind === 'allow',
  'got ' + remembered.kind);

check('prefix rule matches', matchesRule('bash(git status:*)', bash('git status -sb')));
check('prefix rule does not over-match', !matchesRule('bash(git status:*)', bash('git push')));

console.log(failures.length ? '\n' + failures.length + ' FAILED' : '\nAll permission checks passed');
process.exit(failures.length ? 1 : 0);
