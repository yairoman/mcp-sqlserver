import type { AppConfig } from "../../config.js";
import { executeReadOnlyOnDatabase } from "../../connection.js";
import { sanitizeIdentifier } from "../../utils/sql-sanitizer.js";
import { assertReadOnlyQuery } from "../../utils/sql-sanitizer.js";
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

  // Rejections throw, so the caller gets isError: true.
  assertReadOnlyQuery(executeSelectQueryDefinition.name, query);

  const startTime = Date.now();
  // maxRows + 1 rows are fetched so the formatter can tell "exactly maxRows"
  // from "more than maxRows"; the server stops producing rows after that.
  const result = await executeReadOnlyOnDatabase(config, database, query, undefined, {
    rowLimit: config.maxRows + 1,
  });
  const elapsed = Date.now() - startTime;

  const columns =
    result.recordset.length > 0 ? Object.keys(result.recordset[0]) : [];

  return formatQueryResult(
    columns,
    result.recordset as Record<string, unknown>[],
    config.maxRows,
    elapsed,
    { serverCapped: true }
  );
}
