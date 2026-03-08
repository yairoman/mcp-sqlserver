import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import { sanitizeIdentifier } from "../../utils/sql-sanitizer.js";
import { formatObjectList } from "../../utils/result-formatter.js";

export const missingIndexesDefinition = {
  name: "get_missing_indexes",
  description:
    "Get indexes recommended by the SQL Server query optimizer based on actual query workload. Shows estimated improvement, recommended columns, and the tables that would benefit.",
  inputSchema: {
    type: "object" as const,
    properties: {
      database: { type: "string", description: "Database name" },
    },
    required: ["database"],
  },
};

export async function missingIndexesHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);

  const query = `
    SELECT TOP 25
      SCHEMA_NAME(t.schema_id) AS [schema],
      t.name AS tableName,
      mid.equality_columns AS equalityColumns,
      mid.inequality_columns AS inequalityColumns,
      mid.included_columns AS includedColumns,
      CAST(migs.avg_total_user_cost * migs.avg_user_impact * (migs.user_seeks + migs.user_scans) AS DECIMAL(18,2)) AS estimatedImprovement,
      migs.user_seeks AS seeks,
      migs.user_scans AS scans,
      migs.avg_total_user_cost AS avgCost,
      CAST(migs.avg_user_impact AS DECIMAL(5,2)) AS avgImpactPct
    FROM sys.dm_db_missing_index_group_stats migs
    INNER JOIN sys.dm_db_missing_index_groups mig ON migs.group_handle = mig.index_group_handle
    INNER JOIN sys.dm_db_missing_index_details mid ON mig.index_handle = mid.index_handle
    INNER JOIN sys.tables t ON mid.object_id = t.object_id
    WHERE mid.database_id = DB_ID()
    ORDER BY estimatedImprovement DESC`;

  const result = await executeQueryOnDatabase(config, database, query);
  return formatObjectList(result.recordset as Record<string, unknown>[], `Missing Indexes (Recommended) — [${database}]`);
}
