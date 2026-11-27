// Direct tool caller for local diagnostics, without the MCP STDIO transport.
// It goes through the same registry and callTool() as the MCP server, so the
// same validation, read-only checks and error handling apply.
//
//   npx tsx src/direct-call.ts <tool_name> '<json args>'
//   npx tsx src/direct-call.ts execute_select_query '{"database":"master","query":"SELECT @@VERSION AS v"}'
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { config as dotenvConfig } from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenvConfig({ path: resolve(__dirname, "..", ".env"), quiet: true });

import { loadConfig } from "./config.js";
import { callTool, tools } from "./tools/registry.js";
import { closePool } from "./connection.js";

async function run(): Promise<number> {
  const toolName = process.argv[2];
  if (!toolName) {
    console.error("Usage: tsx src/direct-call.ts <tool_name> '<json args>'");
    console.error("Tools:", tools.map((t) => t.definition.name).join(", "));
    return 1;
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(process.argv[3] || "{}");
  } catch (e) {
    console.error("Arguments must be valid JSON:", e instanceof Error ? e.message : e);
    return 1;
  }

  const config = loadConfig();
  try {
    const result = await callTool(config, toolName, args);
    if (result.isError) {
      console.error(result.text);
      return 1;
    }
    console.log(result.text);
    return 0;
  } finally {
    await closePool();
  }
}

run().then(
  (code) => process.exit(code),
  (e) => {
    console.error("Error:", e);
    process.exit(1);
  }
);
