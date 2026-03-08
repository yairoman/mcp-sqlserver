import type { AppConfig } from "../../config.js";
import { executeQuery } from "../../connection.js";
import { formatObjectList } from "../../utils/result-formatter.js";

export const blockingChainsDefinition = {
  name: "get_blocking_chains",
  description:
    "Get current blocking chains on the SQL Server: shows which sessions are blocking others, the blocked queries, wait times, and the blocking query. Essential for troubleshooting deadlocks and lock contention.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

export async function blockingChainsHandler(
  config: AppConfig,
  _args: Record<string, unknown>
): Promise<string> {
  const query = `
    SELECT
      r.session_id AS blockedSessionId,
      r.blocking_session_id AS blockingSessionId,
      DB_NAME(r.database_id) AS databaseName,
      r.wait_type AS waitType,
      r.wait_time AS waitTimeMs,
      r.wait_resource AS waitResource,
      blocked_text.text AS blockedQuery,
      blocking_text.text AS blockingQuery,
      s_blocked.login_name AS blockedLogin,
      s_blocked.host_name AS blockedHost,
      s_blocking.login_name AS blockingLogin,
      s_blocking.host_name AS blockingHost
    FROM sys.dm_exec_requests r
    INNER JOIN sys.dm_exec_sessions s_blocked ON r.session_id = s_blocked.session_id
    LEFT JOIN sys.dm_exec_sessions s_blocking ON r.blocking_session_id = s_blocking.session_id
    OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) blocked_text
    LEFT JOIN sys.dm_exec_requests r_blocking ON r.blocking_session_id = r_blocking.session_id
    OUTER APPLY sys.dm_exec_sql_text(r_blocking.sql_handle) blocking_text
    WHERE r.blocking_session_id > 0
    ORDER BY r.wait_time DESC`;

  const result = await executeQuery(config, query);

  if (result.recordset.length === 0) {
    return "✅ **No blocking chains detected.** All sessions are running without contention.";
  }

  return formatObjectList(result.recordset as Record<string, unknown>[], "⚠️ Active Blocking Chains");
}
