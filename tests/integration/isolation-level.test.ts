import { describe, it, expect, afterAll } from "vitest";
import { callTool } from "../../src/tools/registry.js";
import { closePool } from "../../src/connection.js";
import { captureAudit, itConfig, itDatabase } from "./helpers.js";

// SERIALIZABLE / REPEATABLE READ (and their table hints) hold locks on what was
// read until the forced rollback, so a long read could block other sessions.
// They must be rejected before reaching the server. The allowed levels must
// really run on the engine (control).

const config = itConfig("reader");
const database = itDatabase();

afterAll(async () => {
  await closePool();
});

const LEVEL_SQL =
  "SELECT transaction_isolation_level AS lvl FROM sys.dm_exec_sessions WHERE session_id = @@SPID";

const rejected = [
  `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE; ${LEVEL_SQL}`,
  `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ; ${LEVEL_SQL}`,
  "SELECT Valor FROM dbo.Contador WITH (SERIALIZABLE)",
  "SELECT Valor FROM dbo.Contador WITH (HOLDLOCK)",
  "SELECT Valor FROM dbo.Contador WITH (REPEATABLEREAD)",
];

describe("locking isolation levels are rejected", () => {
  for (const tool of ["execute_select_query", "execute_query"] as const) {
    for (const query of rejected) {
      it(`${tool}: ${query}`, async () => {
        const { result, audit } = await captureAudit(() => callTool(config, tool, { database, query }));
        expect(result.isError).toBe(true);
        expect(audit.filter((a) => a.event === "sql")).toEqual([]);
      });
    }
  }

  for (const tool of ["explain_query", "validate_query"] as const) {
    it(`${tool}: SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`, async () => {
      const r = await callTool(config, tool, { database, query: rejected[0] });
      expect(r.isError).toBe(true);
    });
  }
});

describe("allowed isolation levels run on the engine (control)", () => {
  // sys.dm_exec_sessions.transaction_isolation_level: 1 = READ UNCOMMITTED, 2 = READ COMMITTED.
  const allowed: Array<[string, number]> = [
    ["READ UNCOMMITTED", 1],
    ["READ COMMITTED", 2],
  ];
  for (const [level, code] of allowed) {
    it(`${level} is accepted and applied`, async () => {
      const r = await callTool(config, "execute_select_query", {
        database,
        query: `SET TRANSACTION ISOLATION LEVEL ${level}; ${LEVEL_SQL}`,
      });
      expect(r.isError, r.text).toBe(false);
      expect(r.text).toMatch(new RegExp(`\\|\\s*${code}\\s*\\|`));
    });
  }
});
