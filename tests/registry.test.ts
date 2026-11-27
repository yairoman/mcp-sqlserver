import { describe, it, expect, vi, beforeEach } from "vitest";
import { jsonSchemaToZod } from "../src/utils/args-schema.js";

// Capture what reaches the database layer; no SQL Server is needed.
const executed: Array<{ sql: string; params?: Record<string, unknown> }> = [];

vi.mock("../src/connection.js", () => {
  const ok = async (_c: unknown, _db: unknown, sql: string, params?: Record<string, unknown>) => {
    executed.push({ sql, params });
    return { recordset: [], recordsets: [], rowsAffected: [0] };
  };
  return {
    executeQuery: async (_c: unknown, sql: string) => ok(_c, undefined, sql),
    executeQueryOnDatabase: ok,
    executeReadOnlyOnDatabase: ok,
    withDedicatedConnection: async () => {
      throw new Error("not used in these tests");
    },
    getPool: async () => ({}),
    closePool: async () => {},
  };
});

const { callTool, tools } = await import("../src/tools/registry.js");
const { loadConfig } = await import("../src/config.js");

const config = loadConfig({
  MSSQL_HOST: "localhost",
  MSSQL_USER: "u",
  MSSQL_PASSWORD: "p",
} as NodeJS.ProcessEnv);

beforeEach(() => {
  executed.length = 0;
});

describe("jsonSchemaToZod", () => {
  const schema = jsonSchemaToZod({
    type: "object",
    properties: {
      name: { type: "string" },
      top: { type: "integer", minimum: 1, maximum: 100 },
      ratio: { type: "number" },
      flag: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
      op: { type: "string", enum: ["=", "IN", "NOT IN"] },
    },
    required: ["name"],
  });

  it("coerces numeric strings, truncates integers and clamps to the bounds", () => {
    expect(schema.parse({ name: "a", top: "7" })).toMatchObject({ top: 7 });
    expect(schema.parse({ name: "a", top: 3.9 })).toMatchObject({ top: 3 });
    expect(schema.parse({ name: "a", top: 0 })).toMatchObject({ top: 1 });
    expect(schema.parse({ name: "a", top: 99999 })).toMatchObject({ top: 100 });
    expect(schema.parse({ name: "a", ratio: "0.5" })).toMatchObject({ ratio: 0.5 });
  });

  it("rejects non-numeric values for numbers (no SQL ends up interpolated)", () => {
    expect(schema.safeParse({ name: "a", top: "1; DROP TABLE t" }).success).toBe(false);
    expect(schema.safeParse({ name: "a", top: "" }).success).toBe(false);
    expect(schema.safeParse({ name: "a", top: {} }).success).toBe(false);
  });

  it("accepts boolean strings, rejects others", () => {
    expect(schema.parse({ name: "a", flag: "TRUE" })).toMatchObject({ flag: true });
    expect(schema.safeParse({ name: "a", flag: "yes" }).success).toBe(false);
  });

  it("enforces required, types, enums (case-insensitive) and unknown keys", () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ name: 5 }).success).toBe(false);
    expect(schema.safeParse({ name: "a", tags: "x" }).success).toBe(false);
    expect(schema.safeParse({ name: "a", op: "not  in" }).success).toBe(true);
    expect(schema.safeParse({ name: "a", op: "LIKE" }).success).toBe(false);
    expect(schema.safeParse({ name: "a", extra: 1 }).success).toBe(false);
  });
});

describe("every tool schema compiles", () => {
  it.each(tools.map((t) => [t.definition.name, t] as const))("%s", (_name, t) => {
    expect(() => jsonSchemaToZod(t.definition.inputSchema as never)).not.toThrow();
  });
});

describe("callTool", () => {
  it("returns isError for an unknown tool", async () => {
    const r = await callTool(config, "nope", {});
    expect(r.isError).toBe(true);
  });

  it("returns isError for invalid arguments and never reaches the database", async () => {
    const r = await callTool(config, "get_query_stats", { top: "20 UNION SELECT 1" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/invalid arguments/);
    expect(executed).toHaveLength(0);
  });

  it("clamps top before the handler interpolates it", async () => {
    const r = await callTool(config, "get_query_stats", { top: "999999" });
    expect(r.isError).toBe(false);
    expect(executed[0].sql).toMatch(/TOP \(?500\)?/);
  });

  it("clamps minCount in find_duplicates", async () => {
    await callTool(config, "find_duplicate_records", {
      database: "Tienda",
      table: "Clientes",
      columns: ["Email"],
      minCount: "0",
    });
    expect(executed[0].sql).toMatch(/>=\s*2\b/);
  });

  it("search_data binds the search value as a parameter", async () => {
    const r = await callTool(config, "search_data", {
      database: "Tienda",
      table: "Clientes",
      searchColumns: ["Nombre", "Email"],
      searchValue: "x' OR 1=1 OR 'a'='a",
    });
    expect(r.isError).toBe(false);
    expect(executed[0].sql).not.toContain("OR 1=1");
    expect(executed[0].sql).toMatch(/\[Nombre\] LIKE @searchValue OR \[Email\] LIKE @searchValue/);
    expect(executed[0].params).toEqual({ searchValue: "%x' OR 1=1 OR 'a'='a%" });
  });

  it("rejects the removed free-form `where` of read_table_data", async () => {
    const r = await callTool(config, "read_table_data", {
      database: "Tienda",
      table: "Clientes",
      where: "1=1",
    });
    expect(r.isError).toBe(true);
    expect(executed).toHaveLength(0);
  });

  it("marks validator rejections as isError", async () => {
    const r = await callTool(config, "execute_select_query", {
      database: "Tienda",
      query: "SELECT 1 DROP TABLE t",
    });
    expect(r.isError).toBe(true);
    expect(executed).toHaveLength(0);
  });

  it("returns a successful result with isError false", async () => {
    const r = await callTool(config, "execute_select_query", {
      database: "Tienda",
      query: "SELECT 1",
    });
    expect(r.isError).toBe(false);
    expect(executed).toHaveLength(1);
  });
});
