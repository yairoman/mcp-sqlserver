// Direct MCP tool caller — bypasses STDIO transport issues
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { config as dotenvConfig } from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenvConfig({ path: resolve(__dirname, "..", ".env"), quiet: true });

import { loadConfig } from "./config.js";

// Import handlers directly
import { rowCountsHandler } from "./tools/integrity/row-counts.js";
import { missingIndexesHandler } from "./tools/performance/missing-indexes.js";
import { waitStatsHandler } from "./tools/performance/wait-stats.js";
import { queryStatsHandler } from "./tools/performance/query-stats.js";
import { blockingChainsHandler } from "./tools/performance/blocking-chains.js";
import { blockingHistoryHandler } from "./tools/performance/blocking-history.js";
import { configurationHealthHandler } from "./tools/performance/configuration-health.js";
import { performanceTriageHandler } from "./tools/performance/performance-triage.js";
import { compatibilityAssessmentHandler } from "./tools/performance/compatibility-assessment.js";
import { activeSessionsHandler } from "./tools/performance/active-sessions.js";
import { closePool } from "./connection.js";

const config = loadConfig();

async function run() {
  const toolName = process.argv[2];
  const argsJson = process.argv[3] || "{}";
  const args = JSON.parse(argsJson);

  const handlers: Record<string, (c: typeof config, a: Record<string, unknown>) => Promise<string>> = {
    row_counts: rowCountsHandler,
    missing_indexes: missingIndexesHandler,
    wait_stats: waitStatsHandler,
    query_stats: queryStatsHandler,
    blocking_chains: blockingChainsHandler,
    blocking_history: blockingHistoryHandler,
    configuration_health: configurationHealthHandler,
    performance_triage: performanceTriageHandler,
    compatibility_assessment: compatibilityAssessmentHandler,
    active_sessions: activeSessionsHandler,
  };

  const handler = handlers[toolName];
  if (!handler) {
    console.error("Unknown tool:", toolName);
    process.exit(1);
  }

  try {
    const result = await handler(config, args);
    console.log(result);
  } catch (e) {
    console.error("Error:", e);
  } finally {
    await closePool();
  }
}

run();
