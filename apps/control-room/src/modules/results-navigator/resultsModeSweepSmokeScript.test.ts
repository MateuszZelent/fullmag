import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJsonUrl = new URL("../../../package.json", import.meta.url);
const smokeScriptUrl = new URL(
  "../../../scripts/smoke-results-mode-sweep.mjs",
  import.meta.url,
);

describe("Results mode sweep smoke script", () => {
  it("is registered and exposes the fixture proof contract", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["smoke:results-mode-sweep"]).toBe(
      "node scripts/smoke-results-mode-sweep.mjs",
    );
    expect(existsSync(smokeScriptUrl)).toBe(true);

    const smokeScript = readFileSync(smokeScriptUrl, "utf8");
    expect(smokeScript).toContain("installResultsFixtureRoutes");
    expect(smokeScript).toContain("Time-domain spectrum fixture");
    expect(smokeScript).toContain("Dynamic structure factor fixture");
    expect(smokeScript).not.toContain("datasetRows.first()");
    expect(smokeScript).toContain('transverse_components: ["x", "y"]');
    expect(smokeScript).toContain(".fm-ribbon__tab");
    expect(smokeScript).toContain(".fm-results-navigator");
    expect(smokeScript).toContain(".fm-analysis-plots");
    expect(smokeScript).toContain("typed dataset manifest");
    expect(smokeScript).toContain("legacy");
    expect(smokeScript).toContain("partial");
    expect(smokeScript).toContain("data-result-item-id");
    expect(smokeScript).toContain("keyboard");
    expect(smokeScript).toContain("selection");
    expect(smokeScript).toContain("overlay");
    expect(smokeScript).toContain("200%");
    expect(smokeScript).toContain("Mocha");
    expect(smokeScript).toContain("Latte");
    expect(smokeScript).toContain('page.emulateMedia({ reducedMotion: "reduce" })');
    expect(smokeScript).toContain("mediaMatches");
    expect(smokeScript).toContain("NOT VERIFIED");
    expect(smokeScript).toContain("isContextLost");
  });
});
