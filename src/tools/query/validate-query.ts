import type { AppConfig } from "../../config.js";
import { withDedicatedConnection } from "../../connection.js";
import { sanitizeIdentifier, assertReadOnlyQuery } from "../../utils/sql-sanitizer.js";

export const validateQueryDefinition = {
  name: "validate_query",
  description:
    "Validate the syntax of a read-only T-SQL query (SELECT or WITH) without executing it. SET PARSEONLY is enabled in its own batch on a dedicated connection. Returns success or the specific syntax error.",
  inputSchema: {
    type: "object" as const,
    properties: {
      database: {
        type: "string",
        description: "Database name",
      },
      query: {
        type: "string",
        description: "The read-only T-SQL query (SELECT or WITH) to validate",
      },
    },
    required: ["database", "query"],
  },
};

export async function validateQueryHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);
  const query = (args.query as string).trim();

  // Validate BEFORE touching the server.
  assertReadOnlyQuery(validateQueryDefinition.name, query);

  try {
    await withDedicatedConnection(config, async (conn) => {
      await conn.request().batch(`USE [${database}]`);
      await conn.request().batch("SET PARSEONLY ON");
      try {
        await conn.request().batch(query);
      } finally {
        await conn.request().batch("SET PARSEONLY OFF");
      }
    });
    return `✅ **Query syntax is valid.**\n\n\`\`\`sql\n${query}\n\`\`\``;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `❌ **Syntax error**:\n${message}\n\n**Query**:\n\`\`\`sql\n${query}\n\`\`\``;
  }
}
