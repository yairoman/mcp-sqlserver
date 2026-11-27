import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import { sanitizeIdentifier, quoteIdentifier, qualifiedName } from "../../utils/sql-sanitizer.js";
import { formatQueryResult } from "../../utils/result-formatter.js";

export const findDuplicatesDefinition = {
  name: "find_duplicate_records",
  description:
    "Find duplicate records in a table based on specified columns. Returns the duplicate values and their count. Useful for identifying data quality issues.",
  inputSchema: {
    type: "object" as const,
    properties: {
      database: { type: "string", description: "Database name" },
      schema: { type: "string", description: "Schema name (default: dbo)", default: "dbo" },
      table: { type: "string", description: "Table name" },
      columns: {
        type: "array",
        items: { type: "string" },
        description: "Columns to check for duplicates. Example: ['Email', 'Name']",
      },
      minCount: {
        type: "integer",
        minimum: 2,
        maximum: 1000000,
        description: "Minimum count to consider a duplicate (default: 2)",
        default: 2,
      },
    },
    required: ["database", "table", "columns"],
  },
};

export async function findDuplicatesHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);
  const schema = sanitizeIdentifier((args.schema as string) || "dbo");
  const table = sanitizeIdentifier(args.table as string);
  const columns = (args.columns as string[]).map((c) => sanitizeIdentifier(c));
  const minCount = Math.min(Math.max(Math.trunc(Number(args.minCount)) || 2, 2), 1_000_000);

  const colList = columns.map((c) => quoteIdentifier(c)).join(", ");
  const query = `
    SELECT ${colList}, COUNT(*) AS duplicateCount
    FROM ${qualifiedName(schema, table)}
    GROUP BY ${colList}
    HAVING COUNT(*) >= ${minCount}
    ORDER BY COUNT(*) DESC`;

  const startTime = Date.now();
  const result = await executeQueryOnDatabase(config, database, query);
  const elapsed = Date.now() - startTime;

  if (result.recordset.length === 0) {
    return `✅ **No duplicates found** in [${schema}].[${table}] for columns: ${columns.join(", ")}`;
  }

  const resultColumns = [...columns, "duplicateCount"];
  return formatQueryResult(
    resultColumns,
    result.recordset as Record<string, unknown>[],
    config.maxRows,
    elapsed
  );
}
