import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJsonUrl = new URL("../../../package.json", import.meta.url);
const smokeScriptUrl = new URL(
  "../../../scripts/smoke-compute-performance.mjs",
  import.meta.url,
);

describe("compute performance smoke script", () => {
  it("is exposed as a strict browser smoke for runtime compute commands", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["smoke:compute-performance"]).toBe(
      "node scripts/smoke-compute-performance.mjs",
    );
    expect(existsSync(smokeScriptUrl)).toBe(true);

    const smokeScript = readFileSync(smokeScriptUrl, "utf8");
    expect(smokeScript).toContain("STRICT_COMPUTE_ACTIONS");
    expect(smokeScript).toContain('"study.compute-fields"');
    expect(smokeScript).toContain('"study.compute-energies"');
    expect(smokeScript).toContain('"study.run"');
    expect(smokeScript).toContain("window.__FULLMAG_REACT_PROFILER__ = true");
    expect(smokeScript).toContain('observePerformanceEntries("longtask"');
    expect(smokeScript).toContain('observePerformanceEntries("measure"');
    expect(smokeScript).toContain("reactRenderMeasureTotals");
    expect(smokeScript).toContain("commandRequestCount");
    expect(smokeScript).toContain("waitForEnabledAction");
    expect(smokeScript).toContain("cleanupSolveCommand");
    expect(smokeScript).toContain("waitForCommandSettled");
    expect(smokeScript).toContain("TERMINAL_COMMAND_STATUSES");
    expect(smokeScript).toContain("Active session status is unavailable");
  });
});
