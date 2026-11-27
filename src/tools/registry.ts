import type { AppConfig } from "../config.js";
import { formatError } from "../utils/error-handler.js";
import { jsonSchemaToZod, formatArgIssues, type JsonSchema } from "../utils/args-schema.js";
import type { z } from "zod";

// Schema tools
import { listDatabasesDefinition, listDatabasesHandler } from "./schema/list-databases.js";
import { listTablesDefinition, listTablesHandler } from "./schema/list-tables.js";
import { describeTableDefinition, describeTableHandler } from "./schema/describe-table.js";
import { listViewsDefinition, listViewsHandler } from "./schema/list-views.js";
import { listStoredProceduresDefinition, listStoredProceduresHandler } from "./schema/list-stored-procedures.js";
import { listTriggersDefinition, listTriggersHandler } from "./schema/list-triggers.js";
import { listIndexesDefinition, listIndexesHandler } from "./schema/list-indexes.js";
import { listForeignKeysDefinition, listForeignKeysHandler } from "./schema/list-foreign-keys.js";
import { getObjectDefinitionDefinition, getObjectDefinitionHandler } from "./schema/get-object-definition.js";

// Data tools
import { readTableDataDefinition, readTableDataHandler } from "./data/read-table-data.js";
import { executeSelectQueryDefinition, executeSelectQueryHandler } from "./data/execute-select-query.js";
import { searchDataDefinition, searchDataHandler } from "./data/search-data.js";
import { getTableSampleDefinition, getTableSampleHandler } from "./data/get-table-sample.js";

// Query tools
import { executeQueryDefinition, executeQueryHandler } from "./query/execute-query.js";
import { explainQueryDefinition, explainQueryHandler } from "./query/explain-query.js";
import { validateQueryDefinition, validateQueryHandler } from "./query/validate-query.js";

// Performance tools
import { indexUsageStatsDefinition, indexUsageStatsHandler } from "./performance/index-usage-stats.js";
import { missingIndexesDefinition, missingIndexesHandler } from "./performance/missing-indexes.js";
import { activeSessionsDefinition, activeSessionsHandler } from "./performance/active-sessions.js";
import { blockingChainsDefinition, blockingChainsHandler } from "./performance/blocking-chains.js";
import { blockingHistoryDefinition, blockingHistoryHandler } from "./performance/blocking-history.js";
import { configurationHealthDefinition, configurationHealthHandler } from "./performance/configuration-health.js";
import { performanceTriageDefinition, performanceTriageHandler } from "./performance/performance-triage.js";
import { compatibilityAssessmentDefinition, compatibilityAssessmentHandler } from "./performance/compatibility-assessment.js";
import { waitStatsDefinition, waitStatsHandler } from "./performance/wait-stats.js";
import { tableStatisticsDefinition, tableStatisticsHandler } from "./performance/table-statistics.js";
import { queryStatsDefinition, queryStatsHandler } from "./performance/query-stats.js";

// Integrity tools
import { checkReferentialIntegrityDefinition, checkReferentialIntegrityHandler } from "./integrity/check-referential-integrity.js";
import { findDuplicatesDefinition, findDuplicatesHandler } from "./integrity/find-duplicates.js";
import { nullAnalysisDefinition, nullAnalysisHandler } from "./integrity/null-analysis.js";
import { validateDataTypesDefinition, validateDataTypesHandler } from "./integrity/validate-data-types.js";
import { rowCountsDefinition, rowCountsHandler } from "./integrity/row-counts.js";
import { compareSchemasDefinition, compareSchemasHandler } from "./integrity/compare-schemas.js";

// ─── Registry ────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolEntry {
  definition: ToolDefinition;
  handler: (config: AppConfig, args: Record<string, unknown>) => Promise<string>;
}

export interface ToolCallResult {
  text: string;
  isError: boolean;
}

export const tools: ToolEntry[] = [
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
  { definition: configurationHealthDefinition, handler: configurationHealthHandler },
  { definition: performanceTriageDefinition, handler: performanceTriageHandler },
  { definition: compatibilityAssessmentDefinition, handler: compatibilityAssessmentHandler },
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

interface CompiledTool extends ToolEntry {
  argsSchema: z.ZodTypeAny;
}

const toolMap = new Map<string, CompiledTool>(
  tools.map((t) => [
    t.definition.name,
    { ...t, argsSchema: jsonSchemaToZod(t.definition.inputSchema as JsonSchema) },
  ])
);

export function getTool(name: string): ToolEntry | undefined {
  return toolMap.get(name);
}

/**
 * Single entry point to run a tool. The MCP server and the direct-call CLI both
 * go through here, so every invocation gets the same validation and error handling:
 *
 * 1. Arguments are parsed with the tool's zod schema (compiled from its inputSchema):
 *    numbers coerced and clamped, unknown keys rejected. The handler only sees the
 *    parsed output.
 * 2. Any thrown error, and any result that starts with "❌", is returned with
 *    `isError: true` so the client can tell a failure from a result.
 */
export async function callTool(
  config: AppConfig,
  name: string,
  args: Record<string, unknown> | undefined
): Promise<ToolCallResult> {
  const tool = toolMap.get(name);
  if (!tool) {
    return { text: `❌ Unknown tool: ${name}`, isError: true };
  }

  const parsed = tool.argsSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return {
      text: `❌ **${name}**: invalid arguments
${formatArgIssues(parsed.error)}`,
      isError: true,
    };
  }

  try {
    const text = await tool.handler(config, parsed.data as Record<string, unknown>);
    return { text, isError: text.trimStart().startsWith("❌") };
  } catch (error) {
    return { text: formatError(error, name), isError: true };
  }
}
