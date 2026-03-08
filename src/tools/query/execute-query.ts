import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import { sanitizeIdentifier, isReadOnlyQuery, validateQuerySafety } from "../../utils/sql-sanitizer.js";
import { formatQueryResult } from "../../utils/result-formatter.js";

export const executeQueryDefinition = {
  name: "execute_query",
  description:
    "Execute any T-SQL query against a database. By default, runs in read-only mode (SELECT only). Set allowWrite=true for INSERT/UPDATE/DELETE/EXEC operations. ⚠️ Write mode must be enabled via MSSQL_READ_ONLY=false in the server configuration.",
  inputSchema: {
    type: "object" as const,
    properties: {
      database: {
        type: "string",
        description: "Database name",
      },
      query: {
        type: "string",
        description: "The T-SQL query to execute",
      },
      allowWrite: {
        type: "boolean",
        description: "Allow write operations (INSERT/UPDATE/DELETE/EXEC). Default: false",
        default: false,
      },
    },
    required: ["database", "query"],
  },
};

export async function executeQueryHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);
  const query = (args.query as string).trim();
  const allowWrite = args.allowWrite === true;

  // Safety checks
  const warnings = validateQuerySafety(query);
  if (warnings.length > 0) {
    return `❌ **Query rejected** — dangerous patterns detected:\n${warnings.map((w) => `- ${w}`).join("\n")}`;
  }

  if (!allowWrite || config.readOnly) {
    if (!isReadOnlyQuery(query)) {
      if (config.readOnly) {
        return "❌ **Query rejected**: Server is in read-only mode (MSSQL_READ_ONLY=true). Only SELECT queries are allowed.";
      }
      return "❌ **Query rejected**: Write operations require `allowWrite: true`. Use this flag carefully.";
    }
  }

  const startTime = Date.now();
  const result = await executeQueryOnDatabase(config, database, query);
  const elapsed = Date.now() - startTime;

  // If it returned rows (SELECT)
  if (result.recordset && result.recordset.length > 0) {
    const columns = Object.keys(result.recordset[0]);
    return formatQueryResult(
      columns,
      result.recordset as Record<string, unknown>[],
      config.maxRows,
      elapsed
    );
  }

  // If it was a DML (affected rows)
  const affected = result.rowsAffected?.reduce((a, b) => a + b, 0) || 0;
  return `✅ **Query executed successfully** (${elapsed}ms)\n- Rows affected: ${affected}`;
}
