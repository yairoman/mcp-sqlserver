import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import { sanitizeIdentifier } from "../../utils/sql-sanitizer.js";

export const validateQueryDefinition = {
  name: "validate_query",
  description:
    "Validate the syntax of a T-SQL query without executing it. Uses SET PARSEONLY to check for syntax errors. Returns success or the specific syntax error.",
  inputSchema: {
    type: "object" as const,
    properties: {
      database: {
        type: "string",
        description: "Database name",
      },
      query: {
        type: "string",
        description: "The T-SQL query to validate",
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

  try {
    const parseQuery = `SET PARSEONLY ON;\n${query}\nSET PARSEONLY OFF;`;
    await executeQueryOnDatabase(config, database, parseQuery);
    return `✅ **Query syntax is valid.**\n\n\`\`\`sql\n${query}\n\`\`\``;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `❌ **Syntax error**:\n${message}\n\n**Query**:\n\`\`\`sql\n${query}\n\`\`\``;
  }
}
