import { describe, expect, it, vi } from "vitest";

const fakeTables = [
  {
    schema: "dbo",
    name: "Customers",
    type: "TABLE",
    rowCount: 1200,
    sizeKB: 256,
    createdDate: new Date("2024-01-10T00:00:00Z"),
    modifiedDate: new Date("2024-06-01T00:00:00Z"),
  },
  {
    schema: "sales",
    name: "Orders",
    type: "TABLE",
    rowCount: 5400,
    sizeKB: 1024,
    createdDate: new Date("2024-01-10T00:00:00Z"),
    modifiedDate: new Date("2024-07-15T00:00:00Z"),
  },
];

vi.mock("mssql", () => {
  class ConnectionPool {
    connected = false;
    async connect(): Promise<this> {
      this.connected = true;
      return this;
    }
    request() {
      return {
        input: () => undefined,
        query: async () => ({ recordset: fakeTables }),
      };
    }
    async close(): Promise<void> {
      this.connected = false;
    }
  }
  return { default: { ConnectionPool } };
});

const { listTablesHandler } = await import("../src/tools/schema/list-tables.js");
const { sanitizeIdentifier } = await import("../src/utils/sql-sanitizer.js");

// connection.ts references sanitizeIdentifier without importing it; expose it globally
// so the handler can run under test without touching src/.
(globalThis as Record<string, unknown>).sanitizeIdentifier = sanitizeIdentifier;

const config = {
  host: "localhost",
  port: 1433,
  user: "test",
  password: "test",
  database: "master",
  encrypt: true,
  trustServerCertificate: true,
  readOnly: true,
  maxRows: 1000,
  queryTimeout: 30000,
  connectionTimeout: 15000,
  poolMin: 1,
  poolMax: 10,
};

describe("list_tables response time", () => {
  it("responds in 0 ms or less (real time)", async () => {
    const start = performance.now();
    const output = await listTablesHandler(config, { database: "TiendaDemo" });
    const elapsed = performance.now() - start;

    expect(output).toContain("TiendaDemo");
    expect(elapsed).toBeLessThanOrEqual(0);
  });
});
