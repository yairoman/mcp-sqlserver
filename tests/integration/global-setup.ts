import { randomBytes } from "node:crypto";
import sql from "mssql";
import type { TestProject } from "vitest/node";
import {
  readIntegrationEnv,
  assertThrowawayServer,
  maskSecrets,
  SERVER_IDENTITY_SQL,
  type ServerIdentity,
} from "./guard.js";
import { SEED_BATCHES } from "./seed.js";

/**
 * Creates, for this run only, a throwaway database and two least-privilege
 * logins on the docker-compose SQL Server, and drops all three at the end.
 *
 * - reader: db_datareader only. Every tool test runs as this login.
 * - writer: SELECT + UPDATE on dbo.Contador only. Used by ONE test, to prove
 *   that the always-rolled-back transaction undoes a write that got through.
 *
 * Passwords are generated per run and never written anywhere. The SA login is
 * used only here, never by the code under test.
 */

declare module "vitest" {
  export interface ProvidedContext {
    it: {
      host: string;
      port: number;
      database: string;
      reader: { user: string; password: string };
      writer: { user: string; password: string };
    };
  }
}

/** Meets the SQL Server password policy: upper, lower, digit and symbol. */
function generatePassword(): string {
  return `${randomBytes(18).toString("base64url")}aA1!`;
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // 1. Before any connection: loopback host and admin credentials.
  const env = readIntegrationEnv();
  const suffix = randomBytes(4).toString("hex");
  const database = `mcp_it_${suffix}`;
  const reader = { user: `mcp_it_reader_${suffix}`, password: generatePassword() };
  const writer = { user: `mcp_it_writer_${suffix}`, password: generatePassword() };
  const secrets = [env.adminPassword, reader.password, writer.password];

  const admin = new sql.ConnectionPool({
    server: env.host,
    port: env.port,
    user: env.adminUser,
    password: env.adminPassword,
    database: "master",
    options: { encrypt: true, trustServerCertificate: true },
    connectionTimeout: 30_000,
    requestTimeout: 120_000,
    pool: { min: 0, max: 1 },
  });

  let created = false;
  const teardown = async (): Promise<void> => {
    if (!created) {
      await admin.close().catch(() => undefined);
      return;
    }
    // Drop only the exact names created by this run, never by pattern.
    try {
      // USE master first: the seed batches left this session inside the database.
      await admin.request().batch(`
        USE master;
        IF DB_ID(N'${database}') IS NOT NULL
        BEGIN
          ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
          DROP DATABASE [${database}];
        END;
        IF SUSER_ID(N'${reader.user}') IS NOT NULL DROP LOGIN [${reader.user}];
        IF SUSER_ID(N'${writer.user}') IS NOT NULL DROP LOGIN [${writer.user}];`);
    } finally {
      await admin.close().catch(() => undefined);
    }
  };

  try {
    await admin.connect();

    // 2. After connecting, before any DDL: it must be the throwaway container.
    const identity = (await admin.request().query(SERVER_IDENTITY_SQL)).recordset[0] as ServerIdentity;
    assertThrowawayServer(identity);

    // 3. Throwaway database, seed data and least-privilege logins.
    created = true;
    await admin.request().batch(`CREATE DATABASE [${database}];`);
    for (const batch of SEED_BATCHES) {
      await admin.request().batch(`USE [${database}];\n${batch}`);
    }
    await admin.request().batch(`
      CREATE LOGIN [${reader.user}] WITH PASSWORD = N'${reader.password}', DEFAULT_DATABASE = [${database}], CHECK_POLICY = ON;
      CREATE LOGIN [${writer.user}] WITH PASSWORD = N'${writer.password}', DEFAULT_DATABASE = [${database}], CHECK_POLICY = ON;`);
    await admin.request().batch(`
      USE [${database}];
      CREATE USER [${reader.user}] FOR LOGIN [${reader.user}];
      ALTER ROLE db_datareader ADD MEMBER [${reader.user}];
      CREATE USER [${writer.user}] FOR LOGIN [${writer.user}];
      GRANT SELECT, UPDATE ON dbo.Contador TO [${writer.user}];`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await teardown().catch(() => undefined);
    throw new Error(maskSecrets(`Integration setup failed: ${message}`, secrets));
  }

  project.provide("it", { host: env.host, port: env.port, database, reader, writer });
  return teardown;
}
