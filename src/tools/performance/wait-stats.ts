import type { AppConfig } from "../../config.js";
import { executeQuery } from "../../connection.js";
import { formatObjectList } from "../../utils/result-formatter.js";

export const waitStatsDefinition = {
  name: "get_wait_stats",
  description:
    "Get SQL Server wait statistics: shows what the server is spending time waiting on (I/O, locks, network, CPU, etc.). Critical for server-level performance tuning.",
  inputSchema: {
    type: "object" as const,
    properties: {
      top: {
        type: "number",
        description: "Number of top wait types to return (default: 20)",
        default: 20,
      },
    },
  },
};

export async function waitStatsHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const top = (args.top as number) || 20;

  const query = `
    SELECT TOP ${top}
      wait_type AS waitType,
      waiting_tasks_count AS waitingTasks,
      wait_time_ms AS totalWaitMs,
      max_wait_time_ms AS maxWaitMs,
      signal_wait_time_ms AS signalWaitMs,
      CAST(100.0 * wait_time_ms / SUM(wait_time_ms) OVER() AS DECIMAL(5,2)) AS pctOfTotal
    FROM sys.dm_os_wait_stats
    WHERE wait_type NOT IN (
      'CLR_SEMAPHORE','LAZYWRITER_SLEEP','RESOURCE_QUEUE','SQLTRACE_BUFFER_FLUSH',
      'SLEEP_TASK','SLEEP_SYSTEMTASK','WAITFOR','HADR_FILESTREAM_IOMGR_IOCOMPLETION',
      'CHECKPOINT_QUEUE','REQUEST_FOR_DEADLOCK_SEARCH','XE_TIMER_EVENT',
      'BROKER_TO_FLUSH','BROKER_TASK_STOP','CLR_MANUAL_EVENT','CLR_AUTO_EVENT',
      'DISPATCHER_QUEUE_SEMAPHORE','FT_IFTS_SCHEDULER_IDLE_WAIT','XE_DISPATCHER_WAIT',
      'XE_DISPATCHER_JOIN','BROKER_EVENTHANDLER','TRACEWRITE','FT_IFTSHC_MUTEX',
      'SQLTRACE_INCREMENTAL_FLUSH_SLEEP','ONDEMAND_TASK_QUEUE',
      'DBMIRROR_EVENTS_QUEUE','DBMIRRORING_CMD','BROKER_RECEIVE_WAITFOR',
      'DIRTY_PAGE_POLL','HADR_WORK_QUEUE','SP_SERVER_DIAGNOSTICS_SLEEP',
      'QDS_PERSIST_TASK_MAIN_LOOP_SLEEP','QDS_ASYNC_QUEUE',
      'QDS_CLEANUP_STALE_QUERIES_TASK_MAIN_LOOP_SLEEP',
      'WAIT_XTP_OFFLINE_CKPT_NEW_LOG'
    )
    AND waiting_tasks_count > 0
    ORDER BY wait_time_ms DESC`;

  const result = await executeQuery(config, query);
  return formatObjectList(result.recordset as Record<string, unknown>[], "Server Wait Statistics (Top Waits)");
}
