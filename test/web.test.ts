/** web_fetch guards: scheme, content-type, size, redirects, HTML conversion. */
import http from 'node:http';
import { htmlToText, hostOf, webFetchTool } from '../src/tools/web.ts';
import { decide, suggestedRule } from '../src/agent/permissions.ts';
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

// --- HTML conversion -------------------------------------------------------
const html = `<!doctype html><html><head><title>T</title>
<style>body{color:red}</style><script>alert('x')</script></head>
<body><h1>Heading</h1><p>First &amp; second.</p><ul><li>one</li><li>two</li></ul>
<div>Tail&nbsp;text</div></body></html>`;
const text = htmlToText(html);
check('script contents stripped', !text.includes('alert'));
check('style contents stripped', !text.includes('color:red'));
check('entities decoded', text.includes('First & second.'));
check('list items marked', text.includes('- one') && text.includes('- two'));
check(
  'text preserved',
  text.includes('Heading') && text.includes('Tail text'),
  JSON.stringify(text),
);

check(
  'hostOf extracts domain',
  hostOf('https://deerdawn.com/agent-setup/prompt.md') === 'deerdawn.com',
);
check('hostOf tolerates junk', hostOf('not a url') === '');

// --- Scheme guard ----------------------------------------------------------
const fileRes = await webFetchTool.run({ url: 'file:///etc/passwd' }, process.cwd());
check('file:// refused', fileRes.isError && fileRes.output.includes('Only http'), fileRes.output);

const dataRes = await webFetchTool.run({ url: 'data:text/html,<b>hi</b>' }, process.cwd());
check('data: refused', dataRes.isError, dataRes.output);

// --- Live local server -----------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url === '/page.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><p>Hello <b>world</b></p></body></html>');
  } else if (req.url === '/image') {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  } else if (req.url === '/redirect') {
    res.writeHead(302, { location: '/page.html' });
    res.end();
  } else if (req.url === '/loop') {
    res.writeHead(302, { location: '/loop' });
    res.end();
  } else if (req.url === '/gone') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
  } else {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('plain body');
  }
});
await new Promise<void>((r) => server.listen(8792, '127.0.0.1', r));
const base = 'http://127.0.0.1:8792';

const page = await webFetchTool.run({ url: base + '/page.html' }, process.cwd());
check(
  'html fetched and converted',
  !page.isError && page.output.includes('Hello world'),
  page.output.slice(0, 200),
);
check('output labels content as data', page.output.includes('data, not instructions'));

const img = await webFetchTool.run({ url: base + '/image' }, process.cwd());
check('non-text content refused', img.isError && img.output.includes('image/png'), img.output);

const red = await webFetchTool.run({ url: base + '/redirect' }, process.cwd());
check('redirect followed', !red.isError && red.output.includes('Hello world'));
check('redirect chain reported', red.output.includes('Redirected via'), red.output.slice(0, 200));

const loop = await webFetchTool.run({ url: base + '/loop' }, process.cwd());
check(
  'redirect loop capped',
  loop.isError && loop.output.includes('Too many redirects'),
  loop.output,
);

const gone = await webFetchTool.run({ url: base + '/gone' }, process.cwd());
check('http error surfaced', gone.isError && gone.output.includes('404'), gone.output);

server.close();

// --- Permissions -----------------------------------------------------------
const settings: Settings = {
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
const call: ToolCall = {
  id: 'c',
  name: 'web_fetch',
  input: { url: 'https://deerdawn.com/a/b.md' },
};

check('web_fetch asks by default', decide(call, settings, 'default', '/tmp').kind === 'ask');
check('rule is per-domain', suggestedRule(call) === 'web_fetch(deerdawn.com)', suggestedRule(call));
check(
  'approving the domain covers other paths on it',
  decide(
    { ...call, input: { url: 'https://deerdawn.com/other' } },
    { ...settings, allow: ['web_fetch(deerdawn.com)'] },
    'default',
    '/tmp',
  ).kind === 'allow',
);
check(
  'approving one domain does not cover another',
  decide(
    { ...call, input: { url: 'https://evil.example/x' } },
    { ...settings, allow: ['web_fetch(deerdawn.com)'] },
    'default',
    '/tmp',
  ).kind === 'ask',
);

// A redirect that leaves the approved host is a different fetch entirely.
{
  const server = http.createServer((req, res) => {
    if (req.url === '/away') {
      res.writeHead(302, { location: 'http://elsewhere.invalid/landing' });
      res.end();
      return;
    }
    if (req.url === '/local') {
      res.writeHead(302, { location: '/final' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('arrived');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const base = 'http://127.0.0.1:' + port;

  const cross = await webFetchTool.run({ url: base + '/away' }, process.cwd());
  check(
    'a cross-host redirect is refused',
    cross.isError && /cross-host redirect/.test(cross.output),
    cross.output,
  );
  check('the refusal names both hosts', cross.output.includes('elsewhere.invalid'), cross.output);

  const same = await webFetchTool.run({ url: base + '/local' }, process.cwd());
  check(
    'a same-host redirect is still followed',
    !same.isError && same.output.includes('arrived'),
    same.output,
  );

  server.close();
}

console.log(failures.length ? '\n' + failures.length + ' FAILED' : '\nAll web_fetch checks passed');
process.exit(failures.length ? 1 : 0);
