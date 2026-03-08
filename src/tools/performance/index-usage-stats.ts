import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import { sanitizeIdentifier } from "../../utils/sql-sanitizer.js";
import { formatObjectList } from "../../utils/result-formatter.js";

export const indexUsageStatsDefinition = {
  name: "get_index_usage_stats",
  description:
    "Get index usage statistics: seeks, scans, lookups, and updates for each index. Helps identify unused or underutilized indexes.",
  inputSchema: {
    type: "object" as const,
    properties: {
      database: { type: "string", description: "Database name" },
      table: { type: "string", description: "Optional: filter by table name" },
    },
    required: ["database"],
  },
};

export async function indexUsageStatsHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);
  const tableFilter = args.table ? sanitizeIdentifier(args.table as string) : null;

  let query = `
    SELECT
      SCHEMA_NAME(t.schema_id) AS [schema],
      t.name AS tableName,
      i.name AS indexName,
      i.type_desc AS indexType,
      ISNULL(s.user_seeks, 0) AS seeks,
      ISNULL(s.user_scans, 0) AS scans,
      ISNULL(s.user_lookups, 0) AS lookups,
      ISNULL(s.user_updates, 0) AS updates,
      ISNULL(s.last_user_seek, '') AS lastSeek,
      ISNULL(s.last_user_scan, '') AS lastScan
    FROM sys.indexes i
    INNER JOIN sys.tables t ON i.object_id = t.object_id
    LEFT JOIN sys.dm_db_index_usage_stats s ON i.object_id = s.object_id AND i.index_id = s.index_id AND s.database_id = DB_ID()
    WHERE i.name IS NOT NULL`;

  if (tableFilter) {
    query += ` AND t.name = '${tableFilter}'`;
  }

  query += ` ORDER BY ISNULL(s.user_seeks, 0) + ISNULL(s.user_scans, 0) DESC`;

  const result = await executeQueryOnDatabase(config, database, query);
  return formatObjectList(result.recordset as Record<string, unknown>[], `Index Usage Stats — [${database}]`);
}
