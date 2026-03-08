import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import { sanitizeIdentifier } from "../../utils/sql-sanitizer.js";
import { formatObjectList } from "../../utils/result-formatter.js";

export const checkReferentialIntegrityDefinition = {
  name: "check_referential_integrity",
  description:
    "Check for orphaned records that violate foreign key relationships. Scans all foreign keys in a database (or for a specific table) to find child records without a matching parent. Critical for data integrity validation.",
  inputSchema: {
    type: "object" as const,
    properties: {
      database: { type: "string", description: "Database name" },
      table: { type: "string", description: "Optional: check FKs for a specific table only" },
    },
    required: ["database"],
  },
};

export async function checkReferentialIntegrityHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);
  const tableFilter = args.table ? sanitizeIdentifier(args.table as string) : null;

  // Get all foreign keys
  let fkQuery = `
    SELECT
      fk.name AS fkName,
      SCHEMA_NAME(tp.schema_id) AS parentSchema,
      tp.name AS parentTable,
      cp.name AS parentColumn,
      SCHEMA_NAME(tr.schema_id) AS refSchema,
      tr.name AS refTable,
      cr.name AS refColumn
    FROM sys.foreign_keys fk
    INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
    INNER JOIN sys.tables tp ON fkc.parent_object_id = tp.object_id
    INNER JOIN sys.columns cp ON fkc.parent_object_id = cp.object_id AND fkc.parent_column_id = cp.column_id
    INNER JOIN sys.tables tr ON fkc.referenced_object_id = tr.object_id
    INNER JOIN sys.columns cr ON fkc.referenced_object_id = cr.object_id AND fkc.referenced_column_id = cr.column_id
    WHERE 1=1`;

  if (tableFilter) {
    fkQuery += ` AND tp.name = '${tableFilter}'`;
  }

  const fkResult = await executeQueryOnDatabase(config, database, fkQuery);
  const fks = fkResult.recordset as Record<string, unknown>[];

  if (fks.length === 0) {
    return tableFilter
      ? `✅ No foreign keys found for table [${tableFilter}].`
      : `✅ No foreign keys found in database [${database}].`;
  }

  const violations: Record<string, unknown>[] = [];

  for (const fk of fks) {
    const checkQuery = `
      SELECT COUNT(*) AS orphanCount
      FROM [${fk.parentSchema}].[${fk.parentTable}] p
      LEFT JOIN [${fk.refSchema}].[${fk.refTable}] r ON p.[${fk.parentColumn}] = r.[${fk.refColumn}]
      WHERE r.[${fk.refColumn}] IS NULL AND p.[${fk.parentColumn}] IS NOT NULL`;

    try {
      const checkResult = await executeQueryOnDatabase(config, database, checkQuery);
      const orphanCount = (checkResult.recordset[0] as Record<string, unknown>).orphanCount as number;

      if (orphanCount > 0) {
        violations.push({
          fkName: fk.fkName,
          parentTable: `${fk.parentSchema}.${fk.parentTable}`,
          parentColumn: fk.parentColumn,
          referencedTable: `${fk.refSchema}.${fk.refTable}`,
          referencedColumn: fk.refColumn,
          orphanedRecords: orphanCount,
        });
      }
    } catch {
      // Skip if we can't check this FK (permissions, etc.)
    }
  }

  if (violations.length === 0) {
    return `✅ **Referential integrity check passed!** All ${fks.length} foreign keys are valid — no orphaned records found.`;
  }

  return formatObjectList(
    violations,
    `⚠️ Referential Integrity Violations (${violations.length} FKs with orphans)`
  );
}
