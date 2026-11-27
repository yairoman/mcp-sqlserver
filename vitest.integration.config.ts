import { defineConfig } from "vitest/config";

// `npm run test:integration`: runs against a real, THROWAWAY SQL Server
// (the `sqlserver` service of docker-compose.yml). See README, "Pruebas de integración".
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    // One file at a time: each file owns the module-level connection pool of
    // src/connection.ts and the seed database is shared.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
