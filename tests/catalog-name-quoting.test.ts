import { describe, it, expect, vi, beforeEach } from "vitest";
import { maskLiteralsAndIdentifiers, quoteName, quoteLiteral } from "../src/utils/sql-sanitizer.js";

/**
 * Second-order SQL injection: names read from the catalog (sys.columns,
 * sys.foreign_keys) were pasted into the next query as `[${name}]`. Whoever can
 * create a column could then close the bracket and append their own statement.
 * These tests feed a hostile name through the catalog and check what reaches
 * the database layer.
 */
const PAYLOAD = "x] = 1 THEN 1 END) AS a FROM sys.objects; SELECT [y";
const QUOTED = "[x]] = 1 THEN 1 END) AS a FROM sys.objects; SELECT [y]";

const executed: string[] = [];

vi.mock("../src/connection.js", () => {
  const onDatabase = async (_c: unknown, _db: unknown, sql: string) => {
    executed.push(sql);
    if (sql.includes("sys.foreign_keys")) {
      return {
        recordset: [
          {
            fkName: "FK_evil",
            parentSchema: "dbo",
            parentTable: PAYLOAD,
            parentColumn: PAYLOAD,
            refSchema: "dbo",
            refTable: "Ref",
            refColumn: PAYLOAD,
          },
        ],
      };
    }
    if (sql.includes("sys.columns")) {
      return { recordset: [{ name: PAYLOAD, dataType: "varchar", max_length: 10 }] };
    }
    return { recordset: [{ totalRows: 0, totalNonNull: 0, orphanCount: 0 }] };
  };
  return {
    executeQuery: async (_c: unknown, sql: string) => onDatabase(_c, undefined, sql),
    executeQueryOnDatabase: onDatabase,
    executeReadOnlyOnDatabase: onDatabase,
    withDedicatedConnection: async () => {
      throw new Error("not used in these tests");
    },
    getPool: async () => ({}),
    closePool: async () => {},
  };
});

const { validateDataTypesHandler } = await import("../src/tools/integrity/validate-data-types.js");
const { nullAnalysisHandler } = await import("../src/tools/integrity/null-analysis.js");
const { checkReferentialIntegrityHandler } = await import(
  "../src/tools/integrity/check-referential-integrity.js"
);

const config = { maxRows: 10, auditLog: false } as never;

/** The analysis queries (everything after the catalog lookup). */
function analysisQueries(): string[] {
  return executed.filter((q) => !q.includes("sys.columns") && !q.includes("sys.foreign_keys"));
}

/** One statement: once literals and [identifiers] are blanked, no `;` is left. */
function expectSingleStatement(sql: string): void {
  const masked = maskLiteralsAndIdentifiers(sql);
  expect(masked).not.toBeNull();
  expect(masked).not.toContain(";");
  expect(masked).not.toMatch(/sys\.objects/i);
}

beforeEach(() => {
  executed.length = 0;
});

describe("quoteName / quoteLiteral", () => {
  it("doubles closing brackets like QUOTENAME", () => {
    expect(quoteName(PAYLOAD)).toBe(QUOTED);
    expect(quoteName("a]]b")).toBe("[a]]]]b]");
    expect(quoteName("normal")).toBe("[normal]");
  });

  it("doubles single quotes in an N'' literal", () => {
    expect(quoteLiteral("O'Brien")).toBe("N'O''Brien'");
    expect(quoteLiteral("x'; DROP TABLE t; SELECT '")).toBe("N'x''; DROP TABLE t; SELECT '''");
  });
});

describe("catalog names are quoted before reuse (second-order injection)", () => {
  it("validate_data_types", async () => {
    await validateDataTypesHandler(config, { database: "D", table: "T" });
    const queries = analysisQueries();
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain(QUOTED);
    expect(queries[0]).toContain(quoteLiteral(PAYLOAD));
    expectSingleStatement(queries[0]);
  });

  it("check_null_analysis", async () => {
    await nullAnalysisHandler(config, { database: "D", table: "T" });
    const queries = analysisQueries();
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain(QUOTED);
    expectSingleStatement(queries[0]);
  });

  it("check_referential_integrity", async () => {
    await checkReferentialIntegrityHandler(config, { database: "D" });
    const queries = analysisQueries();
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain(`[dbo].${QUOTED}`);
    expect(queries[0]).toContain(`p.${QUOTED}`);
    expectSingleStatement(queries[0]);
  });
});
