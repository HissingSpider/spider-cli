import type { ToolImpl } from './index.ts';
import type { McpConnection } from '../mcp/client.ts';

/**
 * Resource access as two tools rather than one per resource.
 *
 * A server can expose hundreds of resources; minting a tool for each would
 * swamp the tool list and drown out everything else. Listing and reading are
 * the whole interface, so two tools cover it at fixed cost.
 */
export function createResourceTools(mcp: McpConnection): Record<string, ToolImpl> {
  return {
    list_mcp_resources: {
      spec: {
        name: 'list_mcp_resources',
        description:
          'List the resources exposed by connected MCP servers — documents, records and ' +
          'other content a server offers for reading. Optionally filter to one server.',
        parameters: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'Optional server name to filter by' },
          },
          additionalProperties: false,
        },
      },
      async run(input) {
        const wanted = input.server ? String(input.server) : null;
        const all = mcp.resources().filter((r) => !wanted || r.server === wanted);
        if (!all.length) {
          return {
            output: wanted
              ? 'No resources from "' + wanted + '".'
              : 'No connected MCP server exposes resources.',
            isError: false,
          };
        }
        return {
          output: all
            .map(
              (r) =>
                r.server + '  ' + r.uri + '  ' + r.name +
                (r.mimeType ? '  (' + r.mimeType + ')' : '') +
                (r.description ? '\n    ' + r.description : ''),
            )
            .join('\n'),
          isError: false,
        };
      },
    },

    read_mcp_resource: {
      spec: {
        name: 'read_mcp_resource',
        description:
          'Read one MCP resource by its URI. Use list_mcp_resources first to find the URI.',
        parameters: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'The server exposing the resource' },
            uri: { type: 'string', description: 'The resource URI' },
          },
          required: ['server', 'uri'],
          additionalProperties: false,
        },
      },
      async run(input) {
        try {
          const text = await mcp.readResource(String(input.server), String(input.uri));
          return { output: text || '(empty resource)', isError: false };
        } catch (err: any) {
          return {
            output: 'Could not read resource: ' + (err?.message ?? String(err)),
            isError: true,
          };
        }
      },
    },
  };
}
