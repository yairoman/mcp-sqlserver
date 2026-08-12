import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "./config.js";
import { withErrorHandling } from "./utils/error-handler.js";

// Schema tools
import { listDatabasesDefinition, listDatabasesHandler } from "./tools/schema/list-databases.js";
import { listTablesDefinition, listTablesHandler } from "./tools/schema/list-tables.js";
import { describeTableDefinition, describeTableHandler } from "./tools/schema/describe-table.js";
import { listViewsDefinition, listViewsHandler } from "./tools/schema/list-views.js";
import { listStoredProceduresDefinition, listStoredProceduresHandler } from "./tools/schema/list-stored-procedures.js";
import { listTriggersDefinition, listTriggersHandler } from "./tools/schema/list-triggers.js";
import { listIndexesDefinition, listIndexesHandler } from "./tools/schema/list-indexes.js";
import { listForeignKeysDefinition, listForeignKeysHandler } from "./tools/schema/list-foreign-keys.js";
import { getObjectDefinitionDefinition, getObjectDefinitionHandler } from "./tools/schema/get-object-definition.js";

// Data tools
import { readTableDataDefinition, readTableDataHandler } from "./tools/data/read-table-data.js";
import { executeSelectQueryDefinition, executeSelectQueryHandler } from "./tools/data/execute-select-query.js";
import { searchDataDefinition, searchDataHandler } from "./tools/data/search-data.js";
import { getTableSampleDefinition, getTableSampleHandler } from "./tools/data/get-table-sample.js";

// Query tools
import { executeQueryDefinition, executeQueryHandler } from "./tools/query/execute-query.js";
import { explainQueryDefinition, explainQueryHandler } from "./tools/query/explain-query.js";
import { validateQueryDefinition, validateQueryHandler } from "./tools/query/validate-query.js";

// Performance tools
import { indexUsageStatsDefinition, indexUsageStatsHandler } from "./tools/performance/index-usage-stats.js";
import { missingIndexesDefinition, missingIndexesHandler } from "./tools/performance/missing-indexes.js";
import { activeSessionsDefinition, activeSessionsHandler } from "./tools/performance/active-sessions.js";
import { blockingChainsDefinition, blockingChainsHandler } from "./tools/performance/blocking-chains.js";
import { blockingHistoryDefinition, blockingHistoryHandler } from "./tools/performance/blocking-history.js";
import { waitStatsDefinition, waitStatsHandler } from "./tools/performance/wait-stats.js";
import { tableStatisticsDefinition, tableStatisticsHandler } from "./tools/performance/table-statistics.js";
import { queryStatsDefinition, queryStatsHandler } from "./tools/performance/query-stats.js";

// Integrity tools
import { checkReferentialIntegrityDefinition, checkReferentialIntegrityHandler } from "./tools/integrity/check-referential-integrity.js";
import { findDuplicatesDefinition, findDuplicatesHandler } from "./tools/integrity/find-duplicates.js";
import { nullAnalysisDefinition, nullAnalysisHandler } from "./tools/integrity/null-analysis.js";
import { validateDataTypesDefinition, validateDataTypesHandler } from "./tools/integrity/validate-data-types.js";
import { rowCountsDefinition, rowCountsHandler } from "./tools/integrity/row-counts.js";
import { compareSchemasDefinition, compareSchemasHandler } from "./tools/integrity/compare-schemas.js";

// Resources
import { serverInfoUri, serverInfoDefinition, getServerInfo } from "./resources/server-info.js";
import { databaseDiagramUri, databaseDiagramDefinition, getDatabaseDiagram } from "./resources/database-diagram.js";

// ─── Tool & Resource Registry Types ──────────────────────────────

interface ToolEntry {
  definition: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
  handler: (config: AppConfig, args: Record<string, unknown>) => Promise<string>;
}

/**
 * Create and configure the MCP server with all tools and resources.
 */
export function createServer(config: AppConfig): Server {
  const server = new Server(
    { name: "mcp-sqlserver", version: "1.1.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  // ─── Build Tool Registry ───────────────────────────────────────
  const tools: ToolEntry[] = [
    // Schema
    { definition: listDatabasesDefinition, handler: listDatabasesHandler },
    { definition: listTablesDefinition, handler: listTablesHandler },
    { definition: describeTableDefinition, handler: describeTableHandler },
    { definition: listViewsDefinition, handler: listViewsHandler },
    { definition: listStoredProceduresDefinition, handler: listStoredProceduresHandler },
    { definition: listTriggersDefinition, handler: listTriggersHandler },
    { definition: listIndexesDefinition, handler: listIndexesHandler },
    { definition: listForeignKeysDefinition, handler: listForeignKeysHandler },
    { definition: getObjectDefinitionDefinition, handler: getObjectDefinitionHandler },
    // Data
    { definition: readTableDataDefinition, handler: readTableDataHandler },
    { definition: executeSelectQueryDefinition, handler: executeSelectQueryHandler },
    { definition: searchDataDefinition, handler: searchDataHandler },
    { definition: getTableSampleDefinition, handler: getTableSampleHandler },
    // Query
    { definition: executeQueryDefinition, handler: executeQueryHandler },
    { definition: explainQueryDefinition, handler: explainQueryHandler },
    { definition: validateQueryDefinition, handler: validateQueryHandler },
    // Performance
    { definition: indexUsageStatsDefinition, handler: indexUsageStatsHandler },
    { definition: missingIndexesDefinition, handler: missingIndexesHandler },
    { definition: activeSessionsDefinition, handler: activeSessionsHandler },
    { definition: blockingChainsDefinition, handler: blockingChainsHandler },
    { definition: blockingHistoryDefinition, handler: blockingHistoryHandler },
    { definition: waitStatsDefinition, handler: waitStatsHandler },
    { definition: tableStatisticsDefinition, handler: tableStatisticsHandler },
    { definition: queryStatsDefinition, handler: queryStatsHandler },
    // Integrity
    { definition: checkReferentialIntegrityDefinition, handler: checkReferentialIntegrityHandler },
    { definition: findDuplicatesDefinition, handler: findDuplicatesHandler },
    { definition: nullAnalysisDefinition, handler: nullAnalysisHandler },
    { definition: validateDataTypesDefinition, handler: validateDataTypesHandler },
    { definition: rowCountsDefinition, handler: rowCountsHandler },
    { definition: compareSchemasDefinition, handler: compareSchemasHandler },
  ];

  const toolMap = new Map<string, ToolEntry>();
  for (const tool of tools) {
    toolMap.set(tool.definition.name, tool);
  }

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
    const tool = toolMap.get(name);

    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `❌ Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const wrappedHandler = withErrorHandling(name, (a) =>
      tool.handler(config, a)
    );
    const result = await wrappedHandler(args || {});

    return {
      content: [{ type: "text" as const, text: result }],
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
