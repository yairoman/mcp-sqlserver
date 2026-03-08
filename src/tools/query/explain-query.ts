import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import { sanitizeIdentifier } from "../../utils/sql-sanitizer.js";
import { formatObjectList } from "../../utils/result-formatter.js";

export const explainQueryDefinition = {
  name: "explain_query",
  description:
    "Show the estimated execution plan for a query. Returns the query plan operators, estimated costs, and index usage. Useful for understanding query performance before execution.",
  inputSchema: {
    type: "object" as const,
    properties: {
      database: {
        type: "string",
        description: "Database name",
      },
      query: {
        type: "string",
        description: "The T-SQL query to analyze",
      },
    },
    required: ["database", "query"],
  },
};

export async function explainQueryHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);
  const query = (args.query as string).trim();

  // Use SET SHOWPLAN_TEXT to get the estimated plan
  const planQuery = `SET SHOWPLAN_TEXT ON;\n${query}\nSET SHOWPLAN_TEXT OFF;`;

  try {
    const result = await executeQueryOnDatabase(config, database, planQuery);
    
    const planLines: string[] = [];
    for (const recordset of result.recordsets) {
      for (const row of recordset) {
        const r = row as Record<string, unknown>;
        const planText = r["StmtText"] || r[Object.keys(r)[0]];
        if (planText) {
          planLines.push(String(planText));
        }
      }
    }

    if (planLines.length === 0) {
      return "❌ Could not retrieve execution plan. The query might have syntax errors.";
    }

    return `**Estimated Execution Plan**\n\n\`\`\`\n${planLines.join("\n")}\n\`\`\``;
  } catch (error) {
    // If SHOWPLAN fails, try SET STATISTICS PROFILE
    const statsQuery = `SET STATISTICS PROFILE ON;\n${query}\nSET STATISTICS PROFILE OFF;`;
    const result = await executeQueryOnDatabase(config, database, statsQuery);
    
    const rows = result.recordset as Record<string, unknown>[];
    return formatObjectList(rows, "Query Execution Profile");
  }
}
