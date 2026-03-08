import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import { sanitizeIdentifier } from "../../utils/sql-sanitizer.js";
import { formatObjectList } from "../../utils/result-formatter.js";

export const tableStatisticsDefinition = {
  name: "get_table_statistics",
  description:
    "Get column-level statistics for a table: statistics name, columns, rows sampled, last updated, and modification counter. Useful for understanding data distribution and identifying stale statistics.",
  inputSchema: {
    type: "object" as const,
    properties: {
      database: { type: "string", description: "Database name" },
      schema: { type: "string", description: "Schema name (default: dbo)", default: "dbo" },
      table: { type: "string", description: "Table name" },
    },
    required: ["database", "table"],
  },
};

export async function tableStatisticsHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);
  const schema = sanitizeIdentifier((args.schema as string) || "dbo");
  const table = sanitizeIdentifier(args.table as string);

  const query = `
    SELECT
      s.name AS statisticName,
      STUFF((
        SELECT ', ' + c.name
        FROM sys.stats_columns sc
        INNER JOIN sys.columns c ON sc.object_id = c.object_id AND sc.column_id = c.column_id
        WHERE sc.stats_id = s.stats_id AND sc.object_id = s.object_id
        ORDER BY sc.stats_column_id
        FOR XML PATH(''), TYPE
      ).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS columns,
      CASE WHEN s.auto_created = 1 THEN 'Auto' WHEN s.user_created = 1 THEN 'User' ELSE 'System' END AS createdBy,
      sp.last_updated AS lastUpdated,
      sp.rows AS totalRows,
      sp.rows_sampled AS rowsSampled,
      sp.modification_counter AS modifications,
      sp.steps AS histogramSteps
    FROM sys.stats s
    INNER JOIN sys.tables t ON s.object_id = t.object_id
    INNER JOIN sys.schemas sc ON t.schema_id = sc.schema_id
    CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
    WHERE sc.name = '${schema}' AND t.name = '${table}'
    ORDER BY sp.modification_counter DESC`;

  const result = await executeQueryOnDatabase(config, database, query);
  return formatObjectList(
    result.recordset as Record<string, unknown>[],
    `Statistics for [${database}].[${schema}].[${table}]`
  );
}
