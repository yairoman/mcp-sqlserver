import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import { sanitizeIdentifier } from "../../utils/sql-sanitizer.js";
import { formatObjectList } from "../../utils/result-formatter.js";

export const compareSchemasDefinition = {
  name: "compare_table_schemas",
  description:
    "Compare the column schemas of two tables (same or different databases). Shows columns that exist in one but not the other, and columns with different data types.",
  inputSchema: {
    type: "object" as const,
    properties: {
      database1: { type: "string", description: "First database name" },
      schema1: { type: "string", description: "First schema name (default: dbo)", default: "dbo" },
      table1: { type: "string", description: "First table name" },
      database2: { type: "string", description: "Second database name" },
      schema2: { type: "string", description: "Second schema name (default: dbo)", default: "dbo" },
      table2: { type: "string", description: "Second table name" },
    },
    required: ["database1", "table1", "database2", "table2"],
  },
};

export async function compareSchemasHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const db1 = sanitizeIdentifier(args.database1 as string);
  const schema1 = sanitizeIdentifier((args.schema1 as string) || "dbo");
  const table1 = sanitizeIdentifier(args.table1 as string);
  const db2 = sanitizeIdentifier(args.database2 as string);
  const schema2 = sanitizeIdentifier((args.schema2 as string) || "dbo");
  const table2 = sanitizeIdentifier(args.table2 as string);

  const getColumnsQuery = (schema: string, table: string) => `
    SELECT
      c.name AS columnName,
      tp.name AS dataType,
      c.max_length AS maxLength,
      c.precision,
      c.scale,
      c.is_nullable AS isNullable,
      c.is_identity AS isIdentity
    FROM sys.columns c
    INNER JOIN sys.types tp ON c.user_type_id = tp.user_type_id
    INNER JOIN sys.tables t ON c.object_id = t.object_id
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = '${schema}' AND t.name = '${table}'
    ORDER BY c.column_id`;

  const [result1, result2] = await Promise.all([
    executeQueryOnDatabase(config, db1, getColumnsQuery(schema1, table1)),
    executeQueryOnDatabase(config, db2, getColumnsQuery(schema2, table2)),
  ]);

  const cols1 = result1.recordset as Record<string, unknown>[];
  const cols2 = result2.recordset as Record<string, unknown>[];

  const map1 = new Map(cols1.map((c) => [c.columnName as string, c]));
  const map2 = new Map(cols2.map((c) => [c.columnName as string, c]));

  const differences: Record<string, unknown>[] = [];

  // Columns only in table1
  for (const [name, col] of map1) {
    if (!map2.has(name)) {
      differences.push({
        column: name,
        status: `Only in ${db1}.${table1}`,
        type1: col.dataType,
        type2: "-",
      });
    }
  }

  // Columns only in table2
  for (const [name, col] of map2) {
    if (!map1.has(name)) {
      differences.push({
        column: name,
        status: `Only in ${db2}.${table2}`,
        type1: "-",
        type2: col.dataType,
      });
    }
  }

  // Columns in both but different
  for (const [name, col1] of map1) {
    const col2 = map2.get(name);
    if (col2) {
      const diffs: string[] = [];
      if (col1.dataType !== col2.dataType) diffs.push(`type: ${col1.dataType} vs ${col2.dataType}`);
      if (col1.maxLength !== col2.maxLength) diffs.push(`length: ${col1.maxLength} vs ${col2.maxLength}`);
      if (col1.isNullable !== col2.isNullable) diffs.push(`nullable: ${col1.isNullable} vs ${col2.isNullable}`);

      if (diffs.length > 0) {
        differences.push({
          column: name,
          status: "Different",
          differences: diffs.join("; "),
          type1: col1.dataType,
          type2: col2.dataType,
        });
      }
    }
  }

  if (differences.length === 0) {
    return `✅ **Schemas are identical.** [${db1}].[${schema1}].[${table1}] and [${db2}].[${schema2}].[${table2}] have the same column definitions.`;
  }

  return formatObjectList(
    differences,
    `Schema Comparison: [${db1}].[${table1}] vs [${db2}].[${table2}] (${differences.length} differences)`
  );
}
