import { describe, expect, it } from "vitest";
import { runBench, type BenchRow } from "./bench";

describe("performance bench", () => {
  it("wudc", async () => {
    const result = await runBench("wudc");
    for (const row of result.rows as BenchRow[]) {
      if (!row.passed) {
        const miss = row.medianMs - (row.targetMs ?? row.medianMs);
        expect.fail(`${row.operation} missed target by ${miss.toFixed(1)} ms`);
      }
    }
  }, 300_000);

  it("xl", async () => {
    const result = await runBench("xl");
    expect(result.rows.length).toBe(6);
  }, 600_000);
});
