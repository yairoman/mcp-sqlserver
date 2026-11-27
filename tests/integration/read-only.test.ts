import { describe, it, expect, afterAll } from "vitest";
import { callTool } from "../../src/tools/registry.js";
import { closePool, executeReadOnlyOnDatabase } from "../../src/connection.js";
import { captureAudit, itConfig, itDatabase, readOutside } from "./helpers.js";

// Read-only mode, as the read-only login: writes are rejected before any SQL
// is sent, reads run inside a transaction, and the login itself cannot write.

const config = itConfig("reader");
const database = itDatabase();

afterAll(async () => {
  await closePool();
});

async function contador(): Promise<number> {
  const rows = await readOutside<{ Valor: number }>("SELECT Valor FROM dbo.Contador WHERE Id = 1");
  return rows[0].Valor;
}

describe("read-only mode rejects writes", () => {
  const writes = [
    "UPDATE dbo.Contador SET Valor = 42 WHERE Id = 1",
    "INSERT INTO dbo.Contador (Id, Valor) VALUES (2, 2)",
    "DELETE FROM dbo.Contador",
    "SELECT * INTO dbo.Copia FROM dbo.Contador",
    "SELECT 1; UPDATE dbo.Contador SET Valor = 42",
    "CREATE TABLE dbo.X (i INT)",
  ];

  for (const query of writes) {
    it(`execute_query refuses (MSSQL_READ_ONLY, allowWrite: true): ${query}`, async () => {
      const { result, audit } = await captureAudit(() =>
        callTool(config, "execute_query", { database, query, allowWrite: true })
      );
      expect(result.isError).toBe(true);
      expect(result.text).toContain("read-only mode");
      // Rejected before reaching the server: no SQL audit line.
      expect(audit.filter((a) => a.event === "sql")).toEqual([]);
    });

    it(`execute_select_query refuses: ${query}`, async () => {
      const { result, audit } = await captureAudit(() =>
        callTool(config, "execute_select_query", { database, query })
      );
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Query rejected");
      expect(audit.filter((a) => a.event === "sql")).toEqual([]);
    });
  }

  it("leaves the data untouched", async () => {
    expect(await contador()).toBe(1);
  });
});

describe("reads run inside a transaction that is rolled back", () => {
  it("a SELECT sees @@TRANCOUNT = 1", async () => {
    const r = await callTool(config, "execute_select_query", {
      database,
      query: "SELECT @@TRANCOUNT AS trancount",
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/\|\s*trancount\s*\|[\s\S]*\|\s*1\s*\|/);
  });

  it("the connection goes back to the pool with no open transaction", async () => {
    const r = await callTool(config, "execute_select_query", {
      database,
      query: "SELECT open_transaction_count AS otc FROM sys.dm_exec_sessions WHERE session_id = @@SPID",
    });
    // Inside the wrapper there is exactly one (ours); none survives it, or the
    // next call would see 2.
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/\|\s*1\s*\|/);
  });
});

describe("least-privilege login", () => {
  it("cannot write even when the text filter is bypassed", async () => {
    // Straight to the connection layer: no validator in the way. The login is
    // the real boundary and must refuse (error 229, permission denied).
    await expect(
      executeReadOnlyOnDatabase(config, database, "UPDATE dbo.Contador SET Valor = 42 WHERE Id = 1")
    ).rejects.toThrow(/permission was denied/i);
    expect(await contador()).toBe(1);
  });
});
