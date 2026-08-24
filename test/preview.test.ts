/** Approval previews. An edit shown as `edit_file → path` asks the user to
 *  approve a change they cannot see, so edits must render a real diff. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editDiff, unifiedDiff } from '../src/agent/preview.ts';
import { decide, matchesRule, registerReadOnlyTools, clearReadOnlyTools } from '../src/agent/permissions.ts';
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-preview-'));
const base: Settings = {
  model: 'gpt-5', permissionMode: 'default', allow: [], deny: [], maxTokens: 8192,
  autoCompactAt: 100000, keepRecentTurns: 6, mcpServers: {},
};

console.log('\nunifiedDiff');
const d = unifiedDiff('a\nb\nc', 'a\nB\nc');
check('marks the removed line', d.includes('-b'), JSON.stringify(d));
check('marks the added line', d.includes('+B'), JSON.stringify(d));
check('keeps surrounding context', d.includes(' a') && d.includes(' c'));
check('identical input reports no change', unifiedDiff('x\ny', 'x\ny')[0] === '(no change)');

console.log('\neditDiff');
fs.writeFileSync(path.join(dir, 'f.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
const edit: ToolCall = {
  id: 'e', name: 'edit_file',
  input: { path: 'f.ts', old_string: 'const b = 2;', new_string: 'const b = 22;' },
};
const ed = editDiff(edit, dir);
check('edit_file produces a diff', !!ed && ed.includes('-const b = 2;') && ed.includes('+const b = 22;'),
  JSON.stringify(ed));

const noMatch: ToolCall = {
  id: 'e', name: 'edit_file',
  input: { path: 'f.ts', old_string: 'nope', new_string: 'x' },
};
check('a non-matching edit yields no diff rather than a wrong one', editDiff(noMatch, dir) === null);

const newFile: ToolCall = {
  id: 'w', name: 'write_file', input: { path: 'new.ts', content: 'line one\nline two' },
};
const nd = editDiff(newFile, dir);
check('a new file shows every line as an addition',
  !!nd && nd.every((l) => l.startsWith('+') || l.startsWith('@@')), JSON.stringify(nd));

fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 2, 0]));
check('a binary file is not diffed',
  editDiff({ id: 'w', name: 'write_file', input: { path: 'bin.dat', content: 'x' } }, dir) === null);

console.log('\nthe approval preview carries the diff');
const decision = decide(edit, base, 'default', dir);
check('preview includes the diff body',
  decision.kind === 'ask' && decision.preview.includes('+const b = 22;'),
  decision.kind === 'ask' ? decision.preview : decision.kind);

console.log('\nMCP rules: wildcards and read-only hints');
const mcpCall: ToolCall = { id: 'm', name: 'mcp__deerdawn__recall', input: {} };
check('a server wildcard covers its tools', matchesRule('mcp__deerdawn__*', mcpCall));
check('a server wildcard does not cover another server',
  !matchesRule('mcp__other__*', mcpCall));
check('an un-hinted MCP tool still asks',
  decide(mcpCall, base, 'default', dir).kind === 'ask');
check('an un-hinted MCP tool is refused while planning',
  decide(mcpCall, base, 'plan', dir).kind === 'deny');

registerReadOnlyTools(['mcp__deerdawn__recall']);
check('a read-only-hinted MCP tool runs unprompted',
  decide(mcpCall, base, 'default', dir).kind === 'allow');
check('a read-only-hinted MCP tool is usable while planning (card #22)',
  decide(mcpCall, base, 'plan', dir).kind === 'allow');
clearReadOnlyTools();

fs.rmSync(dir, { recursive: true, force: true });
console.log('');
if (failures.length) {
  console.error(failures.length + ' failure(s): ' + failures.join(', '));
  process.exit(1);
}
console.log('All preview/MCP-rule checks passed.');
