import type { AppConfig } from "../../config.js";
import { executeQuery, executeQueryOnDatabase } from "../../connection.js";
import { formatObjectList } from "../../utils/result-formatter.js";

/**
 * Databases per UNION ALL batch. The MCP query timeout is 30s and each
 * cross-database Query Store read costs ~100ms, so batches keep a wide
 * instance (50+ databases) from timing out on a single round trip.
 */
const DB_BATCH_SIZE = 8;

export const blockingHistoryDefinition = {
  name: "get_blocking_history",
  description:
    "Get HISTORICAL lock blocking from Query Store: which queries waited on locks, for how long, when, and whether they were aborted. Use this to answer 'did the server have blocking today?' — unlike get_blocking_chains, which only sees blocking happening right now. Without a database argument it sweeps every Query Store enabled database and returns a per-database summary; with one it returns the individual queries that waited.",
  inputSchema: {
    type: "object" as const,
    properties: {
      hours: {
        type: "number",
        description: "How many hours back to look (default: 24)",
        default: 24,
      },
      database: {
        type: "string",
        description:
          "Drill into a single database and list the queries that waited. Omit to sweep all databases and get a summary.",
      },
      minWaitMs: {
        type: "number",
        description:
          "Ignore anything that waited less than this, in milliseconds (default: 1000)",
        default: 1000,
      },
      top: {
        type: "number",
        description: "Max rows in single-database mode (default: 20)",
        default: 20,
      },
    },
  },
};

export async function blockingHistoryHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const hours = clamp(args.hours, 24, 1, 24 * 90);
  const minWaitMs = clamp(args.minWaitMs, 1000, 0, 86_400_000);
  const top = clamp(args.top, 20, 1, 200);
  const database =
    typeof args.database === "string" && args.database.trim().length > 0
      ? args.database.trim()
      : null;

  return database
    ? singleDatabase(config, database, hours, minWaitMs, top)
    : sweepAllDatabases(config, hours, minWaitMs);
}

/**
 * Per-database summary across every Query Store enabled database.
 */
async function sweepAllDatabases(
  config: AppConfig,
  hours: number,
  minWaitMs: number
): Promise<string> {
  const dbResult = await executeQuery(
    config,
    `SELECT name
     FROM sys.databases
     WHERE is_query_store_on = 1 AND state = 0
     ORDER BY name`
  );

  const databases = dbResult.recordset.map((r) => String(r.name));
  if (databases.length === 0) {
    return "**Blocking History**: _No database has Query Store enabled — there is no historical source to read. Blocking cannot be reconstructed for the past; only `get_blocking_chains` (live) is available._";
  }

  const rows: Record<string, unknown>[] = [];
  for (const batch of chunk(databases, DB_BATCH_SIZE)) {
    const unionAll = batch
      .map((db) => summaryQueryFor(db, hours))
      .join("\n    UNION ALL\n");
    const result = await executeQuery(config, unionAll);
    rows.push(...(result.recordset as Record<string, unknown>[]));
  }

  const withBlocking = rows
    .filter((r) => Number(r.lockWaitMs ?? 0) >= minWaitMs)
    .sort((a, b) => Number(b.lockWaitMs ?? 0) - Number(a.lockWaitMs ?? 0));

  const coverage = await describeCoverage(config, databases);

  if (withBlocking.length === 0) {
    return [
      `**Blocking History** — last ${hours}h: _no database recorded lock waits above ${minWaitMs}ms._`,
      "",
      coverage,
    ].join("\n");
  }

  return [
    formatObjectList(
      withBlocking,
      `Lock Blocking by Database (last ${hours}h, over ${minWaitMs}ms)`
    ),
    "",
    `Drill in with \`get_blocking_history\` and \`database: "${String(withBlocking[0].databaseName)}"\`.`,
    "",
    coverage,
  ].join("\n");
}

/**
 * The queries that actually waited, inside one database.
 */
async function singleDatabase(
  config: AppConfig,
  database: string,
  hours: number,
  minWaitMs: number,
  top: number
): Promise<string> {
  const query = `
    SELECT TOP ${top}
      rsi.start_time AS intervalStartUtc,
      ws.total_query_wait_time_ms AS lockWaitMs,
      ws.max_query_wait_time_ms AS maxSingleWaitMs,
      ws.execution_type_desc AS executionType,
      q.query_id AS queryId,
      OBJECT_NAME(q.object_id) AS objectName,
      SUBSTRING(qt.query_sql_text, 1, 200) AS queryText
    FROM sys.query_store_wait_stats ws
    INNER JOIN sys.query_store_runtime_stats_interval rsi
      ON rsi.runtime_stats_interval_id = ws.runtime_stats_interval_id
    INNER JOIN sys.query_store_plan p ON p.plan_id = ws.plan_id
    INNER JOIN sys.query_store_query q ON q.query_id = p.query_id
    INNER JOIN sys.query_store_query_text qt ON qt.query_text_id = q.query_text_id
    WHERE ws.wait_category_desc = 'Lock'
      AND rsi.start_time >= DATEADD(hour, -${hours}, SYSDATETIMEOFFSET())
      AND ws.total_query_wait_time_ms >= ${minWaitMs}
    ORDER BY ws.total_query_wait_time_ms DESC`;

  const result = await executeQueryOnDatabase(config, database, query);
  const rows = result.recordset as Record<string, unknown>[];

  if (rows.length === 0) {
    return `**Blocking History — ${database}**: _no query waited on locks for more than ${minWaitMs}ms in the last ${hours}h._\n\n${LIMITATION_NOTE}`;
  }

  const aborted = rows.filter((r) => r.executionType === "Aborted").length;
  const parts = [
    formatObjectList(
      rows,
      `Queries Blocked in ${database} (last ${hours}h, over ${minWaitMs}ms)`
    ),
  ];

  if (aborted > 0) {
    parts.push(
      `\n⚠️ ${aborted} of these ended as **Aborted** — the session died (client timeout or cancellation) while still waiting on the lock.`
    );
  }

  parts.push(`\n${LIMITATION_NOTE}`);
  return parts.join("\n");
}

/**
 * One aggregate row per database. No GROUP BY: the literal database name is a
 * constant, so a bare HAVING-less aggregate always yields exactly one row,
 * which keeps databases with zero blocking visible in the result.
 */
function summaryQueryFor(database: string, hours: number): string {
  const db = quoteIdent(database);
  return `SELECT ${quoteLiteral(database)} AS databaseName,
      ISNULL(SUM(ws.total_query_wait_time_ms), 0) AS lockWaitMs,
      ISNULL(MAX(ws.max_query_wait_time_ms), 0) AS maxSingleWaitMs,
      COUNT(DISTINCT p.query_id) AS affectedQueries,
      MAX(rsi.start_time) AS lastIntervalStartUtc
    FROM ${db}.sys.query_store_wait_stats ws
    INNER JOIN ${db}.sys.query_store_runtime_stats_interval rsi
      ON rsi.runtime_stats_interval_id = ws.runtime_stats_interval_id
    INNER JOIN ${db}.sys.query_store_plan p ON p.plan_id = ws.plan_id
    WHERE ws.wait_category_desc = 'Lock'
      AND rsi.start_time >= DATEADD(hour, -${hours}, SYSDATETIMEOFFSET())`;
}

/**
 * What the numbers above can and cannot prove. A silent zero is worse than no
 * answer: Query Store in AUTO mode drops trivial queries, READ_ONLY databases
 * record nothing new, and without the blocked process report there is no
 * blocker-to-blocked chain at all.
 */
async function describeCoverage(
  config: AppConfig,
  databases: string[]
): Promise<string> {
  const notes: string[] = ["**Coverage** — read this before concluding 'no blocking':"];

  const optionRows: Record<string, unknown>[] = [];
  for (const batch of chunk(databases, DB_BATCH_SIZE)) {
    const unionAll = batch
      .map(
        (db) =>
          `SELECT ${quoteLiteral(db)} AS databaseName, actual_state_desc, query_capture_mode_desc, wait_stats_capture_mode_desc
           FROM ${quoteIdent(db)}.sys.database_query_store_options`
      )
      .join("\n    UNION ALL\n");
    const result = await executeQuery(config, unionAll);
    optionRows.push(...(result.recordset as Record<string, unknown>[]));
  }

  const readOnly = optionRows.filter((r) => r.actual_state_desc === "READ_ONLY");
  const autoCapture = optionRows.filter((r) => r.query_capture_mode_desc === "AUTO");
  const waitsOff = optionRows.filter((r) => r.wait_stats_capture_mode_desc !== "ON");

  notes.push(`- ${databases.length} database(s) with Query Store enabled.`);

  if (readOnly.length > 0) {
    notes.push(
      `- ⚠️ ${readOnly.length} in READ_ONLY (${readOnly.map((r) => r.databaseName).join(", ")}) — historical data only, nothing new is being recorded.`
    );
  }
  if (waitsOff.length > 0) {
    notes.push(
      `- ⚠️ ${waitsOff.length} with wait stats capture OFF (${waitsOff.map((r) => r.databaseName).join(", ")}) — lock waits are NOT recorded there at all.`
    );
  }
  if (autoCapture.length > 0) {
    notes.push(
      `- ${autoCapture.length} in AUTO capture mode — infrequent or trivial queries are never captured, so they cannot appear here even if they blocked.`
    );
  }

  const bptResult = await executeQuery(
    config,
    `SELECT CAST(value_in_use AS int) AS threshold
     FROM sys.configurations
     WHERE name = 'blocked process threshold (s)'`
  );
  const threshold = Number(bptResult.recordset[0]?.threshold ?? 0);
  if (threshold === 0) {
    notes.push(
      "- ⚠️ `blocked process threshold (s)` is 0: the blocked process report is OFF. Set it (15–20s) plus an Extended Events session to capture the blocker-to-blocked chain."
    );
  }

  notes.push(`\n${LIMITATION_NOTE}`);
  return notes.join("\n");
}

const LIMITATION_NOTE =
  "ℹ️ Query Store records who **waited**, never who **held** the lock. Identifying the head blocker from this data is inference from timing, not proof — the blocked process report is what names it.";

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/** Escape a SQL identifier for use inside brackets. Preserves hyphens. */
function quoteIdent(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}

/** Escape a value for use as a SQL string literal. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
