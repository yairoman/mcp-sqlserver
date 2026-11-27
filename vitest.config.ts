import { defineConfig } from "vitest/config";

// `npm test`: unit tests only. They need no SQL Server.
// The suite under tests/integration/ talks to a real engine and has its own
// config (vitest.integration.config.ts) and script (`npm run test:integration`).
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**", "node_modules/**", "dist/**"],
  },
});
