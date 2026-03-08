import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import { sanitizeIdentifier } from "../../utils/sql-sanitizer.js";
import { formatObjectList } from "../../utils/result-formatter.js";

export const listStoredProceduresDefinition = {
  name: "list_stored_procedures",
  description:
    "List all stored procedures in a database with their schema, parameters, creation and modification dates. Optionally include the SQL definition.",
  inputSchema: {
    type: "object" as const,
    properties: {
      database: {
        type: "string",
        description: "Database name",
      },
      schema: {
        type: "string",
        description: "Optional schema filter",
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

export async function listStoredProceduresHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);
  const schemaFilter = args.schema
    ? sanitizeIdentifier(args.schema as string)
    : null;
  const includeDefinition = args.includeDefinition === true;

  // First get the stored procedures
  let spQuery = `
    SELECT
      s.name AS [schema],
      p.name AS [name],
      p.create_date AS createdDate,
      p.modify_date AS modifiedDate
      ${includeDefinition ? ", m.definition" : ""}
    FROM sys.procedures p
    INNER JOIN sys.schemas s ON p.schema_id = s.schema_id
    ${includeDefinition ? "LEFT JOIN sys.sql_modules m ON p.object_id = m.object_id" : ""}
    WHERE p.is_ms_shipped = 0`;

  if (schemaFilter) {
    spQuery += ` AND s.name = '${schemaFilter}'`;
  }

  spQuery += ` ORDER BY s.name, p.name`;

  const result = await executeQueryOnDatabase(config, database, spQuery);
  const sps = result.recordset as Record<string, unknown>[];

  // Get parameters for each SP
  const paramsQuery = `
    SELECT
      SCHEMA_NAME(p.schema_id) AS [schema],
      p.name AS spName,
      par.name AS paramName,
      TYPE_NAME(par.user_type_id) AS dataType,
      par.max_length AS maxLength,
      par.is_output AS isOutput,
      par.has_default_value AS hasDefault
    FROM sys.procedures p
    INNER JOIN sys.parameters par ON p.object_id = par.object_id
    WHERE p.is_ms_shipped = 0 AND par.parameter_id > 0
    ORDER BY p.name, par.parameter_id`;

  const paramsResult = await executeQueryOnDatabase(
    config,
    database,
    paramsQuery
  );
  const paramsMap = new Map<string, Record<string, unknown>[]>();
  for (const row of paramsResult.recordset) {
    const key = `${row.schema}.${row.spName}`;
    if (!paramsMap.has(key)) paramsMap.set(key, []);
    paramsMap.get(key)!.push(row as Record<string, unknown>);
  }

  // Enrich SPs with parameter summary
  const enriched = sps.map((sp) => {
    const key = `${sp.schema}.${sp.name}`;
    const params = paramsMap.get(key) || [];
    const paramSummary = params
      .map(
        (p) =>
          `${p.paramName} ${p.dataType}${p.isOutput ? " OUTPUT" : ""}`
      )
      .join(", ");
    return {
      ...sp,
      parameters: paramSummary || "(none)",
      paramCount: params.length,
    };
  });

  return formatObjectList(enriched, `Stored Procedures in [${database}]`);
}
