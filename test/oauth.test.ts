/** End-to-end OAuth: discovery, dynamic registration, authorization-code with
 *  PKCE, token storage, and an authorized tool call — no browser involved. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loginToServer } from '../src/mcp/login.ts';
import { connectServers } from '../src/mcp/client.ts';
import { forgetServer, hasStoredTokens, startCallbackListener } from '../src/mcp/oauth.ts';

const NAME = 'oauthfixture';
const PORT = 8794;
const CFG = { url: 'http://127.0.0.1:' + PORT + '/mcp' };
const STORE = path.join(os.homedir(), '.spidercli', 'oauth', NAME + '.json');

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS  ' + name);
  else {
    failures.push(name);
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

forgetServer(NAME);

const server = spawn(
  'node',
  [path.join(import.meta.dirname, 'mcp-oauth-fixture.mjs'), String(PORT)],
  {
    stdio: ['ignore', 'ignore', 'ignore'],
  },
);
await sleep(1200);

try {
  // Unauthenticated connect must fail, and say how to fix itself.
  const before = await connectServers({ [NAME]: CFG }, process.cwd());
  check('unauthorized server is reported, not crashed', before.status[0]?.ok === false);
  check(
    'error tells the user to log in',
    /spider mcp login/.test(before.status[0]?.error ?? ''),
    before.status[0]?.error,
  );
  await before.close();

  // Drive the browser step by fetching the authorization URL; the fixture
  // auto-approves and 302s to our loopback listener, completing the flow.
  const result = await loginToServer(NAME, CFG, {
    log: () => {},
    onAuthorizationUrl: async (url) => {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error('authorize failed: ' + res.status + ' ' + (await res.text()));
    },
  });

  check('login succeeded', result.ok, result.error);
  check('server advertised its tool', result.toolCount === 1, 'got ' + result.toolCount);
  check('tokens persisted', hasStoredTokens(NAME));

  const mode = fs.statSync(STORE).mode & 0o777;
  check('token file is owner-only (0600)', mode === 0o600, '0' + mode.toString(8));

  const stored = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  check('access token stored', typeof stored.tokens?.access_token === 'string');
  check('refresh token stored', typeof stored.tokens?.refresh_token === 'string');
  check('dynamic registration persisted', typeof stored.clientInformation?.client_id === 'string');
  check(
    'redirect uri persisted for refresh',
    /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(stored.redirectUrl ?? ''),
    stored.redirectUrl,
  );

  // The real payoff: a normal startup now connects using the stored token.
  const after = await connectServers({ [NAME]: CFG }, process.cwd());
  check('authorized connect succeeds', after.status[0]?.ok === true, after.status[0]?.error);
  const toolName = Object.keys(after.tools)[0];
  check(
    'tool exposed under an mcp__ name',
    toolName === 'mcp__oauthfixture__classified_record',
    toolName,
  );

  const called = await after.tools[toolName].run({ id: 'X-9' }, process.cwd());
  check(
    'authorized tool call works',
    called.output.includes('CLEARANCE-GRANTED-5150'),
    called.output,
  );
  await after.close();

  // State mismatch must be rejected — otherwise any page could complete a login.
  const listener = await startCallbackListener();
  // Handlers must be attached synchronously: the callback can reject before a
  // later-attached .catch() exists, which Node reports as an unhandled rejection.
  const waiting = listener.waitForCode('expected-state-value').then(
    () => null,
    (e: Error) => e.message,
  );
  await fetch(listener.redirectUrl + '?code=abc&state=wrong-state').catch(() => {});
  const rejected = await waiting;
  check(
    'callback with a mismatched state is rejected',
    /state mismatch/i.test(rejected ?? ''),
    String(rejected),
  );
  listener.close();
} finally {
  server.kill();
  forgetServer(NAME);
}

console.log(failures.length ? '\n' + failures.length + ' FAILED' : '\nAll OAuth checks passed');
process.exit(failures.length ? 1 : 0);
