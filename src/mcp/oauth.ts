import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { HOME_DIR } from '../config.ts';

const STORE_DIR = path.join(HOME_DIR, 'oauth');
const CALLBACK_TIMEOUT_MS = 300_000;

type Stored = {
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  /** The redirect URI this client registered with; must match on refresh. */
  redirectUrl?: string;
};

function storePath(server: string): string {
  return path.join(STORE_DIR, server.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
}

function readStore(server: string): Stored {
  try {
    return JSON.parse(fs.readFileSync(storePath(server), 'utf8'));
  } catch {
    return {};
  }
}

function writeStore(server: string, data: Stored): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const file = storePath(server);
  // Tokens are bearer credentials — never leave them world-readable.
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function hasStoredTokens(server: string): boolean {
  return Boolean(readStore(server).tokens?.access_token);
}

export function forgetServer(server: string): boolean {
  try {
    fs.unlinkSync(storePath(server));
    return true;
  } catch {
    return false;
  }
}

/**
 * Persists client registration and tokens under ~/.spidercli/oauth. The SDK
 * drives PKCE and the token exchange; this supplies storage, the loopback
 * redirect URI, and a way to get the user to the authorization page.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  private data: Stored;
  private _state: string;

  constructor(
    private server: string,
    redirect: string | undefined,
    private onAuthorizationUrl: (url: URL) => void | Promise<void>,
    private scope?: string,
  ) {
    this.data = readStore(server);
    this._state = crypto.randomBytes(16).toString('hex');
    if (redirect && redirect !== this.data.redirectUrl) {
      this.data.redirectUrl = redirect;
      writeStore(server, this.data);
    }
  }

  get redirectUrl(): string {
    return this.data.redirectUrl ?? '';
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'spider-cli',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }

  /** Guards against a stray callback completing someone else's flow. */
  state(): string {
    return this._state;
  }

  expectedState(): string {
    return this._state;
  }

  clientInformation(): OAuthClientInformationFull | undefined {
    return this.data.clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    this.data.clientInformation = info;
    writeStore(this.server, this.data);
  }

  tokens(): OAuthTokens | undefined {
    return this.data.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.data.tokens = tokens;
    writeStore(this.server, this.data);
  }

  saveCodeVerifier(verifier: string): void {
    this.data.codeVerifier = verifier;
    writeStore(this.server, this.data);
  }

  codeVerifier(): string {
    const v = this.data.codeVerifier;
    if (!v) throw new Error('No PKCE code verifier stored — restart the login.');
    return v;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') this.data = {};
    else if (scope === 'tokens') delete this.data.tokens;
    else if (scope === 'client') delete this.data.clientInformation;
    else if (scope === 'verifier') delete this.data.codeVerifier;
    writeStore(this.server, this.data);
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    await this.onAuthorizationUrl(url);
  }
}

export type CallbackListener = {
  redirectUrl: string;
  /** Resolves with the authorization code once the browser hits the callback. */
  waitForCode: (expectedState: string) => Promise<string>;
  close: () => void;
};

/**
 * Loopback listener on an ephemeral port. The port is only known after binding,
 * so the redirect URI has to be built from the live address rather than guessed.
 */
export async function startCallbackListener(): Promise<CallbackListener> {
  // The callback can land before waitForCode() is called — the authorization
  // request is issued from inside connect(), so a fast redirect beats the
  // caller to it. Buffer whatever arrives and let waitForCode drain it.
  let received: { code?: string; state?: string | null; error?: string } | null = null;
  let notify: (() => void) | null = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/callback')) {
      res.writeHead(404).end();
      return;
    }

    const code = url.searchParams.get('code') ?? undefined;
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error') ?? undefined;

    const finish = (status: number, message: string) => {
      res.writeHead(status, { 'content-type': 'text/html' });
      res.end(
        '<html><body style="font-family:system-ui;padding:2rem">' +
          '<h2>' + message + '</h2><p>You can close this tab and return to the terminal.</p>' +
          '</body></html>',
      );
    };

    received = { code, state, error };
    finish(error || !code ? 400 : 200, error ? 'Authorization failed: ' + error
      : !code ? 'No authorization code received' : 'Authorized');
    notify?.();
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  return {
    redirectUrl: 'http://127.0.0.1:' + port + '/callback',
    waitForCode(expectedState: string) {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for the browser callback')),
          CALLBACK_TIMEOUT_MS,
        );

        const settle = () => {
          if (!received) return;
          clearTimeout(timer);
          const { code, state, error } = received;
          if (error) return reject(new Error('Authorization denied: ' + error));
          if (!code) return reject(new Error('Callback had no authorization code'));
          // Validated here rather than in the handler so a callback that
          // arrives early is still checked against the expected state.
          if (expectedState && state !== expectedState) {
            return reject(new Error('OAuth state mismatch; aborting'));
          }
          resolve(code);
        };

        notify = settle;
        settle(); // drain anything that already arrived
      });
    },
    close: () => server.close(),
  };
}

/** Open the authorization page, falling back to printing it. */
export function openInBrowser(url: URL): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url.toString()], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* fall through to the printed URL */
  }
}
