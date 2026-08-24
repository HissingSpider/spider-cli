/** Hooks. The point of a hook is that the harness runs it, so a hook that
 *  blocks must actually stop the tool — and a hook that is merely broken must
 *  not silently become a deny-all. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runHooks } from '../src/agent/hooks.ts';
import type { Settings } from '../src/config.ts';

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS  ' + name);
  else {
    failures.push(name);
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-hooks-'));
const settings = (hooks: any): Settings => ({
  model: 'gpt-5',
  permissionMode: 'default',
  allow: [],
  deny: [],
  maxTokens: 8192,
  autoCompactAt: 100000,
  keepRecentTurns: 6,
  mcpServers: {},
  hooks,
});

// A hook that records what it was handed, so we can check the payload arrives.
const recorder = path.join(dir, 'record.sh');
fs.writeFileSync(recorder, '#!/bin/sh\ncat > "' + dir + '/payload.json"\nexit 0\n', {
  mode: 0o755,
});

console.log('\npayload');
await runHooks(
  'PreToolUse',
  settings({ PreToolUse: [{ command: recorder }] }),
  { tool_name: 'bash', tool_input: { command: 'ls' } },
  dir,
);
const payload = JSON.parse(fs.readFileSync(path.join(dir, 'payload.json'), 'utf8'));
check('the event is named', payload.event === 'PreToolUse', JSON.stringify(payload));
check('the tool name is passed', payload.tool_name === 'bash');
check('the tool input is passed', payload.tool_input.command === 'ls');
check('the cwd is passed', payload.cwd === dir);

console.log('\nblocking');
const byExit2 = await runHooks(
  'PreToolUse',
  settings({ PreToolUse: [{ command: 'echo "nope" 1>&2; exit 2' }] }),
  { tool_name: 'bash' },
  dir,
);
check('exit 2 blocks', byExit2.blocked);
check('stderr becomes the reason', (byExit2.reason ?? '').includes('nope'), byExit2.reason);

const byJson = await runHooks(
  'PreToolUse',
  settings({ PreToolUse: [{ command: `echo '{"decision":"block","reason":"policy"}'` }] }),
  { tool_name: 'bash' },
  dir,
);
check('a JSON decision blocks', byJson.blocked);
check('its reason is used', byJson.reason === 'policy', byJson.reason);

console.log('\na broken hook is not a veto');
const broken = await runHooks(
  'PreToolUse',
  settings({ PreToolUse: [{ command: 'exit 7' }] }),
  { tool_name: 'bash' },
  dir,
);
check('an unexpected exit code does not block', !broken.blocked);
check('but it is reported', broken.notices.length === 1, JSON.stringify(broken.notices));

const missing = await runHooks(
  'PreToolUse',
  settings({ PreToolUse: [{ command: '/nonexistent/hook' }] }),
  { tool_name: 'bash' },
  dir,
);
check('a missing hook command does not block', !missing.blocked);
check('and is reported', missing.notices.length === 1);

console.log('\nmatchers');
const nonMatching = await runHooks(
  'PreToolUse',
  settings({ PreToolUse: [{ matcher: 'write_file', command: 'exit 2' }] }),
  { tool_name: 'bash' },
  dir,
);
check('a hook whose matcher misses does not run', !nonMatching.blocked);

const matching = await runHooks(
  'PreToolUse',
  settings({ PreToolUse: [{ matcher: 'write_file|edit_file', command: 'exit 2' }] }),
  { tool_name: 'edit_file' },
  dir,
);
check('an alternation matcher hits', matching.blocked);

const anchored = await runHooks(
  'PreToolUse',
  settings({ PreToolUse: [{ matcher: 'bash', command: 'exit 2' }] }),
  { tool_name: 'bash_other' },
  dir,
);
check('matchers are anchored, so "bash" does not match "bash_other"', !anchored.blocked);

const badRegex = await runHooks(
  'PreToolUse',
  settings({ PreToolUse: [{ matcher: '[', command: 'exit 2' }] }),
  { tool_name: 'bash' },
  dir,
);
check('a malformed matcher matches nothing rather than everything', !badRegex.blocked);

console.log('\nadditional context');
const ctx = await runHooks(
  'PostToolUse',
  settings({ PostToolUse: [{ command: `echo '{"additionalContext":"tests are failing"}'` }] }),
  { tool_name: 'bash' },
  dir,
);
check('additionalContext comes back', ctx.context === 'tests are failing', ctx.context);
check('and does not block', !ctx.blocked);

console.log('\nordering');
const order = path.join(dir, 'order.txt');
fs.writeFileSync(order, '');
await runHooks(
  'PostToolUse',
  settings({
    PostToolUse: [
      { command: 'sleep 0.2; echo one >> ' + order },
      { command: 'echo two >> ' + order },
    ],
  }),
  { tool_name: 'bash' },
  dir,
);
check(
  'hooks run in order, not concurrently',
  fs.readFileSync(order, 'utf8').trim().split('\n').join(',') === 'one,two',
  fs.readFileSync(order, 'utf8'),
);

console.log('\nno hooks configured');
const none = await runHooks('Stop', settings({}), {}, dir);
check('nothing configured is a no-op', !none.blocked && !none.notices.length);

console.log('\nhooks that ignore stdin');
// A hook that never reads stdin closes the pipe early; writing the payload then
// raises EPIPE, which unguarded is an unhandled socket error that kills the CLI.
// Timing-dependent — it passed on macOS and failed on Linux CI — so the payload
// is padded to make the write big enough to lose the race reliably.
const big = 'x'.repeat(200_000);

const quiet = await runHooks(
  'PreToolUse',
  settings({ PreToolUse: [{ command: 'exit 0' }] }),
  { tool_name: 'bash', tool_input: { command: big } },
  dir,
);
check('a hook that ignores stdin does not crash the process', !quiet.blocked);

const printer = await runHooks(
  'PreToolUse',
  settings({ PreToolUse: [{ command: 'echo ok' }] }),
  { tool_name: 'bash', tool_input: { command: big } },
  dir,
);
check('a hook that only prints still completes', !printer.blocked);

fs.rmSync(dir, { recursive: true, force: true });
console.log('');
if (failures.length) {
  console.error(failures.length + ' failure(s): ' + failures.join(', '));
  process.exit(1);
}
console.log('All hook checks passed.');
