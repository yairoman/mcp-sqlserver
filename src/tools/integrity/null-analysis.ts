import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import { sanitizeIdentifier, qualifiedName } from "../../utils/sql-sanitizer.js";
import { formatObjectList } from "../../utils/result-formatter.js";

export const nullAnalysisDefinition = {
  name: "check_null_analysis",
  description:
    "Analyze NULL values across all columns in a table. Returns the count and percentage of NULLs per column. Useful for assessing data completeness.",
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

export async function nullAnalysisHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);
  const schema = sanitizeIdentifier((args.schema as string) || "dbo");
  const table = sanitizeIdentifier(args.table as string);
  const fullName = qualifiedName(schema, table);

  // Get columns
  const colQuery = `
    SELECT c.name
    FROM sys.columns c
    INNER JOIN sys.tables t ON c.object_id = t.object_id
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = '${schema}' AND t.name = '${table}'
    ORDER BY c.column_id`;

  const colResult = await executeQueryOnDatabase(config, database, colQuery);
  const columns = colResult.recordset.map((r) => (r as Record<string, unknown>).name as string);

  if (columns.length === 0) {
    return `❌ Table [${schema}].[${table}] not found in [${database}].`;
  }

  // Build NULL analysis query
  const nullExpressions = columns.map(
    (col) =>
      `SUM(CASE WHEN [${col}] IS NULL THEN 1 ELSE 0 END) AS [${col}_nulls]`
  );

  const nullQuery = `
    SELECT COUNT(*) AS totalRows, ${nullExpressions.join(", ")}
    FROM ${fullName}`;

  const nullResult = await executeQueryOnDatabase(config, database, nullQuery);
  const row = nullResult.recordset[0] as Record<string, unknown>;
  const totalRows = row.totalRows as number;

  const analysis = columns.map((col) => {
    const nullCount = (row[`${col}_nulls`] as number) || 0;
    const pct = totalRows > 0 ? ((nullCount / totalRows) * 100).toFixed(2) : "0.00";
    return {
      column: col,
      nullCount,
      totalRows,
      nullPercentage: `${pct}%`,
      status: nullCount === 0 ? "✅ Complete" : Number(pct) > 50 ? "⚠️ High" : "ℹ️ Partial",
    };
  });

  return formatObjectList(analysis, `NULL Analysis — [${schema}].[${table}] (${totalRows} rows)`);
}
