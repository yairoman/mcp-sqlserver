import type { AppConfig } from "../../config.js";
import { withDedicatedConnection } from "../../connection.js";
import { sanitizeIdentifier, assertReadOnlyQuery } from "../../utils/sql-sanitizer.js";
import { McpToolError } from "../../utils/error-handler.js";

export const explainQueryDefinition = {
  name: "explain_query",
  description:
    "Show the estimated execution plan for a read-only query (SELECT or WITH). The query is NOT executed: SET SHOWPLAN_TEXT is enabled in its own batch on a dedicated connection. Returns the plan operators, estimated costs, and index usage.",
  inputSchema: {
    type: "object" as const,
    properties: {
      database: {
        type: "string",
        description: "Database name",
      },
      query: {
        type: "string",
        description: "The read-only T-SQL query (SELECT or WITH) to analyze",
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

  // Validate BEFORE touching the server. No fallback ever executes the query.
  assertReadOnlyQuery(explainQueryDefinition.name, query);

  const planLines = await withDedicatedConnection(config, database, async (batch) => {
    // Each step is its own batch (.batch → sp_executesql is NOT used), so the
    // SET applies to the connection and SHOWPLAN is the only statement in its batch.
    await batch("SET SHOWPLAN_TEXT ON");
    try {
      const result = await batch(query);
      const lines: string[] = [];
      const recordsets = (result.recordsets ?? []) as unknown as Record<string, unknown>[][];
      for (const recordset of recordsets) {
        for (const r of recordset) {
          const planText = r["StmtText"] ?? r[Object.keys(r)[0]];
          if (planText) {
            lines.push(String(planText));
          }
        }
      }
      return lines;
    } finally {
      await batch("SET SHOWPLAN_TEXT OFF");
    }
  });

  if (planLines.length === 0) {
    throw new McpToolError(
      explainQueryDefinition.name,
      "Could not retrieve the execution plan. The query might have syntax errors."
    );
  }

  return `**Estimated Execution Plan**\n\n\`\`\`\n${planLines.join("\n")}\n\`\`\``;
}
