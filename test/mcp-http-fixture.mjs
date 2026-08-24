#!/usr/bin/env node
// Minimal remote MCP server over Streamable HTTP, to test the non-stdio transport.
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const PORT = Number(process.argv[2] ?? 8793);

function buildServer() {
  const server = new Server(
    { name: 'remote-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'orbit_status',
        description: 'Returns the status of a named satellite.',
        inputSchema: {
          type: 'object',
          properties: { satellite: { type: 'string' } },
          required: ['satellite'],
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const sat = req.params.arguments?.satellite ?? 'unknown';
    return { content: [{ type: 'text', text: `Satellite ${sat}: NOMINAL, altitude 402 km` }] };
  });
  return server;
}

const httpServer = http.createServer(async (req, res) => {
  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    body = undefined;
  }

  // Stateless: a fresh server and transport per request.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => void transport.close());
  await buildServer().connect(transport);
  await transport.handleRequest(req, res, body);
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.error('remote MCP fixture on http://127.0.0.1:' + PORT + '/mcp');
});
