import { describe, it, expect, afterAll } from "vitest";
import { callTool } from "../../src/tools/registry.js";
import { closePool, executeQueryOnDatabase } from "../../src/connection.js";
import { captureAudit, itConfig, itDatabase } from "./helpers.js";
import { SEED } from "./seed.js";

// MSSQL_MAX_ROWS is applied on the SERVER (SET ROWCOUNT maxRows + 1): the
// driver must receive maxRows + 1 rows, not the 1000 of the table. The audit
// line records what the driver received.
//
// MSSQL_POOL_MAX=1 forces every call onto the same physical connection, so the
// "does not leak" test would see a leftover cap. Note: with request.query() the
// driver already scopes SET ROWCOUNT to that request (verified with mssql 11),
// so this test checks the PROPERTY (no leak), not the explicit `SET ROWCOUNT 0`
// in src/connection.ts: removing that reset alone does not make it fail. It
// would fail if the capped query were ever sent with .batch(), whose SET does
// persist on the pooled connection.

const MAX_ROWS = 5;
const config = itConfig("reader", { MSSQL_MAX_ROWS: String(MAX_ROWS), MSSQL_POOL_MIN: "0", MSSQL_POOL_MAX: "1" });
const database = itDatabase();

afterAll(async () => {
  await closePool();
});

function sqlRows(audit: Array<{ event: string; rows?: number | null }>): Array<number | null | undefined> {
  return audit.filter((a) => a.event === "sql").map((a) => a.rows);
}

describe("MSSQL_MAX_ROWS", () => {
  it("is read from the environment by loadConfig", () => {
    expect(config.maxRows).toBe(MAX_ROWS);
    expect(config.poolMax).toBe(1);
  });

  it("execute_select_query: the server stops at maxRows + 1", async () => {
    const { result, audit } = await captureAudit(() =>
      callTool(config, "execute_select_query", { database, query: `SELECT n FROM dbo.${SEED.numeros} ORDER BY n` })
    );
    expect(result.isError, result.text).toBe(false);
    expect(sqlRows(audit)).toContain(MAX_ROWS + 1);
    expect(Math.max(...sqlRows(audit).map((n) => n ?? 0))).toBe(MAX_ROWS + 1);
    expect(result.text).toContain(`Results truncated to ${MAX_ROWS} rows (MSSQL_MAX_ROWS)`);
  });

  it("execute_query (read path): the server stops at maxRows + 1", async () => {
    const { result, audit } = await captureAudit(() =>
      callTool(config, "execute_query", { database, query: `SELECT n FROM dbo.${SEED.numeros}` })
    );
    expect(result.isError, result.text).toBe(false);
    expect(Math.max(...sqlRows(audit).map((n) => n ?? 0))).toBe(MAX_ROWS + 1);
  });

  it("an exact fit is not reported as truncated", async () => {
    const r = await callTool(config, "execute_select_query", {
      database,
      query: `SELECT TOP (${MAX_ROWS}) n FROM dbo.${SEED.numeros} ORDER BY n`,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).not.toContain("truncated");
  });

  it("the cap does not leak to the next query on the same connection", async () => {
    await callTool(config, "execute_select_query", { database, query: `SELECT n FROM dbo.${SEED.numeros}` });
    // Uncapped path, same (single) pooled connection: must get all 1000 rows.
    const all = await executeQueryOnDatabase(config, database, `SELECT n FROM dbo.${SEED.numeros}`);
    expect(all.recordset.length).toBe(SEED.numerosRows);
  });
});
