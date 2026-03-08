import type { AppConfig } from "../../config.js";
import { executeQuery } from "../../connection.js";
import { formatObjectList } from "../../utils/result-formatter.js";

export const activeSessionsDefinition = {
  name: "get_active_sessions",
  description:
    "Get currently active sessions on the SQL Server: running queries, session status, wait types, CPU time, and memory usage. Useful for identifying long-running queries and resource-heavy sessions.",
  inputSchema: {
    type: "object" as const,
    properties: {
      includeIdle: {
        type: "boolean",
        description: "Include idle sessions (default: false)",
        default: false,
      },
    },
  },
};

export async function activeSessionsHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const includeIdle = args.includeIdle === true;

  const query = `
    SELECT
      s.session_id AS sessionId,
      s.login_name AS loginName,
      s.host_name AS hostName,
      DB_NAME(s.database_id) AS databaseName,
      s.status,
      s.cpu_time AS cpuTimeMs,
      s.memory_usage * 8 AS memoryKB,
      s.total_elapsed_time AS elapsedMs,
      r.command,
      r.wait_type AS waitType,
      r.wait_time AS waitTimeMs,
      r.blocking_session_id AS blockingSessionId,
      SUBSTRING(st.text, (r.statement_start_offset/2)+1,
        ((CASE r.statement_end_offset
          WHEN -1 THEN DATALENGTH(st.text)
          ELSE r.statement_end_offset
        END - r.statement_start_offset)/2) + 1) AS currentQuery
    FROM sys.dm_exec_sessions s
    LEFT JOIN sys.dm_exec_requests r ON s.session_id = r.session_id
    OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st
    WHERE s.is_user_process = 1
    ${includeIdle ? "" : "AND s.status != 'sleeping'"}
    ORDER BY s.cpu_time DESC`;

  const result = await executeQuery(config, query);
  return formatObjectList(result.recordset as Record<string, unknown>[], "Active Sessions");
}
