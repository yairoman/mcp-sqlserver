import sql from "mssql";
import type { AppConfig } from "./config.js";
import { sanitizeIdentifier } from "./utils/sql-sanitizer.js";
import { auditSql, countRows } from "./utils/audit.js";

let pool: sql.ConnectionPool | null = null;
/**
 * The connection attempt in flight, if any. Concurrent callers share it, so two
 * tools called before the first connect finishes get the same pool instead of
 * each creating one (and orphaning all but the last).
 */
let connecting: Promise<sql.ConnectionPool> | null = null;

/**
 * Translate the app config into an mssql connection config.
 */
function buildSqlConfig(config: AppConfig, poolSize?: { min: number; max: number }): sql.config {
  return {
    server: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    options: {
      encrypt: config.encrypt,
      trustServerCertificate: config.trustServerCertificate,
    },
    connectionTimeout: config.connectionTimeout,
    requestTimeout: config.queryTimeout,
    pool: {
      min: poolSize?.min ?? config.poolMin,
      max: poolSize?.max ?? config.poolMax,
      idleTimeoutMillis: 30000,
    },
  };
}

/**
 * Create a pool with an 'error' listener. mssql re-emits connection errors on the
 * pool; with no listener that emit becomes an uncaught exception, and the process
 * now exits on those. A dropped connection must be logged, not fatal: the failing
 * request still rejects and the tool reports the error.
 */
function createPool(config: AppConfig, poolSize?: { min: number; max: number }): sql.ConnectionPool {
  const created = new sql.ConnectionPool(buildSqlConfig(config, poolSize));
  created.on("error", (error: unknown) => {
    console.error("⚠️ SQL Server connection error:", error instanceof Error ? error.message : error);
  });
  return created;
}

/**
 * Get or create the SQL Server connection pool.
 * Uses lazy initialization — pool is created on first call.
 *
 * Only one connection attempt is in flight at a time: concurrent callers await the
 * same promise. If the attempt fails it is forgotten, so the next call retries. If
 * closePool() runs while the attempt is in flight, the pool is closed as soon as it
 * connects and the waiting callers get an error instead of a pool nobody tracks.
 */
export function getPool(config: AppConfig): Promise<sql.ConnectionPool> {
  if (pool && pool.connected) {
    return Promise.resolve(pool);
  }
  if (connecting) {
    return connecting;
  }

  const created = createPool(config);
  const attempt: Promise<sql.ConnectionPool> = created.connect().then(
    async () => {
      if (connecting !== attempt) {
        // closePool() ran while we were connecting: do not resurrect the pool.
        await created.close().catch(() => undefined);
        throw new Error("SQL Server connection pool was closed while connecting");
      }
      pool = created;
      connecting = null;
      return created;
    },
    async (error: unknown) => {
      if (connecting === attempt) {
        connecting = null;
      }
      await created.close().catch(() => undefined);
      throw error;
    }
  );
  connecting = attempt;
  return attempt;
}

/**
 * Run one SQL call and write its audit line (tool, database, SQL hash, rows).
 */
async function audited<T extends { recordsets?: unknown }>(
  config: AppConfig,
  database: string,
  sqlText: string,
  run: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  try {
    const result = await run();
    auditSql(config.auditLog, {
      database,
      sql: sqlText,
      rows: countRows(result),
      ms: Date.now() - start,
      ok: true,
    });
    return result;
  } catch (error) {
    auditSql(config.auditLog, { database, sql: sqlText, rows: null, ms: Date.now() - start, ok: false });
    throw error;
  }
}

function bindParams(request: sql.Request, params?: Record<string, unknown>): void {
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      request.input(key, value);
    }
  }
}

async function runQuery(
  config: AppConfig,
  database: string,
  query: string,
  params?: Record<string, unknown>
): Promise<sql.IResult<Record<string, unknown>>> {
  const p = await getPool(config);
  const request = p.request();
  bindParams(request, params);
  return audited(config, database, query, () => request.query(query));
}

/**
 * Execute a SQL query with optional parameters.
 * Returns the recordset result.
 */
export async function executeQuery(
  config: AppConfig,
  query: string,
  params?: Record<string, unknown>
): Promise<sql.IResult<Record<string, unknown>>> {
  return runQuery(config, config.database, query, params);
}

/**
 * Execute a query on a specific database (USE [dbName]).
 */
export async function executeQueryOnDatabase(
  config: AppConfig,
  database: string,
  query: string,
  params?: Record<string, unknown>
): Promise<sql.IResult<Record<string, unknown>>> {
  const sanitizedDb = sanitizeIdentifier(database);
  const fullQuery = `USE [${sanitizedDb}];
${query}`;
  return runQuery(config, sanitizedDb, fullQuery, params);
}

/**
 * Execute a query on a specific database inside a transaction that is ALWAYS
 * rolled back, whether the query succeeds or fails.
 *
 * This is defense in depth for the tools that run caller-supplied SQL or filters:
 * if something slips past the text validator, the engine undoes any DML it did.
 * It does NOT undo effects outside the transaction (sequences, identity values,
 * extended procedures, linked-server calls, DDL that cannot run in a transaction
 * fails instead). The real control is a least-privilege login — see README.
 */
export async function executeReadOnlyOnDatabase(
  config: AppConfig,
  database: string,
  query: string,
  params?: Record<string, unknown>
): Promise<sql.IResult<Record<string, unknown>>> {
  const sanitizedDb = sanitizeIdentifier(database);
  const fullQuery = `USE [${sanitizedDb}];\n${query}`;

  const p = await getPool(config);
  const transaction = new sql.Transaction(p);
  await transaction.begin();

  try {
    const request = new sql.Request(transaction);
    bindParams(request, params);
    return await audited(config, sanitizedDb, fullQuery, () => request.query(fullQuery));
  } finally {
    try {
      await transaction.rollback();
    } catch {
      // The server may have already aborted the transaction (e.g. after a
      // severe error). Nothing left to undo; never mask the original error.
    }
  }
}

/** Send one batch on a dedicated connection (see withDedicatedConnection). */
export type BatchRunner = (sqlText: string) => Promise<sql.IResult<Record<string, unknown>>>;

/**
 * Run `work` on a dedicated single-connection pool, switched to `database`,
 * that is closed afterwards.
 *
 * Use it for connection-scoped SET options (SHOWPLAN, PARSEONLY): every step is
 * sent with `.batch()` (a plain SQL batch, not sp_executesql, so a SET applies to
 * the connection) over the same physical connection, and closing the pool
 * guarantees none of that state leaks into the shared pool.
 */
export async function withDedicatedConnection<T>(
  config: AppConfig,
  database: string,
  work: (batch: BatchRunner) => Promise<T>
): Promise<T> {
  const sanitizedDb = sanitizeIdentifier(database);
  const dedicated = createPool(config, { min: 0, max: 1 });
  await dedicated.connect();
  const batch: BatchRunner = (sqlText) =>
    audited(config, sanitizedDb, sqlText, () =>
      dedicated.request().batch(sqlText) as Promise<sql.IResult<Record<string, unknown>>>
    );
  try {
    await batch(`USE [${sanitizedDb}]`);
    return await work(batch);
  } finally {
    await dedicated.close();
  }
}

/**
 * Close the connection pool gracefully, including one still connecting.
 */
export async function closePool(): Promise<void> {
  const inFlight = connecting;
  const current = pool;
  connecting = null;
  pool = null;
  if (current) {
    await current.close();
  }
  if (inFlight) {
    // The attempt sees it was abandoned, closes its pool and rejects; its callers
    // get that error. Wait for it so the socket is closed when we return.
    await inFlight.catch(() => undefined);
  }
}
