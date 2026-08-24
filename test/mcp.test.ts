/** The MCP client: concurrent connect with deadlines, listing changes picked up
 *  mid-session, stderr kept, resources and prompts, and tool filtering. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectServers, textOf } from '../src/mcp/client.ts';
import { clearReadOnlyTools, decide } from '../src/agent/permissions.ts';
import type { Settings } from '../src/config.ts';

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS  ' + name);
  else {
    failures.push(name);
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const rich = { command: process.execPath, args: [path.join(here, 'mcp-rich-fixture.mjs')] };
const base: Settings = {
  model: 'gpt-5',
  permissionMode: 'default',
  allow: [],
  deny: [],
  maxTokens: 8192,
  autoCompactAt: 100000,
  keepRecentTurns: 6,
  mcpServers: {},
  hooks: {},
};

clearReadOnlyTools();

console.log('\nconnect');
const notices: string[] = [];
let toolsChanged = 0;
const mcp = await connectServers(
  {
    rich,
    // A server that will never come up must not hold the others hostage.
    wedged: { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 800 },
    off: { command: 'does-not-exist', enabled: false },
  },
  process.cwd(),
  { onNotice: (t) => notices.push(t), onToolsChanged: () => toolsChanged++ },
);

const byName = (n: string) => mcp.status.find((s) => s.name === n)!;
check('the good server connected', byName('rich').ok, JSON.stringify(byName('rich')));
check('it reports a latency', typeof byName('rich').latencyMs === 'number');
check('a hanging server times out instead of blocking', !byName('wedged').ok);
check(
  'the timeout is reported as such',
  /timed out/.test(byName('wedged').error ?? ''),
  byName('wedged').error,
);
check('a disabled server is not connected', byName('off').state === 'disabled');
check(
  'stderr from the server is kept',
  byName('rich').stderr.some((l) => l.includes('starting up')),
  JSON.stringify(byName('rich').stderr),
);

console.log('\nlisting');
check('tools are namespaced', 'mcp__rich__peek' in mcp.tools, Object.keys(mcp.tools).join(','));
check('resources are listed', mcp.status.find((s) => s.name === 'rich')!.resourceCount === 1);
check('prompts are listed', mcp.status.find((s) => s.name === 'rich')!.promptCount === 1);

console.log('\nread-only hints reach the permission engine');
const peek = { id: 'p', name: 'mcp__rich__peek', input: {} };
const mutate = { id: 'm', name: 'mcp__rich__mutate', input: {} };
check(
  'a readOnlyHint tool runs unprompted',
  decide(peek, base, 'default', process.cwd()).kind === 'allow',
);
check(
  'a readOnlyHint tool works while planning',
  decide(peek, base, 'plan', process.cwd()).kind === 'allow',
);
check(
  'an un-hinted tool still asks',
  decide(mutate, base, 'default', process.cwd()).kind === 'ask',
);
check(
  'an un-hinted tool is refused while planning',
  decide(mutate, base, 'plan', process.cwd()).kind === 'deny',
);

console.log('\nnon-text content is described, not dumped');
const noisy = await mcp.tools.mcp__rich__noisy.run({}, process.cwd());
check('text survives', noisy.output.includes('here is a picture'));
check('an image is summarized', /\[image, image\/png, \d+ KB\]/.test(noisy.output), noisy.output);
check('a resource link keeps its uri', noisy.output.includes('mem://doc/1'), noisy.output);

console.log('\nresources and prompts');
check(
  'readResource returns contents',
  (await mcp.readResource('rich', 'mem://doc/1')).includes('contents of mem://doc/1'),
);
check(
  'getPrompt fills arguments',
  (await mcp.getPrompt('rich', 'review', { path: 'src/a.ts' })).includes('review src/a.ts'),
);

console.log('\ntools/list_changed is acted on');
const before = Object.keys(mcp.tools).filter((k) => k.startsWith('mcp__rich__')).length;
await mcp.tools.mcp__rich__grow.run({}, process.cwd());
await new Promise((r) => setTimeout(r, 500));
const after = Object.keys(mcp.tools).filter((k) => k.startsWith('mcp__rich__')).length;
check('a tool added mid-session appears', after === before + 1, before + ' -> ' + after);
check('the host was told to rebuild its tool map', toolsChanged > 0);
check(
  'the change was announced',
  notices.some((n) => n.includes('updated its tools')),
  JSON.stringify(notices),
);

await mcp.close();

console.log('\ntool filtering keeps the list small');
const filtered = await connectServers(
  { rich: { ...rich, excludeTools: ['mutate', 'noisy', 'grow'] } },
  process.cwd(),
);
check(
  'excluded tools are not exposed',
  !('mcp__rich__mutate' in filtered.tools),
  Object.keys(filtered.tools).join(','),
);
check('the rest are', 'mcp__rich__peek' in filtered.tools);
check(
  'the count of what was dropped is reported',
  filtered.status[0].filtered === 3,
  String(filtered.status[0].filtered),
);
await filtered.close();

const only = await connectServers({ rich: { ...rich, tools: ['peek'] } }, process.cwd());
check(
  'an allowlist exposes only what it names',
  Object.keys(only.tools).filter((k) => k.startsWith('mcp__rich__')).length === 1,
);
await only.close();

console.log('\ntextOf');
check('a bare object is stringified', textOf({ foo: 1 }) === '{"foo":1}');
check(
  'embedded text resources are inlined',
  textOf({ content: [{ type: 'resource', resource: { text: 'inline', uri: 'x' } }] }) === 'inline',
);

console.log('\ntrust gate');
const { gateUntrusted, fingerprint, isTrusted, trust, untrust } = await import(
  '../src/mcp/trust.ts'
);
const cfgA = { command: 'node', args: ['a.mjs'] };
const cfgB = { command: 'node', args: ['b.mjs'] };
untrust('__test_srv');
check('an unseen server is untrusted', !isTrusted('__test_srv', cfgA));
trust('__test_srv', cfgA);
check('trusting works', isTrusted('__test_srv', cfgA));
check(
  'trust is keyed to what was approved, not the name',
  !isTrusted('__test_srv', cfgB),
  fingerprint(cfgA) + ' vs ' + fingerprint(cfgB),
);

const gated = await gateUntrusted({ __test_srv: cfgA, __test_other: cfgB }, { interactive: false });
check('a trusted server passes the gate', '__test_srv' in gated.approved);
check('an untrusted server is skipped without a TTY', !('__test_other' in gated.approved));
check('the skip is reported', gated.skipped.includes('__test_other'));
untrust('__test_srv');

console.log('\nconfig sources');
const fsMod = await import('node:fs');
const osMod = await import('node:os');
const pathMod = await import('node:path');
const { addMcpServer, loadSettings, removeMcpServer } = await import('../src/config.ts');
const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'spider-cfg-'));
addMcpServer(tmp, 'from_mcp_json', { command: 'x' });
check(
  '.mcp.json is picked up by loadSettings',
  'from_mcp_json' in loadSettings(tmp).mcpServers,
  JSON.stringify(Object.keys(loadSettings(tmp).mcpServers)),
);
check(
  'removing takes it back out',
  removeMcpServer(tmp, 'from_mcp_json') && !('from_mcp_json' in loadSettings(tmp).mcpServers),
);

const { persistAllowRule } = await import('../src/config.ts');
persistAllowRule(tmp, 'bash(ls:*)');
check(
  'a learned rule lands in settings.local.json',
  fsMod.existsSync(pathMod.join(tmp, '.spider/settings.local.json')),
);
check(
  'it is not written to the shared project file',
  !fsMod.existsSync(pathMod.join(tmp, '.spider/settings.json')),
);
check(
  'the local file is git-ignored',
  fsMod
    .readFileSync(pathMod.join(tmp, '.spider/.gitignore'), 'utf8')
    .includes('settings.local.json'),
);
check('and it is loaded back', loadSettings(tmp).allow.includes('bash(ls:*)'));
fsMod.rmSync(tmp, { recursive: true, force: true });

console.log('');
if (failures.length) {
  console.error(failures.length + ' failure(s): ' + failures.join(', '));
  process.exit(1);
}
console.log('All MCP checks passed.');
process.exit(0);
