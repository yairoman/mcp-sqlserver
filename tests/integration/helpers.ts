import { inject, vi } from "vitest";
import sql from "mssql";
import { loadConfig, type AppConfig } from "../../src/config.js";

export type Login = "reader" | "writer";

/**
 * AppConfig for the code under test, built through the real loadConfig() from
 * an EXPLICIT env object: process.env and .env are never consulted, so a
 * developer's MSSQL_HOST cannot leak in. Host and port come from the global
 * setup, which already checked them.
 */
export function itConfig(login: Login = "reader", extra: Record<string, string> = {}): AppConfig {
  const it = inject("it");
  const creds = it[login];
  return loadConfig({
    MSSQL_HOST: it.host,
    MSSQL_PORT: String(it.port),
    MSSQL_USER: creds.user,
    MSSQL_PASSWORD: creds.password,
    MSSQL_DATABASE: it.database,
    MSSQL_ENCRYPT: "true",
    // The container uses a self-signed certificate.
    MSSQL_TRUST_SERVER_CERTIFICATE: "true",
    MSSQL_READ_ONLY: "true",
    MSSQL_AUDIT_LOG: "true",
    ...extra,
  });
}

export function itDatabase(): string {
  return inject("it").database;
}

/**
 * A separate connection, outside src/connection.ts, to look at the data from
 * the outside (e.g. after a rollback). Uses the read-only login.
 */
export async function readOutside<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const it = inject("it");
  const pool = new sql.ConnectionPool({
    server: it.host,
    port: it.port,
    user: it.reader.user,
    password: it.reader.password,
    database: it.database,
    options: { encrypt: true, trustServerCertificate: true },
    pool: { min: 0, max: 1 },
  });
  await pool.connect();
  try {
    return (await pool.request().query(query)).recordset as T[];
  } finally {
    await pool.close();
  }
}

export interface AuditLine {
  event: "sql" | "tool_call";
  tool: string | null;
  rows?: number | null;
  ok: boolean;
}

/**
 * Capture the JSON audit lines written to stderr while `fn` runs. The audit
 * records the rows the DRIVER received, which is how a server-side cut is told
 * apart from a client-side slice.
 */
export async function captureAudit<T>(fn: () => Promise<T>): Promise<{ result: T; audit: AuditLine[] }> {
  const lines: AuditLine[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      try {
        const parsed = JSON.parse(line) as AuditLine & { audit?: boolean };
        if (parsed.audit) lines.push(parsed);
      } catch {
        // not an audit line
      }
    }
    return true;
  });
  try {
    const result = await fn();
    return { result, audit: lines };
  } finally {
    spy.mockRestore();
  }
}
