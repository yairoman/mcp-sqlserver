import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import { sanitizeIdentifier } from "../../utils/sql-sanitizer.js";

export const getObjectDefinitionDefinition = {
  name: "get_object_definition",
  description:
    "Get the T-SQL source code definition of any database object: stored procedure, view, function, or trigger.",
  inputSchema: {
    type: "object" as const,
    properties: {
      database: {
        type: "string",
        description: "Database name",
      },
      schema: {
        type: "string",
        description: "Schema name (default: dbo)",
        default: "dbo",
      },
      objectName: {
        type: "string",
        description: "Name of the object (stored procedure, view, function, or trigger)",
      },
    },
    required: ["database", "objectName"],
  },
};

export async function getObjectDefinitionHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);
  const schema = sanitizeIdentifier((args.schema as string) || "dbo");
  const objectName = sanitizeIdentifier(args.objectName as string);

  const query = `
    SELECT
      o.type_desc AS objectType,
      m.definition
    FROM sys.sql_modules m
    INNER JOIN sys.objects o ON m.object_id = o.object_id
    INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
    WHERE s.name = '${schema}' AND o.name = '${objectName}'`;

  const result = await executeQueryOnDatabase(config, database, query);

  if (result.recordset.length === 0) {
    return `❌ Object [${schema}].[${objectName}] not found in [${database}], or it does not have a SQL definition.`;
  }

  const row = result.recordset[0];
  const parts = [
    `**Object Definition**: [${database}].[${schema}].[${objectName}]`,
    `**Type**: ${row.objectType}`,
    "",
    "```sql",
    String(row.definition),
    "```",
  ];

  return parts.join("\n");
}
