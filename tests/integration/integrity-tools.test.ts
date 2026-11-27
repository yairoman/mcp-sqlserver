import { describe, it, expect, afterAll } from "vitest";
import { callTool } from "../../src/tools/registry.js";
import { closePool } from "../../src/connection.js";
import { itConfig, itDatabase } from "./helpers.js";
import { SEED } from "./seed.js";

// Integrity tools against real data, as the read-only login. The columns with
// `]` in their name carry the findings: if quoting failed, the tool would
// swallow the SQL error and the finding would be missing from the output.

const config = itConfig("reader");
const database = itDatabase();

afterAll(async () => {
  await closePool();
});

describe("validate_data_types", () => {
  it("flags the numeric-text and date-text columns whose names contain ]", async () => {
    const r = await callTool(config, "validate_data_types", { database, table: SEED.pedidos });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("Data Type Issues");
    expect(r.text).toContain(SEED.numericTextColumn);
    expect(r.text).toMatch(/100\.0% numeric values/);
    expect(r.text).toContain(SEED.dateTextColumn);
    expect(r.text).toMatch(/100\.0% date values/);
  });
});

describe("check_null_analysis", () => {
  it("counts NULLs per column, including the column whose name contains ]", async () => {
    const r = await callTool(config, "check_null_analysis", { database, table: SEED.pedidos });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain(`(${SEED.pedidosRows} rows)`);

    const row = (column: string) => r.text.split("\n").find((l) => l.includes(`| ${column} |`));
    // Cliente]Id: 1 NULL out of 10.
    expect(row(SEED.fkColumn), r.text).toMatch(/\|\s*1\s*\|\s*10\s*\|\s*10\.00%/);
    // Notas: 6 NULLs out of 10 -> "High".
    expect(row(SEED.mostlyNullColumn), r.text).toMatch(/\|\s*6\s*\|\s*10\s*\|\s*60\.00%.*High/);
    // Codigo]Postal: complete.
    expect(row(SEED.numericTextColumn), r.text).toMatch(/\|\s*0\s*\|\s*10\s*\|\s*0\.00%/);
  });

  it("rejects a table name with ] before reaching the server", async () => {
    const r = await callTool(config, "check_null_analysis", { database, table: "Pedidos]x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Invalid SQL identifier");
  });
});

describe("check_referential_integrity", () => {
  it("finds the orphans of an FK whose columns contain ] (whole database)", async () => {
    const r = await callTool(config, "check_referential_integrity", { database });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("Referential Integrity Violations");
    const line = r.text.split("\n").find((l) => l.includes(SEED.fkName));
    expect(line, r.text).toBeDefined();
    expect(line).toContain(SEED.fkColumn);
    expect(line).toContain(SEED.refColumn);
    expect(line).toMatch(new RegExp(`\\|\\s*${SEED.orphanRows}\\s*\\|\\s*$`));
  });

  it("finds the same orphans when filtered by table", async () => {
    const r = await callTool(config, "check_referential_integrity", { database, table: SEED.pedidos });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain(SEED.fkName);
  });

  it("reports no FKs for a table without them", async () => {
    const r = await callTool(config, "check_referential_integrity", { database, table: SEED.numeros });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("No foreign keys found");
  });
});
