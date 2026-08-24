#!/usr/bin/env node
// A fuller stdio MCP server: resources, prompts, read-only hints, a
// list_changed notification, non-text content, and noise on stderr.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Anything a stdio server writes here used to be discarded outright.
process.stderr.write('fixture: starting up\n');

const server = new Server(
  { name: 'rich', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} } },
);

let extraTool = false;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'peek',
      description: 'Reports something without changing anything.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'mutate',
      description: 'Changes something.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'noisy',
      description: 'Returns an image and a resource link.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'grow',
      description: 'Adds another tool and announces it.',
      inputSchema: { type: 'object', properties: {} },
    },
    ...(extraTool
      ? [{ name: 'sprouted', description: 'Appeared later.', inputSchema: { type: 'object', properties: {} } }]
      : []),
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  switch (req.params.name) {
    case 'peek':
      return { content: [{ type: 'text', text: 'peeked' }] };
    case 'mutate':
      return { content: [{ type: 'text', text: 'mutated' }] };
    case 'noisy':
      return {
        content: [
          { type: 'text', text: 'here is a picture' },
          { type: 'image', data: 'AAAA'.repeat(256), mimeType: 'image/png' },
          { type: 'resource_link', uri: 'mem://doc/1', name: 'The Doc', description: 'a doc' },
        ],
      };
    case 'grow':
      extraTool = true;
      await server.sendToolListChanged();
      return { content: [{ type: 'text', text: 'grew' }] };
    default:
      return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: 'mem://doc/1', name: 'The Doc', description: 'a doc', mimeType: 'text/plain' },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
  contents: [{ uri: req.params.uri, mimeType: 'text/plain', text: 'contents of ' + req.params.uri }],
}));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: 'review',
      description: 'Review a file.',
      arguments: [{ name: 'path', description: 'file to review', required: true }],
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => ({
  messages: [
    {
      role: 'user',
      content: { type: 'text', text: 'Please review ' + (req.params.arguments?.path ?? '?') },
    },
  ],
}));

await server.connect(new StdioServerTransport());
