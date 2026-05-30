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
const memoryChurnScriptUrl = new URL(
  "../../../scripts/audit-viewport-3d-memory-churn.mjs",
  import.meta.url,
);
const profileSwitchScriptUrl = new URL(
  "../../../scripts/audit-viewport-3d-profile-switch.mjs",
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
    expect(smokeScript).toContain("const initialProjectionSample = await sampleCanvasComposite(page);");
    expect(smokeScript).toContain("await waitForCanvasCompositeChange(");
    expect(smokeScript).toContain("projection canvas renders after first toggle");
    expect(smokeScript).toContain("projection canvas renders after second toggle");
    expect(smokeScript).toContain("Viewport canvas did not visually change after first projection toggle");
    expect(smokeScript).toContain("Viewport canvas did not visually leave orthographic projection after second toggle");
    expect(smokeScript).toContain("const png = await withTimeout(");
    expect(smokeScript).toContain("CANVAS_SCREENSHOT_TIMEOUT_MS");
    expect(smokeScript).toContain("page.screenshot({");
    expect(smokeScript).toContain("3D viewport canvas composite screenshot");
    expect(smokeScript).toContain("readCanvasContextState(page)");
    expect(smokeScript).toContain("await waitForCanvasClipBox(page)");
    expect(smokeScript).toContain("readCanvasClipBox(page)");
    expect(smokeScript).not.toContain("canvas.evaluate");
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
    expect(smokeScript).toContain("CONTROL_ROOM_SMOKE_CAMERA_ONLY");
    expect(smokeScript).toContain(
      "if (!cameraOnlySmoke && isModelSceneUrl(response.url()) && status < 400)",
    );
    expect(smokeScript).toContain("window.__FULLMAG_CONFIG__");
  });

  it("guards camera wheel and drag gestures against visualization state PATCH churn", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain("verifyCameraGesturesStayLocal");
    expect(smokeScript).toContain("recordCameraGestureRequests = true");
    expect(smokeScript).toContain('request.method === "PATCH"');
    expect(smokeScript).toContain("request.path === VISUALIZATION_STATE_PATH");
    expect(smokeScript).toContain("visualization_state_patches=0");
    expect(smokeScript).toContain('await page.mouse.down({ button: "right" });');
    expect(smokeScript).toContain(
      "right-button free-camera pan changes the viewport camera state",
    );
    expect(smokeScript).toContain(
      "Viewport camera state did not change after right-button free-camera pan",
    );
    expect(smokeScript).toContain("readViewportCameraSignature");
  });

  it("verifies the COMSOL-style dimension frame cage with canvas pixels", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain("verifyDimensionFrameCage");
    expect(smokeScript).toContain("selectDimensionFrameMode(page, \"Off\")");
    expect(smokeScript).toContain("selectDimensionFrameMode(page, \"Floor + vertical\")");
    expect(smokeScript).toContain("clickFreshAction");
    expect(smokeScript).toContain("minimumChangedPixels: 1");
    expect(smokeScript).toContain("waitForBrowserPaint");
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
    expect(screenshotScript).toContain("profileChangedPixels=");
    expect(screenshotScript).not.toContain(
      "interactive/figure screenshots are too similar",
    );
    expect(screenshotScript).toContain('fillDraftField(page, "Size X", "9e-7")');
    expect(screenshotScript).toContain(
      'fillDraftField(page, "Translation X", "-1.6e-6")',
    );
    expect(screenshotScript).toContain("await waitForCanvasClipBox(page)");
    expect(screenshotScript).not.toContain("canvas.evaluate");
  });

  it("lets the screenshot gate use a controlled missing-session canvas", () => {
    const screenshotScript = readFileSync(screenshotScriptUrl, "utf8");

    expect(screenshotScript).toContain("CONTROL_ROOM_SCREENSHOT_ALLOW_MISSING_SESSION");
    expect(screenshotScript).toContain(
      'const defaultRequiredScenes = allowMissingSession ? "fdm" : "fdm,fem,object";',
    );
    expect(screenshotScript).toContain("useMainPageFdmFixture");
    expect(screenshotScript).toContain(
      "process.env.CONTROL_ROOM_SCREENSHOT_SCENES ?? defaultRequiredScenes",
    );
    expect(screenshotScript).toContain("missingSessionFixtureRequests");
    expect(screenshotScript).toContain("await installFdmFixtureApi(page, missingSessionFixtureRequests)");
    expect(screenshotScript).toContain("allowMissingSessionSmoke");
    expect(screenshotScript).toContain("isAllowedMissingSessionResponse");
  });

  it("keeps the memory churn fixture isolated from live realtime websocket events", () => {
    const memoryChurnScript = readFileSync(memoryChurnScriptUrl, "utf8");

    expect(memoryChurnScript).toContain("disableRealtime: true");
    expect(memoryChurnScript).toContain(
      "Cached quantity switching refetched field resources",
    );
  });

  it("finds viewport diagnostics by content instead of a fixed HUD index", () => {
    const profileSwitchScript = readFileSync(profileSwitchScriptUrl, "utf8");

    expect(profileSwitchScript).toContain("openViewport3D(page)");
    expect(profileSwitchScript).toContain(
      'page.getByRole("tab", { exact: true, name: "View" })',
    );
    expect(profileSwitchScript).toContain("await page.waitForFunction(");
    expect(profileSwitchScript).toContain("const value = await page.evaluate(");
    expect(profileSwitchScript).toContain("waitForStableDiagnostics(page)");
    expect(profileSwitchScript).toContain(
      "current.cacheBytes === previous.cacheBytes",
    );
    expect(profileSwitchScript).toContain("Date.now() + 45_000");
    expect(profileSwitchScript).toContain(
      "spans.some((span) => span.textContent?.includes(\"geo:\"))",
    );
    expect(profileSwitchScript).toContain(
      "spans.find((span) => span.textContent?.includes(\"geo:\"))",
    );
    expect(profileSwitchScript).not.toContain(
      "locator(\".fm-viewport-3d__hud span\").nth(4)",
    );
  });
});
