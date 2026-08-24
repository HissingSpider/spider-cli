/**
 * The SpiderAI gateway returns failures as HTTP 200 with an error object in the
 * body, so `res.ok` reports success on a failed call. That quirk cost a whole
 * debugging session once; these tests pin the shim that handles it.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { postJSON, postSSE } from '../src/providers/http.ts';
import { SpiderAIError, throwIfErrorBody } from '../src/providers/types.ts';
import { errorCode, errorMessage } from '../src/errors.ts';
import type { SSEData } from '../src/providers/http.ts';

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS  ' + name);
  else {
    failures.push(name);
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
}
const threw = async (fn: () => Promise<unknown>): Promise<string | null> => {
  try {
    await fn();
    return null;
  } catch (e) {
    return errorMessage(e);
  }
};

// --- throwIfErrorBody ------------------------------------------------------
check(
  'a clean body passes through',
  (() => {
    throwIfErrorBody({ id: 'resp_1', output: [] });
    return true;
  })(),
);

check(
  'an error object throws',
  /not allowed/.test(
    (() => {
      try {
        throwIfErrorBody({ error: { code: 400, message: 'Sub-product x is not allowed' } });
      } catch (e) {
        return errorMessage(e);
      }
      return '';
    })(),
  ),
);

check(
  'the error code is preserved',
  (() => {
    try {
      throwIfErrorBody({ error: { code: 429, message: 'slow down' } });
    } catch (e) {
      return errorCode(e) === 429;
    }
    return false;
  })(),
);

check(
  'a string error throws',
  (() => {
    try {
      throwIfErrorBody({ error: 'plain string failure' });
    } catch (e) {
      return /plain string failure/.test(errorMessage(e));
    }
    return false;
  })(),
);

check(
  'a FastAPI detail throws',
  (() => {
    try {
      throwIfErrorBody({ detail: 'Missing Authorization header' });
    } catch (e) {
      return /Missing Authorization/.test(errorMessage(e));
    }
    return false;
  })(),
);

check(
  'null and non-objects are safe',
  (() => {
    throwIfErrorBody(null);
    throwIfErrorBody(undefined);
    throwIfErrorBody('text');
    return true;
  })(),
);

// --- live server -----------------------------------------------------------
let attempts = 0;
const server = http.createServer(async (req, res) => {
  const url = req.url ?? '';
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (url === '/ok') return json(200, { id: 'resp_1', ok: true });
  // The signature quirk: success status, failure body.
  if (url === '/error-200') return json(200, { error: { code: 400, message: 'gateway said no' } });
  if (url === '/html-403') {
    res.writeHead(403, { 'content-type': 'text/html' });
    return res.end('<html><title>403: Forbidden</title><body>403: Forbidden</body></html>');
  }
  if (url === '/flaky') {
    attempts++;
    if (attempts < 3) return json(503, { error: 'unavailable' });
    return json(200, { id: 'resp_after_retry', attempts });
  }
  if (url === '/sse') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"a","n":1}\n\n');
    res.write('data: {"type":"b","n":2}\n\n');
    res.write('data: [DONE]\n\n');
    res.write('data: {"type":"after-done"}\n\n');
    return res.end();
  }
  // A rejected streaming request answers with plain JSON, not a stream.
  if (url === '/sse-rejected')
    return json(200, { error: { code: 400, message: 'model not entitled' } });
  res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;

// --- postJSON --------------------------------------------------------------
const ok = await postJSON(base + '/ok', {}, {});
check('a good response parses', ok.id === 'resp_1');

const err200 = await threw(() => postJSON(base + '/error-200', {}, {}));
check(
  'HTTP 200 with an error body still throws',
  /gateway said no/.test(err200 ?? ''),
  String(err200),
);

const html = await threw(() => postJSON(base + '/html-403', {}, {}));
check(
  'an HTML error page gives a readable message',
  /Non-JSON response/.test(html ?? '') && /403/.test(html ?? ''),
  String(html),
);

const retried = await postJSON(base + '/flaky', {}, {});
check(
  'a 503 is retried until it succeeds',
  retried.id === 'resp_after_retry',
  JSON.stringify(retried),
);
check('it retried rather than got lucky', retried.attempts === 3, 'attempts=' + retried.attempts);

// --- postSSE ---------------------------------------------------------------
const events: SSEData[] = [];
for await (const ev of postSSE(base + '/sse', {}, {})) events.push(ev.data);
check(
  'SSE frames are parsed in order',
  events.length === 2 && events[0].n === 1 && events[1].n === 2,
  JSON.stringify(events),
);
check('[DONE] ends the stream', !events.some((e) => e.type === 'after-done'));

const sseErr = await threw(async () => {
  for await (const _ of postSSE(base + '/sse-rejected', {}, {})) {
    /* drain */
  }
});
check(
  'a non-stream error body is surfaced, not parsed as SSE',
  /model not entitled/.test(sseErr ?? ''),
  String(sseErr),
);
check(
  'it is a SpiderAIError',
  await (async () => {
    try {
      for await (const _ of postSSE(base + '/sse-rejected', {}, {})) {
        /* drain */
      }
    } catch (e) {
      return e instanceof SpiderAIError;
    }
    return false;
  })(),
);

server.close();
console.log(failures.length ? '\n' + failures.length + ' FAILED' : '\nAll http checks passed');
process.exit(failures.length ? 1 : 0);
