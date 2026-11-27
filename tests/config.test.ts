import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const BASE = {
  MSSQL_HOST: "localhost",
  MSSQL_USER: "mcp_reader",
  MSSQL_PASSWORD: "placeholder",
};

function cfg(extra: Record<string, string | undefined> = {}) {
  return loadConfig({ ...BASE, ...extra } as NodeJS.ProcessEnv);
}

describe("loadConfig: read-only fails closed", () => {
  it("defaults to read-only", () => {
    expect(cfg().readOnly).toBe(true);
  });

  it.each(["false", "FALSE", "False", " false "])("only an explicit false (%j) disables it", (v) => {
    expect(cfg({ MSSQL_READ_ONLY: v }).readOnly).toBe(false);
  });

  it.each(["true", "TRUE", "1", "yes", "0", "no", "", "flase", "off"])(
    "any other value (%j) keeps read-only on",
    (v) => {
      expect(cfg({ MSSQL_READ_ONLY: v }).readOnly).toBe(true);
    }
  );
});

describe("loadConfig: encrypt fails closed", () => {
  it("defaults to encrypted", () => {
    expect(cfg().encrypt).toBe(true);
  });

  it.each(["false", "FALSE"])("only an explicit false (%j) disables it", (v) => {
    expect(cfg({ MSSQL_ENCRYPT: v }).encrypt).toBe(false);
  });

  it.each(["TRUE", "1", "no", "0", ""])("any other value (%j) keeps it on", (v) => {
    expect(cfg({ MSSQL_ENCRYPT: v }).encrypt).toBe(true);
  });
});

describe("loadConfig: trustServerCertificate fails closed", () => {
  it("defaults to false (validate the certificate)", () => {
    expect(cfg().trustServerCertificate).toBe(false);
  });

  it.each(["true", "TRUE", " True "])("only an explicit true (%j) enables it", (v) => {
    expect(cfg({ MSSQL_TRUST_SERVER_CERTIFICATE: v }).trustServerCertificate).toBe(true);
  });

  it.each(["1", "yes", "", "false", "ture"])("any other value (%j) keeps it off", (v) => {
    expect(cfg({ MSSQL_TRUST_SERVER_CERTIFICATE: v }).trustServerCertificate).toBe(false);
  });
});

describe("loadConfig: required fields and numbers", () => {
  it("throws when host, user or password is missing", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/Configuration validation failed/);
    expect(() => loadConfig({ ...BASE, MSSQL_PASSWORD: "" } as NodeJS.ProcessEnv)).toThrow(
      /password/
    );
  });

  it("coerces numeric settings and applies defaults", () => {
    const c = cfg({ MSSQL_PORT: "14330", MSSQL_MAX_ROWS: "50" });
    expect(c.port).toBe(14330);
    expect(c.maxRows).toBe(50);
    expect(c.database).toBe("master");
    expect(c.queryTimeout).toBe(30000);
  });

  it("rejects non-numeric limits", () => {
    expect(() => cfg({ MSSQL_MAX_ROWS: "lots" })).toThrow(/maxRows/);
  });
});
