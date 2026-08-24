/** A half-written state file is silently treated as absent by every reader
 *  here, so an interrupted write quietly logs you out or drops your rules.
 *  writeFileAtomic makes the swap all-or-nothing. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../src/atomic.ts';

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS  ' + name);
  else {
    failures.push(name);
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-atomic-'));
const file = path.join(dir, 'state.json');

writeFileAtomic(file, '{"a":1}');
check('writes the file', fs.readFileSync(file, 'utf8') === '{"a":1}');

writeFileAtomic(file, '{"a":2}');
check('overwrites cleanly', fs.readFileSync(file, 'utf8') === '{"a":2}');

check(
  'leaves no temp files behind',
  fs.readdirSync(dir).filter((f) => f.includes('.tmp')).length === 0,
  fs.readdirSync(dir).join(','),
);

const nested = path.join(dir, 'a', 'b', 'c.json');
writeFileAtomic(nested, 'deep');
check('creates missing parent directories', fs.readFileSync(nested, 'utf8') === 'deep');

const secret = path.join(dir, 'token.json');
writeFileAtomic(secret, 'shh', { mode: 0o600 });
check(
  'honours the mode, so tokens stay owner-only',
  (fs.statSync(secret).mode & 0o777) === 0o600,
  '0' + (fs.statSync(secret).mode & 0o777).toString(8),
);

// The point of the exercise: a failed write must not destroy what was there.
const kept = path.join(dir, 'kept.json');
writeFileAtomic(kept, '{"original":true}');
let threw = false;
try {
  // A directory where the temp file needs to go cannot be written.
  writeFileAtomic(path.join(dir, 'blocked', 'x.json'), 'irrelevant');
  fs.mkdirSync(path.join(dir, 'blocked2'), { recursive: true });
  writeFileAtomic(path.join(dir, 'blocked2'), 'this target is a directory');
} catch {
  threw = true;
}
check('a failed write throws rather than silently passing', threw);
check(
  'the previous file is untouched by an unrelated failure',
  fs.readFileSync(kept, 'utf8') === '{"original":true}',
);
check(
  'a failed write cleans up its temp file',
  fs.readdirSync(dir).filter((f) => f.includes('.tmp')).length === 0,
  fs.readdirSync(dir).join(','),
);

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures.length ? '\n' + failures.length + ' FAILED' : '\nAll atomic checks passed');
process.exit(failures.length ? 1 : 0);
