#!/usr/bin/env node
// Minimal stdio MCP server used to test the client end to end without network.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'vault_code',
      description: 'Returns the vault access code for a named vault.',
      inputSchema: {
        type: 'object',
        properties: { vault: { type: 'string' } },
        required: ['vault'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'vault_code') {
    const vault = req.params.arguments?.vault ?? 'unknown';
    return { content: [{ type: 'text', text: 'Vault ' + vault + ' code is 74-ALPHA-2913' }] };
  }
  return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
});

await server.connect(new StdioServerTransport());
