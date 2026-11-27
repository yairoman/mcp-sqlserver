import type { QueryResult } from "../types/index.js";

/**
 * Format a SQL result set for LLM consumption.
 * Handles truncation, formatting, and summary generation.
 */
export function formatQueryResult(
  columns: string[],
  rows: Record<string, unknown>[],
  maxRows: number,
  executionTimeMs: number,
  options?: { serverCapped?: boolean }
): string {
  const truncated = rows.length > maxRows;
  const displayRows = truncated ? rows.slice(0, maxRows) : rows;
  // When the server stopped at maxRows + 1, rows.length is not the real total:
  // it only proves that more rows exist.
  const serverCapped = options?.serverCapped === true && truncated;
  const totalRows = serverCapped ? displayRows.length : rows.length;

  const result: QueryResult = {
    columns,
    rows: displayRows,
    rowCount: totalRows,
    truncated,
    executionTimeMs,
  };

  const parts: string[] = [];

  // Header
  if (serverCapped) {
    parts.push(`**Query Results** (first ${maxRows} rows, ${executionTimeMs}ms)`);
    parts.push(
      `⚠️ Results truncated to ${maxRows} rows (MSSQL_MAX_ROWS). The server stopped there, so the total is unknown: add TOP / WHERE / ORDER BY to narrow the query, or COUNT(*) to size it.`
    );
  } else {
    parts.push(`**Query Results** (${totalRows} rows, ${executionTimeMs}ms)`);
    if (truncated) {
      parts.push(
        `⚠️ Results truncated to ${maxRows} rows (total: ${totalRows})`
      );
    }
  }

  // Table format if small enough
  if (columns.length <= 10 && displayRows.length <= 50) {
    parts.push(formatAsMarkdownTable(columns, displayRows));
  } else {
    // JSON format for wider/larger results
    parts.push("```json");
    parts.push(JSON.stringify(result, null, 2));
    parts.push("```");
  }

  return parts.join("\n\n");
}

/**
 * Format rows as a Markdown table.
 */
function formatAsMarkdownTable(
  columns: string[],
  rows: Record<string, unknown>[]
): string {
  if (rows.length === 0) {
    return "_No rows returned._";
  }

  const header = `| ${columns.join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const dataRows = rows.map(
    (row) =>
      `| ${columns.map((col) => formatCellValue(row[col])).join(" | ")} |`
  );

  return [header, separator, ...dataRows].join("\n");
}

/**
 * Format a cell value for display.
 */
function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "_NULL_";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  const str = String(value);
  // Truncate long cell values
  if (str.length > 100) return str.substring(0, 97) + "...";
  // Escape pipe characters for markdown tables
  return str.replace(/\|/g, "\\|");
}

/**
 * Format a simple list of objects as text.
 */
export function formatObjectList(
  items: Record<string, unknown>[],
  title: string
): string {
  if (items.length === 0) {
    return `**${title}**: _No items found._`;
  }

  const parts: string[] = [`**${title}** (${items.length} items)\n`];

  // If fewer than 20 items and small columns, use table
  if (items.length <= 30) {
    const columns = Object.keys(items[0]);
    if (columns.length <= 8) {
      parts.push(formatAsMarkdownTable(columns, items));
      return parts.join("\n");
    }
  }

  // Otherwise list format
  for (const item of items) {
    const entries = Object.entries(item)
      .map(([k, v]) => `**${k}**: ${formatCellValue(v)}`)
      .join(" | ");
    parts.push(`- ${entries}`);
  }

  return parts.join("\n");
}

/**
 * Format a single object's details.
 */
export function formatObjectDetail(
  obj: Record<string, unknown>,
  title: string
): string {
  const parts: string[] = [`**${title}**\n`];
  for (const [key, value] of Object.entries(obj)) {
    parts.push(`- **${key}**: ${formatCellValue(value)}`);
  }
  return parts.join("\n");
}
