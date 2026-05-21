import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const smokeScriptUrl = new URL(
  "../../../scripts/smoke-viewport-3d.mjs",
  import.meta.url,
);
const screenshotScriptUrl = new URL(
  "../../../scripts/screenshot-viewport-3d.mjs",
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
    expect(smokeScript).toContain("const initialProjectionSample = await sampleCanvasComposite(page, canvas);");
    expect(smokeScript).toContain("await waitForCanvasCompositeChange(");
    expect(smokeScript).toContain("projection canvas renders after first toggle");
    expect(smokeScript).toContain("projection canvas renders after second toggle");
    expect(smokeScript).toContain("Viewport canvas did not visually change after first projection toggle");
    expect(smokeScript).toContain("Viewport canvas did not visually leave orthographic projection after second toggle");
    expect(smokeScript).toContain("const png = await canvas.screenshot();");
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

  it("guards camera wheel and drag gestures against visualization state PATCH churn", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain("verifyCameraGesturesStayLocal");
    expect(smokeScript).toContain("recordCameraGestureRequests = true");
    expect(smokeScript).toContain('request.method === "PATCH"');
    expect(smokeScript).toContain("request.path === VISUALIZATION_STATE_PATH");
    expect(smokeScript).toContain("visualization_state_patches=0");
  });

  it("verifies the COMSOL-style dimension frame cage with canvas pixels", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain("verifyDimensionFrameCage");
    expect(smokeScript).toContain('name: "Floor + vertical"');
    expect(smokeScript).toContain("viewport-3d.dimension-frame-cage");
    expect(smokeScript).toContain("dimension frame canvas renders after cage mode");
    expect(smokeScript).toContain(
      "Viewport canvas did not visually change after enabling dimension frame cage",
    );
  });

  it("keeps the screenshot gate on the full dimension frame path", () => {
    const screenshotScript = readFileSync(screenshotScriptUrl, "utf8");

    expect(screenshotScript).toContain("enableDimensionFrameCage");
    expect(screenshotScript).toContain('name: "Floor + vertical"');
    expect(screenshotScript).toContain("viewport-3d.dimension-frame-cage");
    expect(screenshotScript).toContain("dimensionFrameChangedPixels=");
  });
});
