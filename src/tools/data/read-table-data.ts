import type { AppConfig } from "../../config.js";
import { executeQueryOnDatabase } from "../../connection.js";
import {
  sanitizeIdentifier,
  quoteIdentifier,
  qualifiedName,
} from "../../utils/sql-sanitizer.js";
import { formatQueryResult } from "../../utils/result-formatter.js";

export const readTableDataDefinition = {
  name: "read_table_data",
  description:
    "Read rows from a database table with optional filtering, sorting, and pagination. Returns the actual data content that users have entered into the table.",
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
      columns: {
        type: "array",
        items: { type: "string" },
        description:
          "Columns to select (default: all columns). Example: ['Name', 'Email', 'CreatedDate']",
      },
      where: {
        type: "string",
        description:
          "Optional WHERE clause (without the WHERE keyword). Example: \"Status = 'Active' AND Age > 18\"",
      },
      orderBy: {
        type: "string",
        description:
          "Optional ORDER BY clause (without the ORDER BY keyword). Example: 'CreatedDate DESC'",
      },
      top: {
        type: "number",
        description:
          "Maximum number of rows to return (default: config maxRows, typically 1000)",
      },
      offset: {
        type: "number",
        description: "Number of rows to skip (for pagination, default: 0)",
      },
    },
    required: ["database", "table"],
  },
};

export async function readTableDataHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const database = sanitizeIdentifier(args.database as string);
  const schema = sanitizeIdentifier((args.schema as string) || "dbo");
  const table = sanitizeIdentifier(args.table as string);
  const maxRows = Math.min(
    (args.top as number) || config.maxRows,
    config.maxRows
  );
  const offset = (args.offset as number) || 0;

  // Build column list
  let columnList = "*";
  if (args.columns && Array.isArray(args.columns)) {
    columnList = (args.columns as string[])
      .map((c) => quoteIdentifier(c))
      .join(", ");
  }

  // Build query
  let query = `SELECT ${columnList} FROM ${qualifiedName(schema, table)}`;

  if (args.where) {
    query += ` WHERE ${args.where}`;
  }

  if (args.orderBy) {
    query += ` ORDER BY ${args.orderBy}`;
    query += ` OFFSET ${offset} ROWS FETCH NEXT ${maxRows} ROWS ONLY`;
  } else {
    query = `SELECT TOP ${maxRows} ${columnList} FROM ${qualifiedName(schema, table)}`;
    if (args.where) {
      query += ` WHERE ${args.where}`;
    }
  }

  const startTime = Date.now();
  const result = await executeQueryOnDatabase(config, database, query);
  const elapsed = Date.now() - startTime;

  const columns =
    result.recordset.columns
      ? Object.keys(result.recordset.columns)
      : result.recordset.length > 0
        ? Object.keys(result.recordset[0])
        : [];

  return formatQueryResult(
    columns,
    result.recordset as Record<string, unknown>[],
    maxRows,
    elapsed
  );
}
