import { describe, it, expect } from "vitest";
import {
  assertLoopbackHost,
  assertThrowawayServer,
  readIntegrationEnv,
  maskSecrets,
  EXPECTED_MACHINE_NAME,
} from "./integration/guard.js";

// Unit tests of the integration suite's safety guard (no SQL Server needed):
// the suite must refuse to touch anything but the local throwaway container.

describe("assertLoopbackHost", () => {
  it.each(["localhost", "127.0.0.1", "::1", "[::1]", " LOCALHOST "])("accepts %s", (h) => {
    expect(() => assertLoopbackHost(h)).not.toThrow();
  });

  it.each([
    "",
    undefined,
    "sqlprod01",
    "10.0.0.5",
    "192.168.1.10",
    "127.0.0.2",
    "localhost.example.com",
    "db.internal",
    "host.docker.internal",
    "sqlserver",
  ])("refuses %s", (h) => {
    expect(() => assertLoopbackHost(h)).toThrow(/refuse to run/);
  });
});

describe("readIntegrationEnv", () => {
  it("never falls back to MSSQL_HOST", () => {
    expect(() =>
      readIntegrationEnv({ MSSQL_HOST: "sqlprod01", MSSQL_IT_HOST: "sqlprod01", MSSQL_IT_ADMIN_PASSWORD: "x" })
    ).toThrow(/refuse to run/);
    const env = readIntegrationEnv({ MSSQL_HOST: "sqlprod01", MSSQL_IT_ADMIN_PASSWORD: "x" });
    expect(env.host).toBe("127.0.0.1");
  });

  it("fails (does not skip) without admin password", () => {
    expect(() => readIntegrationEnv({})).toThrow(/MSSQL_IT_ADMIN_PASSWORD/);
  });

  it("accepts MSSQL_SA_PASSWORD as the admin password", () => {
    expect(readIntegrationEnv({ MSSQL_SA_PASSWORD: "x" }).adminPassword).toBe("x");
  });

  it("rejects a bad port", () => {
    expect(() => readIntegrationEnv({ MSSQL_IT_ADMIN_PASSWORD: "x", MSSQL_IT_PORT: "abc" })).toThrow(/MSSQL_IT_PORT/);
  });
});

describe("assertThrowawayServer", () => {
  const ok = {
    machineName: EXPECTED_MACHINE_NAME,
    edition: "Developer Edition (64-bit)",
    engineEdition: 3,
    hostPlatform: "Linux",
  };

  it("accepts the docker-compose container", () => {
    expect(() => assertThrowawayServer(ok)).not.toThrow();
  });

  it.each([
    ["another machine", { ...ok, machineName: "SQLPROD01" }],
    ["Windows host", { ...ok, hostPlatform: "Windows" }],
    ["Enterprise edition", { ...ok, edition: "Enterprise Edition: Core-based Licensing (64-bit)" }],
    ["Standard edition", { ...ok, edition: "Standard Edition (64-bit)" }],
    ["unknown identity", { machineName: null, edition: null, engineEdition: null, hostPlatform: null }],
  ])("refuses %s", (_label, id) => {
    expect(() => assertThrowawayServer(id)).toThrow(/not the throwaway docker-compose container/);
  });
});

describe("maskSecrets", () => {
  it("replaces every occurrence", () => {
    expect(maskSecrets("pw=abc;again abc", ["abc", undefined, ""])).toBe("pw=****;again ****");
  });
});
