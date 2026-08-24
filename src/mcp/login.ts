import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { McpHttpConfig } from './client.ts';
import { FileOAuthProvider, openInBrowser, startCallbackListener } from './oauth.ts';
import { errorMessage } from '../errors.ts';

export type Transportish = StreamableHTTPClientTransport | SSEClientTransport;

export function makeTransport(
  cfg: McpHttpConfig,
  authProvider?: OAuthClientProvider,
): Transportish {
  const url = new URL(cfg.url);
  const opts = {
    ...(cfg.headers ? { requestInit: { headers: cfg.headers } } : {}),
    ...(authProvider ? { authProvider } : {}),
  };
  return cfg.transport === 'sse'
    ? new SSEClientTransport(url, opts)
    : new StreamableHTTPClientTransport(url, opts);
}

export type LoginResult = { ok: boolean; toolCount: number; error?: string };

/**
 * Full authorization-code + PKCE login against a remote MCP server.
 *
 * The SDK generates the PKCE pair, performs dynamic client registration if the
 * server supports it, and exchanges the code. What it cannot do is receive the
 * redirect — that needs a loopback listener, whose port is only known after it
 * binds, so the redirect URI is built from the live address.
 */
export async function loginToServer(
  name: string,
  cfg: McpHttpConfig,
  opts: {
    onAuthorizationUrl?: (url: URL) => void | Promise<void>;
    log?: (msg: string) => void;
  } = {},
): Promise<LoginResult> {
  const log = opts.log ?? ((m: string) => process.stderr.write(m + '\n'));
  const listener = await startCallbackListener();

  const provider = new FileOAuthProvider(
    name,
    listener.redirectUrl,
    async (url) => {
      if (opts.onAuthorizationUrl) {
        await opts.onAuthorizationUrl(url);
        return;
      }
      log('\nOpening your browser to authorize "' + name + '".');
      log('If it does not open, visit:\n  ' + url.toString() + '\n');
      openInBrowser(url);
    },
    cfg.scope,
  );

  try {
    const first = new Client({ name: 'spider-cli', version: '0.1.0' }, { capabilities: {} });
    const transport = makeTransport(cfg, provider);

    try {
      await first.connect(transport);
      // Stored tokens were still good; nothing to authorize.
      const tools = await first.listTools();
      await first.close();
      return { ok: true, toolCount: tools.tools?.length ?? 0 };
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
    }

    // redirectToAuthorization has fired by now; wait for the browser to come back.
    const code = await listener.waitForCode(provider.expectedState());
    await transport.finishAuth(code);
    await transport.close().catch(() => {});

    // Reconnect on a fresh transport now that tokens are stored.
    const client = new Client({ name: 'spider-cli', version: '0.1.0' }, { capabilities: {} });
    await client.connect(makeTransport(cfg, provider));
    const tools = await client.listTools();
    await client.close();
    return { ok: true, toolCount: tools.tools?.length ?? 0 };
  } catch (err) {
    return { ok: false, toolCount: 0, error: errorMessage(err) };
  } finally {
    listener.close();
  }
}
