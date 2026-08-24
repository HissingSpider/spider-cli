import type { ToolImpl } from './index.ts';

/**
 * Web search.
 *
 * There is no free, scrapeable search endpoint: the HTML front ends all return
 * a bot-check page rather than results, and working around that is neither
 * reliable nor something worth building. So this talks to a real search API and
 * says plainly when it has not been given one, instead of shipping a tool that
 * appears to work and silently returns nothing.
 *
 * Configure in `.spider/settings.json` or the environment:
 *
 *   { "search": { "provider": "brave", "apiKey": "..." } }
 *
 * Supported: `brave` (BRAVE_API_KEY) and `tavily` (TAVILY_API_KEY).
 */

export type SearchConfig = {
  provider?: 'brave' | 'tavily';
  apiKey?: string;
  /** Results to request. */
  count?: number;
};

export type SearchHit = { title: string; url: string; snippet: string };

const TIMEOUT_MS = 15_000;
const MAX_RESULTS = 10;

function resolveConfig(cfg: SearchConfig | undefined): Required<SearchConfig> | null {
  const provider =
    cfg?.provider ??
    (process.env.BRAVE_API_KEY ? 'brave' : process.env.TAVILY_API_KEY ? 'tavily' : undefined);
  if (!provider) return null;

  const apiKey =
    cfg?.apiKey ??
    (provider === 'brave' ? process.env.BRAVE_API_KEY : process.env.TAVILY_API_KEY);
  if (!apiKey) return null;

  return { provider, apiKey, count: Math.min(cfg?.count ?? 5, MAX_RESULTS) };
}

async function brave(query: string, key: string, count: number, signal: AbortSignal): Promise<SearchHit[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));
  const res = await fetch(url, {
    signal,
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
  });
  if (!res.ok) throw new Error('Brave search returned HTTP ' + res.status);
  const body: any = await res.json();
  return (body?.web?.results ?? []).slice(0, count).map((r: any) => ({
    title: String(r.title ?? ''),
    url: String(r.url ?? ''),
    snippet: String(r.description ?? '').replace(/<[^>]+>/g, ''),
  }));
}

async function tavily(query: string, key: string, count: number, signal: AbortSignal): Promise<SearchHit[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: count }),
  });
  if (!res.ok) throw new Error('Tavily search returned HTTP ' + res.status);
  const body: any = await res.json();
  return (body?.results ?? []).slice(0, count).map((r: any) => ({
    title: String(r.title ?? ''),
    url: String(r.url ?? ''),
    snippet: String(r.content ?? ''),
  }));
}

export function createSearchTool(cfg: SearchConfig | undefined): ToolImpl {
  const resolved = resolveConfig(cfg);

  return {
    spec: {
      name: 'web_search',
      description: resolved
        ? 'Search the web and return titles, URLs and snippets. Follow up with web_fetch ' +
          'to read a result in full.'
        : 'Web search — NOT CONFIGURED. No search API key is set, so this tool cannot run. ' +
          'Do not call it; ask the user for a URL instead.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
          count: { type: 'number', description: 'How many results (default 5, max 10)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },

    async run(input) {
      if (!resolved) {
        return {
          output:
            'web_search is not configured. Set a search provider in .spider/settings.json:\n' +
            '  { "search": { "provider": "brave", "apiKey": "..." } }\n' +
            'or export BRAVE_API_KEY / TAVILY_API_KEY.\n' +
            'Until then, ask the user for a URL and use web_fetch.',
          isError: true,
        };
      }

      const query = String(input.query ?? '').trim();
      if (!query) return { output: 'web_search needs a query.', isError: true };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const count = Math.min(Number(input.count ?? resolved.count) || resolved.count, MAX_RESULTS);
        const hits =
          resolved.provider === 'brave'
            ? await brave(query, resolved.apiKey, count, controller.signal)
            : await tavily(query, resolved.apiKey, count, controller.signal);

        if (!hits.length) return { output: 'No results for: ' + query, isError: false };
        return {
          output: hits
            .map((h, i) => i + 1 + '. ' + h.title + '\n   ' + h.url + '\n   ' + h.snippet)
            .join('\n\n'),
          isError: false,
        };
      } catch (err: any) {
        const aborted = controller.signal.aborted;
        return {
          output: aborted
            ? 'Search timed out after ' + TIMEOUT_MS + 'ms.'
            : 'Search failed: ' + (err?.message ?? String(err)),
          isError: true,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
