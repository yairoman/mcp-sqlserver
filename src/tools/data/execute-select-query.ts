import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import { sanitizeIdentifier } from "../../utils/sql-sanitizer.js";
import { isReadOnlyQuery, validateQuerySafety } from "../../utils/sql-sanitizer.js";
import { formatQueryResult } from "../../utils/result-formatter.js";

export const executeSelectQueryDefinition = {
  name: "execute_select_query",
  description:
    "Execute a read-only SELECT query against a database. The query must be a SELECT statement — INSERT, UPDATE, DELETE, and DDL statements are blocked. Use this to run custom queries to analyze data, join tables, aggregate data, etc.",
  inputSchema: {
    type: "object" as const,
    properties: {
      database: {
        type: "string",
        description: "Database name to execute the query against",
      },
      query: {
        type: "string",
        description:
          "The SELECT query to execute. Must be a valid read-only SQL query.",
      },
    },
    required: ["database", "query"],
  },
};

export async function executeSelectQueryHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);
  const query = (args.query as string).trim();

  // Validate read-only
  if (!isReadOnlyQuery(query)) {
    return "❌ **Query rejected**: Only SELECT and WITH (CTE) queries are allowed. Use the `execute_query` tool with read-write mode for other operations.";
  }

  // Check for dangerous patterns
  const warnings = validateQuerySafety(query);
  if (warnings.length > 0) {
    return `❌ **Query rejected** — dangerous patterns detected:\n${warnings.map((w) => `- ${w}`).join("\n")}`;
  }

  const startTime = Date.now();
  const result = await executeQueryOnDatabase(config, database, query);
  const elapsed = Date.now() - startTime;

  const columns =
    result.recordset.length > 0 ? Object.keys(result.recordset[0]) : [];

  return formatQueryResult(
    columns,
    result.recordset as Record<string, unknown>[],
    config.maxRows,
    elapsed
  );
}
