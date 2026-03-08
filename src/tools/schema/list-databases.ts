import type { AppConfig } from "../../config.js";
import { executeQuery } from "../../connection.js";
import { formatObjectList } from "../../utils/result-formatter.js";

export const listDatabasesDefinition = {
  name: "list_databases",
  description:
    "List all databases on the SQL Server instance with their state, size, compatibility level, collation, and recovery model.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

export async function listDatabasesHandler(
  config: AppConfig,
  _args: Record<string, unknown>
): Promise<string> {
  const result = await executeQuery(
    config,
    `SELECT
      d.name,
      d.state_desc AS state,
      CAST(SUM(mf.size) * 8.0 / 1024 / 1024 AS DECIMAL(10,2)) AS sizeGB,
      d.compatibility_level AS compatibilityLevel,
      d.collation_name AS collation,
      d.recovery_model_desc AS recoveryModel,
      d.create_date AS createdDate
    FROM sys.databases d
    LEFT JOIN sys.master_files mf ON d.database_id = mf.database_id
    GROUP BY d.name, d.state_desc, d.compatibility_level, d.collation_name, d.recovery_model_desc, d.create_date
    ORDER BY d.name`
  );

  return formatObjectList(
    result.recordset as Record<string, unknown>[],
    "Databases"
  );
}
