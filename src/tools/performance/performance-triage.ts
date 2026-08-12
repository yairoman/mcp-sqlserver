import type { AppConfig } from "../../config.js";
import { executeQuery } from "../../connection.js";
import { captureWaits, diffWaits, type WaitRow } from "./wait-stats.js";

const DEFAULT_SAMPLE_SECONDS = 30;

/**
 * Wait families, in the order a diagnosis should consider them. `test` runs
 * against the wait type name; first match wins, so order matters.
 */
const FAMILIES: Array<{
  name: string;
  test: (waitType: string) => boolean;
  meaning: string;
  nextStep: string;
}> = [
  {
    name: "Blocking",
    test: (w) => w.startsWith("LCK_M_"),
    meaning:
      "Sessions are waiting for locks held by other sessions. Nothing is slow — things are stopped.",
    nextStep:
      "`get_blocking_chains` for what is blocked right now, `get_blocking_history` for what already happened.",
  },
  {
    name: "Disk I/O",
    test: (w) =>
      w.startsWith("PAGEIOLATCH_") ||
      w === "WRITELOG" ||
      w === "IO_COMPLETION" ||
      w === "ASYNC_IO_COMPLETION" ||
      w === "BACKUPIO",
    meaning:
      "Time is going into reading or writing storage: either the queries read far more than they need, or the storage is slow.",
    nextStep:
      "`get_query_stats` sorted by logical reads, then `get_missing_indexes`. Fix the reads before blaming the disk.",
  },
  {
    name: "tempdb / latch contention",
    test: (w) => w.startsWith("PAGELATCH_") || w.startsWith("LATCH_"),
    meaning:
      "Contention on in-memory pages, typically tempdb allocation pages or a hot page in a small table.",
    nextStep:
      "`get_configuration_health` for the tempdb file count, and look for large `SELECT ... INTO #temp` in the hot procedures.",
  },
  {
    name: "Memory pressure",
    test: (w) => w.startsWith("RESOURCE_SEMAPHORE") || w === "CMEMTHREAD",
    meaning:
      "Queries are queuing for a memory grant before they can even start running.",
    nextStep:
      "Look for oversized sort/hash operators from bad row estimates, and check `max server memory` in `get_configuration_health`.",
  },
  {
    name: "Parallelism",
    test: (w) => w.startsWith("CXPACKET") || w.startsWith("CXCONSUMER") || w.startsWith("CXSYNC") || w.startsWith("EXCHANGE"),
    meaning:
      "Parallel threads waiting on each other. Often a symptom rather than a cause: a plan went parallel because a predicate is not sargable.",
    nextStep:
      "Check `cost threshold for parallelism` and MAXDOP, but look first for the query that should never have gone parallel.",
  },
  {
    name: "CPU pressure",
    test: (w) => w === "SOS_SCHEDULER_YIELD",
    meaning:
      "Tasks were ready to run and queued for a CPU slot. The work exists; there are not enough cores for it.",
    nextStep:
      "`get_query_stats` by CPU. Scalar functions and row-by-row logic are the usual cause — that is code, not hardware.",
  },
  {
    name: "Client / network",
    test: (w) => w === "ASYNC_NETWORK_IO",
    meaning:
      "SQL Server produced results faster than the client consumed them. Usually the application processing row by row, not the network.",
    nextStep:
      "Look at the application side: row-by-row cursors over a result set, or a client fetching far more rows than it displays.",
  },
  {
    name: "Availability groups",
    test: (w) => w.startsWith("HADR_") || w.startsWith("PREEMPTIVE_HADR"),
    meaning: "Synchronisation with Always On replicas.",
    nextStep:
      "Check replica health and redo queue before attributing this to the workload.",
  },
  {
    name: "System / external",
    test: (w) => w.startsWith("PREEMPTIVE_") || w === "MSQL_XP",
    meaning:
      "Calls that left the SQL Server scheduler for external code: Windows APIs, extended stored procedures, backup or antivirus agents.",
    nextStep:
      "Not the workload. Look at what external component is being called — backup software and extended procedures are the usual sources.",
  },
];

/**
 * Families that never constitute a finding on their own. A verdict that points
 * at these tells the reader nothing they can act on.
 */
const NON_ACTIONABLE = new Set(["System / external", "Other"]);

export const performanceTriageDefinition = {
  name: "get_performance_triage",
  description:
    "Triage server performance in one step: measure a live wait window, classify where the time actually goes, check whether anything is blocked right now, and return a verdict with the next tool to run. Answers 'is the server waiting or working, and on what?' — the question that has to be settled before looking at any individual query. Use as the first step when asked why a server or application is slow.",
  inputSchema: {
    type: "object" as const,
    properties: {
      sampleSeconds: {
        type: "number",
        description:
          "Length of the measured window in seconds (default: 30, max 60). Longer windows catch intermittent problems; shorter ones respond faster.",
        default: DEFAULT_SAMPLE_SECONDS,
      },
    },
  },
};

export async function performanceTriageHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const raw = Number(args.sampleSeconds);
  const sampleSeconds = Number.isFinite(raw)
    ? Math.min(Math.max(Math.trunc(raw), 5), 60)
    : DEFAULT_SAMPLE_SECONDS;

  const cores = await readCoreCount(config);

  const before = await captureWaits(config);
  const liveStart = await readLiveState(config);
  await sleep(sampleSeconds * 1000);
  const after = await captureWaits(config);
  const liveEnd = await readLiveState(config);

  const deltas = diffWaits(before, after).sort(
    (a, b) => b.totalWaitMs - a.totalWaitMs
  );
  const totalWaitMs = deltas.reduce((sum, r) => sum + r.totalWaitMs, 0);

  const byFamily = groupByFamily(deltas);
  const parts: string[] = [
    "# Performance Triage",
    "",
    `Measured window: **${sampleSeconds}s** · ${cores} cores · total wait recorded: **${totalWaitMs} ms**`,
    "",
  ];

  parts.push(verdict(byFamily, totalWaitMs, sampleSeconds, cores, liveStart, liveEnd));

  if (byFamily.length > 0) {
    parts.push("", "## Where the time went", "");
    parts.push("| Family | Wait ms | % of window | Top wait type |");
    parts.push("| --- | ---: | ---: | --- |");
    for (const f of byFamily) {
      parts.push(
        `| ${f.name} | ${f.totalWaitMs} | ${pct(f.totalWaitMs, totalWaitMs)}% | ${f.topWait} |`
      );
    }

    const leading = leadingActionable(byFamily);
    const family = leading && FAMILIES.find((f) => f.name === leading.name);
    if (leading && family) {
      const isTop = byFamily[0].name === leading.name;
      parts.push(
        "",
        `**${leading.name}${isTop ? " dominates" : " leads the actionable waits"}.** ${family.meaning}`,
        "",
        `**Next step:** ${family.nextStep}`
      );
    }
  }

  parts.push("", "## Live state", "");
  parts.push(
    `- Sessions blocked at start / end of window: **${liveStart.blocked}** / **${liveEnd.blocked}**`,
    `- Running requests at start / end: ${liveStart.running} / ${liveEnd.running}`,
    `- Longest running request: ${liveEnd.longestMs} ms — \`${liveEnd.longestCommand}\` (${liveEnd.longestStatus}) by ${liveEnd.longestLogin}`
  );

  if (liveEnd.longestMs > 300000) {
    parts.push(
      "",
      `ℹ️ That longest request has been alive for ${Math.round(liveEnd.longestMs / 60000)} minutes. Check the login and command before treating it as a stuck query — monitoring agents hold persistent connections and routinely show durations like this.`
    );
  }

  if (liveEnd.oldestOpenTranSeconds > 60) {
    parts.push(
      "",
      `⚠️ Oldest open transaction has been alive **${liveEnd.oldestOpenTranSeconds}s**. A long transaction holds its locks until it ends, whether or not it is doing anything — this is the classic sleeping head blocker.`
    );
  }

  parts.push(
    "",
    "---",
    "",
    "ℹ️ This measures a live window, so it only sees what happened during it. A quiet sample does not mean a healthy server — it means nothing was struggling *just now*. For problems that already happened, use `get_blocking_history` or Query Store.",
    "",
    "ℹ️ Waiting is not automatically bad: a server doing nothing also waits for nothing. Read these numbers against whether users are actually complaining."
  );

  return parts.join("\n");
}

interface LiveState {
  blocked: number;
  running: number;
  longestMs: number;
  longestCommand: string;
  longestLogin: string;
  longestStatus: string;
  oldestOpenTranSeconds: number;
}

async function readLiveState(config: AppConfig): Promise<LiveState> {
  const counts = await executeQuery(
    config,
    `SELECT
       (SELECT COUNT(*) FROM sys.dm_exec_requests WHERE blocking_session_id > 0) AS blocked,
       (SELECT COUNT(*) FROM sys.dm_exec_requests r
         INNER JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
        WHERE s.is_user_process = 1 AND r.session_id <> @@SPID) AS running,
       (SELECT ISNULL(MAX(DATEDIFF(second, dt.database_transaction_begin_time, GETDATE())), 0)
        FROM sys.dm_tran_database_transactions dt
        INNER JOIN sys.dm_tran_session_transactions st
          ON st.transaction_id = dt.transaction_id) AS oldestOpenTranSeconds`
  );
  const counted = counts.recordset[0] ?? {};

  // Reported with command, login and status rather than as a bare duration:
  // the longest-running request is very often a monitoring agent holding a
  // persistent connection, and a naked "3.6 hours" reads as a stuck query.
  const longest = await executeQuery(
    config,
    `SELECT TOP 1
       r.total_elapsed_time AS ms,
       r.command AS command,
       r.status AS status,
       s.login_name AS loginName
     FROM sys.dm_exec_requests r
     INNER JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
     WHERE s.is_user_process = 1 AND r.session_id <> @@SPID
     ORDER BY r.total_elapsed_time DESC`
  );
  const top = longest.recordset[0] ?? {};

  return {
    blocked: Number(counted.blocked ?? 0),
    running: Number(counted.running ?? 0),
    longestMs: Number(top.ms ?? 0),
    longestCommand: String(top.command ?? "none"),
    longestLogin: String(top.loginName ?? "none"),
    longestStatus: String(top.status ?? "none"),
    oldestOpenTranSeconds: Number(counted.oldestOpenTranSeconds ?? 0),
  };
}

async function readCoreCount(config: AppConfig): Promise<number> {
  const result = await executeQuery(
    config,
    `SELECT cpu_count AS cores FROM sys.dm_os_sys_info`
  );
  return Number(result.recordset[0]?.cores ?? 0);
}

interface FamilyTotal {
  name: string;
  totalWaitMs: number;
  topWait: string;
}

function groupByFamily(deltas: WaitRow[]): FamilyTotal[] {
  const totals = new Map<string, { ms: number; topWait: string; topMs: number }>();

  for (const row of deltas) {
    const family = FAMILIES.find((f) => f.test(row.waitType));
    const name = family?.name ?? "Other";
    const current = totals.get(name) ?? { ms: 0, topWait: row.waitType, topMs: 0 };
    current.ms += row.totalWaitMs;
    if (row.totalWaitMs > current.topMs) {
      current.topMs = row.totalWaitMs;
      current.topWait = row.waitType;
    }
    totals.set(name, current);
  }

  return [...totals.entries()]
    .map(([name, v]) => ({ name, totalWaitMs: v.ms, topWait: v.topWait }))
    .sort((a, b) => b.totalWaitMs - a.totalWaitMs);
}

/**
 * The verdict has to survive the case where nothing is wrong. Reporting a
 * dominant wait family on an idle instance is how these reports become noise.
 */
function verdict(
  byFamily: FamilyTotal[],
  totalWaitMs: number,
  sampleSeconds: number,
  cores: number,
  start: LiveState,
  end: LiveState
): string {
  const capacityMs = sampleSeconds * 1000 * Math.max(cores, 1);
  const share = capacityMs > 0 ? (totalWaitMs / capacityMs) * 100 : 0;

  if (start.blocked > 0 || end.blocked > 0) {
    return `## Verdict\n\n🔴 **Blocking is happening right now** (${Math.max(start.blocked, end.blocked)} blocked session(s)). Start there — everything else in this report is secondary until the blocking chain is resolved. Run \`get_blocking_chains\`.`;
  }

  if (totalWaitMs === 0 || byFamily.length === 0) {
    return "## Verdict\n\n🟢 **Nothing waited during the window.** Either the instance is idle or its work is completing without contention. If users are reporting slowness right now, the cause is not on this server — or it is intermittent and needs a longer sample.";
  }

  const leading = leadingActionable(byFamily);
  const describe = leading
    ? `${leading.name} (${pct(leading.totalWaitMs, totalWaitMs)}%)`
    : "nothing the workload can act on — all of it is system or external calls";

  if (share < 1) {
    return `## Verdict\n\n🟢 **The server is essentially idle.** Waits add up to ${totalWaitMs} ms against roughly ${capacityMs} ms of core time in the window — under 1%. Leading contributor: ${describe}, which at this volume is background noise, not a finding.`;
  }

  if (share < 15) {
    return `## Verdict\n\n🟡 **Light load, no contention worth acting on.** Waits are about ${share.toFixed(1)}% of available core time. Leading contributor: ${describe}. Worth noting, not worth a change.`;
  }

  return `## Verdict\n\n🔴 **The server spends significant time waiting** — roughly ${share.toFixed(1)}% of available core time in the window. Leading contributor: ${describe}. This is where the investigation goes.`;
}

/** The highest-ranked family the reader can actually do something about. */
function leadingActionable(byFamily: FamilyTotal[]): FamilyTotal | undefined {
  return byFamily.find((f) => !NON_ACTIONABLE.has(f.name));
}

function pct(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((value / total) * 10000) / 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
