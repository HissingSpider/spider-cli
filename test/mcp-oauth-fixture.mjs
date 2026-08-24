#!/usr/bin/env node
// A remote MCP server behind OAuth 2.1: discovery, dynamic client registration,
// authorization-code + PKCE, and a bearer-protected /mcp endpoint.
// /authorize auto-approves so the flow can be driven without a browser.
import http from 'node:http';
import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const PORT = Number(process.argv[2] ?? 8794);
const ORIGIN = 'http://127.0.0.1:' + PORT;

const clients = new Map();   // client_id -> { redirect_uris }
const codes = new Map();     // code -> { client_id, challenge, redirect_uri }
const tokens = new Set();    // issued access tokens

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return { raw, json: raw ? safeJson(raw) : undefined };
};
const safeJson = (s) => {
  try { return JSON.parse(s); } catch { return undefined; }
};

const s256 = (verifier) =>
  crypto.createHash('sha256').update(verifier).digest('base64url');

function buildMcpServer() {
  const server = new Server(
    { name: 'secure-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'classified_record',
      description: 'Returns a record that requires authorization.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [{ type: 'text', text: 'Record ' + (req.params.arguments?.id ?? '?') + ': CLEARANCE-GRANTED-5150' }],
  }));
  return server;
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', ORIGIN);

  // --- Discovery ---
  if (url.pathname === '/.well-known/oauth-protected-resource' ||
      url.pathname === '/.well-known/oauth-protected-resource/mcp') {
    return json(res, 200, { resource: ORIGIN + '/mcp', authorization_servers: [ORIGIN] });
  }
  if (url.pathname === '/.well-known/oauth-authorization-server' ||
      url.pathname === '/.well-known/openid-configuration') {
    return json(res, 200, {
      issuer: ORIGIN,
      authorization_endpoint: ORIGIN + '/authorize',
      token_endpoint: ORIGIN + '/token',
      registration_endpoint: ORIGIN + '/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  }

  // --- Dynamic client registration ---
  if (url.pathname === '/register' && req.method === 'POST') {
    const { json: body } = await readBody(req);
    const client_id = 'client_' + crypto.randomBytes(8).toString('hex');
    clients.set(client_id, { redirect_uris: body?.redirect_uris ?? [] });
    return json(res, 201, {
      client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: body?.redirect_uris ?? [],
      token_endpoint_auth_method: 'none',
grant_types: body?.grant_types ?? ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  }

  // --- Authorization (auto-approved; a real server shows a consent screen) ---
  if (url.pathname === '/authorize') {
    const client_id = url.searchParams.get('client_id');
    const redirect_uri = url.searchParams.get('redirect_uri');
    const challenge = url.searchParams.get('code_challenge');
    const method = url.searchParams.get('code_challenge_method');
    const state = url.searchParams.get('state');

    if (!clients.has(client_id)) return json(res, 400, { error: 'invalid_client' });
    if (method !== 'S256' || !challenge) return json(res, 400, { error: 'invalid_request', method });
    if (!clients.get(client_id).redirect_uris.includes(redirect_uri)) {
      return json(res, 400, { error: 'invalid_redirect_uri', redirect_uri });
    }

    const code = crypto.randomBytes(16).toString('hex');
    codes.set(code, { client_id, challenge, redirect_uri });
    const back = new URL(redirect_uri);
    back.searchParams.set('code', code);
    if (state) back.searchParams.set('state', state);
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }

  // --- Token exchange, with PKCE verification ---
  if (url.pathname === '/token' && req.method === 'POST') {
    const { raw } = await readBody(req);
    const form = new URLSearchParams(raw);
    const grant = form.get('grant_type');

    if (grant === 'refresh_token') {
      const access = 'at_' + crypto.randomBytes(16).toString('hex');
      tokens.add(access);
      return json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: 3600,
        refresh_token: form.get('refresh_token') });
    }

    const code = form.get('code');
    const verifier = form.get('code_verifier');
    const entry = codes.get(code);
    if (!entry) return json(res, 400, { error: 'invalid_grant' });
    if (!verifier || s256(verifier) !== entry.challenge) {
      return json(res, 400, { error: 'invalid_grant', detail: 'PKCE verification failed' });
    }
    codes.delete(code);
    const access = 'at_' + crypto.randomBytes(16).toString('hex');
    tokens.add(access);
    return json(res, 200, {
      access_token: access, token_type: 'Bearer', expires_in: 3600,
      refresh_token: 'rt_' + crypto.randomBytes(16).toString('hex'),
    });
  }

  // --- Protected MCP endpoint ---
  if (url.pathname.startsWith('/mcp')) {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token || !tokens.has(token)) {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate':
          'Bearer resource_metadata="' + ORIGIN + '/.well-known/oauth-protected-resource"',
      });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    const { json: body } = await readBody(req);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => void transport.close());
    await buildMcpServer().connect(transport);
    return transport.handleRequest(req, res, body);
  }

  res.writeHead(404).end();
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.error('oauth-protected MCP fixture on ' + ORIGIN + '/mcp');
});
