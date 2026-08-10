import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  DATA_FIELD_VECTOR_PATH,
  DATA_FIELDS_PATH,
  MESHING_SUMMARY_PATH,
  MODEL_SCENE_PATH,
  MODEL_SYNCS_PATH,
  SESSION_EVENTS_WS_PATH,
  VISUALIZATION_STATE_PATH,
} from "@/kernel/api/apiPaths";

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
const femTopologyUploadAuditScriptUrl = new URL(
  "../../../scripts/audit-viewport-3d-fem-topology-uploads.mjs",
  import.meta.url,
);
const profileSwitchScriptUrl = new URL(
  "../../../scripts/audit-viewport-3d-profile-switch.mjs",
  import.meta.url,
);
const justfileUrl = new URL("../../../../../justfile", import.meta.url);

function endpointFamilyLiteral(path: string, suffix: string): string {
  const suffixStart = path.lastIndexOf(suffix);

  if (suffixStart < 0) {
    throw new Error(`Expected ${path} to contain ${suffix}`);
  }

  return JSON.stringify(path.slice(0, suffixStart));
}

describe("viewport smoke projection round-trip", () => {
  it("refuses mutating an existing session without a disposable script guard", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain(
      'import { createSmokeMutationGuard } from "./lib/smoke-session-isolation.mjs"',
    );
    expect(smokeScript).toContain("const requiresDisposableSession =");
    expect(smokeScript).toContain("mutationRequired: requiresDisposableSession");
    expect(smokeScript).toContain("mutationGuard.installProcessGuards()");
    expect(smokeScript).toContain("mutationGuard.restoreAndVerify()");
    expect(smokeScript).toContain("Viewport smoke fixture isolation passed:");
  });

  it("provides a launcher that binds mutating smoke to a temporary script", () => {
    const justfile = readFileSync(justfileUrl, "utf8");

    expect(justfile).toContain("run-viewport-3d-smoke-disposable");
    expect(justfile).toContain('smoke_dir="$(TMPDIR=/tmp mktemp -d)"');
    expect(justfile).toContain("TMPDIR=/tmp");
    expect(justfile).toContain('cp "$fixture" "$smoke_script"');
    expect(justfile).toContain(".fullmag-smoke-disposable");
    expect(justfile).toContain("CONTROL_ROOM_SMOKE_DISPOSABLE_SCRIPT_PATH");
    expect(justfile).toContain("CONTROL_ROOM_SMOKE_DISPOSABLE_FIXTURE_TOKEN");
  });

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

  it("rechecks the final WebGL context and drawing buffer after every smoke flow", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain("assertFinalViewportWebGLState");
    expect(smokeScript).toContain("isContextLost");
    expect(smokeScript).toContain("contextLost: context?.isContextLost() ?? true");
    expect(smokeScript).toContain("3D viewport WebGL context is lost after");
    expect(smokeScript).toContain("3D viewport final drawing buffer is empty after");
    expect(smokeScript).toContain("finalWebGL");
  });
  it("passes the compute metrics label into the browser evaluation context", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain(
      "return page.evaluate(({ label, measureNames, scope }) => {",
    );
    expect(smokeScript).toContain(
      "}, { label, measureNames: COMPUTE_PERFORMANCE_MEASURE_NAMES, scope });",
    );
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
    expect(smokeScript).toContain("longAnimationFrameCount");
    expect(smokeScript).toContain("phaseElapsedMs");
    expect(smokeScript).toContain("longAnimationFrameTopInvokers");
    expect(smokeScript).toContain("viewportFrameDelta");
    expect(smokeScript).toContain("viewportDiagnostics");
  });

  it("splits viewport smoke performance metrics into actionable phases", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain("__FULLMAG_RESET_VIEWPORT_3D_PERFORMANCE__");
    expect(smokeScript).toContain("resetViewport3DPerformanceProbe");
    expect(smokeScript).toContain("collectViewport3DPerformancePhase");
    expect(smokeScript).toContain("Viewport 3D phased compute metrics:");
    expect(smokeScript).toContain('"long-animation-frame"');
    expect(smokeScript).toContain('"startup-to-canvas"');
    expect(smokeScript).not.toContain('"viewport-focus"');
    expect(smokeScript).toContain('"camera-orbit-rotate"');
    expect(smokeScript).toContain('"camera-wheel-zoom"');
    expect(smokeScript).toContain('"camera-right-pan"');
    expect(smokeScript).toContain("assertSmoothCameraWheelZoomPhase");
    expect(smokeScript).toContain("viewportFrameDelta < 2");
    expect(smokeScript).toContain("assertResponsiveCameraRightPanPhase");
    expect(smokeScript).toContain(
      "cameraPhaseHasBlockingLongAnimationFrames(phase)",
    );
    expect(smokeScript).toContain("longAnimationFrameBlockingMs > 0");
    expect(smokeScript).toContain("Camera right-button pan produced blocking long animation frames");
    expect(smokeScript).toContain("viewportMeasureCount > 0");
    expect(smokeScript).toContain("const gesturePerformancePhases = []");
    expect(smokeScript).toContain("return gesturePerformancePhases");
    expect(smokeScript).toContain('"projection-round-trip"');
    expect(smokeScript).toContain('"dimension-frame-cage"');
    expect(smokeScript).toContain('"geometry-authoring"');
    expect(smokeScript).toContain("scope: \"phase\"");
    expect(smokeScript).toContain("scope: \"all\"");
    expect(smokeScript).toContain("state.phaseStartTime");
    expect(smokeScript).toContain("state.phaseViewportDiagnostics");
    expect(smokeScript).toContain('scope === "phase"');
    expect(smokeScript).toContain("viewportDiagnostics?.frames ?? 0");
    expect(smokeScript).toContain("__FULLMAG_READ_VIEWPORT_3D_DIAGNOSTICS__");
  });

  it("does not confuse a selectable canvas click with a camera gesture", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).not.toContain('"viewport focus"');
    expect(smokeScript).not.toContain("await page.mouse.click(x, y);");
    expect(smokeScript.indexOf("const initialCameraSignature")).toBeLessThan(
      smokeScript.indexOf('"orbit rotate"'),
    );
  });

  it("excludes smoke harness canvas sampling from viewport long-task metrics", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain("probeWindows: []");
    expect(smokeScript).toContain("__FULLMAG_BEGIN_VIEWPORT_3D_PROBE__");
    expect(smokeScript).toContain("__FULLMAG_END_VIEWPORT_3D_PROBE__");
    expect(smokeScript).toContain("withViewport3DPerformanceProbePaused");
    expect(smokeScript).toContain("longTaskOverlapsProbeWindow");
    expect(smokeScript).toContain(
      "const longTasks = state.longTasks.filter(",
    );
    expect(smokeScript).toContain(
      "!longTaskOverlapsProbeWindow(entry, probeWindows)",
    );
    expect(smokeScript).toContain(
      "return withViewport3DPerformanceProbePaused(page, async () => {",
    );
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
    expect(smokeScript).toContain(
      `text.includes("${SESSION_EVENTS_WS_PATH}")`,
    );
    expect(smokeScript).toContain('text.includes("net::ERR_INVALID_HTTP_RESPONSE")');
    expect(smokeScript).toContain(
      `allowMissingSession &&\n    text.includes("${SESSION_EVENTS_WS_PATH}")`,
    );
  });

  it("can verify hysteresis replay routes snapshots through the field data plane", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");
    const hysteresisChartSource = readFileSync(
      new URL("../../shared/domain/study/HysteresisChart.tsx", import.meta.url),
      "utf8",
    );

    expect(smokeScript).toContain("CONTROL_ROOM_SMOKE_HYSTERESIS_REPLAY");
    expect(smokeScript).toContain("CONTROL_ROOM_SMOKE_HYSTERESIS_REPLAY_ONLY");
    expect(smokeScript).toContain("verifyHysteresisChartReplaySmoke");
    expect(smokeScript).toContain("verifyHysteresisReplaySmoke");
    expect(smokeScript).toContain("if (hysteresisReplayOnly) {");
    expect(smokeScript).toContain("enableAuditHooks: hysteresisReplaySmoke");
    expect(smokeScript).toContain("loadHysteresisReplaySnapshot");
    expect(smokeScript).toContain(".fm-hysteresis-container");
    expect(smokeScript).toContain("data-hysteresis-point-count");
    expect(smokeScript).toContain("data-hysteresis-active-snapshot-id");
    expect(smokeScript).toContain("data-hysteresis-replay-snapshot-id");
    expect(smokeScript).toContain("data-hysteresis-replay-stage-id");
    expect(smokeScript).toContain('params.get("snapshot_id") === hysteresisReplaySnapshotId');
    expect(smokeScript).toContain('params.get("stage_id") === hysteresisReplayStageId');
    expect(smokeScript).toContain('params.get("component") === "full"');
    expect(smokeScript).toContain('params.get("scope_kind") === "full"');
    expect(smokeScript).toContain("hysteresis replay return-to-live field-vector request");
    expect(smokeScript).toContain('params.get("snapshot_id") == null');
    expect(smokeScript).toContain('params.get("stage_id") == null');
    expect(smokeScript).toContain("Return to live");
    expect(smokeScript).toContain("Hysteresis replay return-to-live smoke passed");
    expect(smokeScript).toContain("Hysteresis replay smoke passed:");
    expect(hysteresisChartSource).toContain("data-hysteresis-stage-id");
    expect(hysteresisChartSource).toContain("data-hysteresis-point-count");
    expect(hysteresisChartSource).toContain("data-hysteresis-active-snapshot-id");
    expect(smokeScript.indexOf("if (hysteresisReplayOnly) {")).toBeLessThan(
      smokeScript.indexOf("verifyCameraGesturesStayLocal"),
    );
  });

  it("asserts camera gestures do not issue data/model/visualization fetches", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain("assertCameraGestureDoesNotFetch");
    expect(smokeScript).toContain("verifyCameraGesturesStayLocal");
    expect(smokeScript).toContain("CAMERA_GESTURE_FORBIDDEN_REQUEST_PREFIXES");
    expect(smokeScript).toContain(
      endpointFamilyLiteral(DATA_FIELDS_PATH, "fields"),
    );
    expect(smokeScript).toContain(
      endpointFamilyLiteral(MODEL_SCENE_PATH, "scene"),
    );
    expect(smokeScript).toContain(
      endpointFamilyLiteral(MESHING_SUMMARY_PATH, "summary"),
    );
    expect(smokeScript).toContain(JSON.stringify(VISUALIZATION_STATE_PATH));
    expect(smokeScript).toContain("recordCameraGestureRequests = true");
    expect(smokeScript).toContain("waitForInitialViewport3DResourceQuiet(page)");
    expect(smokeScript).toContain("activeInitialForbiddenResourceRequests");
    expect(smokeScript).toContain("lastInitialForbiddenResourceRequestAt");
    expect(smokeScript).toContain('request.method === "PATCH"');
    expect(smokeScript).toContain("request.path === VISUALIZATION_STATE_PATH");
    expect(smokeScript).toContain("visualization_state_patches=0");
    expect(smokeScript).toContain("background_resource_requests=0");
    expect(smokeScript).toContain('"orbit rotate"');
    expect(smokeScript).toContain('"orbit pan"');
    expect(smokeScript).toContain('"orbit zoom"');
    expect(smokeScript).toContain('await page.mouse.down({ button: "left" });');
    expect(smokeScript).toContain(
      "left-button orbit rotate changes the viewport camera state",
    );
    expect(smokeScript).toContain(
      "Viewport camera state did not change after left-button orbit rotate",
    );
    expect(smokeScript).toContain('await page.mouse.down({ button: "right" });');
    expect(smokeScript).toContain(
      "right-button free-camera pan changes the viewport camera state",
    );
    expect(smokeScript).toContain(
      "Viewport camera state did not change after right-button free-camera pan",
    );
    expect(smokeScript).toContain("readViewportCameraSignature");
    expect(smokeScript).toContain('node?.getAttribute("data-camera-up")');
    expect(smokeScript).toContain("assertViewportCameraUpIsWorldUp");
    expect(smokeScript).toContain("CONTROL_ROOM_SMOKE_SKIP_CAMERA_GESTURES");
  });

  it("holds orbit rotation across the damping window", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain(
      "for (let step = 1; step <= 12; step += 1)",
    );
    expect(smokeScript).toContain("await page.waitForTimeout(120);");
  });

  it("does not add fixed settle delays to measured camera gesture phases", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");
    const gestureGuardBlock = smokeScript.slice(
      smokeScript.indexOf("async function assertCameraGestureDoesNotFetch"),
      smokeScript.indexOf("function unexpectedCameraGestureRequests"),
    );

    expect(gestureGuardBlock).toContain("waitForCameraGestureSettle(page)");
    expect(gestureGuardBlock).not.toContain("delay(300)");
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

  it("uses current inspector vector labels in the strict geometry authoring smoke", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain('fillDraftField(page, "Size X", "9e-7")');
    expect(smokeScript).toContain('fillDraftField(page, "Size Y", "7e-7")');
    expect(smokeScript).toContain('fillDraftField(page, "Size Z", "1e-7")');
    expect(smokeScript).toContain(
      'fillDraftField(page, "Translation X", "-1.6e-6")',
    );
    expect(smokeScript).not.toContain('fillDraftField(page, "TX"');
  });

  it("uses the transaction SceneDocument for the UI commit before checking observable state", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain("const uiScene =");
    expect(smokeScript).toContain("committedSceneWithObject ??");
    expect(smokeScript).toContain("model/scene fallback refetch after UI object commit");
    expect(smokeScript).not.toContain(
      `GET ${MODEL_SCENE_PATH} refetch after UI object commit`,
    );
  });

  it("verifies object region authoring without degrading mesh topology", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain("verifyRegionAuthoringOverlayFlow");
    expect(smokeScript).toContain("CONTROL_ROOM_SMOKE_REGION_ONLY_OBJECT_ID");
    expect(smokeScript).toContain("isObjectRegionCreateUrl");
    expect(smokeScript).toContain("if (!regionOnlyObjectId)");
    expect(smokeScript.indexOf("if (hysteresisReplayOnly) {")).toBeLessThan(
      smokeScript.indexOf("if (!regionOnlyObjectId)"),
    );
    expect(smokeScript).toContain("ensureExplorerNodeExpanded");
    expect(smokeScript).toContain(
      'if ((await node.getAttribute("aria-expanded")) === "false")',
    );
    expect(smokeScript).toContain('fillDraftField(page, "Name", regionName)');
    expect(smokeScript).toContain('shapeSelect.selectOption("cylinder")');
    expect(smokeScript).toContain("region create button enabled");
    expect(smokeScript).toContain("createButton.evaluate");
    expect(smokeScript).toContain(
      'getByRole("group", { name: "Region overlays" })',
    );
    expect(smokeScript).toContain(
      'const authoredRegionOverlayMode = regionOverlayControl.getByRole("button",',
    );
    expect(smokeScript).toContain('name: "Authored"');
    expect(smokeScript).toContain("authored region overlay mode active");
    expect(smokeScript).not.toContain(
      'getByRole("button", { name: "Hide regions" })',
    );
    expect(smokeScript).toContain("assertViewportTopologyNotStale");
    expect(smokeScript).toContain("topology remains renderable");
    expect(smokeScript).toContain("edge-only safety view");
    expect(smokeScript).toContain(
      "3D viewport canvas change after object region overlay commit",
    );
    expect(smokeScript).toContain("Region overlay smoke passed:");
    expect(smokeScript).toContain("mesh=preserved");
    expect(smokeScript).toContain("waitForRegionAuthoringScriptSync");
    expect(smokeScript).toContain(JSON.stringify(MODEL_SYNCS_PATH));
    expect(smokeScript).toContain("script=region-authoring-synced");
  });

  it("uses the region transaction revision for geometry smoke cleanup", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain(
      "const regionOverlayResult = await verifyRegionAuthoringOverlayFlow",
    );
    expect(smokeScript).toContain(
      "cleanupRevision = regionOverlayResult.sceneRevision;",
    );
    expect(smokeScript).toContain("sceneRevision: committedSceneRevision");
    expect(smokeScript).toContain(
      "const externalBaseRevision = cleanupRevision;",
    );
    expect(smokeScript).not.toContain(
      "sceneRevision(uiScene) ?? transaction.scene_revision ?? null",
    );
  });

  it("does not order websocket refetch proof by probe timestamps", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain("sceneSequenceBeforeExternalCommit");
    expect(smokeScript).toContain(
      `GET ${MODEL_SCENE_PATH} refetch after websocket invalidation`,
    );
    expect(smokeScript).not.toContain(
      "record.timestamp >= realtimeSceneChange.timestamp",
    );
  });

  it("keeps the screenshot gate on the full dimension frame path", () => {
    const screenshotScript = readFileSync(screenshotScriptUrl, "utf8");

    expect(screenshotScript).toContain("enableDimensionFrameCage");
    expect(screenshotScript).toContain('selectDimensionFrameMode(page, "Off")');
    expect(screenshotScript).toContain(
      'selectDimensionFrameMode(page, "Floor + vertical")',
    );
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
    expect(screenshotScript).toContain("verifyFdmFixtureRegionOverlaySelection");
    expect(screenshotScript).toContain("verifyFdmFixtureFieldPresentation");
    expect(screenshotScript).toContain("configureFdmFixtureFieldPresentation");
    expect(screenshotScript).toContain("patchFdmVisualization");
    expect(screenshotScript).toContain("readFdmVisualizationSettings");
    expect(screenshotScript).toContain("readViewportAuditRuntime");
    expect(screenshotScript).toContain("readViewport3DFieldUpdateHoldActive");
    expect(screenshotScript).toContain(".fm-viewport-3d__hud");
    expect(screenshotScript).toContain("viewportColorbarVisible: true");
    expect(screenshotScript).toContain(
      "configureFdmFixtureFieldPresentation(page, true)",
    );
    expect(screenshotScript).toContain("waitForFixtureRequest");
    expect(screenshotScript).toContain("waitForProjectionFixtureRender");
    expect(screenshotScript).not.toContain("waitForTimeout(400)");
    expect(screenshotScript).toContain("projection-fallback");
    expect(screenshotScript).toContain("1, 0, 0.25");
    expect(screenshotScript).toContain("FDM_FIXTURE_REGION_NODE_ID");
    expect(screenshotScript).toContain("ensureExplorerNodeExpanded");
    expect(screenshotScript).toContain("clickCanvasUntilExplorerNodeSelected");
    expect(screenshotScript).toContain('name: "Auto"');
    expect(screenshotScript).toContain("Region overlay mode must default to Auto.");
    expect(screenshotScript).toContain(
      'const visibility = control.getByRole("button", { exact: true, name: "Regions" });',
    );
    expect(screenshotScript).toContain(
      "Authored region overlay mode must remain disabled while region overlays are hidden.",
    );
    expect(screenshotScript).toContain("await visibility.click()");
    expect(screenshotScript).toContain(
      "Authored region overlay mode remained disabled after enabling region overlays.",
    );
    expect(screenshotScript).toContain("aria-selected");
    expect(screenshotScript).toContain("Viewport 3D region overlay selection passed");
    expect(screenshotScript).toContain('"x-fullmag-domain-generation-id": "1"');
    expect(screenshotScript).toContain("WebGL is unavailable");
    expect(screenshotScript).toContain("drawingBufferWidth");
    expect(screenshotScript).toContain(".fm-viewport-3d__colorbar-range-label");
    expect(screenshotScript).toContain(
      DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m"),
    );
    expect(screenshotScript.match(/browser\.newPage/g)).toHaveLength(1);
    expect(screenshotScript.match(/browser\.newContext/g)).toHaveLength(3);
    expect(screenshotScript.match(/await context\.close\(\)/g)).toHaveLength(3);
  });

  it("publishes the current scene and a complete generated-shape target registry for projection screenshots", () => {
    const screenshotScript = readFileSync(screenshotScriptUrl, "utf8");

    expect(screenshotScript).toContain('scope: "part"');
    expect(screenshotScript).toContain('scope_id: "part-film"');
    expect(screenshotScript).toContain('source: "mesh_part"');
    expect(screenshotScript).toContain('object_id: "projection-film"');
  });

  it("selects the semantic object Visualization node before changing projection", () => {
    const screenshotScript = readFileSync(screenshotScriptUrl, "utf8");

    expect(screenshotScript).toContain(
      "selectProjectionFixtureVisualizationNode",
    );
    expect(screenshotScript).toContain(
      'page.locator(\'[data-node-id="model:objects"]\')',
    );
    expect(screenshotScript).toContain(
      'page.locator(\'[data-node-id="model:object:projection-film"]\')',
    );
    expect(screenshotScript).toContain(
      '[data-node-id="model:object:projection-film:visualization"]',
    );
    expect(screenshotScript).toContain("const objectOverride =");
    expect(screenshotScript).toContain(
      'entry?.scope_id === "projection-film"',
    );
    expect(screenshotScript).toContain("const partOverride =");
    expect(screenshotScript).toContain(
      "const override = objectOverride ?? partOverride;",
    );
    expect(screenshotScript).not.toContain(
      "clickCanvasUntilProjectionControlVisible",
    );
  });

  it("rejects a projection screenshot gate with no pixel difference for any mode pair", () => {
    const screenshotScript = readFileSync(screenshotScriptUrl, "utf8");

    expect(screenshotScript).toContain(
      "if (!rawToSurface.changed || !surfaceToThickness.changed || !rawToThickness.changed)",
    );
    expect(screenshotScript).toContain(
      "Top/bottom projection fixture did not visually distinguish all projection modes.",
    );
  });

  it("keeps the memory churn fixture isolated from live realtime websocket events", () => {
    const memoryChurnScript = readFileSync(memoryChurnScriptUrl, "utf8");

    expect(memoryChurnScript).toContain("disableRealtime: true");
    expect(memoryChurnScript).toContain(
      "Cached quantity switching refetched field resources",
    );
  });

  it("keeps production lifecycle negative controls wired to their runtime guards", () => {
    const memoryChurnScript = readFileSync(memoryChurnScriptUrl, "utf8");

    expect(memoryChurnScript).toContain("CONTROL_ROOM_AUDIT_INJECT_IDLE_LOOP");
    expect(memoryChurnScript).toContain("injectViewportIdleLoop(page)");
    expect(memoryChurnScript).toContain("Viewport rendered during");
    expect(memoryChurnScript).toContain("CONTROL_ROOM_AUDIT_INJECT_WORKER_LEAK");
    expect(memoryChurnScript).toContain("injectViewportAuditWorkerLeak");
    expect(memoryChurnScript).toContain("workers.activeLeases !== 0");
    expect(memoryChurnScript).toContain("CONTROL_ROOM_AUDIT_INJECT_GPU_BUFFER_LEAK");
    expect(memoryChurnScript).toContain("injectViewportGpuBufferLeak(page)");
    expect(memoryChurnScript).toContain("Live WebGL buffers did not return");
  });

  it("browser-proves the pre-canvas React error boundary and forensic stacks", () => {
    const femTopologyAuditScript = readFileSync(femTopologyUploadAuditScriptUrl, "utf8");

    expect(femTopologyAuditScript).toContain("verifyViewport3DPreCanvasErrorBoundary");
    expect(femTopologyAuditScript).toContain("CONTROL_ROOM_AUDIT_PRE_CANVAS_ONLY");
    expect(femTopologyAuditScript).toContain("injectViewport3DRenderError: true");
    expect(femTopologyAuditScript).toContain('entry.name === "viewport-3d.render-error"');
    expect(femTopologyAuditScript).toContain("record?.detail?.componentStack");
    expect(femTopologyAuditScript).toContain("Retry viewport");
  });

  it("measures shared FEM topology position uploads in a real WebGL viewport", () => {
    const femTopologyAuditScript = readFileSync(femTopologyUploadAuditScriptUrl, "utf8");

    expect(femTopologyAuditScript).toContain("FEM_PART_COUNTS = [1, 10, 100]");
    expect(femTopologyAuditScript).toContain("surface-wireframe-points");
    expect(femTopologyAuditScript).toContain("createFemTopologyFixture");
    expect(femTopologyAuditScript).toContain("boundary_face_indices");
    expect(femTopologyAuditScript).toContain("arrayBufferBytesUploaded");
    expect(femTopologyAuditScript).toContain("elementArrayBufferBytesUploaded");
    expect(femTopologyAuditScript).toContain("drawCalls <= 0");
    expect(femTopologyAuditScript).toContain("Position upload grew with FEM part count");
    expect(femTopologyAuditScript).toContain("fem-topology-upload-metrics.json");
  });

  it("browser-proves semantic picks and keeps outer boundary under Universe", () => {
    const femTopologyAuditScript = readFileSync(femTopologyUploadAuditScriptUrl, "utf8");

    expect(femTopologyAuditScript).toContain("verifySemanticTargetExplorerInvariant");
    expect(femTopologyAuditScript).toContain('"model:airbox"');
    expect(femTopologyAuditScript).toContain('"model:object:semantic-magnet"');
    expect(femTopologyAuditScript).toContain(
      '"model:mesh:unassigned:semantic-orphan"',
    );
    expect(femTopologyAuditScript).toContain('"model:boundary-faces"');
    expect(femTopologyAuditScript).toContain(
      '"model:mesh:unassigned:semantic-outer-boundary"',
    );
    expect(femTopologyAuditScript).toContain("Boundary Faces Overview");
    expect(femTopologyAuditScript).toContain("Outer boundary leaked into Unassigned mesh");
    expect(femTopologyAuditScript).toContain('"Realized carriers": "1"');
    expect(femTopologyAuditScript).toContain('"Boundary faces": "4"');
    expect(femTopologyAuditScript).toContain('"Manifest state": "ready"');
    expect(femTopologyAuditScript).toContain("postInteractionWebgl");
    expect(femTopologyAuditScript).toContain(
      "semantic-target-boundary-faces-success.png",
    );
    expect(femTopologyAuditScript).toContain("drawingBufferWidth");
    expect(femTopologyAuditScript).toContain("isContextLost()");
    expect(femTopologyAuditScript).toContain("aria-selected");
    expect(femTopologyAuditScript).toContain("unaddressable-render-target:");
    expect(femTopologyAuditScript).toContain("boundary_face_count: surfaceFaces.length");
    expect(femTopologyAuditScript).toContain("tetraSurfaceFaces(nodeStart)");
    expect(femTopologyAuditScript).toContain("PICK_SCAN_COLUMNS = 32");
    expect(femTopologyAuditScript).toContain("PICK_SCAN_ROWS = 24");
    expect(femTopologyAuditScript).toContain(
      "fixture.domainMeta ?? femDomainMetaFixture()",
    );
    expect(femTopologyAuditScript).toContain("bounds: { max: [4, 2, 1], min: [-4, -2, -1] }");
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
