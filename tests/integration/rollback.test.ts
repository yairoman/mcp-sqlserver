import { describe, it, expect, afterAll } from "vitest";
import { closePool, executeReadOnlyOnDatabase } from "../../src/connection.js";
import { itConfig, itDatabase, readOutside } from "./helpers.js";

// The always-rolled-back transaction is defence in depth: it only matters if a
// write gets past the text validator. The read-only login cannot write at all,
// so this file uses the "writer" login, whose ONLY write right is UPDATE on
// dbo.Contador, and calls the connection layer directly (no validator).

const config = itConfig("writer");
const database = itDatabase();

afterAll(async () => {
  await closePool();
});

describe("executeReadOnlyOnDatabase rolls back what slipped through", () => {
  it("an UPDATE runs, is visible inside the transaction, and is undone", async () => {
    const result = await executeReadOnlyOnDatabase(
      config,
      database,
      "UPDATE dbo.Contador SET Valor = 42 WHERE Id = 1; SELECT Valor FROM dbo.Contador WHERE Id = 1"
    );
    // The write really happened inside the transaction...
    expect(result.rowsAffected.some((n) => n >= 1)).toBe(true);
    expect((result.recordset[0] as { Valor: number }).Valor).toBe(42);

    // ...and is gone afterwards, seen from a different connection.
    const after = await readOutside<{ Valor: number }>("SELECT Valor FROM dbo.Contador WHERE Id = 1");
    expect(after[0].Valor).toBe(1);
  });

  it("rolls back when the batch fails after the write", async () => {
    await expect(
      executeReadOnlyOnDatabase(
        config,
        database,
        "UPDATE dbo.Contador SET Valor = 43 WHERE Id = 1; SELECT 1 / 0 AS boom"
      )
    ).rejects.toThrow(/divide by zero/i);

    const after = await readOutside<{ Valor: number }>("SELECT Valor FROM dbo.Contador WHERE Id = 1");
    expect(after[0].Valor).toBe(1);
  });
});
