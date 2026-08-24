/** Rewinding must restore the transcript AND the working tree. Undoing the
 *  conversation while leaving edited files behind produces a state that never
 *  existed, which is worse than not rewinding at all. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CheckpointStore, formatList } from '../src/checkpoint.ts';
import type { Turn } from '../src/providers/types.ts';

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS  ' + name);
  else {
    failures.push(name);
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-cp-'));
const fileA = path.join(dir, 'a.txt');
const fileB = path.join(dir, 'nested', 'b.txt');
fs.writeFileSync(fileA, 'ORIGINAL A');

const store = new CheckpointStore();
const turns: Turn[] = [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'ok', toolCalls: [] }];

// --- checkpoint 1: two turns of history, then edit A and create B ---
const cp1 = store.record('edit the files', turns);
check('checkpoint gets an id', cp1.id === 1);
check('transcript is snapshotted', cp1.turns.length === 2);

store.backup(fileA);
fs.writeFileSync(fileA, 'MODIFIED A');
store.backup(fileB); // does not exist yet
fs.mkdirSync(path.dirname(fileB), { recursive: true });
fs.writeFileSync(fileB, 'NEW B');

// --- checkpoint 2: later turn, edits A again ---
const longer: Turn[] = [...turns, { role: 'user', text: 'second' }, { role: 'assistant', text: 'done', toolCalls: [] }];
const cp2 = store.record('edit again', longer);
store.backup(fileA);
fs.writeFileSync(fileA, 'MODIFIED A TWICE');

check('two checkpoints tracked', store.length === 2);
check('cp2 captured A as it was at cp2', cp2.files.get(fileA) === 'MODIFIED A',
  String(cp2.files.get(fileA)));
check('cp1 still holds the original A', cp1.files.get(fileA) === 'ORIGINAL A',
  String(cp1.files.get(fileA)));
check('cp1 recorded B as absent', cp1.files.get(fileB) === null);

// --- rewind to cp2: A goes back one step, B survives ---
const r2 = store.restore(cp2.id)!;
check('restore returns the transcript at cp2', r2.turns.length === 4);
check('A reverted to its cp2 content', fs.readFileSync(fileA, 'utf8') === 'MODIFIED A');
check('B untouched by a cp2 rewind', fs.readFileSync(fileB, 'utf8') === 'NEW B');
check('restoring drops that checkpoint', store.length === 1);

// --- rewind to cp1: A back to original, B deleted since it did not exist ---
const r1 = store.restore(cp1.id)!;
check('restore returns the transcript at cp1', r1.turns.length === 2);
check('A reverted to the original', fs.readFileSync(fileA, 'utf8') === 'ORIGINAL A',
  fs.readFileSync(fileA, 'utf8'));
check('a file created after the checkpoint is deleted', !fs.existsSync(fileB));
check('deletion is reported', r1.removed.some((f) => f === fileB), r1.removed.join(','));
check('all checkpoints consumed', store.length === 0);

// --- snapshots must be independent of later mutation ---
const store2 = new CheckpointStore();
const live: Turn[] = [{ role: 'user', text: 'one' }];
const cp = store2.record('snapshot', live);
live.push({ role: 'assistant', text: 'mutated after the snapshot', toolCalls: [] });
check('snapshot is a deep copy, not a reference', cp.turns.length === 1, String(cp.turns.length));

// --- edge cases ---
check('restoring an unknown id returns null', store2.restore(999) === null);
check('backup with no checkpoints is a no-op', (() => {
  const empty = new CheckpointStore();
  empty.backup(fileA);
  return empty.length === 0;
})());
check('empty listing explains itself', /No checkpoints yet/.test(formatList([], dir)));
check('listing shows changed-file counts', /1 file changed since/.test(
  (() => {
    const s3 = new CheckpointStore();
    s3.record('x', []);
    s3.backup(fileA);
    return formatList(s3.list(), dir);
  })(),
));

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures.length ? '\n' + failures.length + ' FAILED' : '\nAll checkpoint checks passed');
process.exit(failures.length ? 1 : 0);
