import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJsonUrl = new URL("../../../package.json", import.meta.url);
const smokeScriptUrl = new URL(
  "../../../scripts/smoke-cross-section-workflow.mjs",
  import.meta.url,
);
const cdpSmokeScriptUrl = new URL(
  "../../../scripts/smoke-cross-section-workflow-cdp.mjs",
  import.meta.url,
);

describe("cross-section workflow smoke script", () => {
  it("is exposed as a browser proof for the 2D cross-section workflow", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["smoke:cross-section-workflow"]).toBe(
      "node scripts/smoke-cross-section-workflow.mjs",
    );
    expect(existsSync(smokeScriptUrl)).toBe(true);
    expect(existsSync(cdpSmokeScriptUrl)).toBe(true);

    const smokeScript = readFileSync(smokeScriptUrl, "utf8");
    const cdpSmokeScript = readFileSync(cdpSmokeScriptUrl, "utf8");
    expect(smokeScript).toContain("smoke-cross-section-workflow-cdp.mjs");
    expect(smokeScript).toContain('"ribbon.cross-section.begin-draft"');
    expect(smokeScript).toContain('"model:visualizations-2d:draft"');
    expect(smokeScript).toContain('"model:visualizations-2d:plot-1"');
    expect(smokeScript).toContain('"Create 2D Plot"');
    expect(smokeScript).toContain(".fm-viewport-2d canvas");
    expect(smokeScript).toContain("waitForWebGLCanvasReady");
    expect(smokeScript).toContain("gl.isContextLost()");
    expect(smokeScript).toContain("makeCrossSectionBuffer");
    expect(smokeScript).toContain("makeCrossSectionQualityBuffer");
    expect(smokeScript).toContain("3d=cut-frame");
    expect(smokeScript).toContain("viewport-2d=webgl");
    expect(cdpSmokeScript).toContain("Target.createTarget");
    expect(cdpSmokeScript).toContain("Page.captureScreenshot");
    expect(cdpSmokeScript).toContain("controlRoomApiBase");
    expect(cdpSmokeScript).toContain("driver=cdp");
  });
});
