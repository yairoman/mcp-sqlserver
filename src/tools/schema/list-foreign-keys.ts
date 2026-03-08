import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import { sanitizeIdentifier } from "../../utils/sql-sanitizer.js";
import { formatObjectList } from "../../utils/result-formatter.js";

export const listForeignKeysDefinition = {
  name: "list_foreign_keys",
  description:
    "List all foreign key relationships in a database or for a specific table, showing parent/child columns and cascade actions.",
  inputSchema: {
    type: "object" as const,
    properties: {
      database: {
        type: "string",
        description: "Database name",
      },
      table: {
        type: "string",
        description: "Optional: filter FKs for a specific table (as parent or referenced)",
      },
      schema: {
        type: "string",
        description: "Schema name (default: dbo)",
        default: "dbo",
      },
    },
    required: ["database"],
  },
};

export async function listForeignKeysHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);
  const tableFilter = args.table
    ? sanitizeIdentifier(args.table as string)
    : null;
  const schema = sanitizeIdentifier((args.schema as string) || "dbo");

  let query = `
    SELECT
      fk.name AS fkName,
      SCHEMA_NAME(tp.schema_id) AS parentSchema,
      tp.name AS parentTable,
      cp.name AS parentColumn,
      SCHEMA_NAME(tr.schema_id) AS referencedSchema,
      tr.name AS referencedTable,
      cr.name AS referencedColumn,
      fk.delete_referential_action_desc AS onDelete,
      fk.update_referential_action_desc AS onUpdate
    FROM sys.foreign_keys fk
    INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
    INNER JOIN sys.tables tp ON fkc.parent_object_id = tp.object_id
    INNER JOIN sys.columns cp ON fkc.parent_object_id = cp.object_id AND fkc.parent_column_id = cp.column_id
    INNER JOIN sys.tables tr ON fkc.referenced_object_id = tr.object_id
    INNER JOIN sys.columns cr ON fkc.referenced_object_id = cr.object_id AND fkc.referenced_column_id = cr.column_id
    WHERE 1=1`;

  if (tableFilter) {
    query += ` AND (tp.name = '${tableFilter}' OR tr.name = '${tableFilter}')`;
    query += ` AND (SCHEMA_NAME(tp.schema_id) = '${schema}' OR SCHEMA_NAME(tr.schema_id) = '${schema}')`;
  }

  query += ` ORDER BY tp.name, fk.name, fkc.constraint_column_id`;

  const result = await executeQueryOnDatabase(config, database, query);

  return formatObjectList(
    result.recordset as Record<string, unknown>[],
    `Foreign Keys in [${database}]${tableFilter ? ` (table: ${tableFilter})` : ""}`
  );
}
