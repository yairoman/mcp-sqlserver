import type { AppConfig } from "../config.js";
import { executeQueryOnDatabase } from "../connection.js";
import { sanitizeIdentifier } from "../utils/sql-sanitizer.js";

export const databaseDiagramUri = "sqlserver://database-diagram";
export const databaseDiagramDefinition = {
  uri: databaseDiagramUri,
  name: "Database ER Diagram",
  description:
    "Entity-Relationship diagram in Mermaid format showing tables and their foreign key relationships.",
  mimeType: "text/markdown",
};

export async function getDatabaseDiagram(
  config: AppConfig,
  database: string
): Promise<string> {
  const db = sanitizeIdentifier(database);

  const query = `
    SELECT
      SCHEMA_NAME(tp.schema_id) + '.' + tp.name AS parentTable,
      SCHEMA_NAME(tr.schema_id) + '.' + tr.name AS referencedTable,
      fk.name AS fkName,
      cp.name AS parentColumn,
      cr.name AS referencedColumn
    FROM sys.foreign_keys fk
    INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
    INNER JOIN sys.tables tp ON fkc.parent_object_id = tp.object_id
    INNER JOIN sys.columns cp ON fkc.parent_object_id = cp.object_id AND fkc.parent_column_id = cp.column_id
    INNER JOIN sys.tables tr ON fkc.referenced_object_id = tr.object_id
    INNER JOIN sys.columns cr ON fkc.referenced_object_id = cr.object_id AND fkc.referenced_column_id = cr.column_id
    ORDER BY tp.name, fk.name`;

  const result = await executeQueryOnDatabase(config, db, query);
  const fks = result.recordset as Record<string, unknown>[];

  if (fks.length === 0) {
    return `# Database Diagram — [${db}]\n\n_No foreign key relationships found._`;
  }

  // Collect unique tables
  const tables = new Set<string>();
  for (const fk of fks) {
    tables.add(fk.parentTable as string);
    tables.add(fk.referencedTable as string);
  }

  // Build Mermaid ERD
  const lines = ["# Database Diagram — " + db, "", "```mermaid", "erDiagram"];

  // Add relationships
  for (const fk of fks) {
    const parent = (fk.parentTable as string).replace(".", "_");
    const ref = (fk.referencedTable as string).replace(".", "_");
    lines.push(
      `    ${ref} ||--o{ ${parent} : "${fk.parentColumn} -> ${fk.referencedColumn}"`
    );
  }

  lines.push("```");

  return lines.join("\n");
}
