import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

/**
 * Audit trail (ISO 27001 A.8.15): one JSON line per tool call and per SQL sent
 * to the server, written to **stderr** (stdout is the MCP JSON-RPC channel).
 *
 * It records which tool ran, against which database, a SHA-256 of the SQL text
 * (never the SQL itself, which may carry data), how many rows came back and
 * whether it failed. Disable with MSSQL_AUDIT_LOG=false.
 */

interface AuditContext {
  tool: string;
}

const context = new AsyncLocalStorage<AuditContext>();

export function sqlHash(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

function write(enabled: boolean, record: Record<string, unknown>): void {
  if (!enabled) return;
  try {
    process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), audit: true, ...record })}\n`);
  } catch {
    // Auditing must never break a tool call.
  }
}

/** Run `fn` with `tool` attached to every SQL audit line it produces. */
export function withAuditContext<T>(tool: string, fn: () => Promise<T>): Promise<T> {
  return context.run({ tool }, fn);
}

export function auditToolCall(
  enabled: boolean,
  tool: string,
  outcome: { ok: boolean; ms: number }
): void {
  write(enabled, { event: "tool_call", tool, ok: outcome.ok, ms: outcome.ms });
}

export function auditSql(
  enabled: boolean,
  entry: { database: string; sql: string; rows: number | null; ms: number; ok: boolean }
): void {
  write(enabled, {
    event: "sql",
    tool: context.getStore()?.tool ?? null,
    database: entry.database,
    sqlSha256: sqlHash(entry.sql),
    rows: entry.rows,
    ms: entry.ms,
    ok: entry.ok,
  });
}

/** Total rows returned across every result set of an mssql result. */
export function countRows(result: { recordsets?: unknown } | undefined): number | null {
  const sets = result?.recordsets;
  if (!Array.isArray(sets)) return null;
  return sets.reduce((sum: number, rs: unknown) => sum + (Array.isArray(rs) ? rs.length : 0), 0);
}
