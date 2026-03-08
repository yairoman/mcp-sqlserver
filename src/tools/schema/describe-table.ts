import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import { sanitizeIdentifier } from "../../utils/sql-sanitizer.js";
import { formatObjectList } from "../../utils/result-formatter.js";

export const describeTableDefinition = {
  name: "describe_table",
  description:
    "Get detailed column information for a table: column names, data types, nullability, primary keys, foreign keys, defaults, identity, computed columns, and descriptions.",
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
      table: {
        type: "string",
        description: "Table name",
      },
    },
    required: ["database", "table"],
  },
};

export async function describeTableHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);
  const schema = sanitizeIdentifier((args.schema as string) || "dbo");
  const table = sanitizeIdentifier(args.table as string);

  const query = `
    SELECT
      c.name AS columnName,
      tp.name AS dataType,
      c.max_length AS maxLength,
      c.precision,
      c.scale,
      c.is_nullable AS isNullable,
      CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS isPrimaryKey,
      CASE WHEN fk.parent_column_id IS NOT NULL THEN 1 ELSE 0 END AS isForeignKey,
      c.is_identity AS isIdentity,
      c.is_computed AS isComputed,
      dc.definition AS defaultValue,
      ep.value AS description
    FROM sys.columns c
    INNER JOIN sys.types tp ON c.user_type_id = tp.user_type_id
    INNER JOIN sys.tables t ON c.object_id = t.object_id
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    LEFT JOIN (
      SELECT ic.object_id, ic.column_id
      FROM sys.index_columns ic
      INNER JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      WHERE i.is_primary_key = 1
    ) pk ON c.object_id = pk.object_id AND c.column_id = pk.column_id
    LEFT JOIN sys.foreign_key_columns fk ON c.object_id = fk.parent_object_id AND c.column_id = fk.parent_column_id
    LEFT JOIN sys.default_constraints dc ON c.default_object_id = dc.object_id
    LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
    WHERE s.name = '${schema}' AND t.name = '${table}'
    ORDER BY c.column_id`;

  const result = await executeQueryOnDatabase(config, database, query);

  return formatObjectList(
    result.recordset as Record<string, unknown>[],
    `Columns in [${database}].[${schema}].[${table}]`
  );
}
