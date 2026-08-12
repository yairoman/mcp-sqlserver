import type { AppConfig } from "../../config.js";
import { executeQuery } from "../../connection.js";

/**
 * Databases per UNION ALL batch, to stay inside the 30s query timeout.
 */
const DB_BATCH_SIZE = 8;

/** Change Tracking retention at or above this many days is almost always an unmade decision. */
const CT_RETENTION_WARN_DAYS = 90;

type Severity = "critical" | "warning" | "info";

/**
 * Why a setting matters. Callers triage by this, not by the setting's name:
 * a stability finding outranks a performance one even if the latter is louder.
 */
type Category = "Stability" | "Diagnosability" | "Performance" | "Integrity";

interface Finding {
  severity: Severity;
  category: Category;
  check: string;
  current: string;
  recommended: string;
  why: string;
}

export const configurationHealthDefinition = {
  name: "get_configuration_health",
  description:
    "Audit SQL Server instance and database configuration against known-good values, and return a judged list of findings — not raw settings. Checks memory, MAXDOP, parallelism threshold, tempdb file layout, compatibility level against the actual engine version, RCSI, auto_shrink/auto_close/page_verify, Change Tracking retention, Query Store state, and whether blocking can be diagnosed at all. Use when asked what configuration a server should have, whether it is well tuned, or as the first step of a performance audit.",
  inputSchema: {
    type: "object" as const,
    properties: {
      includeHealthy: {
        type: "boolean",
        description:
          "Also list the checks that passed, to show what was verified (default: false)",
        default: false,
      },
    },
  },
};

export async function configurationHealthHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const includeHealthy = args.includeHealthy === true;

  const findings: Finding[] = [];
  const passed: string[] = [];

  const context = await readServerContext(config);

  checkInstanceSettings(context, findings, passed);
  await checkTempdb(config, context, findings, passed);
  await checkDatabaseSettings(config, context, findings, passed);
  await checkChangeTracking(config, findings, passed);
  await checkDiagnosability(config, findings, passed);

  return render(context, findings, passed, includeHealthy);
}

interface ServerContext {
  cores: number;
  memoryMb: number;
  majorVersion: number;
  productVersion: string;
  edition: string;
  alwaysOn: boolean;
  settings: Map<string, number>;
}

async function readServerContext(config: AppConfig): Promise<ServerContext> {
  const result = await executeQuery(
    config,
    `SELECT
       si.cpu_count AS cores,
       si.physical_memory_kb / 1024 AS memoryMb,
       CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS majorVersion,
       CAST(SERVERPROPERTY('ProductVersion') AS varchar(50)) AS productVersion,
       CAST(SERVERPROPERTY('Edition') AS varchar(100)) AS edition,
       CAST(SERVERPROPERTY('IsHadrEnabled') AS int) AS alwaysOn
     FROM sys.dm_os_sys_info si`
  );
  const row = result.recordset[0] ?? {};

  const settingsResult = await executeQuery(
    config,
    `SELECT name, CAST(value_in_use AS bigint) AS value
     FROM sys.configurations
     WHERE name IN (
       'max server memory (MB)', 'max degree of parallelism',
       'cost threshold for parallelism', 'blocked process threshold (s)',
       'optimize for ad hoc workloads', 'remote admin connections',
       'priority boost'
     )`
  );

  const settings = new Map<string, number>();
  for (const r of settingsResult.recordset) {
    settings.set(String(r.name), Number(r.value));
  }

  return {
    cores: Number(row.cores ?? 0),
    memoryMb: Number(row.memoryMb ?? 0),
    majorVersion: Number(row.majorVersion ?? 0),
    productVersion: String(row.productVersion ?? "unknown"),
    edition: String(row.edition ?? "unknown"),
    alwaysOn: Number(row.alwaysOn ?? 0) === 1,
    settings,
  };
}

function checkInstanceSettings(
  ctx: ServerContext,
  findings: Finding[],
  passed: string[]
): void {
  const maxMemory = ctx.settings.get("max server memory (MB)") ?? 0;
  // 2147483647 is the factory default: no cap at all.
  if (maxMemory >= 2147483647) {
    const reserve = Math.max(4096, Math.round(ctx.memoryMb * 0.1));
    const suggested = Math.max(1024, ctx.memoryMb - reserve);
    findings.push({
      severity: "critical",
      category: "Stability",
      check: "max server memory",
      current: "unlimited (factory default)",
      recommended: `~${suggested} MB (of ${ctx.memoryMb} MB physical)`,
      why: `SQL Server can claim all ${ctx.memoryMb} MB and starve the OS${ctx.alwaysOn ? ", and this instance runs Always On, whose threads need memory outside the buffer pool" : ""}. Fails as instability, not slowness.`,
    });
  } else {
    passed.push(`max server memory capped at ${maxMemory} MB`);
  }

  const maxdop = ctx.settings.get("max degree of parallelism") ?? 0;
  const suggestedMaxdop = ctx.cores <= 8 ? Math.max(1, ctx.cores / 2) : 8;
  if (maxdop === 0 && ctx.cores > 1) {
    findings.push({
      severity: "warning",
      category: "Performance",
      check: "max degree of parallelism",
      current: "0 (unlimited)",
      recommended: String(suggestedMaxdop),
      why: `A single query can seize all ${ctx.cores} schedulers, so one heavy statement stalls everything else.`,
    });
  } else {
    passed.push(`MAXDOP = ${maxdop} on ${ctx.cores} cores`);
  }

  const costThreshold = ctx.settings.get("cost threshold for parallelism") ?? 0;
  if (costThreshold <= 5) {
    findings.push({
      severity: "warning",
      category: "Performance",
      check: "cost threshold for parallelism",
      current: String(costThreshold),
      recommended: "~50",
      why: "The default of 5 dates from 1998 and parallelizes trivial queries, whose coordination costs more than the work itself.",
    });
  } else {
    passed.push(`cost threshold for parallelism = ${costThreshold}`);
  }

  if ((ctx.settings.get("optimize for ad hoc workloads") ?? 0) === 0) {
    findings.push({
      severity: "info",
      category: "Performance",
      check: "optimize for ad hoc workloads",
      current: "0 (off)",
      recommended: "1",
      why: "Single-use plans accumulate in the cache and evict the ones that get reused.",
    });
  } else {
    passed.push("optimize for ad hoc workloads is on");
  }

  if ((ctx.settings.get("priority boost") ?? 0) === 1) {
    findings.push({
      severity: "critical",
      category: "Stability",
      check: "priority boost",
      current: "1 (on)",
      recommended: "0",
      why: "Starves OS threads, can break cluster failover, and is deprecated. Never leave it on.",
    });
  }

  if ((ctx.settings.get("remote admin connections") ?? 0) === 0) {
    findings.push({
      severity: "info",
      category: "Diagnosability",
      check: "remote admin connections (DAC)",
      current: "0 (off)",
      recommended: "1",
      why: "The dedicated admin connection is the way in when the instance stops accepting normal connections. Costs nothing to enable.",
    });
  } else {
    passed.push("dedicated admin connection is enabled");
  }
}

async function checkTempdb(
  config: AppConfig,
  ctx: ServerContext,
  findings: Finding[],
  passed: string[]
): Promise<void> {
  // tempdb.sys.database_files, not sys.master_files: the latter returns no rows
  // for databases the login cannot see, which would read as "zero files".
  const result = await executeQuery(
    config,
    `SELECT COUNT(*) AS dataFiles,
            MIN(size) AS minPages,
            MAX(size) AS maxPages
     FROM tempdb.sys.database_files
     WHERE type = 0`
  );
  const row = result.recordset[0] ?? {};
  const dataFiles = Number(row.dataFiles ?? 0);
  const minPages = Number(row.minPages ?? 0);
  const maxPages = Number(row.maxPages ?? 0);

  // tempdb always has at least one data file. Zero means the metadata was not
  // readable, so report nothing rather than inventing a finding.
  if (dataFiles === 0) {
    findings.push({
      severity: "info",
      category: "Diagnosability",
      check: "tempdb file layout",
      current: "could not read tempdb file metadata",
      recommended: "re-run with a login that can read tempdb.sys.database_files",
      why: "This check was skipped, not passed. Treat tempdb file count and sizing as unverified.",
    });
    return;
  }

  const target = Math.min(8, ctx.cores);
  if (dataFiles < target) {
    findings.push({
      severity: dataFiles === 1 ? "warning" : "info",
      category: "Stability",
      check: "tempdb data files",
      current: `${dataFiles} file(s)`,
      recommended: `${target} (min(8, cores))`,
      why: "Too few files concentrate allocation-page latching on one file, which shows up as PAGELATCH_* contention under concurrency, not as slow I/O.",
    });
  } else {
    passed.push(`tempdb has ${dataFiles} data files for ${ctx.cores} cores`);
  }

  if (dataFiles > 1 && minPages !== maxPages) {
    findings.push({
      severity: "warning",
      category: "Stability",
      check: "tempdb file sizes",
      current: `uneven (${Math.round((minPages * 8) / 1024)} MB to ${Math.round((maxPages * 8) / 1024)} MB)`,
      recommended: "all files the same size",
      why: "Proportional fill sends most allocations to the largest file, which undoes the reason for having several.",
    });
  }
}

async function checkDatabaseSettings(
  config: AppConfig,
  ctx: ServerContext,
  findings: Finding[],
  passed: string[]
): Promise<void> {
  const result = await executeQuery(
    config,
    `SELECT name, compatibility_level AS compatLevel, is_auto_shrink_on AS autoShrink,
            is_auto_close_on AS autoClose, page_verify_option_desc AS pageVerify,
            is_read_committed_snapshot_on AS rcsi
     FROM sys.databases
     WHERE database_id > 4 AND state = 0`
  );

  const rows = result.recordset;
  if (rows.length === 0) return;

  const expectedCompat = ctx.majorVersion * 10;
  const staleCompat = rows.filter((r) => Number(r.compatLevel) < expectedCompat);
  const autoShrink = rows.filter((r) => r.autoShrink === true);
  const autoClose = rows.filter((r) => r.autoClose === true);
  const badPageVerify = rows.filter((r) => r.pageVerify !== "CHECKSUM");
  const noRcsi = rows.filter((r) => r.rcsi === false);

  if (autoShrink.length > 0) {
    findings.push({
      severity: "critical",
      category: "Performance",
      check: "auto_shrink",
      current: `on in ${autoShrink.length} database(s): ${nameList(autoShrink)}`,
      recommended: "off everywhere",
      why: "Shrink fragments every index, then growth re-expands the file: a loop that burns I/O forever and is never the right answer to disk space.",
    });
  } else {
    passed.push("auto_shrink is off everywhere");
  }

  if (autoClose.length > 0) {
    findings.push({
      severity: "warning",
      category: "Performance",
      check: "auto_close",
      current: `on in ${autoClose.length} database(s): ${nameList(autoClose)}`,
      recommended: "off",
      why: "The database is torn down when the last connection leaves, so the next one pays the full startup and cache warm-up.",
    });
  }

  if (badPageVerify.length > 0) {
    findings.push({
      severity: "critical",
      category: "Integrity",
      check: "page_verify",
      current: `not CHECKSUM in ${badPageVerify.length} database(s): ${nameList(badPageVerify)}`,
      recommended: "CHECKSUM",
      why: "Without checksums, storage corruption is not detected when the page is read — it is discovered later, as wrong data.",
    });
  } else {
    passed.push("page_verify is CHECKSUM everywhere");
  }

  if (staleCompat.length > 0) {
    findings.push({
      severity: "warning",
      category: "Performance",
      check: "compatibility level",
      current: `${staleCompat.length} of ${rows.length} database(s) below ${expectedCompat}`,
      recommended: `${expectedCompat} (engine is ${ctx.productVersion})`,
      why: `The engine was upgraded but the databases were not. Below 150 there is no scalar UDF inlining and no table variable deferred compilation, so every scalar function runs row by row and serializes the plan. Raise it one database at a time, with Query Store on to catch regressions.`,
    });
  } else {
    passed.push(`all databases at compatibility level ${expectedCompat}`);
  }

  if (noRcsi.length === rows.length) {
    findings.push({
      severity: "info",
      category: "Performance",
      check: "read committed snapshot (RCSI)",
      current: `off in all ${rows.length} databases`,
      recommended: "evaluate enabling it",
      why: "With RCSI off, readers and writers block each other: a 3-page SELECT can wait behind any long write. This is the root cause behind most NOLOCK hints. Enabling it costs tempdb and needs testing — it is a decision, not a fix.",
    });
  } else if (noRcsi.length > 0) {
    findings.push({
      severity: "info",
      category: "Performance",
      check: "read committed snapshot (RCSI)",
      current: `off in ${noRcsi.length} of ${rows.length} databases`,
      recommended: "make it a deliberate, consistent choice",
      why: "Mixed RCSI across databases usually means nobody decided: the same query blocks in one database and not in another.",
    });
  }
}

async function checkChangeTracking(
  config: AppConfig,
  findings: Finding[],
  passed: string[]
): Promise<void> {
  const result = await executeQuery(
    config,
    `SELECT DB_NAME(database_id) AS name, is_auto_cleanup_on AS autoCleanup,
            retention_period AS retention, retention_period_units_desc AS units
     FROM sys.change_tracking_databases`
  );

  const rows = result.recordset;
  if (rows.length === 0) return;

  const asDays = (r: Record<string, unknown>): number => {
    const value = Number(r.retention ?? 0);
    const units = String(r.units ?? "").toUpperCase();
    if (units === "DAYS") return value;
    if (units === "HOURS") return value / 24;
    if (units === "MINUTES") return value / 1440;
    return value;
  };

  const excessive = rows.filter((r) => asDays(r) >= CT_RETENTION_WARN_DAYS);
  if (excessive.length > 0) {
    findings.push({
      severity: "warning",
      category: "Performance",
      check: "Change Tracking retention",
      current: excessive
        .map((r) => `${r.name}: ${r.retention} ${String(r.units).toLowerCase()}`)
        .join(", "),
      recommended: "days, sized to how far behind the slowest consumer can fall",
      why: "365 days is not a decision, it is what stays when nobody touches the value. The side tables and their cleanup keep growing, and the cost shows up as engine-internal queries attributed to no database. A cloned database inherits this setting silently.",
    });
  }

  const noCleanup = rows.filter((r) => r.autoCleanup === false);
  if (noCleanup.length > 0) {
    findings.push({
      severity: "warning",
      category: "Performance",
      check: "Change Tracking auto cleanup",
      current: `off in: ${nameList(noCleanup)}`,
      recommended: "on",
      why: "With cleanup off the side tables grow without bound and nothing ever reclaims the space.",
    });
  }

  const distinct = new Set(rows.map((r) => `${r.retention} ${r.units}`));
  if (distinct.size > 1) {
    findings.push({
      severity: "info",
      category: "Performance",
      check: "Change Tracking consistency",
      current: `${distinct.size} different retentions across ${rows.length} databases`,
      recommended: "one deliberate value per consumer requirement",
      why: "Retentions that differ without a documented reason are inherited defaults, not choices. Review this per instance, not per database.",
    });
  }

  if (excessive.length === 0 && noCleanup.length === 0) {
    passed.push(`Change Tracking retention is bounded in ${rows.length} database(s)`);
  }
}

/**
 * Can blocking and regressions be investigated after the fact at all?
 * These findings do not make anything faster — they decide whether tomorrow's
 * incident is answerable.
 */
async function checkDiagnosability(
  config: AppConfig,
  findings: Finding[],
  passed: string[]
): Promise<void> {
  const threshold =
    Number(
      (
        await executeQuery(
          config,
          `SELECT CAST(value_in_use AS int) AS v FROM sys.configurations
           WHERE name = 'blocked process threshold (s)'`
        )
      ).recordset[0]?.v ?? 0
    ) || 0;

  if (threshold === 0) {
    findings.push({
      severity: "warning",
      category: "Diagnosability",
      check: "blocked process threshold",
      current: "0 (blocked process report off)",
      recommended: "15-20, plus an Extended Events session to capture it",
      why: "This is the only native source that names the blocker. Without it, who held the lock can only be inferred from timing — never proven.",
    });
  } else {
    passed.push(`blocked process report armed at ${threshold}s`);
  }

  const activity = await executeQuery(
    config,
    `SELECT d.name, d.is_query_store_on AS qsOn,
            SUM(ISNULL(u.user_updates, 0)) AS writes
     FROM sys.databases d
     LEFT JOIN sys.dm_db_index_usage_stats u ON u.database_id = d.database_id
     WHERE d.database_id > 4 AND d.state = 0
     GROUP BY d.name, d.is_query_store_on`
  );

  const activeNoQs = activity.recordset.filter(
    (r) => r.qsOn === false && Number(r.writes ?? 0) > 0
  );
  if (activeNoQs.length > 0) {
    const worst = [...activeNoQs].sort(
      (a, b) => Number(b.writes) - Number(a.writes)
    );
    findings.push({
      severity: "warning",
      category: "Diagnosability",
      check: "Query Store coverage",
      current: `${activeNoQs.length} database(s) with write activity and no Query Store, busiest: ${worst
        .slice(0, 3)
        .map((r) => `${r.name} (${r.writes} writes)`)
        .join(", ")}`,
      recommended: "enable Query Store on every database that takes writes",
      why: "These are blind spots: a blocking or regression incident there leaves no historical trace, and any 'no problems found' answer silently excludes them.",
    });
  }

  const qsDatabases = activity.recordset
    .filter((r) => r.qsOn === true)
    .map((r) => String(r.name));

  const stateRows: Record<string, unknown>[] = [];
  for (const batch of chunk(qsDatabases, DB_BATCH_SIZE)) {
    const unionAll = batch
      .map(
        (db) =>
          `SELECT ${quoteLiteral(db)} AS name, actual_state_desc AS state, query_capture_mode_desc AS captureMode
           FROM ${quoteIdent(db)}.sys.database_query_store_options`
      )
      .join(" UNION ALL ");
    if (!unionAll) continue;
    const result = await executeQuery(config, unionAll);
    stateRows.push(...(result.recordset as Record<string, unknown>[]));
  }

  const notReadWrite = stateRows.filter((r) => r.state !== "READ_WRITE");
  if (notReadWrite.length > 0) {
    findings.push({
      severity: "warning",
      category: "Diagnosability",
      check: "Query Store state",
      current: `${notReadWrite.length} database(s) not READ_WRITE: ${nameList(notReadWrite)}`,
      recommended: "READ_WRITE",
      why: "Query Store is enabled but recording nothing new, so it looks monitored while collecting no evidence. Usually the storage quota filled up.",
    });
  } else if (stateRows.length > 0) {
    passed.push(`Query Store is recording in ${stateRows.length} database(s)`);
  }
}

function render(
  ctx: ServerContext,
  findings: Finding[],
  passed: string[],
  includeHealthy: boolean
): string {
  const parts: string[] = [
    "# Configuration Health",
    "",
    `**${ctx.edition}** · version ${ctx.productVersion} · ${ctx.cores} cores · ${ctx.memoryMb} MB RAM${ctx.alwaysOn ? " · Always On enabled" : ""}`,
    "",
  ];

  if (findings.length === 0) {
    parts.push("✅ No configuration issues found against the checks below.");
  } else {
    const order: Severity[] = ["critical", "warning", "info"];
    const labels: Record<Severity, string> = {
      critical: "🔴 Critical",
      warning: "🟡 Worth fixing",
      info: "🔵 Worth knowing",
    };

    for (const severity of order) {
      const group = findings.filter((f) => f.severity === severity);
      if (group.length === 0) continue;

      parts.push(`## ${labels[severity]} (${group.length})`, "");
      for (const f of group) {
        parts.push(
          `### ${f.check} — _${f.category}_`,
          `- **Now:** ${f.current}`,
          `- **Should be:** ${f.recommended}`,
          `- **Why:** ${f.why}`,
          ""
        );
      }
    }
  }

  if (includeHealthy && passed.length > 0) {
    parts.push(`## ✅ Verified as correct (${passed.length})`, "");
    for (const p of passed) parts.push(`- ${p}`);
    parts.push("");
  } else if (passed.length > 0) {
    parts.push(
      `_${passed.length} further checks passed. Pass \`includeHealthy: true\` to list them._`,
      ""
    );
  }

  parts.push(
    "---",
    "",
    "ℹ️ This audits how the engine is **configured**, not how the code is **written**. A scalar function burning hours of CPU lives in the code and will not appear here.",
    "",
    "⚠️ Recommendations are starting points, not commands. Memory, MAXDOP and RCSI depend on workload — change them in a maintenance window, one at a time, and measure."
  );

  return parts.join("\n");
}

function nameList(rows: Record<string, unknown>[]): string {
  return rows.map((r) => String(r.name)).join(", ");
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Escape a SQL identifier for use inside brackets. Preserves hyphens. */
function quoteIdent(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}

/** Escape a value for use as a SQL string literal. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
