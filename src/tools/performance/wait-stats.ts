import type { AppConfig } from "../../config.js";
import { executeQuery } from "../../connection.js";
import { formatObjectList } from "../../utils/result-formatter.js";

/**
 * Waits that are always present and mean nothing: idle worker threads,
 * background queues, timers. Left in, they drown the signal — on an idle
 * instance SOS_WORK_DISPATCHER alone can be 76% of all accumulated wait time.
 */
const BENIGN_WAITS = [
  "CLR_SEMAPHORE", "LAZYWRITER_SLEEP", "RESOURCE_QUEUE", "SQLTRACE_BUFFER_FLUSH",
  "SLEEP_TASK", "SLEEP_SYSTEMTASK", "WAITFOR", "HADR_FILESTREAM_IOMGR_IOCOMPLETION",
  "CHECKPOINT_QUEUE", "REQUEST_FOR_DEADLOCK_SEARCH", "XE_TIMER_EVENT",
  "BROKER_TO_FLUSH", "BROKER_TASK_STOP", "CLR_MANUAL_EVENT", "CLR_AUTO_EVENT",
  "DISPATCHER_QUEUE_SEMAPHORE", "FT_IFTS_SCHEDULER_IDLE_WAIT", "XE_DISPATCHER_WAIT",
  "XE_DISPATCHER_JOIN", "BROKER_EVENTHANDLER", "TRACEWRITE", "FT_IFTSHC_MUTEX",
  "SQLTRACE_INCREMENTAL_FLUSH_SLEEP", "ONDEMAND_TASK_QUEUE",
  "DBMIRROR_EVENTS_QUEUE", "DBMIRRORING_CMD", "BROKER_RECEIVE_WAITFOR",
  "DIRTY_PAGE_POLL", "HADR_WORK_QUEUE", "SP_SERVER_DIAGNOSTICS_SLEEP",
  "QDS_PERSIST_TASK_MAIN_LOOP_SLEEP", "QDS_ASYNC_QUEUE",
  "QDS_CLEANUP_STALE_QUERIES_TASK_MAIN_LOOP_SLEEP",
  "WAIT_XTP_OFFLINE_CKPT_NEW_LOG", "SOS_WORK_DISPATCHER", "VDI_CLIENT_OTHER",
  "PREEMPTIVE_XE_GETTARGETSTATE", "PARALLEL_REDO_DRAIN_WORKER",
  "PARALLEL_REDO_LOG_CACHE", "PARALLEL_REDO_TRAN_LIST",
  "PARALLEL_REDO_WORKER_SYNC", "PARALLEL_REDO_WORKER_WAIT_WORK",
  "HADR_LOGCAPTURE_WAIT", "HADR_NOTIFICATION_DEQUEUE", "HADR_TIMER_TASK",
  "HADR_CLUSAPI_CALL", "LOGMGR_QUEUE", "BROKER_TRANSMITTER",
  // Bookkeeping noise: huge task counts, negligible time, never actionable.
  // MEMORY_ALLOCATION_EXT alone can log ~29k tasks for 68ms in a 20s window.
  "MEMORY_ALLOCATION_EXT", "UCS_SESSION_REGISTRATION",
  // Calls that leave the SQL Server scheduler for a Windows API (file handles,
  // authentication, registry, crypto). They are the OS working on SQL Server's
  // behalf, not the workload contending for a resource — but they accumulate
  // enough milliseconds to dominate a short window and bury the real signal.
  "PREEMPTIVE_OS_DEVICEOPS", "PREEMPTIVE_OS_AUTHENTICATIONOPS",
  "PREEMPTIVE_OS_CRYPTOPS", "PREEMPTIVE_OS_QUERYREGISTRY",
  "PREEMPTIVE_OS_FILEOPS", "PREEMPTIVE_OS_GETPROCADDRESS",
  "PREEMPTIVE_OS_LOOKUPACCOUNTSID", "PREEMPTIVE_OS_WAITFORSINGLEOBJECT",
];

const BENIGN_LIST = BENIGN_WAITS.map((w) => `'${w}'`).join(",");

export interface WaitRow {
  waitType: string;
  waitingTasks: number;
  totalWaitMs: number;
  maxWaitMs: number;
  signalWaitMs: number;
}

export const waitStatsDefinition = {
  name: "get_wait_stats",
  description:
    "Get SQL Server wait statistics: what the server spends time waiting on (I/O, locks, network, CPU). By default these are cumulative since the last restart, which is useless for diagnosing what is happening NOW — on an instance with days of uptime a whole bad afternoon is diluted into noise. Pass sampleSeconds to take two snapshots and subtract them, which shows only the waits that happened during that window.",
  inputSchema: {
    type: "object" as const,
    properties: {
      top: {
        type: "number",
        description: "Number of top wait types to return (default: 20)",
        default: 20,
      },
      sampleSeconds: {
        type: "number",
        description:
          "Measure a live window instead of the cumulative total: take a snapshot, wait this many seconds, take another, and report the difference. Recommended 20-30 to diagnose current behaviour. Default 0 = cumulative since restart.",
        default: 0,
      },
    },
  },
};

export async function waitStatsHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const top = Math.max(1, Number(args.top) || 20);
  const rawSample = Number(args.sampleSeconds);
  const sampleSeconds = Number.isFinite(rawSample)
    ? Math.min(Math.max(Math.trunc(rawSample), 0), 60)
    : 0;

  if (sampleSeconds <= 0) {
    const rows = await captureWaits(config);
    const sorted = [...rows.values()]
      .sort((a, b) => b.totalWaitMs - a.totalWaitMs)
      .slice(0, top);
    const total = sorted.reduce((sum, r) => sum + r.totalWaitMs, 0);

    return [
      formatObjectList(
        sorted.map((r) => ({ ...r, pctOfTotal: pct(r.totalWaitMs, total) })),
        "Server Wait Statistics (cumulative since restart)"
      ),
      "",
      "⚠️ These totals accumulate since the last service restart, so they describe the average of that whole period — not what is happening now. To diagnose a live problem, call again with `sampleSeconds: 30`.",
    ].join("\n");
  }

  const before = await captureWaits(config);
  await sleep(sampleSeconds * 1000);
  const after = await captureWaits(config);

  const deltas = diffWaits(before, after)
    .sort((a, b) => b.totalWaitMs - a.totalWaitMs)
    .slice(0, top);

  if (deltas.length === 0) {
    return `**Wait Statistics — ${sampleSeconds}s window**: _no meaningful waits recorded. The instance was idle, or its work did not have to wait for anything._`;
  }

  const total = deltas.reduce((sum, r) => sum + r.totalWaitMs, 0);

  return [
    formatObjectList(
      deltas.map((r) => ({
        waitType: r.waitType,
        waitingTasks: r.waitingTasks,
        totalWaitMs: r.totalWaitMs,
        signalWaitMs: r.signalWaitMs,
        pctOfWindow: pct(r.totalWaitMs, total),
      })),
      `Wait Statistics — measured over a ${sampleSeconds}s window`
    ),
    "",
    `Total wait in window: ${total} ms. \`maxWaitMs\` is omitted deliberately: a maximum cannot be subtracted between snapshots.`,
    "",
    "ℹ️ `signalWaitMs` is time the task was already runnable and just waiting for a CPU slot. A high share of signal means CPU pressure, not I/O or locks.",
  ].join("\n");
}

/**
 * One snapshot of sys.dm_os_wait_stats, keyed by wait type.
 */
export async function captureWaits(
  config: AppConfig
): Promise<Map<string, WaitRow>> {
  const result = await executeQuery(
    config,
    `SELECT wait_type AS waitType,
            waiting_tasks_count AS waitingTasks,
            wait_time_ms AS totalWaitMs,
            max_wait_time_ms AS maxWaitMs,
            signal_wait_time_ms AS signalWaitMs
     FROM sys.dm_os_wait_stats
     WHERE wait_type NOT IN (${BENIGN_LIST})
       AND waiting_tasks_count > 0`
  );

  const map = new Map<string, WaitRow>();
  for (const r of result.recordset) {
    map.set(String(r.waitType), {
      waitType: String(r.waitType),
      waitingTasks: Number(r.waitingTasks),
      totalWaitMs: Number(r.totalWaitMs),
      maxWaitMs: Number(r.maxWaitMs),
      signalWaitMs: Number(r.signalWaitMs),
    });
  }
  return map;
}

/**
 * Subtract two snapshots, keeping only waits that actually moved.
 * A wait type missing from `before` is new and counts in full.
 */
export function diffWaits(
  before: Map<string, WaitRow>,
  after: Map<string, WaitRow>
): WaitRow[] {
  const out: WaitRow[] = [];
  for (const [waitType, now] of after) {
    const prev = before.get(waitType);
    const delta: WaitRow = {
      waitType,
      waitingTasks: now.waitingTasks - (prev?.waitingTasks ?? 0),
      totalWaitMs: now.totalWaitMs - (prev?.totalWaitMs ?? 0),
      maxWaitMs: now.maxWaitMs,
      signalWaitMs: now.signalWaitMs - (prev?.signalWaitMs ?? 0),
    };
    // A negative delta means the DMV was cleared mid-sample; drop it rather
    // than report a nonsensical number.
    if (delta.totalWaitMs > 0 && delta.waitingTasks >= 0) {
      out.push(delta);
    }
  }
  return out;
}

function pct(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((value / total) * 10000) / 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
