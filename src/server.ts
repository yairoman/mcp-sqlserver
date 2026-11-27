import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "./config.js";
import { tools, callTool } from "./tools/registry.js";

// Resources
import { serverInfoUri, serverInfoDefinition, getServerInfo } from "./resources/server-info.js";
import { databaseDiagramUri, databaseDiagramDefinition, getDatabaseDiagram } from "./resources/database-diagram.js";

/**
 * Create and configure the MCP server with all tools and resources.
 */
export function createServer(config: AppConfig): Server {
  const server = new Server(
    { name: "mcp-sqlserver", version: "1.1.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  // ─── tools/list handler ────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.definition.name,
      description: t.definition.description,
      inputSchema: {
        type: "object" as const,
        properties: t.definition.inputSchema.properties,
        required: t.definition.inputSchema.required,
      },
    })),
  }));

  // ─── tools/call handler ────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = await callTool(config, name, args);
    return {
      content: [{ type: "text" as const, text: result.text }],
      ...(result.isError ? { isError: true } : {}),
    };
  });

  // ─── resources/list handler ────────────────────────────────────
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: serverInfoDefinition.uri,
        name: serverInfoDefinition.name,
        description: serverInfoDefinition.description,
        mimeType: serverInfoDefinition.mimeType,
      },
      {
        uri: databaseDiagramDefinition.uri,
        name: databaseDiagramDefinition.name,
        description: databaseDiagramDefinition.description,
        mimeType: databaseDiagramDefinition.mimeType,
      },
    ],
  }));

  // ─── resources/read handler ────────────────────────────────────
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === serverInfoUri) {
      const content = await getServerInfo(config);
      return {
        contents: [{ uri: serverInfoUri, mimeType: "text/markdown", text: content }],
      };
    }

    if (uri.startsWith(databaseDiagramUri)) {
      const parts = uri.split("/");
      const database = parts[parts.length - 1] || config.database;
      const content = await getDatabaseDiagram(config, database);
      return {
        contents: [{ uri, mimeType: "text/markdown", text: content }],
      };
    }

    throw new Error(`Unknown resource: ${uri}`);
  });

  return server;
}
