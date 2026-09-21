import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../../scripts/smoke-live-charts.mjs", import.meta.url), "utf8");
const start = source.indexOf("async function verifyCanonicalCsvExport(page)");
const end = source.indexOf("async function verifySignalSearchAndBulkSelection", start);
const validCsv = "series_id,row_id,x,y,x_unit,y_unit,data_revision,decimation\nseries:mx,1,1,0.97982,1,1,1,minmax_lttb";

describe("canonical CSV browser verification", () => {
  async function run(newContent: string | null) {
    const downloads = [{ filename: "old.csv", content: validCsv }];
    const window = { __FULLMAG_LIVE_CHARTS_SMOKE__: { downloads } };
    const evaluate = (callback: (...args: unknown[]) => unknown, argument?: unknown) =>
      new Function("window", "argument", `return (${callback.toString()})(argument)`)(window, argument);
    const page = {
      evaluate,
      waitForFunction: (callback: (...args: unknown[]) => unknown, argument: unknown) => {
        if (!evaluate(callback, argument)) throw new Error("No new download");
      },
    };
    const verify = new Function("keyboardExport", "timeoutMs", "EXACT_VALUES", "numbersEqual", `${source.slice(start, end)}; return verifyCanonicalCsvExport;`)(
      async () => { if (newContent !== null) downloads.push({ filename: "new.csv", content: newContent }); },
      100, { mx: 0.97982 }, (a: number, b: number) => a === b,
    );
    return verify(page);
  }

  it("rejects a missing new export even when an older valid CSV exists", async () => {
    await expect(run(null)).rejects.toThrow("No new download");
  });
  it("validates the newly exported contents rather than the older valid CSV", async () => {
    await expect(run("wrong,header")).rejects.toThrow("Canonical CSV header differs");
  });
  it("accepts a new valid export", async () => {
    await expect(run(validCsv)).resolves.toBeUndefined();
  });
});
