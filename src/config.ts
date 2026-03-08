import { z } from "zod";

const configSchema = z.object({
  // Connection
  host: z.string().min(1, "MSSQL_HOST is required"),
  port: z.coerce.number().int().positive().default(1433),
  user: z.string().min(1, "MSSQL_USER is required"),
  password: z.string().min(1, "MSSQL_PASSWORD is required"),
  database: z.string().default("master"),

  // Security
  encrypt: z
    .string()
    .transform((v) => v === "true")
    .default("true"),
  trustServerCertificate: z
    .string()
    .transform((v) => v === "true")
    .default("true"),
  readOnly: z
    .string()
    .transform((v) => v === "true")
    .default("true"),

  // Limits
  maxRows: z.coerce.number().int().positive().default(1000),
  queryTimeout: z.coerce.number().int().positive().default(30000),
  connectionTimeout: z.coerce.number().int().positive().default(15000),

  // Pool
  poolMin: z.coerce.number().int().min(0).default(1),
  poolMax: z.coerce.number().int().positive().default(10),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(): AppConfig {
  const raw = {
    host: process.env.MSSQL_HOST,
    port: process.env.MSSQL_PORT,
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    database: process.env.MSSQL_DATABASE,
    encrypt: process.env.MSSQL_ENCRYPT,
    trustServerCertificate: process.env.MSSQL_TRUST_SERVER_CERTIFICATE,
    readOnly: process.env.MSSQL_READ_ONLY,
    maxRows: process.env.MSSQL_MAX_ROWS,
    queryTimeout: process.env.MSSQL_QUERY_TIMEOUT,
    connectionTimeout: process.env.MSSQL_CONNECTION_TIMEOUT,
    poolMin: process.env.MSSQL_POOL_MIN,
    poolMax: process.env.MSSQL_POOL_MAX,
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
