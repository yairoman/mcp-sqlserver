import { describe, it, expect } from "vitest";
import { buildWhereClause, buildOrderBy } from "../src/tools/data/read-table-data.js";

describe("read_table_data filters DSL", () => {
  it("binds every value as a parameter", () => {
    const { clause, params } = buildWhereClause([
      { column: "Status", operator: "=", value: "Active' OR 1=1" },
      { column: "Age", operator: ">", value: 18 },
      { column: "Pais", operator: "in", value: ["CL", "PE"] },
      { column: "Baja", operator: "IS NULL" },
    ]);
    expect(clause).toBe(
      " WHERE [Status] = @f0 AND [Age] > @f1 AND [Pais] IN (@f2, @f3) AND [Baja] IS NULL"
    );
    expect(params).toEqual({ f0: "Active' OR 1=1", f1: 18, f2: "CL", f3: "PE" });
  });

  it("returns an empty clause without filters", () => {
    expect(buildWhereClause(undefined)).toEqual({ clause: "", params: {} });
  });

  it("rejects unknown operators, bad columns and bad values", () => {
    expect(() => buildWhereClause([{ column: "a", operator: "= 1 OR 1=1 --", value: 1 }])).toThrow(
      /Unsupported filter operator/
    );
    expect(() => buildWhereClause([{ column: "a]; DROP TABLE t", operator: "=", value: 1 }])).toThrow(
      /Invalid SQL identifier/
    );
    expect(() => buildWhereClause([{ column: "a", operator: "IN", value: [] }])).toThrow();
    expect(() => buildWhereClause([{ column: "a", operator: "=", value: { x: 1 } }])).toThrow();
    expect(() => buildWhereClause("1=1 UNION SELECT name FROM sys.sql_logins")).toThrow();
  });
});

describe("read_table_data orderBy", () => {
  it("accepts column lists with ASC/DESC", () => {
    expect(buildOrderBy("CreatedDate DESC, Id")).toBe(" ORDER BY [CreatedDate] DESC, [Id]");
    expect(buildOrderBy("[Total] asc")).toBe(" ORDER BY [Total] ASC");
    expect(buildOrderBy(undefined)).toBe("");
  });

  it("rejects anything that is not a column list", () => {
    expect(() => buildOrderBy("1; DROP TABLE t")).toThrow();
    expect(() => buildOrderBy("(SELECT TOP 1 name FROM sys.sql_logins)")).toThrow();
    expect(() => buildOrderBy("Id DESC OFFSET 0 ROWS")).toThrow();
  });
});
