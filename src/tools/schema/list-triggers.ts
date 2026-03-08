import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import { sanitizeIdentifier } from "../../utils/sql-sanitizer.js";
import { formatObjectList } from "../../utils/result-formatter.js";

export const listTriggersDefinition = {
  name: "list_triggers",
  description:
    "List all triggers in a database with their parent table, type (AFTER/INSTEAD OF), events (INSERT/UPDATE/DELETE), status (enabled/disabled), and optionally the SQL definition.",
  inputSchema: {
    type: "object" as const,
    properties: {
      database: {
        type: "string",
        description: "Database name",
      },
      table: {
        type: "string",
        description: "Optional: filter triggers for a specific table",
      },
      includeDefinition: {
        type: "boolean",
        description: "Include the SQL definition (default: false)",
        default: false,
      },
    },
    required: ["database"],
  },
};

export async function listTriggersHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);
  const tableFilter = args.table
    ? sanitizeIdentifier(args.table as string)
    : null;
  const includeDefinition = args.includeDefinition === true;

  let query = `
    SELECT
      tr.name AS triggerName,
      SCHEMA_NAME(t.schema_id) AS parentSchema,
      t.name AS parentTable,
      CASE WHEN tr.is_instead_of_trigger = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END AS triggerType,
      CASE WHEN tr.is_disabled = 0 THEN 'Enabled' ELSE 'Disabled' END AS status,
      STUFF((
        SELECT ', ' +
          CASE te.type
            WHEN 1 THEN 'INSERT'
            WHEN 2 THEN 'UPDATE'
            WHEN 3 THEN 'DELETE'
          END
        FROM sys.trigger_events te
        WHERE te.object_id = tr.object_id
        FOR XML PATH(''), TYPE
      ).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS events
      ${includeDefinition ? ", m.definition" : ""}
    FROM sys.triggers tr
    INNER JOIN sys.tables t ON tr.parent_id = t.object_id
    ${includeDefinition ? "LEFT JOIN sys.sql_modules m ON tr.object_id = m.object_id" : ""}
    WHERE tr.parent_class = 1`;

  if (tableFilter) {
    query += ` AND t.name = '${tableFilter}'`;
  }

  query += ` ORDER BY t.name, tr.name`;

  const result = await executeQueryOnDatabase(config, database, query);

  return formatObjectList(
    result.recordset as Record<string, unknown>[],
    `Triggers in [${database}]${tableFilter ? ` (table: ${tableFilter})` : ""}`
  );
}
