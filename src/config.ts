import { z } from "zod";

/**
 * Boolean env var that only turns OFF with an explicit, case-insensitive "false".
 * Any other value — including empty, "0", "no" or a typo — keeps it ON (fail-closed).
 */
const onUnlessExplicitFalse = z
  .string()
  .optional()
  .transform((v) => v === undefined || v.trim().toLowerCase() !== "false");

/**
 * Boolean env var that only turns ON with an explicit, case-insensitive "true".
 * Any other value keeps it OFF (fail-closed).
 */
const offUnlessExplicitTrue = z
  .string()
  .optional()
  .transform((v) => v !== undefined && v.trim().toLowerCase() === "true");

const configSchema = z.object({
  // Connection
  host: z.string().min(1, "MSSQL_HOST is required"),
  port: z.coerce.number().int().positive().default(1433),
  user: z.string().min(1, "MSSQL_USER is required"),
  password: z.string().min(1, "MSSQL_PASSWORD is required"),
  database: z.string().default("master"),

  // Security — every flag fails closed
  encrypt: onUnlessExplicitFalse,
  trustServerCertificate: offUnlessExplicitTrue,
  readOnly: onUnlessExplicitFalse,
  auditLog: onUnlessExplicitFalse,

  // Limits
  maxRows: z.coerce.number().int().positive().default(1000),
  queryTimeout: z.coerce.number().int().positive().default(30000),
  connectionTimeout: z.coerce.number().int().positive().default(15000),

  // Pool
  poolMin: z.coerce.number().int().min(0).default(1),
  poolMax: z.coerce.number().int().positive().default(10),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw = {
    host: env.MSSQL_HOST,
    port: env.MSSQL_PORT,
    user: env.MSSQL_USER,
    password: env.MSSQL_PASSWORD,
    database: env.MSSQL_DATABASE,
    encrypt: env.MSSQL_ENCRYPT,
    trustServerCertificate: env.MSSQL_TRUST_SERVER_CERTIFICATE,
    readOnly: env.MSSQL_READ_ONLY,
    auditLog: env.MSSQL_AUDIT_LOG,
    maxRows: env.MSSQL_MAX_ROWS,
    queryTimeout: env.MSSQL_QUERY_TIMEOUT,
    connectionTimeout: env.MSSQL_CONNECTION_TIMEOUT,
    poolMin: env.MSSQL_POOL_MIN,
    poolMax: env.MSSQL_POOL_MAX,
  };

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Configuration validation failed:\n${errors}`);
  }

  return result.data;
}
