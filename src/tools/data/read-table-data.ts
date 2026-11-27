import type { AppConfig } from "../../config.js";
import { executeReadOnlyOnDatabase } from "../../connection.js";
import {
  sanitizeIdentifier,
  quoteIdentifier,
  qualifiedName,
} from "../../utils/sql-sanitizer.js";
import { McpToolError } from "../../utils/error-handler.js";
import { formatQueryResult } from "../../utils/result-formatter.js";

const TOOL_NAME = "read_table_data";

/** Comparison operators accepted in `filters`. Values are always bound as parameters. */
export const FILTER_OPERATORS = [
  "=",
  "<>",
  "<",
  "<=",
  ">",
  ">=",
  "LIKE",
  "NOT LIKE",
  "IN",
  "NOT IN",
  "IS NULL",
  "IS NOT NULL",
] as const;

type FilterOperator = (typeof FILTER_OPERATORS)[number];

type FilterValue = string | number | boolean;

interface Filter {
  column: string;
  operator: string;
  value?: unknown;
}

export const readTableDataDefinition = {
  name: TOOL_NAME,
  description:
    "Read rows from a database table with optional filtering, sorting, and pagination. Filters are structured (column + operator + value) and values are sent as parameters; free-form WHERE / ORDER BY SQL is not accepted.",
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
      filters: {
        type: "array",
        description:
          "Optional filters, combined with AND. Example: [{\"column\":\"Status\",\"operator\":\"=\",\"value\":\"Active\"},{\"column\":\"Age\",\"operator\":\">\",\"value\":18}]. IN / NOT IN take an array value; IS NULL / IS NOT NULL take no value.",
        items: {
          type: "object",
          properties: {
            column: { type: "string", description: "Column name" },
            operator: {
              type: "string",
              enum: [...FILTER_OPERATORS],
              description: "Comparison operator",
            },
            value: {
              description:
                "Value to compare with: string, number, boolean, or an array of them for IN / NOT IN",
            },
          },
          required: ["column", "operator"],
        },
      },
      orderBy: {
        type: "string",
        description:
          "Optional sort: comma-separated column names, each optionally followed by ASC or DESC. Example: 'CreatedDate DESC, Id'",
      },
      top: {
        type: "integer",
        description:
          "Maximum number of rows to return (default: config maxRows, typically 1000)",
        minimum: 1,
      },
      offset: {
        type: "integer",
        description: "Number of rows to skip (for pagination, default: 0). Requires orderBy.",
        minimum: 0,
      },
    },
    required: ["database", "table"],
  },
};

function isScalar(v: unknown): v is FilterValue {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/**
 * Turn structured filters into a parameterized WHERE clause.
 * Column names go through the identifier whitelist; values never touch the SQL text.
 */
export function buildWhereClause(filters: unknown): {
  clause: string;
  params: Record<string, FilterValue>;
} {
  if (filters === undefined || filters === null) {
    return { clause: "", params: {} };
  }
  if (!Array.isArray(filters)) {
    throw new McpToolError(TOOL_NAME, "`filters` must be an array of { column, operator, value }.");
  }

  const params: Record<string, FilterValue> = {};
  const parts: string[] = [];
  let n = 0;

  for (const raw of filters as Filter[]) {
    if (!raw || typeof raw !== "object" || typeof raw.column !== "string") {
      throw new McpToolError(TOOL_NAME, "Each filter needs a string `column`.");
    }
    const op = String(raw.operator ?? "")
      .toUpperCase()
      .replace(/\s+/g, " ")
      .trim() as FilterOperator;
    if (!FILTER_OPERATORS.includes(op)) {
      throw new McpToolError(
        TOOL_NAME,
        `Unsupported filter operator "${raw.operator}". Allowed: ${FILTER_OPERATORS.join(", ")}.`
      );
    }
    const col = quoteIdentifier(raw.column);

    if (op === "IS NULL" || op === "IS NOT NULL") {
      parts.push(`${col} ${op}`);
      continue;
    }

    if (op === "IN" || op === "NOT IN") {
      const values = raw.value;
      if (!Array.isArray(values) || values.length === 0 || !values.every(isScalar)) {
        throw new McpToolError(TOOL_NAME, `Operator ${op} needs a non-empty array of values.`);
      }
      const names = values.map((v) => {
        const name = `f${n++}`;
        params[name] = v;
        return `@${name}`;
      });
      parts.push(`${col} ${op} (${names.join(", ")})`);
      continue;
    }

    if (!isScalar(raw.value)) {
      throw new McpToolError(
        TOOL_NAME,
        `Operator ${op} needs a single string, number or boolean value.`
      );
    }
    const name = `f${n++}`;
    params[name] = raw.value;
    parts.push(`${col} ${op} @${name}`);
  }

  return { clause: parts.length > 0 ? ` WHERE ${parts.join(" AND ")}` : "", params };
}

/**
 * Parse "Col1 DESC, Col2" into a safe ORDER BY list. Anything else is rejected.
 */
export function buildOrderBy(orderBy: unknown): string {
  if (orderBy === undefined || orderBy === null || orderBy === "") {
    return "";
  }
  if (typeof orderBy !== "string") {
    throw new McpToolError(TOOL_NAME, "`orderBy` must be a string like 'CreatedDate DESC, Id'.");
  }
  const items = orderBy.split(",").map((item) => {
    const m = /^\s*(\[[^\]]+\]|[A-Za-z0-9_#@]+)(?:\s+(ASC|DESC))?\s*$/i.exec(item);
    if (!m) {
      throw new McpToolError(
        TOOL_NAME,
        `Invalid orderBy item "${item.trim()}". Use column names optionally followed by ASC or DESC.`
      );
    }
    const dir = m[2] ? ` ${m[2].toUpperCase()}` : "";
    return `${quoteIdentifier(m[1])}${dir}`;
  });
  return ` ORDER BY ${items.join(", ")}`;
}

export async function readTableDataHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  if (args.where !== undefined) {
    throw new McpToolError(
      TOOL_NAME,
      "Free-form `where` is no longer accepted. Use `filters`: [{ column, operator, value }]."
    );
  }

  const database = sanitizeIdentifier(args.database as string);
  const schema = sanitizeIdentifier((args.schema as string) || "dbo");
  const table = sanitizeIdentifier(args.table as string);
  const requestedTop = Math.trunc(Number(args.top)) || config.maxRows;
  const maxRows = Math.max(1, Math.min(requestedTop, config.maxRows));
  const offset = Math.max(0, Math.trunc(Number(args.offset)) || 0);

  // Build column list
  let columnList = "*";
  if (Array.isArray(args.columns) && args.columns.length > 0) {
    columnList = (args.columns as string[]).map((c) => quoteIdentifier(c)).join(", ");
  }

  const { clause: whereClause, params } = buildWhereClause(args.filters);
  const orderClause = buildOrderBy(args.orderBy);

  if (offset > 0 && !orderClause) {
    throw new McpToolError(
      TOOL_NAME,
      "`offset` requires `orderBy` (SQL Server pages with ORDER BY ... OFFSET)."
    );
  }

  const source = `${qualifiedName(schema, table)}${whereClause}`;
  const query = orderClause
    ? `SELECT ${columnList} FROM ${source}${orderClause} OFFSET ${offset} ROWS FETCH NEXT ${maxRows} ROWS ONLY`
    : `SELECT TOP ${maxRows} ${columnList} FROM ${source}`;

  const startTime = Date.now();
  const result = await executeReadOnlyOnDatabase(config, database, query, params);
  const elapsed = Date.now() - startTime;

  const columns = result.recordset.columns
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
