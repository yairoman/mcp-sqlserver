import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { config as dotenvConfig } from "dotenv";

// Load .env from the project root (works regardless of cwd)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = resolve(__dirname, "..", ".env");
dotenvConfig({ path: envPath });

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { closePool } from "./connection.js";

// Prevent unhandled rejections from crashing the process
process.on("uncaughtException", (error) => {
  console.error("💥 Uncaught exception:", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("💥 Unhandled rejection:", reason);
});

async function main() {
  // Load and validate configuration
  const config = loadConfig();

  // Log to stderr (stdout is reserved for MCP JSON-RPC protocol)
  console.error("🚀 morro-mcp-sqlserver starting...");
  console.error(`   Host: ${config.host}:${config.port}`);
  console.error(`   Database: ${config.database}`);
  console.error(`   Read-Only: ${config.readOnly}`);
  console.error(`   Encrypt: ${config.encrypt}`);
  console.error(`   Trust Certificate: ${config.trustServerCertificate}`);
  console.error(`   Max Rows: ${config.maxRows}`);
  console.error(`   .env path: ${envPath}`);

  // Create MCP server with all tools
  const server = createServer(config);

  // Create STDIO transport
  const transport = new StdioServerTransport();

  // Handle graceful shutdown
  const shutdown = async () => {
    console.error("\n🛑 Shutting down...");
    await closePool();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Connect transport to server and start
  await server.connect(transport);
  console.error("✅ MCP Server connected and ready");
}

main().catch((error) => {
  console.error("💥 Fatal error:", error);
  process.exit(1);
});
