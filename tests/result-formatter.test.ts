import { describe, it, expect } from "vitest";
import { formatQueryResult } from "../src/utils/result-formatter.js";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }));

describe("formatQueryResult", () => {
  it("reports the real total when all rows were fetched", () => {
    const out = formatQueryResult(["id"], rows(5), 3, 1);
    expect(out).toContain("(5 rows, 1ms)");
    expect(out).toContain("truncated to 3 rows (total: 5)");
  });

  it("does not invent a total when the server stopped at maxRows + 1", () => {
    const out = formatQueryResult(["id"], rows(4), 3, 1, { serverCapped: true });
    expect(out).toContain("first 3 rows");
    expect(out).toContain("total is unknown");
    expect(out).not.toMatch(/total: 4/);
    expect(out).not.toContain("| 3 |");
  });

  it("is not marked truncated when a capped query returns exactly maxRows", () => {
    const out = formatQueryResult(["id"], rows(3), 3, 1, { serverCapped: true });
    expect(out).toContain("(3 rows, 1ms)");
    expect(out).not.toContain("truncated");
  });
});
