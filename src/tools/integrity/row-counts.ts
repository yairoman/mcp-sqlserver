import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import { sanitizeIdentifier } from "../../utils/sql-sanitizer.js";
import { formatObjectList } from "../../utils/result-formatter.js";

export const rowCountsDefinition = {
  name: "get_row_counts_all_tables",
  description:
    "Get row counts for all tables in a database, sorted by count. Useful for quickly identifying empty tables, very large tables, or unexpected table sizes.",
  inputSchema: {
    type: "object" as const,
    properties: {
      database: { type: "string", description: "Database name" },
      showEmpty: {
        type: "boolean",
        description: "Include tables with 0 rows (default: true)",
        default: true,
      },
    },
    required: ["database"],
  },
};

export async function rowCountsHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);
  const showEmpty = args.showEmpty !== false;

  let query = `
    SELECT
      SCHEMA_NAME(t.schema_id) AS [schema],
      t.name AS tableName,
      p.rows AS [rowCount],
      CAST(SUM(a.total_pages) * 8.0 / 1024 AS DECIMAL(18,2)) AS sizeMB
    FROM sys.tables t
    INNER JOIN sys.indexes i ON t.object_id = i.object_id
    INNER JOIN sys.partitions p ON i.object_id = p.object_id AND i.index_id = p.index_id
    INNER JOIN sys.allocation_units a ON p.partition_id = a.container_id
    WHERE i.index_id <= 1`;

  if (!showEmpty) {
    query += ` AND p.rows > 0`;
  }

  query += `
    GROUP BY t.schema_id, t.name, p.rows
    ORDER BY p.rows DESC`;

  const result = await executeQueryOnDatabase(config, database, query);
  const rows = result.recordset as Record<string, unknown>[];

  // Add summary
  const totalTables = rows.length;
  const emptyTables = rows.filter((r) => (r.rowCount as number) === 0).length;
  const totalRows = rows.reduce((sum, r) => sum + ((r.rowCount as number) || 0), 0);

  const header = `**Summary**: ${totalTables} tables, ${totalRows.toLocaleString()} total rows, ${emptyTables} empty tables\n\n`;

  return header + formatObjectList(rows, `Row Counts — [${database}]`);
}
