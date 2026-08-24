import { SpiderAIError, throwIfErrorBody } from './types.ts';
// A retry is otherwise invisible: the spinner just takes longer, which looks
// identical to a slow model. Say that the network is flapping and being handled.
import { notice } from '../ui/notices.ts';

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function once(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
}

/** POST expecting a JSON body back. Applies the 200-with-error-body shim. */
export async function postJSON(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await once(url, headers, body, signal);
      const text = await res.text();
      if (!res.ok && RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
        const wait = 2 ** attempt * 250;
        notice(
          'HTTP ' + res.status + ' from the gateway — retrying in ' +
            Math.round(wait / 100) / 10 + 's (attempt ' + (attempt + 1) + '/' + MAX_ATTEMPTS + ')',
        );
        await sleep(wait);
        continue;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new SpiderAIError(
          `Non-JSON response (HTTP ${res.status}) from ${url}: ${text.slice(0, 160)}`,
        );
      }
      throwIfErrorBody(parsed);
      if (!res.ok) throw new SpiderAIError(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return parsed;
    } catch (err) {
      if (err instanceof SpiderAIError) throw err;
      lastErr = err;
      if (attempt === MAX_ATTEMPTS) break;
      const wait = 2 ** attempt * 250;
      notice(
        'Request failed (' + ((lastErr as any)?.message ?? 'connection error') + ') — retrying in ' +
          Math.round(wait / 100) / 10 + 's (attempt ' + (attempt + 1) + '/' + MAX_ATTEMPTS + ')',
      );
      await sleep(wait);
    }
  }
  throw lastErr;
}

export type SSEEvent = { event: string; data: any };

/**
 * POST expecting SSE back. If the gateway rejects the request it answers with a
 * plain JSON error body instead of a stream, so the first chunk is sniffed.
 */
export async function* postSSE(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const res = await once(url, headers, { ...(body as object), stream: true }, signal);
  if (!res.body) throw new SpiderAIError('No response body from ' + url);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let sniffed = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    if (!sniffed && buf.trimStart().length > 0) {
      sniffed = true;
      if (!buf.trimStart().startsWith('data:') && !buf.trimStart().startsWith('event:')) {
        // Not a stream — drain and surface the gateway error.
        let rest = buf;
        while (true) {
          const r = await reader.read();
          if (r.done) break;
          rest += decoder.decode(r.value, { stream: true });
        }
        try {
          throwIfErrorBody(JSON.parse(rest));
        } catch (e) {
          if (e instanceof SpiderAIError) throw e;
        }
        throw new SpiderAIError(`Expected SSE, got: ${rest.slice(0, 200)}`);
      }
    }

    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      const payload = dataLines.join('\n');
      if (payload === '[DONE]') return;
      try {
        yield { event, data: JSON.parse(payload) };
      } catch {
        /* ignore keep-alives and unparseable frames */
      }
    }
  }
}
