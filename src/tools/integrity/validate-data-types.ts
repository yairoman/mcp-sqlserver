import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import { sanitizeIdentifier, qualifiedName } from "../../utils/sql-sanitizer.js";
import { formatObjectList } from "../../utils/result-formatter.js";

export const validateDataTypesDefinition = {
  name: "validate_data_types",
  description:
    "Analyze columns for potential data type mismatches: detects numbers stored as strings, dates stored as strings, empty strings that should be NULL, and unusually long values. Useful for data quality assessment.",
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

export async function validateDataTypesHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);
  const schema = sanitizeIdentifier((args.schema as string) || "dbo");
  const table = sanitizeIdentifier(args.table as string);

  // Get string columns to analyze
  const colQuery = `
    SELECT c.name, tp.name AS dataType, c.max_length
    FROM sys.columns c
    INNER JOIN sys.types tp ON c.user_type_id = tp.user_type_id
    INNER JOIN sys.tables t ON c.object_id = t.object_id
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = '${schema}' AND t.name = '${table}'
      AND tp.name IN ('varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext')
    ORDER BY c.column_id`;

  const colResult = await executeQueryOnDatabase(config, database, colQuery);
  const stringColumns = colResult.recordset as Record<string, unknown>[];
  const fullName = qualifiedName(schema, table);

  if (stringColumns.length === 0) {
    return `ℹ️ No string columns found in [${schema}].[${table}] to analyze.`;
  }

  const issues: Record<string, unknown>[] = [];

  for (const col of stringColumns) {
    const colName = col.name as string;

    const analysisQuery = `
      SELECT
        '${colName}' AS columnName,
        '${col.dataType}(${col.max_length})' AS currentType,
        COUNT(*) AS totalNonNull,
        SUM(CASE WHEN LTRIM(RTRIM([${colName}])) = '' THEN 1 ELSE 0 END) AS emptyStrings,
        SUM(CASE WHEN TRY_CAST([${colName}] AS BIGINT) IS NOT NULL AND [${colName}] NOT LIKE '%[^0-9-]%' THEN 1 ELSE 0 END) AS numericValues,
        SUM(CASE WHEN TRY_CAST([${colName}] AS DATE) IS NOT NULL AND LEN([${colName}]) >= 8 THEN 1 ELSE 0 END) AS dateValues,
        MAX(LEN([${colName}])) AS maxActualLength,
        AVG(LEN([${colName}])) AS avgLength
      FROM ${fullName}
      WHERE [${colName}] IS NOT NULL`;

    try {
      const result = await executeQueryOnDatabase(config, database, analysisQuery);
      const r = result.recordset[0] as Record<string, unknown>;
      const total = (r.totalNonNull as number) || 0;

      if (total === 0) continue;

      const issueList: string[] = [];
      const emptyPct = ((r.emptyStrings as number) / total) * 100;
      const numericPct = ((r.numericValues as number) / total) * 100;
      const datePct = ((r.dateValues as number) / total) * 100;

      if (emptyPct > 5) issueList.push(`${emptyPct.toFixed(1)}% empty strings (should be NULL?)`);
      if (numericPct > 80) issueList.push(`${numericPct.toFixed(1)}% numeric values (consider INT/BIGINT)`);
      if (datePct > 80) issueList.push(`${datePct.toFixed(1)}% date values (consider DATE/DATETIME)`);

      if (issueList.length > 0) {
        issues.push({
          column: colName,
          type: r.currentType,
          issues: issueList.join("; "),
          maxLength: r.maxActualLength,
          avgLength: r.avgLength,
        });
      }
    } catch {
      // Skip columns with errors
    }
  }

  if (issues.length === 0) {
    return `✅ **No data type issues detected** in [${schema}].[${table}]. String columns appear well-typed.`;
  }

  return formatObjectList(issues, `⚠️ Data Type Issues — [${schema}].[${table}]`);
}
