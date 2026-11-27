import sql from "mssql";
import type { AppConfig } from "./config.js";
import { sanitizeIdentifier } from "./utils/sql-sanitizer.js";

let pool: sql.ConnectionPool | null = null;

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
 * Get or create the SQL Server connection pool.
 * Uses lazy initialization — pool is created on first call.
 */
export async function getPool(config: AppConfig): Promise<sql.ConnectionPool> {
  if (pool && pool.connected) {
    return pool;
  }

  pool = new sql.ConnectionPool(buildSqlConfig(config));
  await pool.connect();
  return pool;
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
  const p = await getPool(config);
  const request = p.request();

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      request.input(key, value);
    }
  }

  return request.query(query);
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
  const fullQuery = `USE [${sanitizedDb}];\n${query}`;
  return executeQuery(config, fullQuery, params);
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
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        request.input(key, value);
      }
    }
    return await request.query(fullQuery);
  } finally {
    try {
      await transaction.rollback();
    } catch {
      // The server may have already aborted the transaction (e.g. after a
      // severe error). Nothing left to undo; never mask the original error.
    }
  }
}

/**
 * Run `work` on a dedicated single-connection pool that is closed afterwards.
 *
 * Use it for connection-scoped SET options (SHOWPLAN, PARSEONLY): every step is
 * sent as its own batch over the same physical connection, and closing the pool
 * guarantees none of that state leaks into the shared pool.
 */
export async function withDedicatedConnection<T>(
  config: AppConfig,
  work: (connection: sql.ConnectionPool) => Promise<T>
): Promise<T> {
  const dedicated = new sql.ConnectionPool(buildSqlConfig(config, { min: 0, max: 1 }));
  await dedicated.connect();
  try {
    return await work(dedicated);
  } finally {
    await dedicated.close();
  }
}

/**
 * Close the connection pool gracefully.
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}
