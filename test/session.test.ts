/** Session persistence. Turns are appended, not rewritten, and a transcript
 *  truncated by a crash must still load. */
import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR } from '../src/config.ts';
import * as sessions from '../src/session.ts';
import type { Turn } from '../src/providers/types.ts';

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS  ' + name);
  else {
    failures.push(name);
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
}

const DIR = path.join(HOME_DIR, 'sessions');
const CWD = '/tmp/spider-session-test-' + process.pid;
const id = 'test-' + process.pid;
const file = path.join(DIR, id + '.jsonl');
const user = (t: string): Turn => ({ role: 'user', text: t });

const base = { id, cwd: CWD, model: 'gpt-5', updatedAt: '' };

console.log('\nappend');
sessions.save({ ...base, turns: [user('one')] });
const afterOne = fs.readFileSync(file, 'utf8');
check('a header plus one turn is two lines',
  afterOne.trim().split('\n').length === 2, JSON.stringify(afterOne));

sessions.save({ ...base, turns: [user('one'), user('two')] });
const afterTwo = fs.readFileSync(file, 'utf8');
check('the second save appends one line',
  afterTwo.trim().split('\n').length === 3, JSON.stringify(afterTwo));
// The turn lines must be byte-identical: appending means not touching them.
check('the existing turn line is untouched by the append',
  afterTwo.split('\n')[1] === afterOne.split('\n')[1],
  afterOne.split('\n')[1] + ' vs ' + afterTwo.split('\n')[1]);

console.log('\nload');
const loaded = sessions.byId(id, CWD)!;
check('it round-trips', loaded.turns.length === 2, JSON.stringify(loaded.turns));
check('turn text survives', (loaded.turns[0] as any).text === 'one');
check('a title is derived from the first user turn', loaded.title === 'one', loaded.title);

console.log('\nmode and rules survive');
sessions.save({ ...base, turns: [user('one'), user('two')], mode: 'plan', allow: ['bash(ls:*)'] });
const withMode = sessions.byId(id, CWD)!;
check('mode round-trips', withMode.mode === 'plan');
check('allow rules round-trip', withMode.allow?.[0] === 'bash(ls:*)');

console.log('\na crash mid-write does not lose the session');
fs.appendFileSync(file, '{"role":"user","te');
const survived = sessions.byId(id, CWD);
check('a truncated final line is dropped, not fatal',
  survived !== null && survived.turns.length === 2,
  JSON.stringify(survived?.turns.length));

console.log('\nlookup');
check('a unique prefix resolves', sessions.byId(id.slice(0, 8), CWD)?.id === id);
check('an unknown id returns null', sessions.byId('definitely-not-here', CWD) === null);
check('mostRecent finds it', sessions.mostRecent(CWD)?.id === id);
check('another cwd does not see it', sessions.list('/somewhere/else').every((s) => s.id !== id));

console.log('\nfork branches instead of overwriting');
const forked = sessions.fork(id, CWD)!;
check('the fork has a new id', forked.id !== id);
check('it carries the turns', forked.turns.length === 2);
check('the original is untouched', sessions.byId(id, CWD)?.turns.length === 2);

console.log('\nshrinking rewrites rather than appending');
sessions.save({ ...base, turns: [user('fresh')] });
check('a cleared transcript truncates the file',
  sessions.byId(id, CWD)?.turns.length === 1,
  String(sessions.byId(id, CWD)?.turns.length));

console.log('\nexport');
const md = sessions.toMarkdown(sessions.byId(id, CWD)!);
check('markdown has a heading', md.startsWith('# '));
check('markdown includes the turn', md.includes('fresh'));

for (const f of [file, path.join(DIR, forked.id + '.jsonl')]) {
  fs.rmSync(f, { force: true });
}
console.log('');
if (failures.length) {
  console.error(failures.length + ' failure(s): ' + failures.join(', '));
  process.exit(1);
}
console.log('All session checks passed.');
