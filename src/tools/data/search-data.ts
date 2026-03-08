import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import {
  sanitizeIdentifier,
  qualifiedName,
  quoteIdentifier,
} from "../../utils/sql-sanitizer.js";
import { formatQueryResult } from "../../utils/result-formatter.js";

export const searchDataDefinition = {
  name: "search_data",
  description:
    "Search for specific values in a table's columns. Useful for finding records by name, email, ID, or any text pattern using LIKE matching.",
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
      searchColumns: {
        type: "array",
        items: { type: "string" },
        description:
          "Columns to search in. Example: ['Name', 'Email', 'Description']",
      },
      searchValue: {
        type: "string",
        description:
          "Value to search for. Supports SQL LIKE patterns (% for wildcard).",
      },
      exactMatch: {
        type: "boolean",
        description:
          "If true, uses exact match (=). If false (default), wraps with % for partial matching.",
        default: false,
      },
    },
    required: ["database", "table", "searchColumns", "searchValue"],
  },
};

export async function searchDataHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);
  const schema = sanitizeIdentifier((args.schema as string) || "dbo");
  const table = sanitizeIdentifier(args.table as string);
  const searchColumns = (args.searchColumns as string[]).map((c) =>
    sanitizeIdentifier(c)
  );
  const searchValue = args.searchValue as string;
  const exactMatch = args.exactMatch === true;

  // Escape value for inline SQL (safe since we control the context)
  const escapedValue = searchValue.replace(/'/g, "''");
  const inlineConditions = searchColumns.map((col) => {
    if (exactMatch) {
      return `${quoteIdentifier(col)} = '${escapedValue}'`;
    }
    return `${quoteIdentifier(col)} LIKE '%${escapedValue}%'`;
  });

  const whereClause = inlineConditions.join(" OR ");
  const query = `SELECT TOP ${config.maxRows} * FROM ${qualifiedName(schema, table)} WHERE ${whereClause}`;

  const startTime = Date.now();
  const result = await executeQueryOnDatabase(config, database, query);
  const elapsed = Date.now() - startTime;

  const columns =
    result.recordset.length > 0
      ? Object.keys(result.recordset[0])
      : [];

  return formatQueryResult(
    columns,
    result.recordset as Record<string, unknown>[],
    config.maxRows,
    elapsed
  );
}
