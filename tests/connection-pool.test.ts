import { describe, it, expect, vi, beforeEach } from "vitest";

// A fake mssql ConnectionPool whose connect() the test resolves or rejects by
// hand, so it can hold a connection attempt "in flight". No SQL Server needed.
interface Deferred {
  resolve: () => void;
  reject: (error: Error) => void;
}

const pools: FakePoolShape[] = [];
interface FakePoolShape {
  connected: boolean;
  connectCalls: number;
  closeCalls: number;
  listeners: string[];
  pending: Deferred | null;
}

vi.mock("mssql", () => {
  class FakePool implements FakePoolShape {
    connected = false;
    connectCalls = 0;
    closeCalls = 0;
    listeners: string[] = [];
    pending: Deferred | null = null;
    constructor(_cfg: unknown) {
      pools.push(this);
    }
    on(event: string) {
      this.listeners.push(event);
      return this;
    }
    connect() {
      this.connectCalls++;
      return new Promise<this>((resolve, reject) => {
        this.pending = {
          resolve: () => {
            this.connected = true;
            resolve(this);
          },
          reject,
        };
      });
    }
    async close() {
      this.closeCalls++;
      this.connected = false;
    }
  }
  const sql = { ConnectionPool: FakePool };
  return { default: sql, ...sql };
});

const { getPool, closePool } = await import("../src/connection.js");
const { loadConfig } = await import("../src/config.js");

const config = loadConfig({
  MSSQL_HOST: "localhost",
  MSSQL_USER: "u",
  MSSQL_PASSWORD: "p",
} as NodeJS.ProcessEnv);

/** Let the connect() call inside getPool run so `pending` is set. */
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  // Settle anything a previous test left connecting, then reset.
  for (const p of pools) p.pending?.resolve();
  await closePool();
  pools.length = 0;
});

describe("getPool", () => {
  it("N concurrent calls before the pool connects create one pool and call connect once", async () => {
    const calls = Array.from({ length: 5 }, () => getPool(config));
    await tick();
    expect(pools).toHaveLength(1);
    expect(pools[0].connectCalls).toBe(1);

    pools[0].pending!.resolve();
    const results = await Promise.all(calls);
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe(pools[0]);

    // Once connected, later calls reuse it without connecting again.
    expect(await getPool(config)).toBe(pools[0]);
    expect(pools).toHaveLength(1);
    expect(pools[0].connectCalls).toBe(1);
  });

  it("keeps the 'error' listener on the pool", async () => {
    const p = getPool(config);
    await tick();
    expect(pools[0].listeners).toContain("error");
    pools[0].pending!.resolve();
    await p;
  });

  it("a failed connect rejects every waiting caller and the next call retries", async () => {
    const first = getPool(config);
    const second = getPool(config);
    await tick();
    pools[0].pending!.reject(new Error("login failed"));
    await expect(first).rejects.toThrow("login failed");
    await expect(second).rejects.toThrow("login failed");
    expect(pools[0].closeCalls).toBe(1);

    const retry = getPool(config);
    await tick();
    expect(pools).toHaveLength(2);
    pools[1].pending!.resolve();
    expect(await retry).toBe(pools[1]);
  });

  it("closePool during an in-flight connect closes that pool and does not keep it", async () => {
    const inFlight = getPool(config);
    await tick();
    const closing = closePool();
    pools[0].pending!.resolve();
    await closing;

    await expect(inFlight).rejects.toThrow(/closed while connecting/);
    expect(pools[0].closeCalls).toBe(1);

    // The abandoned pool is not reused: the next call connects a fresh one.
    const next = getPool(config);
    await tick();
    expect(pools).toHaveLength(2);
    pools[1].pending!.resolve();
    expect(await next).toBe(pools[1]);
  });

  it("closePool closes a connected pool and the next call reconnects", async () => {
    const p = getPool(config);
    await tick();
    pools[0].pending!.resolve();
    await p;

    await closePool();
    expect(pools[0].closeCalls).toBe(1);

    const again = getPool(config);
    await tick();
    expect(pools).toHaveLength(2);
    pools[1].pending!.resolve();
    expect(await again).toBe(pools[1]);
  });
});
