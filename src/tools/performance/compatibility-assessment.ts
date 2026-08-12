import type { AppConfig } from "../../config.js";
import { executeQuery, executeQueryOnDatabase } from "../../connection.js";

/** Compatibility levels a modern engine still accepts, oldest first. */
const KNOWN_LEVELS = [100, 110, 120, 130, 140, 150, 160, 170];

const LEVEL_NAMES: Record<number, string> = {
  100: "SQL Server 2008",
  110: "SQL Server 2012",
  120: "SQL Server 2014",
  130: "SQL Server 2016",
  140: "SQL Server 2017",
  150: "SQL Server 2019",
  160: "SQL Server 2022",
  170: "SQL Server 2025",
};

/**
 * What actually switches on at each level. Only optimizer behaviour that
 * changes plans is listed — syntax additions do not depend on this setting.
 */
const LEVEL_CHANGES: Record<number, string[]> = {
  120: [
    "New cardinality estimator becomes the default. This is the single biggest plan-changing jump: estimates for multi-predicate filters and joins change across the board.",
  ],
  140: [
    "Adaptive joins: the engine picks hash or nested loops at runtime, after reading the first input.",
    "Interleaved execution for multi-statement table-valued functions, which stops them estimating a fixed row count.",
    "Memory grant feedback: grants are corrected across executions instead of repeating the same bad estimate.",
  ],
  150: [
    "Scalar UDF inlining: qualifying scalar functions stop running row by row and become part of the plan. Usually the largest single win when the code leans on scalar functions.",
    "Table variable deferred compilation: table variables are no longer estimated at 1 row, which changes join strategy wherever they are used.",
    "Batch mode on rowstore for analytical queries over regular indexes.",
    "Approximate count distinct, and row mode memory grant feedback.",
  ],
  160: [
    "Parameter Sensitive Plan optimization: one statement can hold several plans for different parameter values, aimed squarely at parameter sniffing.",
    "Memory grant feedback persistence: corrections survive a restart instead of being relearned.",
    "Degree of parallelism feedback, and cardinality estimation feedback.",
  ],
  170: [
    "Optimized Halloween Protection: update plans stop needing a blocking spool to guarantee correctness, which cuts tempdb usage and speeds up large updates.",
    "Further optimizer feedback: the cardinality estimation and parallelism corrections introduced at 160 are widened and persisted more aggressively.",
    "⚠️ This level is recent, so treat this list as a starting point and confirm the specifics against the documentation for your exact build before planning a migration.",
  ],
};

export const compatibilityAssessmentDefinition = {
  name: "get_compatibility_assessment",
  description:
    "Assess what a compatibility level upgrade would change for a database, and what has to be done before it is safe: prerequisites, what improves automatically, what needs review, and the ordered plan to apply it. Reports how many scalar functions the optimizer can inline, forced plans and plan guides that may not survive, database scoped configurations that conflict, and stale statistics. Without a targetLevel it assumes the highest level the engine supports. Without a database it summarises every database and how far behind each one is.",
  inputSchema: {
    type: "object" as const,
    properties: {
      database: {
        type: "string",
        description:
          "Database to assess in depth. Omit to list every database and its gap to the target.",
      },
      targetLevel: {
        type: "number",
        description:
          "Target compatibility level (130 = SQL Server 2016, 140 = 2017, 150 = 2019, 160 = 2022). Defaults to the highest level this engine supports.",
      },
    },
  },
};

export async function compatibilityAssessmentHandler(
  config: AppConfig,
  args: Record<string, unknown>
): Promise<string> {
  const engine = await readEngine(config);
  const maxLevel = engine.majorVersion * 10;

  const requested = Number(args.targetLevel);
  let target = Number.isFinite(requested) ? Math.trunc(requested) : maxLevel;
  const notes: string[] = [];

  if (!Number.isFinite(requested)) {
    notes.push(
      `No \`targetLevel\` given, so this assumes **${target} (${LEVEL_NAMES[target] ?? "unknown"})** — the highest level this engine supports.`
    );
  } else if (!KNOWN_LEVELS.includes(target)) {
    return `❌ **${target} is not a valid compatibility level.** Valid values: ${KNOWN_LEVELS.map((l) => `${l} (${LEVEL_NAMES[l]})`).join(", ")}.`;
  } else if (target > maxLevel) {
    notes.push(
      `⚠️ Requested level ${target} is above what this engine supports (${maxLevel}). Capped to ${maxLevel} — a database cannot exceed its engine.`
    );
    target = maxLevel;
  }

  const database =
    typeof args.database === "string" && args.database.trim().length > 0
      ? args.database.trim()
      : null;

  return database
    ? assessDatabase(config, database, target, engine, notes)
    : summariseInstance(config, target, engine, notes);
}

interface Engine {
  majorVersion: number;
  productVersion: string;
  edition: string;
}

async function readEngine(config: AppConfig): Promise<Engine> {
  const result = await executeQuery(
    config,
    `SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS majorVersion,
            CAST(SERVERPROPERTY('ProductVersion') AS varchar(50)) AS productVersion,
            CAST(SERVERPROPERTY('Edition') AS varchar(100)) AS edition`
  );
  const row = result.recordset[0] ?? {};
  return {
    majorVersion: Number(row.majorVersion ?? 0),
    productVersion: String(row.productVersion ?? "unknown"),
    edition: String(row.edition ?? "unknown"),
  };
}

async function summariseInstance(
  config: AppConfig,
  target: number,
  engine: Engine,
  notes: string[]
): Promise<string> {
  const result = await executeQuery(
    config,
    `SELECT name, compatibility_level AS level, is_query_store_on AS queryStore
     FROM sys.databases
     WHERE database_id > 4 AND state = 0
     ORDER BY compatibility_level, name`
  );

  const rows = result.recordset;
  const behind = rows.filter((r) => Number(r.level) < target);
  const atTarget = rows.length - behind.length;

  const parts: string[] = [
    "# Compatibility Level Assessment — instance summary",
    "",
    `Engine: **${engine.productVersion}** (${engine.edition}) · target level: **${target} (${LEVEL_NAMES[target] ?? "?"})**`,
    "",
  ];

  if (notes.length > 0) parts.push(...notes.map((n) => `> ${n}`), "");

  if (behind.length === 0) {
    parts.push(`✅ All ${rows.length} databases are already at level ${target} or above.`);
    return parts.join("\n");
  }

  const grouped = new Map<number, string[]>();
  for (const r of behind) {
    const level = Number(r.level);
    const list = grouped.get(level) ?? [];
    list.push(String(r.name));
    grouped.set(level, list);
  }

  parts.push(
    `**${behind.length} of ${rows.length} databases are below the target** (${atTarget} already there).`,
    "",
    "| Current level | Engine it matches | Databases | Count |",
    "| --- | --- | --- | ---: |"
  );

  for (const [level, names] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
    const shown = names.length > 6 ? `${names.slice(0, 6).join(", ")}, …` : names.join(", ");
    parts.push(`| ${level} | ${LEVEL_NAMES[level] ?? "?"} | ${shown} | ${names.length} |`);
  }

  const noQueryStore = behind.filter((r) => r.queryStore === false);
  parts.push("", "## Before going further", "");
  if (noQueryStore.length > 0) {
    parts.push(
      `⚠️ **${noQueryStore.length} of the databases below target have Query Store off.** Query Store is what makes this upgrade reversible in practice: it is how a plan regression is detected and how the old plan is forced back. Turn it on and let it collect a representative period *before* raising the level.`,
      ""
    );
  } else {
    parts.push("✅ Every database below target has Query Store enabled, so regressions will be visible.", "");
  }

  parts.push(
    `Run this again with \`database: "<name>"\` for the detailed assessment of a single database: what improves automatically, what needs review, and the ordered plan.`,
    "",
    "⚠️ Raise the level **one database at a time**. This is not an instance-wide switch to flip in one night."
  );

  return parts.join("\n");
}

async function assessDatabase(
  config: AppConfig,
  database: string,
  target: number,
  engine: Engine,
  notes: string[]
): Promise<string> {
  const current = await readCurrentLevel(config, database);
  if (current === null) {
    return `❌ Database **${database}** not found or not online.`;
  }

  const parts: string[] = [
    `# Compatibility Assessment — ${database}`,
    "",
    `**${current} (${LEVEL_NAMES[current] ?? "?"})** → **${target} (${LEVEL_NAMES[target] ?? "?"})** · engine ${engine.productVersion}`,
    "",
  ];

  if (notes.length > 0) parts.push(...notes.map((n) => `> ${n}`), "");

  if (current >= target) {
    parts.push(
      `✅ This database is already at level ${current}, at or above the target. Nothing to assess.`
    );
    return parts.join("\n");
  }

  const [prereqs, gains, risks] = await Promise.all([
    checkPrerequisites(config, database),
    checkGains(config, database, current, target),
    checkRisks(config, database),
  ]);

  parts.push("## 1. Prerequisites — do these first", "");
  parts.push(prereqs.length > 0 ? prereqs.join("\n") : "✅ No blocking prerequisites found.");

  parts.push("", "## 2. What improves on its own", "");
  parts.push(gains.length > 0 ? gains.join("\n") : "_Nothing measurable detected in the catalog._");

  parts.push("", "## 3. What needs review", "");
  parts.push(risks.length > 0 ? risks.join("\n") : "✅ No forced plans, plan guides or conflicting configurations found.");

  parts.push("", "## 4. Behaviour that changes between these levels", "");
  for (const level of KNOWN_LEVELS.filter((l) => l > current && l <= target)) {
    const changes = LEVEL_CHANGES[level];
    if (!changes) continue;
    parts.push(`**Level ${level} — ${LEVEL_NAMES[level]}**`, "");
    for (const c of changes) parts.push(`- ${c}`);
    parts.push("");
  }

  parts.push(
    "## 5. How to apply it",
    "",
    "```sql",
    `ALTER DATABASE [${database}] SET COMPATIBILITY_LEVEL = ${target};`,
    "```",
    "",
    "The statement itself is instant and fully reversible — it changes optimizer behaviour, it does not rewrite data. The risk is not the command, it is the plans it produces. Sequence that actually protects you:",
    "",
    `1. Query Store on, capturing a representative period (a full business cycle, not an afternoon).`,
    `2. Record the baseline: worst queries by CPU and by duration, so "worse" is measurable rather than a feeling.`,
    `3. Raise the level in a low-traffic window.`,
    `4. Watch Query Store for regressed queries over the following days.`,
    `5. For anything that regressed, force the previous plan — Query Store keeps it — and treat that query on its own instead of reverting the whole database.`,
    "",
    "**Rollback:**",
    "",
    "```sql",
    `ALTER DATABASE [${database}] SET COMPATIBILITY_LEVEL = ${current};`,
    "```",
    "",
    "If reverting everything for a handful of queries feels wrong, the middle ground is `ALTER DATABASE SCOPED CONFIGURATION SET LEGACY_CARDINALITY_ESTIMATION = ON`: it keeps the new level and its features while restoring the old estimator.",
    "",
    "---",
    "",
    "ℹ️ This reads the catalog: it can see functions, forced plans, configurations and statistics. It cannot see application code, dynamic SQL built at runtime, or logic that depends on plan shape. A clean assessment lowers the risk — it does not remove the need to watch after the change."
  );

  return parts.join("\n");
}

async function readCurrentLevel(
  config: AppConfig,
  database: string
): Promise<number | null> {
  const result = await executeQuery(
    config,
    `SELECT compatibility_level AS level FROM sys.databases
     WHERE name = @dbName AND state = 0`,
    { dbName: database }
  );
  const row = result.recordset[0];
  return row ? Number(row.level) : null;
}

async function checkPrerequisites(
  config: AppConfig,
  database: string
): Promise<string[]> {
  const out: string[] = [];

  const qs = await executeQuery(
    config,
    `SELECT is_query_store_on AS queryStoreOn FROM sys.databases WHERE name = @dbName`,
    { dbName: database }
  );
  const queryStoreOn = qs.recordset[0]?.queryStoreOn === true;

  if (!queryStoreOn) {
    out.push(
      "🔴 **Query Store is off. Turn it on before raising the level.** It is the only thing that lets you detect a plan regression and force the old plan back. Without it, the upgrade is irreversible in practice: you would have nothing to compare against and no plan to restore."
    );
  } else {
    const state = await safeQuery(
      config,
      database,
      `SELECT actual_state_desc AS state, query_capture_mode_desc AS captureMode
       FROM sys.database_query_store_options`
    );
    const row = state?.[0];
    if (row && row.state !== "READ_WRITE") {
      out.push(
        `🔴 **Query Store is enabled but in ${row.state}, so it is recording nothing.** It looks like a safety net and is not one. Fix that first.`
      );
    } else {
      out.push(
        `✅ Query Store is active${row?.captureMode ? ` (capture mode ${row.captureMode})` : ""}, so regressions will be visible and the previous plans are available to force back.`
      );
      if (row?.captureMode === "AUTO") {
        out.push(
          "   ↳ In AUTO mode infrequent or trivial queries are never captured. Those cannot be compared before and after, and a regression there will not show up."
        );
      }
    }
  }

  // STATS_DATE, not sys.dm_db_stats_properties: the DMF reads each statistic's
  // header individually and a CROSS APPLY over a large database's statistics
  // runs for minutes. STATS_DATE answers "how old" without that cost.
  const stats = await safeQuery(
    config,
    database,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN STATS_DATE(s.object_id, s.stats_id) IS NULL
                       OR STATS_DATE(s.object_id, s.stats_id) < DATEADD(day, -30, GETDATE())
                     THEN 1 ELSE 0 END) AS stale
     FROM sys.stats s
     INNER JOIN sys.objects o ON o.object_id = s.object_id
     WHERE o.is_ms_shipped = 0 AND o.type = 'U'`
  );
  const statRow = stats?.[0];
  if (statRow) {
    const total = Number(statRow.total ?? 0);
    const stale = Number(statRow.stale ?? 0);
    if (total > 0 && stale / total > 0.25) {
      out.push(
        `🟡 **${stale} of ${total} statistics have not been updated in over 30 days.** A new estimator reading stale statistics produces bad plans and gets blamed for it. Update statistics with FULLSCAN before the change, so that what you measure afterwards is the level and not the statistics.`
      );
    } else {
      out.push(`✅ Statistics are reasonably fresh (${stale} of ${total} older than 30 days).`);
    }
  }

  return out;
}

async function checkGains(
  config: AppConfig,
  database: string,
  current: number,
  target: number
): Promise<string[]> {
  const out: string[] = [];

  // Scalar UDF inlining and table variable deferred compilation both arrive at 150.
  if (current < 150 && target >= 150) {
    const udf = await safeQuery(
      config,
      database,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN m.is_inlineable = 1 THEN 1 ELSE 0 END) AS inlineable
       FROM sys.sql_modules m
       INNER JOIN sys.objects o ON o.object_id = m.object_id
       WHERE o.type = 'FN' AND o.is_ms_shipped = 0`
    );
    const row = udf?.[0];
    const total = Number(row?.total ?? 0);
    const inlineable = Number(row?.inlineable ?? 0);

    if (total > 0) {
      out.push(
        `🟢 **${inlineable} of ${total} scalar functions become inlineable.** The engine itself reports this through \`sys.sql_modules.is_inlineable\`, so it is not an estimate. Those ${inlineable} stop running once per row and become part of the plan — which also lets those plans go parallel, since a scalar function serializes the plan it appears in.`
      );
      if (total - inlineable > 0) {
        out.push(
          `   ↳ The other ${total - inlineable} are **not** inlineable (loops, exec, non-deterministic calls, side effects). They keep running row by row at any level: raising the compatibility level does nothing for them, and they stay a rewrite job.`
        );
      }
    }

    out.push(
      "🟢 **Table variables stop being estimated at 1 row.** Deferred compilation gives them the real row count before compiling. Anywhere a table variable feeds a join, the plan shape can change completely — this is a gain, but it is also the change most likely to move plans."
    );
  }

  if (current < 140 && target >= 140) {
    out.push(
      "🟢 **Memory grant feedback and adaptive joins.** Grants stop repeating the same wrong estimate execution after execution, which reduces both spills to tempdb and oversized grants that make queries queue for memory."
    );
  }

  if (current < 160 && target >= 160) {
    out.push(
      "🟢 **Parameter Sensitive Plan optimization.** A statement whose good plan depends on which parameter it gets can keep several plans instead of one compromise. Directly targets the classic parameter sniffing case."
    );
  }

  return out;
}

async function checkRisks(config: AppConfig, database: string): Promise<string[]> {
  const out: string[] = [];

  const forced = await safeQuery(
    config,
    database,
    `SELECT COUNT(*) AS forcedPlans FROM sys.query_store_plan WHERE is_forced_plan = 1`
  );
  const forcedCount = Number(forced?.[0]?.forcedPlans ?? 0);
  if (forcedCount > 0) {
    out.push(
      `🟡 **${forcedCount} forced plan(s) in Query Store.** A forced plan was someone's fix for an earlier problem. After the change it may stop being valid, or it may pin a plan that the new level would have improved. Review each one: forcing failures are silent unless you look for them.`
    );
  }

  const guides = await safeQuery(
    config,
    database,
    `SELECT COUNT(*) AS guides FROM sys.plan_guides WHERE is_disabled = 0`
  );
  const guideCount = Number(guides?.[0]?.guides ?? 0);
  if (guideCount > 0) {
    out.push(
      `🟡 **${guideCount} active plan guide(s).** They are tied to statement text and hints that may behave differently at the new level. Validate them with \`sys.fn_validate_plan_guide\` before and after.`
    );
  }

  const scoped = await safeQuery(
    config,
    database,
    `SELECT name, value FROM sys.database_scoped_configurations
     WHERE name IN ('LEGACY_CARDINALITY_ESTIMATION','TSQL_SCALAR_UDF_INLINING','PARAMETER_SNIFFING','QUERY_OPTIMIZER_HOTFIXES')`
  );
  for (const row of scoped ?? []) {
    const name = String(row.name);
    const value = String(row.value);
    if (name === "LEGACY_CARDINALITY_ESTIMATION" && value.toLowerCase() !== "false" && value !== "0") {
      out.push(
        "🟡 **`LEGACY_CARDINALITY_ESTIMATION` is ON.** The database keeps the old estimator regardless of the level, so you would get the new features without the new estimation. That may be exactly what someone intended — find out why it was set before deciding, because turning it off is a bigger change than the level itself."
      );
    }
    if (name === "TSQL_SCALAR_UDF_INLINING" && (value.toLowerCase() === "true" || value === "1")) {
      out.push(
        "🔵 **`TSQL_SCALAR_UDF_INLINING` is already ON but has no effect below level 150.** The switch is on and inert; raising the level is what actually activates it. Worth knowing: nobody will need to enable anything afterwards, and if inlining causes trouble this is the switch to turn off — without giving up the level."
      );
    }
    if (name === "PARAMETER_SNIFFING" && value.toLowerCase() === "false") {
      out.push(
        "🟡 **`PARAMETER_SNIFFING` is OFF.** Someone disabled it to work around a specific problem. At level 160 the Parameter Sensitive Plan feature addresses that case properly — but it cannot help while sniffing is disabled wholesale."
      );
    }
  }

  const deprecated = await safeQuery(
    config,
    database,
    `SELECT COUNT(*) AS deprecatedColumns FROM sys.columns c
     INNER JOIN sys.objects o ON o.object_id = c.object_id
     INNER JOIN sys.types t ON t.user_type_id = c.user_type_id
     WHERE o.is_ms_shipped = 0 AND o.type = 'U'
       AND t.name IN ('text','ntext','image')`
  );
  const deprecatedCount = Number(deprecated?.[0]?.deprecatedColumns ?? 0);
  if (deprecatedCount > 0) {
    out.push(
      `🔵 **${deprecatedCount} column(s) still use text/ntext/image.** These do not block the upgrade and keep working, but they have been deprecated for years and are not supported by several newer features. Debt to note, not to fix now.`
    );
  }

  return out;
}

/**
 * Run a query inside one database, returning null instead of throwing.
 * A single missing permission should degrade one section of the assessment,
 * not lose the whole report.
 */
async function safeQuery(
  config: AppConfig,
  database: string,
  query: string
): Promise<Record<string, unknown>[] | null> {
  try {
    const result = await executeQueryOnDatabase(config, database, query);
    return result.recordset as Record<string, unknown>[];
  } catch {
    return null;
  }
}
