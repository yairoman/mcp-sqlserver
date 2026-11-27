import { describe, it, expect, vi, beforeEach } from "vitest";

// Record every interaction with the mssql driver; no SQL Server is needed.
const calls: string[] = [];
let queryShouldFail = false;
let rollbackShouldFail = false;

vi.mock("mssql", () => {
  class FakeRequest {
    constructor(_parent?: unknown) {}
    input(name: string) {
      calls.push(`input:${name}`);
      return this;
    }
    async query(sql: string) {
      calls.push(`query:${sql}`);
      if (queryShouldFail) throw new Error("boom");
      return { recordset: [], recordsets: [], rowsAffected: [0] };
    }
    async batch(sql: string) {
      calls.push(`batch:${sql}`);
      return { recordset: [], recordsets: [], rowsAffected: [0] };
    }
  }
  class FakePool {
    connected = false;
    constructor(_cfg: unknown) {
      calls.push("pool:new");
    }
    async connect() {
      this.connected = true;
      calls.push("pool:connect");
      return this;
    }
    request() {
      return new FakeRequest();
    }
    async close() {
      calls.push("pool:close");
    }
  }
  class FakeTransaction {
    constructor(_pool: unknown) {}
    async begin() {
      calls.push("tx:begin");
    }
    async rollback() {
      calls.push("tx:rollback");
      if (rollbackShouldFail) throw new Error("Transaction has been aborted.");
    }
    async commit() {
      calls.push("tx:commit");
    }
  }
  const sql = { ConnectionPool: FakePool, Transaction: FakeTransaction, Request: FakeRequest };
  return { default: sql, ...sql };
});

const { executeReadOnlyOnDatabase, closePool } = await import("../src/connection.js");
const { loadConfig } = await import("../src/config.js");

const config = loadConfig({
  MSSQL_HOST: "localhost",
  MSSQL_USER: "u",
  MSSQL_PASSWORD: "p",
} as NodeJS.ProcessEnv);

beforeEach(async () => {
  await closePool();
  calls.length = 0;
  queryShouldFail = false;
  rollbackShouldFail = false;
});

describe("executeReadOnlyOnDatabase", () => {
  it("begins, runs the query and always rolls back on success (never commits)", async () => {
    await executeReadOnlyOnDatabase(config, "Tienda", "SELECT 1");
    const tx = calls.filter((c) => c.startsWith("tx:") || c.startsWith("query:"));
    expect(tx).toEqual(["tx:begin", "query:USE [Tienda];\nSELECT 1", "tx:rollback"]);
    expect(calls).not.toContain("tx:commit");
  });

  it("rolls back when the query fails and rethrows the original error", async () => {
    queryShouldFail = true;
    await expect(executeReadOnlyOnDatabase(config, "Tienda", "SELECT 1")).rejects.toThrow("boom");
    expect(calls).toContain("tx:rollback");
  });

  it("does not mask the query error when the rollback also fails", async () => {
    queryShouldFail = true;
    rollbackShouldFail = true;
    await expect(executeReadOnlyOnDatabase(config, "Tienda", "SELECT 1")).rejects.toThrow("boom");
  });

  it("binds parameters instead of interpolating them", async () => {
    await executeReadOnlyOnDatabase(config, "Tienda", "SELECT 1 WHERE a = @f0", { f0: "x" });
    expect(calls).toContain("input:f0");
  });

  it("rejects an invalid database name before connecting", async () => {
    await expect(executeReadOnlyOnDatabase(config, "x]; DROP", "SELECT 1")).rejects.toThrow(
      /Invalid SQL identifier/
    );
    expect(calls).not.toContain("pool:connect");
  });
});

describe("explain_query / validate_query", () => {
  it("explain_query rejects a write before any connection is opened", async () => {
    const { explainQueryHandler } = await import("../src/tools/query/explain-query.js");
    await expect(
      explainQueryHandler(config, { database: "Tienda", query: "SELECT 1 DROP TABLE t" })
    ).rejects.toThrow(/rejected/);
    expect(calls).toEqual([]);
  });

  it("explain_query sends USE, SHOWPLAN ON, the query and SHOWPLAN OFF as separate batches on a dedicated connection", async () => {
    const { explainQueryHandler } = await import("../src/tools/query/explain-query.js");
    // The fake returns no plan rows, so the handler reports it could not get one.
    await expect(
      explainQueryHandler(config, { database: "Tienda", query: "SELECT 1" })
    ).rejects.toThrow(/execution plan/);
    expect(calls).toEqual([
      "pool:new",
      "pool:connect",
      "batch:USE [Tienda]",
      "batch:SET SHOWPLAN_TEXT ON",
      "batch:SELECT 1",
      "batch:SET SHOWPLAN_TEXT OFF",
      "pool:close",
    ]);
    // Never goes through sp_executesql (.query) and never runs STATISTICS PROFILE.
    expect(calls.some((c) => c.startsWith("query:"))).toBe(false);
    expect(calls.join("\n")).not.toMatch(/STATISTICS PROFILE/);
  });

  it("validate_query rejects a write before any connection is opened", async () => {
    const { validateQueryHandler } = await import("../src/tools/query/validate-query.js");
    await expect(
      validateQueryHandler(config, {
        database: "Tienda",
        query: "SELECT 1 SET PARSEONLY OFF DELETE FROM t",
      })
    ).rejects.toThrow(/rejected/);
    expect(calls).toEqual([]);
  });

  it("validate_query wraps the query between PARSEONLY ON/OFF batches", async () => {
    const { validateQueryHandler } = await import("../src/tools/query/validate-query.js");
    const out = await validateQueryHandler(config, { database: "Tienda", query: "SELECT 1" });
    expect(out).toMatch(/valid/);
    expect(calls).toEqual([
      "pool:new",
      "pool:connect",
      "batch:USE [Tienda]",
      "batch:SET PARSEONLY ON",
      "batch:SELECT 1",
      "batch:SET PARSEONLY OFF",
      "pool:close",
    ]);
  });
});

describe("execute_select_query / execute_query", () => {
  it("execute_select_query runs inside the rolled-back transaction", async () => {
    const { executeSelectQueryHandler } = await import("../src/tools/data/execute-select-query.js");
    await executeSelectQueryHandler(config, { database: "Tienda", query: "SELECT 1" });
    expect(calls).toContain("tx:begin");
    expect(calls).toContain("tx:rollback");
  });

  it("execute_query refuses writes in read-only mode even with allowWrite", async () => {
    const { executeQueryHandler } = await import("../src/tools/query/execute-query.js");
    const out = await executeQueryHandler(config, {
      database: "Tienda",
      query: "DELETE FROM t",
      allowWrite: true,
    });
    expect(out).toMatch(/read-only/);
    expect(calls).not.toContain("pool:connect");
  });
});
