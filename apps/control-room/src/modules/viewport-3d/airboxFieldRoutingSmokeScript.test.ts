import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJsonUrl = new URL("../../../package.json", import.meta.url);
const smokeScriptUrl = new URL(
  "../../../scripts/smoke-airbox-field-routing.mjs",
  import.meta.url,
);

describe("airbox field routing smoke script", () => {
  it("proves object m and airbox h_demag use scoped field-vector resources", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["smoke:airbox-field-routing"]).toBe(
      "node scripts/smoke-airbox-field-routing.mjs",
    );
    expect(existsSync(smokeScriptUrl)).toBe(true);

    const smokeScript = readFileSync(smokeScriptUrl, "utf8");
    expect(smokeScript).toContain("CONTROL_ROOM_AIRBOX_FIELD_OBJECT_ID");
    expect(smokeScript).toContain("CONTROL_ROOM_AIRBOX_FIELD_OBJECT_QUANTITY_ID");
    expect(smokeScript).toContain("CONTROL_ROOM_AIRBOX_FIELD_AIRBOX_QUANTITY_ID");
    expect(smokeScript).toContain("CONTROL_ROOM_BROWSER_API_BASE_URL");
    expect(smokeScript).toContain("CONTROL_ROOM_BROWSER_HOST_RESOLVER_IP");
    expect(smokeScript).toContain("CONTROL_ROOM_BROWSER_EXECUTABLE_PATH");
    expect(smokeScript).toContain("compute_fields");
    expect(smokeScript).toContain("scope_kind: \"part\"");
    expect(smokeScript).toContain("scope_kind: \"airbox\"");
    expect(smokeScript).toContain("scope_id: airboxPartId");
    expect(smokeScript).toContain(
      "entry.params.scope_id === airboxPartId",
    );
    expect(smokeScript).toContain("!entry.params.scope_id");
    expect(smokeScript).toContain("domain: \"airbox_only\"");
    expect(smokeScript).toContain("forbiddenHdemagFullDomainRequestCount");
    expect(smokeScript).toContain("H_demag used full-domain field-vector requests");
    expect(smokeScript).toContain("status?.session?.session_id");
    expect(smokeScript).toContain("canvas.getContext(\"webgl2\")");
    expect(smokeScript).toContain(
      '[data-node-id="model:airbox:visualization"]',
    );
    expect(smokeScript).toContain("Available air-only nodes");
    expect(smokeScript).toContain("Decoded field samples");
    expect(smokeScript).toContain("Adopted arrows");
    expect(smokeScript).toContain("matchingAirboxFieldRequestCount");
    expect(smokeScript).toContain("allAirboxRequests");
    expect(smokeScript).toContain("expectedAirboxSampleCount");
    expect(smokeScript).toContain(
      "Number(entry.params.max_samples) === expectedAirboxSampleCount",
    );
    expect(smokeScript).toContain("x-fullmag-point-count");
    expect(smokeScript).toContain("visualization/state");
    expect(smokeScript).toContain("data/fields/");
    expect(smokeScript).not.toContain("scope_kind=full&scope_id=part%3A__air__");
    expect(smokeScript).toContain("debugFieldRequestDelta");
    expect(smokeScript).toContain("debugIdleFieldRequestDelta");
    expect(smokeScript).toContain("debugIdleFrameDelta");
    expect(smokeScript).toContain("debugIdleScanDelta");
    expect(smokeScript).toContain("debugIdlePublishDelta");
    expect(smokeScript).toContain("assertVisualizationDebugIdleBudgets");
  });

  it("proves Airbox, object, and real region Debug inspectors without renderer churn", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain("CONTROL_ROOM_VISUALIZATION_DEBUG_ARTIFACT_DIR");
    expect(smokeScript).toContain("assertVisualizationDebugScenarios");
    expect(smokeScript).toContain("resolveVisualizationDebugRegionScenario");
    expect(smokeScript).toContain("model:airbox:visualization:debug");
    expect(smokeScript).toContain("object.visualization.debug");
    expect(smokeScript).toContain("object.region.visualization.debug");
    expect(smokeScript).not.toContain(
      'expectedSelectionKind: "region.visualization.debug"',
    );
    expect(smokeScript).toContain("fieldMetaRequests");
    expect(smokeScript).toContain("networkFailures");
    expect(smokeScript).toContain("waitForExactVisualizationDebugEvidence");
    expect(smokeScript).toContain("assertVisualizationStateUnchanged");
    expect(smokeScript).toContain("assertVisualizationDebugKeyboardOrder");
    expect(smokeScript).toContain("assertVisualizationDebugStatusText");
    expect(smokeScript).toContain("canvasSha256");
    expect(smokeScript).toContain("drawingBufferWidth");
    expect(smokeScript).toContain("isContextLost");
    expect(smokeScript).toContain("mainFrameDocumentNavigations");
    expect(smokeScript).toContain("request.isNavigationRequest()");
    expect(smokeScript).toContain("assertSingleDocumentNavigation");
    expect(smokeScript).toContain("frameNavigationEvents");
    expect(smokeScript).toContain("fieldVectorRequestDeltaAfterSettle !== 0");
    expect(smokeScript).not.toContain("fieldMetaRequestDeltaAfterSettle > 1");
    expect(smokeScript).toContain(
      "assertExactVisualizationDebugMetaRequests",
    );
    expect(smokeScript).toContain(
      "new Set(metaRequestKeys).size !== metaRequestKeys.length",
    );
    expect(smokeScript).toContain("idleFrameDelta !== 0");
    expect(smokeScript).toContain("idleScanDelta !== 0");
    expect(smokeScript).toContain("idlePublishDelta !== 0");
    expect(smokeScript).toContain("idleRequestDelta !== 0");
    expect(smokeScript).toContain("before-visualization.png");
    expect(smokeScript).toContain("after-debug.png");
    expect(smokeScript).toContain("fieldVectorRequestDeltaAfterSettle");
    expect(smokeScript).toContain("fieldMetaRequestDeltaAfterSettle");
    expect(smokeScript).toContain("resetInspectorScroll");
    expect(smokeScript).toContain('"Decoded component"');
    expect(smokeScript).toContain('"Grid"');
    expect(smokeScript).toContain('"nComp"');
    expect(smokeScript).toContain('"Indexing / node indices"');
    expect(smokeScript).toContain("— (not encoded)");
    expect(smokeScript).toContain('expectedCarrierRole: "air"');
    expect(smokeScript).toContain('"Carrier role"');
    expect(smokeScript).toContain("healthDisposition");
    expect(smokeScript).toContain("backend-meta-incomparable");
    expect(smokeScript).toContain('"Decoded values · decoded-payload"');
    expect(smokeScript).toContain('"Cache accounting · cache"');
    expect(smokeScript).toContain('"Exact decoded wire transfer · transport"');
    expect(smokeScript).toContain("assertVisualizationDebugMemoryEvidence");
    expect(smokeScript).toContain("transportRows");
  });

  it("enables the canonical region target while keeping its field transport part-scoped", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain(
      'entry.scope === "region" &&\n          entry.scope_id === regionScenario.targetId',
    );
    expect(smokeScript).toContain(
      'entry.scope === "part" &&\n          entry.scope_id === regionScenario.carrierId',
    );
    expect(smokeScript).toContain('scope: "region"');
    expect(smokeScript).toContain("scope_id: regionScenario.targetId");
    expect(smokeScript).toContain("regionOverrides.length !== 1");
    expect(smokeScript).toContain("legacyRegionCarrierOverride");
    expect(smokeScript).toContain(
      'expectedScopeKind: "part"',
    );
    expect(smokeScript).toContain(
      "expectedScopeId: regionScenario.carrierId",
    );
  });

  it("waits for a realized region overlay adoption before measuring idle", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");
    const quietStart = smokeScript.indexOf(
      "async function waitForVisualizationDebugQuiet",
    );
    const quietEnd = smokeScript.indexOf(
      "async function readVisualizationDebugPerformance",
      quietStart,
    );
    const quietHelper = smokeScript.slice(quietStart, quietEnd);

    expect(quietHelper).toContain(
      'counters.viewportFrameReasons?.["region-mesh-overlay"] ?? 0',
    );
    expect(quietHelper).toContain("regionMeshOverlayAdoptionCount < 1");
    expect(quietHelper.indexOf("regionMeshOverlayAdoptionCount < 1")).toBeLessThan(
      quietHelper.indexOf("Date.now() - stableSince"),
    );
    expect(smokeScript).toContain("const VIEWPORT_IDLE_SETTLE_MS = 2_000");
    expect(smokeScript).toContain("await page.waitForTimeout(750)");
  });

  it("matches the transport table path against the canonical resource key", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain(
      "hasExactVisualizationTransportEvidence(dom.transportRows, request, resourceKey)",
    );
    expect(smokeScript).toContain(
      "function hasExactVisualizationTransportEvidence(rows, request, resourceKey)",
    );
    expect(smokeScript).toContain("cells[1] === resourceKey");
    expect(smokeScript).not.toContain("cells[1] === request.path");
    expect(smokeScript).toContain('cells[2] === "200"');
    expect(smokeScript).toContain(
      'cells[4] !== "—" && cells[4] !== "0 B"',
    );
  });

  it("matches Debug indexing against the exact FMVP response instead of assuming sampling", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain(
      'response?.headers?.["x-fullmag-field-indexing"]',
    );
    expect(smokeScript).toContain(
      'response?.headers?.["x-fullmag-node-index-count"]',
    );
    expect(smokeScript).toContain("domIndexing === responseIndexing");
    expect(smokeScript).toContain("domNodeIndexCount === nodeIndexCount");
    expect(smokeScript).not.toContain(
      'startsWith("sampled_node_indices / ")',
    );
  });

  it("prints the last exact Debug evidence when a scenario times out", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain("let lastEvidence = null");
    expect(smokeScript).toContain("lastEvidence = {");
    expect(smokeScript).toContain(
      'last evidence=${JSON.stringify(lastEvidence)}',
    );
  });

  it("hides only the composited viewport HUD while hashing the canvas", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");
    const captureStart = smokeScript.indexOf(
      "async function captureVisualizationDebugCanvas",
    );
    const captureEnd = smokeScript.indexOf(
      "async function waitForVisualizationDebugSettled",
      captureStart,
    );
    const captureHelper = smokeScript.slice(captureStart, captureEnd);

    expect(captureHelper).toContain(
      'style: ".fm-viewport-3d__hud { visibility: hidden !important; }"',
    );
    expect(captureHelper).toContain("const png = await canvas.screenshot({");
    expect(captureHelper).toContain("path,");
    expect(captureHelper).not.toContain("clip:");
    expect(captureHelper).toContain('createHash("sha256").update(png)');
  });
});
