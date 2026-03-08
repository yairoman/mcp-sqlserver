import type { AppConfig } from "../config.js";
import { executeQuery } from "../connection.js";

export const serverInfoUri = "sqlserver://server-info";
export const serverInfoDefinition = {
  uri: serverInfoUri,
  name: "SQL Server Info",
  description:
    "SQL Server instance information: version, edition, collation, configuration, and server-level settings.",
  mimeType: "text/markdown",
};

export async function getServerInfo(config: AppConfig): Promise<string> {
  const versionResult = await executeQuery(
    config,
    `SELECT
      SERVERPROPERTY('ProductVersion') AS version,
      SERVERPROPERTY('ProductLevel') AS productLevel,
      SERVERPROPERTY('Edition') AS edition,
      SERVERPROPERTY('EngineEdition') AS engineEdition,
      SERVERPROPERTY('ServerName') AS serverName,
      SERVERPROPERTY('MachineName') AS machineName,
      SERVERPROPERTY('Collation') AS collation,
      SERVERPROPERTY('IsClustered') AS isClustered,
      SERVERPROPERTY('IsHadrEnabled') AS isAlwaysOn,
      @@VERSION AS fullVersion`
  );

  const v = versionResult.recordset[0] as Record<string, unknown>;

  // Get database count
  const dbCount = await executeQuery(
    config,
    `SELECT COUNT(*) AS count FROM sys.databases`
  );
  const totalDbs = (dbCount.recordset[0] as Record<string, unknown>).count;

  // Get uptime
  const uptimeResult = await executeQuery(
    config,
    `SELECT sqlserver_start_time AS startTime, DATEDIFF(HOUR, sqlserver_start_time, GETDATE()) AS uptimeHours FROM sys.dm_os_sys_info`
  );
  const uptime = uptimeResult.recordset[0] as Record<string, unknown>;

  // Get memory
  const memResult = await executeQuery(
    config,
    `SELECT
      physical_memory_kb / 1024 AS physicalMemoryMB,
      committed_kb / 1024 AS committedMemoryMB,
      committed_target_kb / 1024 AS targetMemoryMB
    FROM sys.dm_os_sys_info`
  );
  const mem = memResult.recordset[0] as Record<string, unknown>;

  const parts = [
    `# SQL Server Instance Info`,
    "",
    `| Property | Value |`,
    `|---|---|`,
    `| **Server Name** | ${v.serverName} |`,
    `| **Version** | ${v.version} (${v.productLevel}) |`,
    `| **Edition** | ${v.edition} |`,
    `| **Collation** | ${v.collation} |`,
    `| **Clustered** | ${v.isClustered ? "Yes" : "No"} |`,
    `| **Always On** | ${v.isAlwaysOn ? "Yes" : "No"} |`,
    `| **Databases** | ${totalDbs} |`,
    `| **Uptime** | ${uptime.uptimeHours} hours (since ${uptime.startTime}) |`,
    `| **Physical Memory** | ${mem.physicalMemoryMB} MB |`,
    `| **Committed Memory** | ${mem.committedMemoryMB} MB |`,
    `| **Target Memory** | ${mem.targetMemoryMB} MB |`,
    "",
    `## Full Version String`,
    "```",
    String(v.fullVersion),
    "```",
    "",
    `## MCP Server Config`,
    `- **Read-Only Mode**: ${config.readOnly ? "✅ Enabled" : "⚠️ Disabled (write queries allowed)"}`,
    `- **Max Rows**: ${config.maxRows}`,
    `- **Query Timeout**: ${config.queryTimeout}ms`,
    `- **Connection**: ${config.host}:${config.port}`,
  ];

  return parts.join("\n");
}
