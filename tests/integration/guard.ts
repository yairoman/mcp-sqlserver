/**
 * Safety guard of the integration suite: it must NEVER run against a real
 * (client, QA, DEV or production) SQL Server. Two independent checks, both
 * fail-closed and with no bypass flag:
 *
 * 1. Before any connection: the host must be a literal loopback address.
 *    Hostnames that merely resolve to loopback, private ranges and tunnels to
 *    other machines are refused by name.
 * 2. After connecting, before any DDL: the server must be the throwaway
 *    container of docker-compose.yml. That container sets
 *    `hostname: mcp-sqlserver-test`, which SQL Server reports as
 *    SERVERPROPERTY('MachineName'); it must also be a Linux Developer/Express
 *    edition. A real instance, or another local container that happens to
 *    listen on loopback, fails here.
 *
 * Settings come only from MSSQL_IT_* variables (never from .env or MSSQL_HOST,
 * which point at real instances on a developer machine).
 */

/** The only hosts the suite will connect to. */
export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"] as const;

/** `hostname:` of the `sqlserver` service in docker-compose.yml. */
export const EXPECTED_MACHINE_NAME = "mcp-sqlserver-test";

export interface IntegrationEnv {
  host: string;
  port: number;
  adminUser: string;
  adminPassword: string;
}

export function assertLoopbackHost(host: string | undefined): string {
  const h = (host ?? "").trim().toLowerCase();
  if (!(LOOPBACK_HOSTS as readonly string[]).includes(h)) {
    throw new Error(
      `Integration tests refuse to run against host "${host ?? ""}". ` +
        `Only the local throwaway container is allowed (${LOOPBACK_HOSTS.join(", ")}).`
    );
  }
  return h === "[::1]" ? "::1" : h;
}

/** Read and validate the suite settings. Throws (never skips) when something is missing. */
export function readIntegrationEnv(env: NodeJS.ProcessEnv = process.env): IntegrationEnv {
  const host = assertLoopbackHost(env.MSSQL_IT_HOST ?? "127.0.0.1");

  const port = Number(env.MSSQL_IT_PORT ?? "1433");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`MSSQL_IT_PORT must be a TCP port, got "${env.MSSQL_IT_PORT}".`);
  }

  const adminUser = (env.MSSQL_IT_ADMIN_USER ?? "sa").trim();
  const adminPassword = env.MSSQL_IT_ADMIN_PASSWORD ?? env.MSSQL_SA_PASSWORD ?? "";
  if (adminUser.length === 0 || adminPassword.length === 0) {
    throw new Error(
      "Set MSSQL_IT_ADMIN_PASSWORD (or MSSQL_SA_PASSWORD) to the SA password of the " +
        "docker-compose container. It is only used to create and drop the throwaway database and logins."
    );
  }
  return { host, port, adminUser, adminPassword };
}

export interface ServerIdentity {
  machineName: string | null;
  edition: string | null;
  engineEdition: number | null;
  hostPlatform: string | null;
}

/** SQL that returns the ServerIdentity columns. Read-only, any login can run it. */
export const SERVER_IDENTITY_SQL = `
  SELECT
    CAST(SERVERPROPERTY('MachineName') AS nvarchar(128)) AS machineName,
    CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition,
    CAST(SERVERPROPERTY('EngineEdition') AS int) AS engineEdition,
    (SELECT TOP (1) host_platform FROM sys.dm_os_host_info) AS hostPlatform`;

export function assertThrowawayServer(id: ServerIdentity): void {
  const problems: string[] = [];
  if ((id.machineName ?? "").toLowerCase() !== EXPECTED_MACHINE_NAME) {
    problems.push(`MachineName is "${id.machineName}", expected "${EXPECTED_MACHINE_NAME}"`);
  }
  if (id.hostPlatform !== "Linux") {
    problems.push(`host platform is "${id.hostPlatform}", expected "Linux" (container)`);
  }
  // EngineEdition 3 = Enterprise/Developer/Evaluation, 4 = Express. Edition tells Developer apart.
  if (!/^(Developer|Express)/i.test(id.edition ?? "")) {
    problems.push(`edition is "${id.edition}", expected Developer or Express`);
  }
  if (problems.length > 0) {
    throw new Error(
      "Integration tests refuse to run: the server is not the throwaway docker-compose container (" +
        problems.join("; ") +
        "). Start it with `docker compose up -d --wait sqlserver`."
    );
  }
}

/** Replace every occurrence of the given secrets in a log/error text. */
export function maskSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length > 0) out = out.split(s).join("****");
  }
  return out;
}
