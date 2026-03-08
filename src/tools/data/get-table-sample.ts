import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import {
  sanitizeIdentifier,
  qualifiedName,
} from "../../utils/sql-sanitizer.js";
import { formatQueryResult } from "../../utils/result-formatter.js";

export const getTableSampleDefinition = {
  name: "get_table_sample",
  description:
    "Get a representative sample of data from a table along with basic column statistics (min, max, distinct count, null count). Useful for quickly understanding what kind of data a table contains.",
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
      sampleSize: {
        type: "number",
        description: "Number of sample rows (default: 10)",
        default: 10,
      },
    },
    required: ["database", "table"],
  },
};

export async function getTableSampleHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);
  const schema = sanitizeIdentifier((args.schema as string) || "dbo");
  const table = sanitizeIdentifier(args.table as string);
  const sampleSize = Math.min((args.sampleSize as number) || 10, 100);
  const fullName = qualifiedName(schema, table);

  // Get sample rows
  const sampleQuery = `SELECT TOP ${sampleSize} * FROM ${fullName}`;
  const startTime = Date.now();
  const sampleResult = await executeQueryOnDatabase(
    config,
    database,
    sampleQuery
  );
  const elapsed = Date.now() - startTime;

  // Get row count
  const countResult = await executeQueryOnDatabase(
    config,
    database,
    `SELECT COUNT(*) AS totalRows FROM ${fullName}`
  );
  const totalRows = (countResult.recordset[0] as Record<string, unknown>)
    .totalRows;

  // Get column stats
  const statsQuery = `
    SELECT
      c.name AS columnName,
      tp.name AS dataType,
      c.is_nullable AS isNullable
    FROM sys.columns c
    INNER JOIN sys.types tp ON c.user_type_id = tp.user_type_id
    INNER JOIN sys.tables t ON c.object_id = t.object_id
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = '${schema}' AND t.name = '${table}'
    ORDER BY c.column_id`;

  const statsResult = await executeQueryOnDatabase(
    config,
    database,
    statsQuery
  );

  const columns =
    sampleResult.recordset.length > 0
      ? Object.keys(sampleResult.recordset[0])
      : [];

  const parts: string[] = [];
  parts.push(`**Table Sample**: ${fullName}`);
  parts.push(`**Total Rows**: ${totalRows}`);
  parts.push(`**Sample Size**: ${sampleResult.recordset.length}`);
  parts.push("");

  // Column summary
  parts.push("**Column Types**:");
  for (const stat of statsResult.recordset) {
    const s = stat as Record<string, unknown>;
    parts.push(
      `- ${s.columnName}: ${s.dataType}${s.isNullable ? " (nullable)" : ""}`
    );
  }
  parts.push("");

  // Sample data
  parts.push(
    formatQueryResult(
      columns,
      sampleResult.recordset as Record<string, unknown>[],
      sampleSize,
      elapsed
    )
  );

  return parts.join("\n");
}
