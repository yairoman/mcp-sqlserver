import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import { sanitizeIdentifier } from "../../utils/sql-sanitizer.js";
import { formatObjectList } from "../../utils/result-formatter.js";

export const listTablesDefinition = {
  name: "list_tables",
  description:
    "List all tables in a database with schema, row count, size in KB, and dates. Optionally filter by schema name.",
  inputSchema: {
    type: "object" as const,
    properties: {
      database: {
        type: "string",
        description: "Database name",
      },
      schema: {
        type: "string",
        description: "Optional schema filter (e.g., 'dbo')",
      },
    },
    required: ["database"],
  },
};

export async function listTablesHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);
  const schemaFilter = args.schema
    ? sanitizeIdentifier(args.schema as string)
    : null;

  let query = `
    SELECT
      s.name AS [schema],
      t.name AS [name],
      'TABLE' AS [type],
      p.rows AS rowCount,
      CAST(SUM(a.total_pages) * 8 AS BIGINT) AS sizeKB,
      t.create_date AS createdDate,
      t.modify_date AS modifiedDate
    FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    INNER JOIN sys.indexes i ON t.object_id = i.object_id
    INNER JOIN sys.partitions p ON i.object_id = p.object_id AND i.index_id = p.index_id
    INNER JOIN sys.allocation_units a ON p.partition_id = a.container_id
    WHERE i.index_id <= 1`;

  if (schemaFilter) {
    query += ` AND s.name = '${schemaFilter}'`;
  }

  query += `
    GROUP BY s.name, t.name, p.rows, t.create_date, t.modify_date
    ORDER BY s.name, t.name`;

  const result = await executeQueryOnDatabase(config, database, query);

  return formatObjectList(
    result.recordset as Record<string, unknown>[],
    `Tables in [${database}]`
  );
}
