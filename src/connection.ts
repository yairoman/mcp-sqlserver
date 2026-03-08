import sql from "mssql";
import type { AppConfig } from "./config.js";

let pool: sql.ConnectionPool | null = null;

/**
 * Get or create the SQL Server connection pool.
 * Uses lazy initialization — pool is created on first call.
 */
export async function getPool(config: AppConfig): Promise<sql.ConnectionPool> {
  if (pool && pool.connected) {
    return pool;
  }

  const sqlConfig: sql.config = {
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
      min: config.poolMin,
      max: config.poolMax,
      idleTimeoutMillis: 30000,
    },
  };

  pool = new sql.ConnectionPool(sqlConfig);
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
 * Close the connection pool gracefully.
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}

/**
 * Sanitize a SQL identifier (database, table, column name).
 * Removes brackets and dangerous characters.
 */
export function sanitizeIdentifier(name: string): string {
  return name.replace(/[\[\]'";\-\-\/\*]/g, "").trim();
}
