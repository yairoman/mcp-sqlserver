import type { AppConfig } from "../../config.js";
import { executeQuery } from "../../connection.js";
import { formatObjectList } from "../../utils/result-formatter.js";

export const queryStatsDefinition = {
  name: "get_query_stats",
  description:
    "Get top queries by CPU time, duration, or logical reads from the SQL Server plan cache. Identifies the most expensive queries on the server.",
  inputSchema: {
    type: "object" as const,
    properties: {
      sortBy: {
        type: "string",
        enum: ["cpu", "duration", "reads", "executions"],
        description: "Sort queries by: cpu, duration, reads, or executions (default: cpu)",
        default: "cpu",
      },
      top: {
        type: "number",
        description: "Number of top queries to return (default: 20)",
        default: 20,
      },
    },
  },
};

export async function queryStatsHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const sortBy = (args.sortBy as string) || "cpu";
  const top = (args.top as number) || 20;

  const sortColumn: Record<string, string> = {
    cpu: "qs.total_worker_time",
    duration: "qs.total_elapsed_time",
    reads: "qs.total_logical_reads",
    executions: "qs.execution_count",
  };

  const orderCol = sortColumn[sortBy] || sortColumn.cpu;

  const query = `
    SELECT TOP ${top}
      DB_NAME(st.dbid) AS databaseName,
      SUBSTRING(st.text, (qs.statement_start_offset/2)+1,
        ((CASE qs.statement_end_offset
          WHEN -1 THEN DATALENGTH(st.text)
          ELSE qs.statement_end_offset
        END - qs.statement_start_offset)/2) + 1) AS queryText,
      qs.execution_count AS executions,
      CAST(qs.total_worker_time / 1000.0 AS DECIMAL(18,2)) AS totalCpuMs,
      CAST(qs.total_worker_time / 1000.0 / NULLIF(qs.execution_count, 0) AS DECIMAL(18,2)) AS avgCpuMs,
      CAST(qs.total_elapsed_time / 1000.0 AS DECIMAL(18,2)) AS totalDurationMs,
      CAST(qs.total_elapsed_time / 1000.0 / NULLIF(qs.execution_count, 0) AS DECIMAL(18,2)) AS avgDurationMs,
      qs.total_logical_reads AS totalReads,
      qs.total_logical_reads / NULLIF(qs.execution_count, 0) AS avgReads,
      qs.total_logical_writes AS totalWrites,
      qs.creation_time AS planCreated,
      qs.last_execution_time AS lastExecution
    FROM sys.dm_exec_query_stats qs
    CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
    WHERE st.dbid IS NOT NULL
    ORDER BY ${orderCol} DESC`;

  const result = await executeQuery(config, query);
  return formatObjectList(
    result.recordset as Record<string, unknown>[],
    `Top Queries by ${sortBy.toUpperCase()}`
  );
}
