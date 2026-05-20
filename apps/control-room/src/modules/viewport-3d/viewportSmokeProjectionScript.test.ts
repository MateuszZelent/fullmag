import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const smokeScriptUrl = new URL(
  "../../../scripts/smoke-viewport-3d.mjs",
  import.meta.url,
);

describe("viewport smoke projection round-trip", () => {
  it("toggles relative to the initial projection state", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain('const initialActive = await projectionToggle.getAttribute("data-active")');
    expect(smokeScript).toContain('const firstExpectedActive = initialActive === "true" ? "false" : "true"');
    expect(smokeScript).toContain('const secondExpectedActive = initialActive === "true" ? "true" : "false"');
    expect(smokeScript).toContain('if (active === firstExpectedActive) return true');
    expect(smokeScript).toContain('if (active === secondExpectedActive) return true');
  });
  it("passes the compute metrics label into the browser evaluation context", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain("return page.evaluate(({ label, measureNames }) => {");
    expect(smokeScript).toContain("}, { label, measureNames: COMPUTE_PERFORMANCE_MEASURE_NAMES });");
  });

  it("passes only measure names into the init script probe installer", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain("await page.addInitScript((measureNames) => {");
    expect(smokeScript).toContain("}, COMPUTE_PERFORMANCE_MEASURE_NAMES);");
  });

  it("enables React render profiling and reports render measure totals", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain("REACT_RENDER_MEASURE_NAMES");
    expect(smokeScript).toContain("window.__FULLMAG_REACT_PROFILER__ = true");
    expect(smokeScript).toContain("reactRenderMeasureCount");
    expect(smokeScript).toContain("reactRenderMeasureTotals");
  });

  it("marks controlled missing-session smoke runs in browser config", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain("allowMissingSessionSmoke");
    expect(smokeScript).toContain("allowMissingSessionSmoke: allowMissingSession");
    expect(smokeScript).toContain("window.__FULLMAG_CONFIG__");
  });

});
