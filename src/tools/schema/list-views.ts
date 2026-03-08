import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import { sanitizeIdentifier } from "../../utils/sql-sanitizer.js";
import { formatObjectList } from "../../utils/result-formatter.js";

export const listViewsDefinition = {
  name: "list_views",
  description:
    "List all views in a database with their schema, creation date, and optionally their SQL definition.",
  inputSchema: {
    type: "object" as const,
    properties: {
      database: {
        type: "string",
        description: "Database name",
      },
      includeDefinition: {
        type: "boolean",
        description: "Include the SQL definition of each view (default: false)",
        default: false,
      },
    },
    required: ["database"],
  },
};

export async function listViewsHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);
  const includeDefinition = args.includeDefinition === true;

  const defCol = includeDefinition ? ", m.definition" : "";

  const query = `
    SELECT
      s.name AS [schema],
      v.name AS [name],
      v.create_date AS createdDate,
      v.modify_date AS modifiedDate
      ${defCol}
    FROM sys.views v
    INNER JOIN sys.schemas s ON v.schema_id = s.schema_id
    ${includeDefinition ? "LEFT JOIN sys.sql_modules m ON v.object_id = m.object_id" : ""}
    ORDER BY s.name, v.name`;

  const result = await executeQueryOnDatabase(config, database, query);

  return formatObjectList(
    result.recordset as Record<string, unknown>[],
    `Views in [${database}]`
  );
}
