/** The shell persists, background jobs run, and an edit cannot be made to a
 *  file the agent has never looked at. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOLS } from '../src/tools/index.ts';
import { clearReadFiles } from '../src/tools/index.ts';
import { killAllJobs, resetShells } from '../src/tools/shell.ts';

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS  ' + name);
  else {
    failures.push(name);
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
}

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spider-tools-')));
fs.mkdirSync(path.join(dir, 'sub'));
const run = (tool: string, input: Record<string, unknown>) => TOOLS[tool].run(input, dir);

console.log('\nthe shell persists between calls');
await run('bash', { command: 'cd sub' });
const pwd = await run('bash', { command: 'pwd' });
check('cd carries over to the next call', pwd.output.trim().endsWith('/sub'), pwd.output);

await run('bash', { command: 'export SPIDER_TEST_VAR=hello' });
const env = await run('bash', { command: 'echo $SPIDER_TEST_VAR' });
check('an exported variable survives', env.output.trim() === 'hello', env.output);

await run('bash', { command: 'cd ..' });

console.log('\nexit codes and errors');
const okRun = await run('bash', { command: 'echo fine' });
check('success is not an error', !okRun.isError && okRun.output.trim() === 'fine', okRun.output);
const bad = await run('bash', { command: 'ls /definitely/not/here' });
check('a non-zero exit is an error', bad.isError, bad.output);

// `exit` kills the shell, so the completion sentinel never arrives. Without
// explicit handling this hangs until the timeout.
const suicide = await run('bash', { command: 'exit 3' });
check('a command that exits the shell still returns', suicide.isError, suicide.output);
check('and says what happened', /shell exited/.test(suicide.output), suicide.output);
const revived = await run('bash', { command: 'echo back' });
check('the next command gets a fresh shell', revived.output.trim() === 'back', revived.output);
const stderr = await run('bash', { command: 'echo oops 1>&2; exit 1' });
check('stderr is captured', stderr.output.includes('oops'), stderr.output);

console.log('\ntimeouts restart the shell rather than wedging it');
const slow = await run('bash', { command: 'sleep 5', timeout_ms: 400 });
check('a slow command times out', slow.isError && /timed out/.test(slow.output), slow.output);
const after = await run('bash', { command: 'echo alive' });
check('the shell works again afterwards', after.output.trim() === 'alive', after.output);

console.log('\nbackground jobs');
const started = await run('bash', {
  command: 'for i in 1 2 3; do echo tick $i; sleep 0.15; done',
  run_in_background: true,
});
const jobId = /bg_\d+/.exec(started.output)?.[0] ?? '';
check('starting returns immediately with an id', !!jobId, started.output);
await new Promise((r) => setTimeout(r, 600));
const first = await run('bash_output', { id: jobId });
check('output can be polled', first.output.includes('tick 1'), first.output);
const second = await run('bash_output', { id: jobId });
check('a second poll does not repeat what was already read',
  !second.output.includes('tick 1'), second.output);
check('an unknown job id is an error', (await run('bash_output', { id: 'bg_999' })).isError);
check('killing an unknown job is an error', (await run('kill_shell', { id: 'bg_999' })).isError);

console.log('\nread offset and limit');
fs.writeFileSync(
  path.join(dir, 'big.txt'),
  Array.from({ length: 50 }, (_, i) => 'line ' + (i + 1)).join('\n'),
);
const head = await run('read_file', { path: 'big.txt', limit: 3 });
check('limit truncates', head.output.includes('line 3') && !head.output.includes('line 4'), head.output);
check('the truncation is reported', head.output.includes('of 50'), head.output);
const mid = await run('read_file', { path: 'big.txt', offset: 10, limit: 2 });
check('offset starts where asked',
  mid.output.includes('line 10') && !mid.output.includes('line 9'), mid.output);
check('line numbers reflect the offset', /10\s+line 10/.test(mid.output), mid.output);
const past = await run('read_file', { path: 'big.txt', offset: 999 });
check('an offset past the end is an error', past.isError, past.output);

console.log('\nbinaries are refused, not mangled');
fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([1, 0, 2, 0, 3]));
const bin = await run('read_file', { path: 'blob.bin' });
check('a binary file is refused', bin.isError && /not text/.test(bin.output), bin.output);

console.log('\nread before write');
clearReadFiles();
fs.writeFileSync(path.join(dir, 'existing.ts'), 'const a = 1;\n');
const blindEdit = await run('edit_file', {
  path: 'existing.ts', old_string: 'const a = 1;', new_string: 'const a = 2;',
});
check('editing an unread file is refused', blindEdit.isError, blindEdit.output);
check('the file is untouched',
  fs.readFileSync(path.join(dir, 'existing.ts'), 'utf8') === 'const a = 1;\n');

const blindWrite = await run('write_file', { path: 'existing.ts', content: 'wiped' });
check('overwriting an unread file is refused', blindWrite.isError, blindWrite.output);
check('it is still untouched',
  fs.readFileSync(path.join(dir, 'existing.ts'), 'utf8') === 'const a = 1;\n');

await run('read_file', { path: 'existing.ts' });
const goodEdit = await run('edit_file', {
  path: 'existing.ts', old_string: 'const a = 1;', new_string: 'const a = 2;',
});
check('editing after reading works', !goodEdit.isError, goodEdit.output);
check('the change landed',
  fs.readFileSync(path.join(dir, 'existing.ts'), 'utf8').includes('const a = 2;'));

const newFile = await run('write_file', { path: 'brand-new.ts', content: 'x' });
check('writing a new file needs no prior read', !newFile.isError, newFile.output);

killAllJobs();
resetShells();
fs.rmSync(dir, { recursive: true, force: true });
console.log('');
if (failures.length) {
  console.error(failures.length + ' failure(s): ' + failures.join(', '));
  process.exit(1);
}
console.log('All tool checks passed.');
process.exit(0);
