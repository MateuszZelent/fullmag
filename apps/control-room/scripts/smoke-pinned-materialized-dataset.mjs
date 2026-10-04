import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const workspaceUrl = process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const apiBase = (
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  new URL(workspaceUrl).origin
).replace(/\/$/, "");
const timeoutMs = Number(
  process.env.CONTROL_ROOM_PINNED_DATASET_SMOKE_TIMEOUT_MS ?? 30_000,
);
const projectStorageRoot = requireAbsolutePath(
  "FULLMAG_PROJECT_STORAGE_ROOT",
);
const reportDirectory = resolveReportDirectory(
  projectStorageRoot,
  "FULLMAG_PINNED_DATASET_REPORT_DIR",
);

const TARGET_RUN_ID = "run-pinned-materialized-dataset";
const OTHER_RUN_ID = "run-pinned-materialized-dataset-other";
const SOLUTION_SET_ID = "solution:pinned-materialized-dataset";
const SOLUTION_REVISION = "9007199254740993";
const OWNER_REVISION = "9007199254740992";
const MEMBER_ID = "member:pinned-field";
const MANIFEST_OBJECT_REF = sha256Hex("fullmag.p6-65.legacy-manifest-f64.v1");
const F32_MANIFEST_OBJECT_REF = sha256Hex("fullmag.p6-65.manifest-f32.v1");
const FORGED_MANIFEST_OBJECT_REF = sha256Hex("fullmag.p6-65.forged-manifest.v1");
const FORGED_ARTIFACT_OBJECT_REF = sha256Hex("fullmag.p6-65.forged-artifact.v1");
const F64_TENSOR_OBJECT_REF = sha256Hex(savedTensorPayload("f64"));
const F32_TENSOR_OBJECT_REF = sha256Hex(savedTensorPayload("f32"));
const SAVED_TOPOLOGY_BUFFER = makeSavedTopologyBuffer();
const SAVED_TOPOLOGY_OBJECT_REF = sha256Hex(SAVED_TOPOLOGY_BUFFER);
const SAVED_SUPPORT_BUFFER = makeSavedSupportBuffer();
const SAVED_SUPPORT_OBJECT_REF = sha256Hex(SAVED_SUPPORT_BUFFER);
const F64_LAYOUT_DIGEST = sha256Hex("fullmag.p6-65.layout-f64.v1");
const F32_LAYOUT_DIGEST = sha256Hex("fullmag.p6-65.layout-f32.v1");
const POSITIVE_ARTIFACT_ID = `materialized-dataset-${MANIFEST_OBJECT_REF}`;
const F32_ARTIFACT_ID = `materialized-dataset-${F32_MANIFEST_OBJECT_REF}`;
const FORGED_ARTIFACT_ID = `materialized-dataset-${FORGED_ARTIFACT_OBJECT_REF}`;
const MATERIALIZED_DATASET_SCHEMA = "fullmag.materialized_dataset.v1";
const MATERIALIZED_DATASET_RESOURCE_SCHEMA =
  "fullmag.analysis.materialized_dataset.v1";

const LIVE_VIEWPORT_RESOURCE_PATHS = new Set([
  "/v2/sessions/current/data/domain/meta",
  "/v2/sessions/current/data/domain/topology",
  "/v2/sessions/current/data/fields",
  "/v2/sessions/current/model/scene",
  "/v2/sessions/current/model/regions",
  "/v2/sessions/current/data/masks",
  "/v2/sessions/current/model/universe",
  "/v2/sessions/current/meshing/meshes/shared-domain/manifest",
]);
const LIVE_VIEWPORT_RESOURCE_PREFIXES = [
  "/v2/sessions/current/data/domain/",
  "/v2/sessions/current/data/fields/",
  "/v2/sessions/current/data/mesh-regions/",
  "/v2/sessions/current/data/regions/",
  "/v2/sessions/current/data/periodic",
  "/v2/sessions/current/data/masks/",
  "/v2/sessions/current/data/frozen",
  "/v2/sessions/current/model/frozen",
  "/v2/sessions/current/meshing/mesh/",
  "/v2/sessions/current/meshing/meshes/",
];

function assertCondition(condition, message) {
  assert.ok(condition, message);
}

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    throw new Error(
      "Pinned materialized dataset smoke requires Playwright or @playwright/test.",
    );
  }

  await mkdir(reportDirectory, { recursive: true });
  const state = createFixtureState();
  const channel = process.env.FULLMAG_PINNED_DATASET_BROWSER_CHANNEL;
  if (channel && !["chrome", "msedge"].includes(channel)) {
    throw new Error("Unsupported pinned dataset browser channel.");
  }
  const browser = await playwright.chromium.launch({
    headless: true,
    ...(channel ? { channel } : {}),
  });
  const page = await browser.newPage({
    acceptDownloads: false,
    viewport: { height: 1100, width: 1440 },
  });
  const errors = [];
  let proof = null;
  let failure = null;

  page.on("console", (message) => {
    // Keep the independently observed shell-startup diagnostic visible in
    // evidence. Repetition or any different React error still fails the gate.
    if (message.type() === "error" && message.text().startsWith("Can't perform a React state update on a component that hasn't mounted yet.")) {
      state.startupWarnings.push(message.text());
      return;
    }
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).pathname.endsWith("/materialized-dataset/slice")) state.sliceAborts = (state.sliceAborts ?? 0) + 1;
  });
  page.on("websocket", (socket) => {
    if (!state.activeSessionPhase && new URL(socket.url()).pathname.startsWith("/v2/sessions/current/")) errors.push("Unexpected current-session WebSocket.");
  });
  page.on("dialog", async (dialog) => {
    if (dialog.type() === "prompt" && dialog.message() === "Project name") {
      await dialog.accept("Untitled project");
    } else if (state.expectProjectClose && dialog.type() === "confirm" && dialog.message() === "Discard unsaved project changes?") {
      state.expectProjectClose = false;
      await dialog.accept();
    } else {
      errors.push(`Unexpected dialog: ${dialog.type()} ${dialog.message()}`);
      await dialog.dismiss();
    }
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/v2/")) return;
    const method = request.method();
    state.requests.push({
      method,
      path: url.pathname,
      query: url.search,
      phase: state.activeSessionPhase
        ? (state.viewportPhase ?? "active-session")
        : state.collectionMismatch
          ? "identity-mismatch"
          : "project",
      type: "request",
    });
    if (state.activeSessionPhase && url.pathname.startsWith("/v2/sessions/current/") && method === "GET") {
      state.liveResourceRequests.push({
        method,
        path: url.pathname,
        mount: state.activeWorkspaceMount ?? "saved-workspace",
      });
    }
    const isVisualizationClientAck =
      state.activeSessionPhase &&
      method === "POST" &&
      url.pathname === "/v2/sessions/current/visualization/client-acks";
    if (isVisualizationClientAck) {
      state.visualizationAckRequests.push({ method, path: url.pathname });
    }
    if (
      url.pathname.startsWith("/v2/sessions/current/") &&
      !((state.collectionMismatch && method === "GET" && url.pathname === "/v2/sessions/current/status") ||
        (state.activeSessionPhase && method === "GET") ||
        isVisualizationClientAck)
    ) {
      state.forbiddenRuntimeRequests.push({ method, path: url.pathname });
    }
    if (
      state.activeSessionPhase &&
      method !== "GET" &&
      url.pathname === "/v2/sessions/current/visualization/state"
    ) {
      state.cameraMutationRequests.push({ method, path: url.pathname });
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/v2/")) return;
    state.responses.push({
      method: response.request().method(),
      path: url.pathname,
      query: url.search,
      status: response.status(),
      type: "response",
    });
  });

  await page.addInitScript((baseUrl) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: baseUrl,
      allowMissingSessionSmoke: true,
      disableRealtime: true,
    };
  }, apiBase);
  await page.addInitScript(() => {
    const proof = window.__FULLMAG_PINNED_DATASET_WEBGL_PROOF__ = {
      bufferBytesUploaded: 0,
      buffersCreated: 0,
      colorUploads: [],
      float12Uploads: [],
      drawnAttributeLayouts: [],
      drawCalls: 0,
      elementArrayBufferBytesUploaded: 0,
      frames: 0,
    };
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) {
      const context = originalGetContext.apply(this, args);
      if (!context || !["webgl", "webgl2", "experimental-webgl"].includes(String(args[0]))) return context;
      const gl = context;
      if (gl.__fullmagPinnedDatasetAuditWrapped) return gl;
      gl.__fullmagPinnedDatasetAuditWrapped = true;
      const bufferSamples = new WeakMap();
      const bufferSizes = new WeakMap();
      const drawnSamples = new WeakMap();
      const observeDrawnColors = () => {
        const program = gl.getParameter(gl.CURRENT_PROGRAM);
        if (!program) return;
        const count = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
        const layout = [];
        for (let index = 0; index < count; index++) {
          const attribute = gl.getActiveAttrib(program, index);
          if (attribute) layout.push(attribute.name);
          if (attribute?.name !== "color") continue;
          const location = gl.getAttribLocation(program, attribute.name);
          if (location < 0 || !gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_ENABLED)) continue;
          const buffer = gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING);
          const values = buffer ? bufferSamples.get(buffer) : null;
          if (!values || bufferSizes.get(buffer) !== 48 || drawnSamples.get(buffer) === values) continue;
          drawnSamples.set(buffer, values);
          proof.colorUploads.push(values);
        }
        const key = layout.join(",");
        if (proof.drawnAttributeLayouts.length < 16 && !proof.drawnAttributeLayouts.includes(key)) {
          proof.drawnAttributeLayouts.push(key);
        }
      };
      for (const name of ["createBuffer", "drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"]) {
        const original = gl[name];
        if (typeof original !== "function") continue;
        gl[name] = function (...methodArgs) {
          if (name === "createBuffer") proof.buffersCreated += 1;
          if (name.startsWith("draw")) {
            proof.drawCalls += 1;
            observeDrawnColors();
          }
          return original.apply(this, methodArgs);
        };
      }
      for (const name of ["bufferData", "bufferSubData"]) {
        const original = gl[name];
        if (typeof original !== "function") continue;
        gl[name] = function (...methodArgs) {
          const data = name === "bufferSubData" ? methodArgs[2] : methodArgs[1];
          const bytes = typeof data === "number" ? data : Number(data?.byteLength ?? 0);
          proof.bufferBytesUploaded += bytes;
          if (methodArgs[0] === gl.ELEMENT_ARRAY_BUFFER) proof.elementArrayBufferBytesUploaded += bytes;
          const buffer = methodArgs[0] === gl.ARRAY_BUFFER
            ? gl.getParameter(gl.ARRAY_BUFFER_BINDING)
            : null;
          if (buffer && name === "bufferData") bufferSizes.set(buffer, bytes);
          if (
            buffer &&
            (name === "bufferData" || methodArgs[1] === 0) &&
            data &&
            data.BYTES_PER_ELEMENT === 4 &&
            data.length === 12 &&
            data.byteLength === 48
          ) {
            bufferSamples.set(buffer, Array.from(new Float32Array(data.buffer, data.byteOffset, 12)));
            proof.float12Uploads.push(bufferSamples.get(buffer));
            if (proof.float12Uploads.length > 32) proof.float12Uploads.shift();
          }
          return original.apply(this, methodArgs);
        };
      }
      return gl;
    };
  });
  await installFixtureRoutes(page, state);

  try {
    await page.goto(workspaceUrl, {
      timeout: timeoutMs,
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "File", exact: true }).waitFor({ state: "visible", timeout: timeoutMs });
    await page.locator('[data-state="no-session"]').waitFor({ state: "visible", timeout: timeoutMs });

    await createProject(page, state);
    await openSavedResults(page);
    const projectId = state.currentProjectId;
    assertCondition(projectId, "New Project did not return a project id.");

    const positive = await selectPinnedArtifact(page, {
      artifactId: POSITIVE_ARTIFACT_ID,
      projectId,
      runId: TARGET_RUN_ID,
    });
    assertPositivePinnedInspector(positive.inspectorText);
    await assertBoundedValues(page, state);
    await page.getByRole("button", { name: "Apply", exact: true }).isDisabled().then((disabled) => assertCondition(disabled, "Pinned readonly dataset exposed Apply."));
    await page.getByRole("button", { name: "Focus", exact: true }).isDisabled().then((disabled) => assertCondition(disabled, "Project Inspector exposed runtime Focus."));
    await page.getByRole("button", { name: "Hide Inspector", exact: true }).click();
    await page.getByRole("button", { name: "Show Inspector", exact: true }).waitFor({ state: "visible", timeout: timeoutMs });
    await page.getByRole("button", { name: "Show Inspector", exact: true }).click();
    await page.locator(".fm-inspector").waitFor({ state: "visible", timeout: timeoutMs });
    await captureScreenshot(page, state, "pinned-materialized-dataset-positive.png");

    await selectSavedRun(page, OTHER_RUN_ID);
    const savedRunSwitchInspectorRetained =
      await assertSavedRunSwitchDoesNotRelabelPinnedSelection(page, state, {
        containingRevision: SOLUTION_REVISION,
        ownerRevision: OWNER_REVISION,
        projectId,
        runId: TARGET_RUN_ID,
      });

    state.forgeManifestForArtifact = FORGED_ARTIFACT_ID;
    const forged = await selectPinnedArtifact(page, {
      artifactId: FORGED_ARTIFACT_ID,
      projectId,
      runId: TARGET_RUN_ID,
    });
    assertForgedManifestRejected(forged);
    await captureScreenshot(page, state, "pinned-materialized-dataset-forged.png");

    await createProject(page, state);
    await openSavedResults(page);
    await assertProjectSwitchDoesNotRelabelPinnedSelection(page, {
      oldProjectId: projectId,
      newProjectId: state.currentProjectId,
    });

    state.expectProjectClose = true;
    await page.getByRole("button", { name: "File", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Close Project/i }).click();
    await page.locator('[data-state="no-session"]').waitFor({ state: "visible", timeout: timeoutMs });
    assert.equal(await page.locator(".fm-results-navigator-shell").count(), 0, "Closed project retained saved results.");

    // A collection failure is unknown availability, not confirmed absence.
    // Durable project results still work without any current-session connector.
    state.sessionCollectionError = true;
    assert.ok(state.startupWarnings.length <= 1, "Repeated shell startup mount warning before reload.");
    const warningsBeforeReload = state.startupWarnings.length;
    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.locator('[data-state="session-error"]').waitFor({ state: "visible", timeout: timeoutMs });
    await createProject(page, state);
    await openSavedResults(page, "error");
    await page.getByText("No saved runs in this project.", { exact: true }).waitFor({ state: "visible", timeout: timeoutMs });
    await page.locator(".fm-inspector__empty").waitFor({ state: "visible", timeout: timeoutMs });
    assertCondition((await page.locator("section[aria-label='Saved results']").innerText()).includes(state.currentProjectId), "Unknown-session workspace displayed another project.");
    await captureScreenshot(page, state, "pinned-materialized-dataset-session-list-error.png");
    assert.ok(state.startupWarnings.length - warningsBeforeReload <= 1, "Repeated shell startup mount warning after error reload.");
    const warningsBeforeMismatch = state.startupWarnings.length;
    state.sessionCollectionError = false;
    state.collectionMismatch = true;
    const mismatchRequestOffset = state.requests.length;
    const mismatchStatusResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/v2/sessions/current/status", { timeout: timeoutMs });
    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    await mismatchStatusResponse;
    await page.locator('[data-state="session-loading"]').waitFor({ state: "visible", timeout: timeoutMs });
    await createProject(page, state);
    await openSavedResults(page, "loading");
    await page.getByText("No saved runs in this project.", { exact: true }).waitFor({ state: "visible", timeout: timeoutMs });
    await page.locator(".fm-inspector__empty").waitFor({ state: "visible", timeout: timeoutMs });
    const mismatchCurrent = state.requests.slice(mismatchRequestOffset).filter((request) => request.path.startsWith("/v2/sessions/current/"));
    assertCondition(mismatchCurrent.length > 0, "Identity mismatch did not exercise the status bootstrap.");
    assertCondition(mismatchCurrent.every((request) => request.method === "GET" && request.path === "/v2/sessions/current/status"), "Mismatched cached session identity mounted runtime resources.");
    assert.equal(await page.locator(".fm-ribbon__tab").count(), 0, "Mismatched status enabled session ribbon.");
    await captureScreenshot(page, state, "pinned-materialized-dataset-session-identity-mismatch.png");
    assert.ok(state.startupWarnings.length - warningsBeforeMismatch <= 1, "Repeated shell startup mount warning after mismatch reload.");

    // Re-enter a real active-session shell and exercise the saved viewport
    // carrier. The saved selection must own geometry, topology, support and
    // FMDS values while every live geometry/field request stays disabled.
    state.collectionMismatch = false;
    state.activeSessionPhase = true;
    state.viewportPhase = "live-bootstrap";
    const warningsBeforeActive = state.startupWarnings.length;
    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.getByRole("tab", { name: "3D Viewport", exact: true }).waitFor({ state: "visible", timeout: timeoutMs });
    await createProject(page, state);
    await openActiveSavedResults(page);
    const activeProjectId = state.currentProjectId;
    // Establish the live camera and transport baseline before selecting a
    // pinned artifact.  Saved camera gestures must stay local to the
    // immutable selection and must not patch the live visualization registry.
    const liveBootstrapProof = await assertLiveViewportRendered(page, state);
    const liveCameraBeforeSaved = await readViewportCameraSnapshot(page);
    const cameraMutationsBeforeSaved = state.cameraMutationRequests.length;
    const liveBeforeSaved = liveResourceRequestCount(state);
    await page.getByRole("tab", { name: "Saved", exact: true }).click({ force: true });
    await page.locator("section[aria-label='Saved results']").first().waitFor({ state: "visible", timeout: timeoutMs });
    const savedF64AuditBefore = await readWebglAuditCounters(page);
    const savedF64 = await selectPinnedArtifact(page, {
      artifactId: POSITIVE_ARTIFACT_ID,
      projectId: activeProjectId,
      runId: TARGET_RUN_ID,
    });
    assertPositivePinnedInspector(savedF64.inspectorText);
    const savedF64Proof = await assertSavedViewportRendered(page, state, "f64", savedF64AuditBefore);
    const savedF64CameraBefore = await readViewportCameraSnapshot(page);
    const savedF64CameraAfter = await dragViewportCamera(page, 74, 18);
    state.cameraSnapshots.push({ phase: "saved-f64-gesture", before: savedF64CameraBefore, after: savedF64CameraAfter });
    assert.notDeepEqual(savedF64CameraAfter, savedF64CameraBefore, "Saved F64 camera interaction did not update its local camera view.");
    assert.equal(state.cameraMutationRequests.length, cameraMutationsBeforeSaved, "Saved F64 camera interaction patched the live visualization state.");
    const liveAfterF64 = liveResourceRequestCount(state);
    assert.equal(liveAfterF64, liveBeforeSaved, "Selecting saved F64 data fetched live geometry or field resources.");

    await page.getByRole("tab", { name: "Saved", exact: true }).click({ force: true });
    const savedF32AuditBefore = await readWebglAuditCounters(page);
    const savedF32 = await selectPinnedArtifact(page, {
      artifactId: F32_ARTIFACT_ID,
      projectId: activeProjectId,
      runId: TARGET_RUN_ID,
    });
    assertPositivePinnedInspector(savedF32.inspectorText, F32_MANIFEST_OBJECT_REF);
    const savedF32Proof = await assertSavedViewportRendered(page, state, "f32", savedF32AuditBefore);
    const savedF32CameraBefore = await readViewportCameraSnapshot(page);
    assert.notDeepEqual(savedF32CameraBefore, savedF64CameraAfter, "Saved F32 selection inherited the saved F64 camera state.");
    const savedF32CameraAfter = await dragViewportCamera(page, -58, 14);
    state.cameraSnapshots.push({ phase: "saved-f32-gesture", before: savedF32CameraBefore, after: savedF32CameraAfter });
    assert.notDeepEqual(savedF32CameraAfter, savedF32CameraBefore, "Saved F32 camera interaction did not update its local camera view.");
    assert.equal(state.cameraMutationRequests.length, cameraMutationsBeforeSaved, "Saved F32 camera interaction patched the live visualization state.");
    assert.equal(liveResourceRequestCount(state), liveBeforeSaved, "Selecting saved F32 data fetched live geometry or field resources.");

    await page.getByRole("tab", { name: "Saved", exact: true }).click({ force: true });
    await selectPinnedArtifact(page, {
      artifactId: POSITIVE_ARTIFACT_ID,
      projectId: activeProjectId,
      runId: TARGET_RUN_ID,
    });
    await page.getByRole("tab", { name: "3D Viewport", exact: true }).click({ force: true });
    await page.waitForTimeout(250);
    const savedF64CameraRestored = await readViewportCameraSnapshot(page);
    assert.deepEqual(savedF64CameraRestored, savedF64CameraAfter, "Returning to saved F64 did not restore its selection-scoped camera.");

    await page.getByRole("tab", { name: "Saved", exact: true }).click({ force: true });
    await selectPinnedArtifact(page, {
      artifactId: F32_ARTIFACT_ID,
      projectId: activeProjectId,
      runId: TARGET_RUN_ID,
    });
    await page.getByRole("tab", { name: "3D Viewport", exact: true }).click({ force: true });
    await page.waitForTimeout(250);
    const savedF32CameraRestored = await readViewportCameraSnapshot(page);
    assert.deepEqual(savedF32CameraRestored, savedF32CameraAfter, "Returning to saved F32 did not restore its selection-scoped camera.");

    state.savedGeometryMode = "mismatch";
    const mismatchSaved = await reloadSavedViewport(page, state, POSITIVE_ARTIFACT_ID, activeProjectId);
    assertCondition(mismatchSaved.unavailable, "Saved geometry identity mismatch remained renderable.");
    assertCondition(mismatchSaved.explicit, "Saved geometry mismatch did not produce an explicit unavailable state.");
    assert.equal(mismatchSaved.topology_freshness, "unknown", "Saved geometry identity mismatch retained current topology freshness.");
    assert.match(mismatchSaved.viewport_text, /saved domain unavailable/i, "Saved geometry identity mismatch retained the previous saved field scene.");
    assert.equal(liveResourceRequestCount(state), liveBeforeSaved, "Saved geometry identity mismatch fetched live resources.");

    state.savedGeometryMode = "geometry-503";
    const unavailableSaved = await reloadSavedViewport(page, state, F32_ARTIFACT_ID, activeProjectId);
    assertCondition(unavailableSaved.unavailable, "HTTP 503 saved geometry remained renderable.");
    assertCondition(unavailableSaved.explicit, "HTTP 503 saved geometry did not produce an explicit unavailable HUD state.");
    assert.equal(unavailableSaved.topology_freshness, "unknown", "HTTP 503 saved geometry retained current topology freshness.");
    assert.match(unavailableSaved.viewport_text, /saved domain unavailable/i, "HTTP 503 saved geometry retained the previous saved field scene.");
    assert.equal(liveResourceRequestCount(state), liveBeforeSaved, "HTTP 503 saved geometry fetched live resources.");
    // Clear only the client-owned historical selection. The same mounted
    // viewport must resume current resources without mutating the solver.
    const savedViewportHandle = await page.locator(".fm-viewport-3d").elementHandle();
    const savedCanvasHandle = await page.locator(".fm-viewport-3d canvas").first().elementHandle();
    assert.ok(savedViewportHandle && savedCanvasHandle, "Saved viewport DOM is missing before direct return.");
    const savedRequestCountsBeforeDirectLive = savedBinaryRequestCounts(state);
    state.viewportPhase = "live-direct-return";
    await page.getByRole("button", { name: "Return to current view", exact: true }).click();
    await page.locator('.fm-viewport-3d[data-view-source="current"]').waitFor({ state: "visible", timeout: timeoutMs });
    const directLiveProof = await assertLiveViewportRendered(page, state);
    assert.equal(await savedViewportHandle.evaluate((node) => node === document.querySelector(".fm-viewport-3d")), true, "Direct return replaced the mounted viewport.");
    assert.equal(await savedCanvasHandle.evaluate((node) => node === document.querySelector(".fm-viewport-3d canvas")), true, "Direct return replaced the WebGL canvas.");
    const liveCameraAfterDirectReturn = await readViewportCameraSnapshot(page);
    assert.deepEqual(liveCameraAfterDirectReturn, liveCameraBeforeSaved, "Direct return inherited the saved camera.");
    assert.equal(await page.getByRole("button", { name: "Return to current view", exact: true }).count(), 0, "Current view retained its saved-source control.");
    assert.deepEqual(savedBinaryRequestCounts(state), savedRequestCountsBeforeDirectLive, "Direct return fetched saved resources after clearing their selection.");
    assert.equal(state.cameraMutationRequests.length, cameraMutationsBeforeSaved, "Direct return mutated the live camera.");
    await captureScreenshot(page, state, "pinned-materialized-dataset-direct-current.png");

    assert.ok(state.startupWarnings.length - warningsBeforeActive <= 1, "Repeated shell startup mount warning within the saved viewport phase.");
    const warningsBeforeLiveReturn = state.startupWarnings.length;
    // Unmount the erroring saved workspace before restoring the fixture.
    // Otherwise its pending 503 retry can succeed during navigation and be
    // misattributed to the newly opened live document.
    await page.goto("about:blank", { waitUntil: "load", timeout: timeoutMs });
    state.savedGeometryMode = null;
    state.activeWorkspaceMount = "live-return";
    state.viewportPhase = "live-return";
    const savedRequestCountsBeforeLive = savedBinaryRequestCounts(state);
    await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.getByRole("tab", { name: "3D Viewport", exact: true }).waitFor({ state: "visible", timeout: timeoutMs });
    const liveProof = await assertLiveViewportRendered(page, state);
    const liveCameraAfterSaved = await readViewportCameraSnapshot(page);
    assert.deepEqual(liveCameraAfterSaved, liveCameraBeforeSaved, "Returning to live view inherited a saved selection camera.");
    assert.equal(state.cameraMutationRequests.length, cameraMutationsBeforeSaved, "Saved camera interactions emitted a live visualization mutation.");
    const savedRequestCountsAfterLive = savedBinaryRequestCounts(state);
    assert.deepEqual(savedRequestCountsAfterLive, savedRequestCountsBeforeLive, "Returning to live view re-used saved resources unexpectedly.");

    assert.equal(
      state.forbiddenRuntimeRequests.length,
      0,
      `Saved pinned dataset smoke invoked runtime/model mutation: ${JSON.stringify(
        state.forbiddenRuntimeRequests,
      )}`,
    );
    assert.equal(errors.length, 0, `Browser errors: ${errors.join(" | ")}`);
    assert.ok(await page.locator("canvas").count() > 0, "Active-session live viewport did not mount a canvas.");
    assert.ok(state.startupWarnings.length - warningsBeforeLiveReturn <= 1, "Repeated shell startup mount warning after live-return reload.");
    assertRequiredRequests(state);
    assertResourceRequestBounds(state);

    proof = {
      session_collection: "confirmed_empty",
      current_session_http_or_websocket: "active session resources observed only after explicit active-session phase; realtime disabled",
      project_workspace_canvas_count: 0,
      inspector_hide_restore: "verified in project workspace",
      closed_project_unmounts_saved_results: true,
      collection_error_preserves_explicit_unknown_state: true,
      collection_b_status_a_gates_entire_runtime_tree: true,
      project_switch_suppresses_readonly_old_payload: true,
      positive_owner_revision: OWNER_REVISION,
      positive_containing_revision: SOLUTION_REVISION,
      positive_integrity: "verified",
      positive_owner_execution_status: "running",
      positive_owner_scientific_assessment: "unassessed",
      forged_manifest_rejected: true,
      binary_field_rendering: "bounded readonly numeric table verified from FMDS fixture",
      bounded_slice: state.sliceProof,
      saved_viewport: {
        f64: savedF64Proof,
        f32: savedF32Proof,
        camera: {
          live_before_saved: liveCameraBeforeSaved,
          f64_after_drag: savedF64CameraAfter,
          f32_after_drag: savedF32CameraAfter,
          f64_restored: savedF64CameraRestored,
          f32_restored: savedF32CameraRestored,
          live_after_saved: liveCameraAfterSaved,
          live_mutations: state.cameraMutationRequests,
          visualization_client_acks: state.visualizationAckRequests,
        },
        geometry_topology_support_fenced: true,
        live_resource_suppressed: true,
        mismatch_unavailable: true,
        unavailable_503_fail_closed: true,
        stale_saved_field_suppressed_on_error: true,
        direct_live_return: {
          ...directLiveProof,
          viewport_preserved: true,
          canvas_preserved: true,
          camera: liveCameraAfterDirectReturn,
          saved_resources_stopped: true,
        },
        live_return: liveProof,
      },
      live_bootstrap: liveBootstrapProof,
      runtime_solver_or_model_mutation: "none observed",
      saved_run_switch_preserves_explicit_pinned_selection:
        savedRunSwitchInspectorRetained,
    };
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    try {
      if (failure && !state.screenshots.some((path) => path.endsWith("failed.png"))) {
        await captureScreenshot(page, state, "pinned-materialized-dataset-failed.png");
      }
      await writeReport({
        errors,
        failure,
        projectStorageRoot,
        proof,
        reportDirectory,
        state,
        workspaceUrl,
      });
    } finally {
      await browser.close();
    }
  }

  if (failure) throw failure;
  console.log(
    JSON.stringify(
      {
        fixture: true,
        qualification: "NOT VERIFIED",
        report: resolve(reportDirectory, "pinned-materialized-dataset.json"),
        screenshots: state.screenshots,
        status: "passed",
        ...proof,
      },
      null,
      2,
    ),
  );
}

function createFixtureState() {
  return {
    currentProjectId: null,
    forgeManifestForArtifact: null,
    projectCreateCount: 0,
    requests: [],
    responses: [],
    screenshots: [],
    forbiddenRuntimeRequests: [],
    metadataRequests: [],
    startupWarnings: [],
    expectProjectClose: false,
    sessionCollectionError: false,
    collectionMismatch: false,
    activeSessionPhase: false,
    viewportPhase: null,
    liveResourceRequests: [],
    cameraMutationRequests: [],
    visualizationAckRequests: [],
    savedGeometryRequests: [],
    savedBinaryRequests: [],
    savedGeometryMode: null,
    viewportProofs: [],
    cameraSnapshots: [],
  };
}

async function createProject(page, state) {
  await page.getByRole("button", { name: "File", exact: true }).waitFor({ state: "visible", timeout: timeoutMs });
  await page.getByRole("button", { name: "File", exact: true }).click();
  const button = page.getByRole("menuitem", { name: /^New Project/i });
  await button.waitFor({ state: "visible", timeout: timeoutMs });
  await button.click();
  await page.locator('[data-project-document-state]').waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await page.waitForFunction(
    () => document.querySelector("[data-project-document-state]")?.textContent?.trim()
      === "Untitled project · unsaved",
    { timeout: timeoutMs },
  );
  assertCondition(state.currentProjectId, "Project creation response was not intercepted.");
}

async function openSavedResults(page, sessionState = "no-session") {
  await page.locator(`[data-project-workspace-session-state="${sessionState}"]`).waitFor({ state: "visible", timeout: timeoutMs });
  await page.locator(".fm-results-navigator-shell").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await page.locator("section[aria-label='Saved results']").first().waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
}

async function openActiveSavedResults(page) {
  await page.getByRole("tab", { name: "3D Viewport", exact: true }).waitFor({ state: "visible", timeout: timeoutMs });
  await page.locator("#fm-ribbon-tab-results").click();
  await page.locator(".fm-results-navigator-shell").waitFor({ state: "visible", timeout: timeoutMs });
  const savedTab = page.getByRole("tab", { name: "Saved", exact: true });
  await savedTab.waitFor({ state: "visible", timeout: timeoutMs });
  await savedTab.click();
  await page.locator(".fm-results-navigator-shell").waitFor({ state: "visible", timeout: timeoutMs });
  await page.locator("section[aria-label='Saved results']").first().waitFor({ state: "visible", timeout: timeoutMs });
}

async function selectPinnedArtifact(page, { artifactId, projectId, runId }) {
  await selectSavedRun(page, runId);
  const runSection = page.locator(`section[aria-label='Saved results for run ${cssEscape(runId)}']`);
  await runSection.waitFor({ state: "visible", timeout: timeoutMs });

  const nextSolutionSets = page.getByRole("button", {
    name: "Next SolutionSets",
    exact: true,
  });
  const solutionList = page.locator("ul[aria-label='SolutionSet revisions']");
  // Re-selecting another artifact of the same run preserves its catalog page.
  // Exercise pagination on first discovery, then resume the loaded page.
  await waitForCondition(
    async () => (await solutionList.isVisible()) || (await nextSolutionSets.isVisible()),
    "Saved run neither loaded a SolutionSet page nor exposed pagination.",
  );
  if (!(await solutionList.isVisible())) {
    const discoveryStatus = runSection.getByRole("status").filter({
      hasText: "No SolutionSets on this page.",
    });
    await discoveryStatus.waitFor({ state: "visible", timeout: timeoutMs });
    await nextSolutionSets.click();
  }

  await solutionList.waitFor({ state: "visible", timeout: timeoutMs });
  const solutionButton = solutionList.locator("button").filter({ hasText: SOLUTION_SET_ID }).filter({
    hasText: SOLUTION_REVISION,
  });
  await solutionButton.first().click();

  const memberSection = page.locator(
    `section[aria-label='Members of ${cssEscape(SOLUTION_SET_ID)} revision ${cssEscape(SOLUTION_REVISION)}']`,
  );
  await memberSection.waitFor({ state: "visible", timeout: timeoutMs });
  const memberList = memberSection.locator("ul[aria-label='SolutionSet members']");
  await memberList.waitFor({ state: "visible", timeout: timeoutMs });
  await memberList.locator("button").filter({ hasText: MEMBER_ID }).first().click();

  const artifactSection = page.locator(
    `section[aria-label='Artifacts for member ${cssEscape(MEMBER_ID)}']`,
  );
  await artifactSection.waitFor({ state: "visible", timeout: timeoutMs });
  const artifactList = artifactSection.locator(
    "ul[aria-label='Materialized dataset artifacts']",
  );
  await artifactList.waitFor({ state: "visible", timeout: timeoutMs });
  const artifactButton = artifactList.locator("button").filter({ hasText: artifactId });
  await artifactButton.first().click();

  const status = artifactSection.locator("[role='status']");
  await page.waitForFunction(
    ({ artifactId: expectedArtifactId, projectId: expectedProjectId, runId: expectedRunId }) => {
      const selected = document.querySelector(
        "[aria-label='Materialized dataset artifacts'] button[aria-current='true']",
      );
      return selected?.textContent?.includes(expectedArtifactId) === true &&
        document.querySelector("section[aria-label='Saved results']")?.textContent?.includes(expectedProjectId) === true &&
        document.querySelector(".fm-results-navigator-shell")?.textContent?.includes(expectedRunId) === true;
    },
    { artifactId, projectId, runId },
    { timeout: timeoutMs },
  );

  if (artifactId === POSITIVE_ARTIFACT_ID || artifactId === F32_ARTIFACT_ID) {
    await status.filter({ hasText: "Manifest verified." }).waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    await artifactSection.getByRole("button", {
      name: "Inspect pinned dataset",
      exact: true,
    }).click();
    await page.locator(
      "[data-slot-id='panel-right'] [data-materialized-dataset-inspector='readonly']",
    ).waitFor({ state: "visible", timeout: timeoutMs });
  } else {
    await status.filter({ hasText: "Manifest unavailable:" }).waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
  }

  const inspector = page.locator(
    "[data-slot-id='panel-right'] [data-materialized-dataset-inspector='readonly']",
  );
  const inspectorCount = await inspector.count();
  const inspectButtonCount = await artifactSection.getByRole("button", {
    name: "Inspect pinned dataset",
    exact: true,
  }).count();
  return {
    artifactId,
    inspectorText: inspectorCount > 0 ? await inspector.first().innerText() : "",
    inspector,
    inspectButtonCount,
    statusText: await artifactSection.innerText(),
  };
}

async function selectSavedRun(page, runId) {
  const runs = page.locator("ul[aria-label='Saved runs']");
  await runs.waitFor({ state: "visible", timeout: timeoutMs });
  const runButton = runs.locator("button").filter({ hasText: runId });
  await runButton.first().click();
  await page.locator(`section[aria-label='Saved results for run ${cssEscape(runId)}']`).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
}

function assertPositivePinnedInspector(text, expectedManifestRef = MANIFEST_OBJECT_REF) {
  assert.match(text, /Containing revision[\s\S]*9007199254740993/);
  assert.match(text, /Owner revision[\s\S]*9007199254740992/);
  assert.match(text, /Integrity verified/);
  assert.match(text, /Execution running/);
  assert.match(text, /Assessment unassessed/);
  assert.match(text, new RegExp(expectedManifestRef));
  assert.match(text, /Saved field values/);
}

async function assertBoundedValues(page, state) {
  const table = page.getByRole("table", { name: "Saved field values", exact: true });
  await table.waitFor({ state: "visible", timeout: timeoutMs });
  assert.equal(await table.locator("tbody tr").count(), 32);
  assert.match(await table.innerText(), /0\.25000000/);
  await page.getByLabel("Saved field component index", { exact: true }).fill("2");
  assert.match(await table.innerText(), /2\.2500000/);
  await page.getByRole("button", { name: "Next values", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('table[aria-label="Saved field values"] tbody th')?.textContent === "32");
  assert.match(await table.innerText(), /98\.250000/);
  await page.getByRole("button", { name: "Next values", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('table[aria-label="Saved field values"] tbody th')?.textContent === "64");
  assert.equal(await table.locator("tbody tr").count(), 6);
  assert.equal(await page.getByRole("button", { name: "Next values", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Previous values", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('table[aria-label="Saved field values"] tbody th')?.textContent === "32");
  state.corruptSlice = true;
  await page.getByRole("button", { name: "Reload values", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "checksum mismatch" }).waitFor({ state: "visible", timeout: timeoutMs });
  assert.equal(await table.count(), 0, "Corrupted reload retained a visible quantitative table.");
  state.corruptSlice = false;
  await page.getByRole("button", { name: "Reload values", exact: true }).click();
  await table.waitFor({ state: "visible", timeout: timeoutMs });
  await table.scrollIntoViewIfNeeded();
  await captureScreenshot(page, state, "pinned-materialized-dataset-values.png");
  state.sliceProof = { pages: [32, 32, 6], componentSelection: true, checksumRejected: true, reloadRecovered: true };
  state.holdSlice = true;
  await page.getByRole("button", { name: "Reload values", exact: true }).click();
  await waitForCondition(() => typeof state.releaseSlice === "function", "Delayed slice was not requested.");
  const previousAborts = state.sliceAborts ?? 0;
  await page.getByRole("button", { name: "Hide Inspector", exact: true }).click();
  await waitForCondition(() => (state.sliceAborts ?? 0) > previousAborts, "Closing the last consumer did not abort its slice request.");
  state.holdSlice = false;
  state.releaseSlice();
  state.releaseSlice = null;
  await page.getByRole("button", { name: "Show Inspector", exact: true }).click();
  await table.waitFor({ state: "visible", timeout: timeoutMs });
  await page.waitForFunction(() => document.querySelector('table[aria-label="Saved field values"] tbody th')?.textContent === "0");
  state.sliceProof.lastConsumerAbort = true;
  state.sliceProof.reopenStartsFresh = true;
}

async function waitForCondition(condition, message) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

function assertForgedManifestRejected(result) {
  assert.match(result.statusText, /Manifest unavailable:/);
  assert.doesNotMatch(result.statusText, /Manifest verified\./);
  assert.equal(
    result.inspectButtonCount,
    0,
    "Forged manifest left the Inspector action enabled.",
  );
  assertCondition(
    !result.inspectorText.includes(FORGED_MANIFEST_OBJECT_REF),
    "Forged manifest was rendered as a verified inspector payload.",
  );
}

async function assertSavedRunSwitchDoesNotRelabelPinnedSelection(
  page,
  state,
  { containingRevision, ownerRevision, projectId, runId },
) {
  const inspector = page.locator(
    "[data-slot-id='panel-right'] [data-materialized-dataset-inspector='readonly']",
  );
  await page.waitForFunction(
    ({ expectedProjectId, expectedRunId }) => {
      const panel = document.querySelector(
        "[data-slot-id='panel-right'] [data-materialized-dataset-inspector='readonly']",
      );
      if (!panel) return true;
      const text = panel.textContent ?? "";
      return text.includes(expectedProjectId) && text.includes(expectedRunId);
    },
    { expectedProjectId: projectId, expectedRunId: runId },
    { timeout: timeoutMs },
  );
  if (await inspector.count() === 0) return false;
  const text = await inspector.first().innerText();
  assert.match(text, new RegExp(runId));
  assert.match(text, new RegExp(containingRevision));
  assert.match(text, new RegExp(ownerRevision));
  assert.doesNotMatch(text, new RegExp(OTHER_RUN_ID));
  assert.equal(
    state.metadataRequests.filter((entry) => entry.runId === OTHER_RUN_ID).length,
    0,
    "Switching saved runs must not fetch a pinned metadata response for the wrong run.",
  );
  return true;
}

async function assertProjectSwitchDoesNotRelabelPinnedSelection(
  page,
  { oldProjectId, newProjectId },
) {
  await page.waitForFunction(
    () => document.querySelector(
      "[data-slot-id='panel-right'] [data-materialized-dataset-inspector='readonly']",
    ) === null,
    { timeout: timeoutMs },
  );
  const panel = page.locator("[data-slot-id='panel-right']");
  const panelText = await panel.innerText();
  if (panelText.includes(`pinned dataset belongs to project ${oldProjectId}`)) {
    assertCondition(
      panelText.includes(newProjectId),
      "Foreign-project pinned selection did not identify the active project.",
    );
    return;
  }
  assert.doesNotMatch(panelText, new RegExp(OWNER_REVISION));
  assert.doesNotMatch(panelText, new RegExp(SOLUTION_REVISION));
}

function liveResourceRequestCount(state) {
  return state.liveResourceRequests.filter(({ path }) =>
    isLiveViewportResourcePath(path),
  ).length;
}

function isLiveViewportResourcePath(path) {
  return LIVE_VIEWPORT_RESOURCE_PATHS.has(path) ||
    LIVE_VIEWPORT_RESOURCE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function liveCrossScopeRequests(state) {
  return state.liveResourceRequests.filter(({ path }) =>
    path !== "/v2/sessions/current/status" &&
    path !== "/v2/sessions/current/visualization/state" &&
    !isLiveViewportResourcePath(path),
  );
}

function savedBinaryRequestCounts(state) {
  return {
    geometry: state.savedGeometryRequests.length,
    savedBinary: state.savedBinaryRequests.length,
  };
}

async function assertSavedViewportRendered(page, state, variant, auditBefore = null) {
  state.viewportPhase = `saved-${variant}`;
  const baseline = auditBefore ?? await readWebglAuditCounters(page);
  await page.getByRole("tab", { name: "3D Viewport", exact: true }).click({ force: true });
  const canvas = page.locator(".fm-viewport-3d canvas").first();
  await canvas.waitFor({ state: "visible", timeout: timeoutMs });
  const artifactId = variant === "f32" ? F32_ARTIFACT_ID : POSITIVE_ARTIFACT_ID;
  await waitForCondition(
    () => state.savedGeometryRequests.some((request) => request.kind === "geometry" && request.artifactId === artifactId) &&
      state.savedBinaryRequests.some((request) => request.kind === "topology" && request.artifactId === artifactId) &&
      state.savedBinaryRequests.some((request) => request.kind === "support" && request.artifactId === artifactId) &&
      state.savedBinaryRequests.some((request) => request.kind === "slice" && request.artifactId === artifactId),
    "Saved viewport did not request geometry, topology, support and FMDS payloads.",
  );
  await page.waitForTimeout(250);
  const proof = await readViewportWebglProof(page, `saved-${variant}`, 3, baseline);
  state.viewportProofs.push(proof);
  assert.ok(proof.draw_calls > 0, `Saved ${variant} viewport did not issue a WebGL draw call.`);
  assert.ok(proof.element_array_buffer_bytes > 0, `Saved ${variant} viewport did not upload indexed geometry.`);
  assert.equal(proof.active_node_count, 3, `Saved ${variant} viewport did not preserve its inactive support mask.`);
  assert.equal(proof.active_color_mask_seen, true, `Saved ${variant} viewport did not upload distinct active-node colors with the support mask applied.`);
  return proof;
}

async function readViewportCameraSnapshot(page) {
  const viewport = page.locator(".fm-viewport-3d").first();
  await viewport.waitFor({ state: "visible", timeout: timeoutMs });
  return viewport.evaluate((element) => ({
    position: element.getAttribute("data-camera-position") ?? "",
    projection: element.getAttribute("data-camera-projection") ?? "",
    target: element.getAttribute("data-camera-target") ?? "",
    up: element.getAttribute("data-camera-up") ?? "",
  }));
}

async function dragViewportCamera(page, deltaX, deltaY) {
  const before = await readViewportCameraSnapshot(page);
  const canvas = page.locator(".fm-viewport-3d canvas").first();
  const box = await canvas.boundingBox();
  assertCondition(box && box.width > 80 && box.height > 80, "3D viewport canvas is too small for a camera gesture.");
  const startX = box.x + box.width * 0.5;
  const startY = box.y + box.height * 0.5;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY + deltaY, { steps: 6 });
  await page.mouse.up();
  // CameraControls commits after its settled-pose debounce. Observe the
  // committed snapshot instead of sampling before that callback has run.
  await waitForCondition(
    async () => JSON.stringify(await readViewportCameraSnapshot(page)) !== JSON.stringify(before),
    "Viewport camera gesture did not commit its selection-scoped snapshot.",
  );
  return readViewportCameraSnapshot(page);
}

async function reloadSavedViewport(page, state, artifactId, projectId) {
  await page.getByRole("tab", { name: "Saved", exact: true }).click({ force: true });
  await page.locator("section[aria-label='Saved results']").first().waitFor({ state: "visible", timeout: timeoutMs });
  if (artifactId === F32_ARTIFACT_ID) {
    const mismatchMode = state.savedGeometryMode;
    state.savedGeometryMode = null;
    await selectPinnedArtifact(page, { artifactId: POSITIVE_ARTIFACT_ID, projectId, runId: TARGET_RUN_ID });
    state.savedGeometryMode = mismatchMode;
  }
  const result = await selectPinnedArtifact(page, { artifactId, projectId, runId: TARGET_RUN_ID });
  await page.getByRole("tab", { name: "3D Viewport", exact: true }).click({ force: true });
  const canvas = page.locator(".fm-viewport-3d canvas").first();
  await canvas.waitFor({ state: "visible", timeout: timeoutMs });
  await page.waitForTimeout(250);
  const viewport = page.locator(".fm-viewport-3d").first();
  const text = await viewport.innerText().catch(() => "");
  const viewportBounds = await viewport.getAttribute("data-viewport-bounds").catch(() => null);
  const topologyFreshness = await viewport.getAttribute("data-topology-freshness").catch(() => null);
  const unavailable = /unavailable|identity|differs|unsupported|error|failed|503/i.test(text);
  return {
    explicit: unavailable,
    inspectorText: result.inspectorText,
    unavailable,
    viewport_bounds: viewportBounds,
    topology_freshness: topologyFreshness,
    viewport_text: text,
  };
}

async function assertLiveViewportRendered(page, state) {
  const auditBefore = await readWebglAuditCounters(page);
  await page.getByRole("tab", { name: "3D Viewport", exact: true }).click({ force: true });
  const canvas = page.locator(".fm-viewport-3d canvas").first();
  await canvas.waitFor({ state: "visible", timeout: timeoutMs });
  await waitForCondition(
    () => liveResourceRequestCount(state) > 0 && (state.liveTopologyRequests ?? 0) > 0 && (state.liveFieldRequests ?? 0) > 0,
    "Active live viewport did not request its own topology and field resources.",
  );
  await page.waitForTimeout(250);
  const proof = await readViewportWebglProof(page, "live", null, auditBefore);
  assert.ok(proof.draw_calls > 0, "Live viewport did not issue a WebGL draw call.");
  return proof;
}

async function readWebglAuditCounters(page) {
  return page.evaluate(() => ({ ...(window.__FULLMAG_PINNED_DATASET_WEBGL_PROOF__ ?? {}) }));
}

async function readViewportWebglProof(page, phase, activeNodeCount = null, auditBefore = null) {
  const canvas = page.locator(".fm-viewport-3d canvas").first();
  const metrics = await canvas.evaluate((element) => {
    const gl = element.getContext("webgl2") ?? element.getContext("webgl") ?? element.getContext("experimental-webgl");
    return {
      context_lost: gl ? Boolean(gl.isContextLost?.()) : true,
      drawing_buffer_height: gl?.drawingBufferHeight ?? 0,
      drawing_buffer_width: gl?.drawingBufferWidth ?? 0,
      client_height: element.clientHeight,
      client_width: element.clientWidth,
    };
  });
  assert.equal(metrics.context_lost, false, `${phase} viewport WebGL context was lost.`);
  assert.ok(metrics.drawing_buffer_width > 0 && metrics.drawing_buffer_height > 0, `${phase} viewport has a zero drawing buffer.`);
  const screenshot = await canvas.screenshot();
  const audit = await readWebglAuditCounters(page);
  const baseline = auditBefore ?? {};
  const baselineColorUploadCount = Array.isArray(baseline.colorUploads)
    ? baseline.colorUploads.length
    : 0;
  const colorUploads = Array.isArray(audit.colorUploads)
    ? audit.colorUploads.slice(baselineColorUploadCount)
    : [];
  const neutral = 0.21404114048223255;
  const activeColorMaskSeen = colorUploads.some((values) =>
    [0, 2, 3].every((node) => {
      const offset = node * 3;
      return values.slice(offset, offset + 3).some((value) => Math.abs(value - neutral) > 1e-3);
    }) &&
    values.slice(3, 6).every((value) => Math.abs(value - neutral) <= 1e-3),
  );
  return {
    ...(activeNodeCount === null ? {} : { active_node_count: activeNodeCount }),
    canvas: metrics,
    active_color_mask_seen: activeColorMaskSeen,
    color_upload_count: colorUploads.length,
    drawn_color_samples: colorUploads.slice(-8),
    float12_upload_samples: audit.float12Uploads ?? [],
    drawn_attribute_layouts: audit.drawnAttributeLayouts ?? [],
    draw_calls: Math.max(0, (audit.drawCalls ?? 0) - (baseline.drawCalls ?? 0)),
    element_array_buffer_bytes: Math.max(0, (audit.elementArrayBufferBytesUploaded ?? 0) - (baseline.elementArrayBufferBytesUploaded ?? 0)),
    phase,
    screenshot_sha256: sha256Hex(screenshot),
    screenshot_bytes: screenshot.length,
    uploaded_bytes: Math.max(0, (audit.bufferBytesUploaded ?? 0) - (baseline.bufferBytesUploaded ?? 0)),
  };
}

async function installFixtureRoutes(page, state) {
  await page.route("**/v2/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;

    if (method === "GET" && path === "/v2/sessions") {
      if (state.sessionCollectionError) {
        await fulfillJson(route, { error: { code: "fixture_collection_unavailable", message: "Session collection unavailable." } }, 503);
        return;
      }
      await fulfillJson(route, {
        schema_version: "2.0.0",
        sessions: state.activeSessionPhase
          ? [{ current: true, name: "Pinned FEM active fixture", session_id: "session-pinned-fem", status: "running" }]
          : state.collectionMismatch
            ? [{ current: true, name: "Session B", session_id: "session-b", status: "ready" }]
            : [],
      });
      return;
    }
    if (method === "GET" && path === "/v2/sessions/current/status") {
      if (state.activeSessionPhase) {
        await fulfillJson(route, activeSessionStatusFixture());
        return;
      }
      if (state.collectionMismatch) {
        await fulfillJson(route, { session: { session_id: "session-a", session_epoch: "epoch-a", request_scope_epoch: "scope-a" }, resources: {} });
        return;
      }
      await fulfillJson(route, {
        error: { code: "session_missing", message: "No session in this saved-results fixture." },
      }, 404);
      return;
    }
    if (state.activeSessionPhase && method === "GET" && path === "/v2/sessions/current/visualization/state") {
      await fulfillJson(route, activeVisualizationStateFixture());
      return;
    }
    if (state.activeSessionPhase && method === "GET" && path === "/v2/sessions/current/data/quantities") {
      await fulfillJson(route, activeQuantityCatalogFixture());
      return;
    }
    if (state.activeSessionPhase && method === "GET" && path === "/v2/sessions/current/visualization/mode-compositions/active") {
      await fulfillJson(route, activeModeCompositionFixture());
      return;
    }
    if (state.activeSessionPhase && method === "GET" && path === "/v2/sessions/current/data/domain/meta") {
      await fulfillJson(route, activeDomainMetaFixture());
      return;
    }
    if (state.activeSessionPhase && method === "GET" && path === "/v2/sessions/current/data/fields") {
      await fulfillJson(route, activeFieldCatalogFixture());
      return;
    }
    if (state.activeSessionPhase && method === "GET" && path === "/v2/sessions/current/data/fields/m/availability") {
      await fulfillJson(route, activeFieldAvailabilityFixture(url.searchParams));
      return;
    }
    if (state.activeSessionPhase && method === "GET" && path === "/v2/sessions/current/data/fields/m/meta") {
      await fulfillJson(route, activeFieldMetaFixture());
      return;
    }
    if (state.activeSessionPhase && method === "GET" && path === "/v2/sessions/current/data/domain/topology") {
      state.liveTopologyRequests = (state.liveTopologyRequests ?? 0) + 1;
      const range = route.request().headers().range;
      const match = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
      if (!range) {
        // The client probes the header first, then fetches small topologies
        // as a complete resource rather than loading every section by range.
        await fulfillBinary(route, SAVED_TOPOLOGY_BUFFER, 200, {
          etag: `"${SAVED_TOPOLOGY_OBJECT_REF}"`,
          "x-fullmag-topology-fingerprint": `sha256:${SAVED_TOPOLOGY_OBJECT_REF}`,
        });
        return;
      }
      assert.ok(match, "Live topology fixture requires a valid bounded byte range.");
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), SAVED_TOPOLOGY_BUFFER.length - 1);
      assert.ok(start <= end && start >= 0, "Live topology requested an invalid range.");
      await fulfillBinary(route, SAVED_TOPOLOGY_BUFFER.subarray(start, end + 1), 206, {
        "content-range": `bytes ${start}-${end}/${SAVED_TOPOLOGY_BUFFER.length}`,
        etag: `"${SAVED_TOPOLOGY_OBJECT_REF}"`,
        "x-fullmag-topology-fingerprint": `sha256:${SAVED_TOPOLOGY_OBJECT_REF}`,
      });
      return;
    }
    if (state.activeSessionPhase && method === "GET" && path === "/v2/sessions/current/data/fields/m/samples/vector") {
      state.liveFieldRequests = (state.liveFieldRequests ?? 0) + 1;
      await fulfillBinary(route, liveFieldVectorBuffer(), 200, { "x-fullmag-domain-generation-id": "1" });
      return;
    }
    if (state.activeSessionPhase && method === "GET" && path === "/v2/sessions/current/model/scene") {
      await fulfillJson(route, activeSceneFixture());
      return;
    }
    if (state.activeSessionPhase && method === "GET" && path === "/v2/sessions/current/model/universe") {
      await fulfillJson(route, activeUniverseFixture());
      return;
    }
    if (state.activeSessionPhase && method === "GET" && path === "/v2/sessions/current/meshing/meshes/shared-domain/manifest") {
      await fulfillJson(route, activeMeshManifestFixture());
      return;
    }
    if (method === "POST" && path === "/v2/persistence/projects") {
      const projectId = `project-pinned-materialized-dataset-${++state.projectCreateCount}`;
      state.currentProjectId = projectId;
      await fulfillJson(route, projectResource(projectId), 201);
      return;
    }

    const runListMatch = path.match(/^\/v2\/persistence\/projects\/([^/]+)\/runs$/);
    if (method === "GET" && runListMatch) {
      const projectId = decodeURIComponent(runListMatch[1]);
      await fulfillJson(route, projectRunList(projectId, state));
      return;
    }

    const runResourceMatch = path.match(/^\/v2\/persistence\/projects\/([^/]+)\/runs\/([^/]+)$/);
    if (method === "GET" && runResourceMatch) {
      await fulfillJson(route, projectRunResource(
        decodeURIComponent(runResourceMatch[1]),
        decodeURIComponent(runResourceMatch[2]),
      ));
      return;
    }

    const discoveryMatch = path.match(
      /^\/v2\/persistence\/projects\/([^/]+)\/runs\/([^/]+)\/solution-sets$/,
    );
    if (method === "GET" && discoveryMatch) {
      const projectId = decodeURIComponent(discoveryMatch[1]);
      const runId = decodeURIComponent(discoveryMatch[2]);
      await fulfillJson(route, solutionDiscovery(
        projectId,
        runId,
        url.searchParams.get("cursor"),
      ));
      return;
    }

    const solutionMatch = path.match(
      /^\/v2\/persistence\/projects\/([^/]+)\/runs\/([^/]+)\/solution-sets\/([^/]+)\/revisions\/([^/]+)$/,
    );
    if (method === "GET" && solutionMatch) {
      await fulfillJson(route, solutionSetResource(decodeURIComponent(solutionMatch[1])));
      return;
    }

    const membersMatch = path.match(
      /^\/v2\/persistence\/projects\/([^/]+)\/runs\/([^/]+)\/solution-sets\/([^/]+)\/revisions\/([^/]+)\/members$/,
    );
    if (method === "GET" && membersMatch) {
      await fulfillJson(route, solutionSetMembersPage(decodeURIComponent(membersMatch[1])));
      return;
    }

    const artifactsMatch = path.match(
      /^\/v2\/persistence\/projects\/([^/]+)\/runs\/([^/]+)\/solution-sets\/([^/]+)\/revisions\/([^/]+)\/members\/([^/]+)\/artifacts$/,
    );
    if (method === "GET" && artifactsMatch) {
      await fulfillJson(route, solutionSetArtifactsPage(decodeURIComponent(artifactsMatch[1]), state));
      return;
    }

    const savedGeometryMatch = path.match(
      /^\/v2\/persistence\/projects\/([^/]+)\/runs\/([^/]+)\/solution-sets\/([^/]+)\/revisions\/([^/]+)\/members\/([^/]+)\/artifacts\/([^/]+)\/saved-field-geometry(?:\/(topology|support))?$/,
    );
    if (method === "GET" && savedGeometryMatch) {
      const projectId = decodeURIComponent(savedGeometryMatch[1]);
      const artifactId = decodeURIComponent(savedGeometryMatch[6]);
      const variant = artifactId === F32_ARTIFACT_ID ? "f32" : "f64";
      const kind = savedGeometryMatch[7] ?? "geometry";
      state.savedGeometryRequests.push({ artifactId, kind, projectId });
      if (kind === "geometry") {
        if (state.savedGeometryMode === "geometry-503") {
          await fulfillJson(route, {
            error: {
              code: "saved_geometry_unavailable",
              message: "Pinned saved geometry is unavailable in this fixture.",
            },
          }, 503);
          return;
        }
        const geometry = activeSavedGeometryResource(variant, projectId);
        if (state.savedGeometryMode === "mismatch") {
          geometry.support_fingerprint = sha256Hex("fullmag.p6-65.mismatched-support.v1");
        }
        await fulfillJson(route, geometry);
      } else if (kind === "topology") {
        assertSavedGeometryBinaryQuery(url, activeSavedGeometryResource(variant, projectId), SAVED_TOPOLOGY_BUFFER.length);
        state.savedBinaryRequests.push({ artifactId, kind });
        await fulfillBinary(route, SAVED_TOPOLOGY_BUFFER, 200, {
          etag: `"${SAVED_TOPOLOGY_OBJECT_REF}"`,
        });
      } else {
        assertSavedGeometryBinaryQuery(url, activeSavedGeometryResource(variant, projectId), SAVED_SUPPORT_BUFFER.length);
        state.savedBinaryRequests.push({ artifactId, kind });
        await fulfillBinary(route, SAVED_SUPPORT_BUFFER, 200, {
          etag: `"${SAVED_SUPPORT_OBJECT_REF}"`,
        });
      }
      return;
    }

    const sliceMatch = path.match(
      /^\/v2\/persistence\/projects\/([^/]+)\/runs\/([^/]+)\/solution-sets\/([^/]+)\/revisions\/([^/]+)\/members\/([^/]+)\/artifacts\/([^/]+)\/materialized-dataset\/slice$/,
    );
    if (method === "GET" && sliceMatch) {
      const projectId = decodeURIComponent(sliceMatch[1]);
      assert.equal(decodeURIComponent(sliceMatch[2]), TARGET_RUN_ID);
      assert.equal(decodeURIComponent(sliceMatch[4]), SOLUTION_REVISION);
      const artifactId = decodeURIComponent(sliceMatch[6]);
      if (state.activeSessionPhase) {
        assert.equal(projectId, state.currentProjectId);
        assert.ok([POSITIVE_ARTIFACT_ID, F32_ARTIFACT_ID].includes(artifactId));
        state.savedBinaryRequests.push({ artifactId, kind: "slice" });
      } else {
        assert.equal(projectId, "project-pinned-materialized-dataset-1");
        assert.equal(artifactId, POSITIVE_ARTIFACT_ID);
      }
      const held = state.holdSlice;
      if (held) await new Promise((release) => { state.releaseSlice = release; });
      try {
        const sliceBody = state.activeSessionPhase
          ? activeDatasetSliceBody(url.searchParams, artifactId === F32_ARTIFACT_ID ? "f32" : "f64", state.corruptSlice, projectId)
          : datasetSliceBody(url.searchParams, state.corruptSlice);
        await route.fulfill({
          status: 200,
          contentType: "application/octet-stream",
          headers: {
            "access-control-allow-origin": "*",
            "access-control-expose-headers": "content-range,etag,x-api-contract-version",
            "etag": `"${sha256Hex(sliceBody)}"`,
            "x-api-contract-version": "1.0.0",
          },
          body: sliceBody,
        });
      } catch (error) {
        if (!held) throw error;
        assert.match(String(error), /closed|intercept|cancel|abort|Invalid|Target/i);
      }
      return;
    }

    const materializedMatch = path.match(
      /^\/v2\/persistence\/projects\/([^/]+)\/runs\/([^/]+)\/solution-sets\/([^/]+)\/revisions\/([^/]+)\/members\/([^/]+)\/artifacts\/([^/]+)\/materialized-dataset$/,
    );
    if (method === "GET" && materializedMatch) {
      const artifactId = decodeURIComponent(materializedMatch[6]);
      state.metadataRequests.push({
        artifactId,
        forged: artifactId === state.forgeManifestForArtifact,
        projectId: decodeURIComponent(materializedMatch[1]),
        runId: decodeURIComponent(materializedMatch[2]),
      });
      if (state.activeSessionPhase) {
        await fulfillJson(route, activeMaterializedDatasetResource(
          artifactId === F32_ARTIFACT_ID ? "f32" : "f64",
          decodeURIComponent(materializedMatch[1]),
        ));
      } else {
        await fulfillJson(route, materializedDatasetResource(artifactId === state.forgeManifestForArtifact));
      }
      return;
    }

    if (path.startsWith("/v2/sessions/current/") && method !== "GET") {
      await fulfillJson(route, { error: { code: "runtime_mutation_forbidden_in_fixture" } }, 409);
      return;
    }

    await fulfillJson(route, {}, 204);
  });
}

function projectResource(projectId) {
  return {
    archive_base64: "UEsDBA==",
    dirty: true,
    durability: "memory_only",
    migration: {
      can_write: true,
      migrated: false,
      preserved_paths: [],
      source_schema: "fullmag.project.v1",
      target_schema: "fullmag.project.v1",
      warnings: [],
    },
    mode: { kind: "read_write" },
    name: "Untitled project",
    persisted_revision: 0,
    project_id: projectId,
    revision: 0,
    schema_version: "fullmag.project.v1",
    source_hash: "sha256:browser-pinned-materialized-dataset",
  };
}

function projectRunList(projectId, state) {
  const hasSavedRuns = projectId.endsWith("-1") ||
    (state.activeSessionPhase && projectId === state.currentProjectId);
  return {
    next_cursor: null,
    project_id: projectId,
    runs: hasSavedRuns
      ? [projectRunSummary(TARGET_RUN_ID), projectRunSummary(OTHER_RUN_ID)]
      : [],
  };
}

function projectRunSummary(runId) {
  return {
    accepted_at: "2026-10-01T00:00:00Z",
    catalog_revision: 1,
    catalog_state: "materialized",
    payload_fingerprint: `sha256:${"b".repeat(64)}`,
    requested_execution: {
      backend: "cpu",
      device: "cpu",
      mode: "run",
      precision: "double",
      minimum_resources: null,
    },
    run_id: runId,
    scheduling_priority: 0,
    task_count: 1,
  };
}

function projectRunResource(projectId, runId) {
  return {
    catalog_revision: 1,
    catalog_state: "materialized",
    payload_fingerprint: `sha256:${"b".repeat(64)}`,
    project_id: projectId,
    requested_execution: projectRunSummary(runId).requested_execution,
    run_id: runId,
    scheduling_priority: 0,
    tasks: [],
  };
}

function solutionDiscovery(projectId, runId, cursor) {
  const base = {
    project_id: projectId,
    run_id: runId,
    schema_version: "fullmag.analysis.solution_set_discovery.v1",
  };
  if (runId !== TARGET_RUN_ID || cursor !== "solution-next") {
    return {
      ...base,
      items: [],
      next_cursor: runId === TARGET_RUN_ID ? "solution-next" : null,
    };
  }
  return {
    ...base,
    items: [{
      manifest_digest: `sha256:${"c".repeat(64)}`,
      revision: SOLUTION_REVISION,
      solution_set_id: SOLUTION_SET_ID,
    }],
    next_cursor: null,
  };
}

function solutionSetResource(projectId = "project-pinned-materialized-dataset-1") {
  return {
    artifact_count: 3,
    coverage_count: 1,
    execution_status: "running",
    manifest_digest: `sha256:${"c".repeat(64)}`,
    manifest_state: "open",
    member_count: 1,
    project_id: projectId,
    provenance: solutionProvenance(),
    revision: SOLUTION_REVISION,
    run_id: TARGET_RUN_ID,
    schema_version: "fullmag.analysis.solution_revision.v1",
    scientific_assessment: {
      evidence_artifact_count: 0,
      reason: null,
      status: "unassessed",
    },
    solution_set_id: SOLUTION_SET_ID,
  };
}

function solutionSetMembersPage(projectId = "project-pinned-materialized-dataset-1") {
  return {
    items: [{
      artifact_count: 3,
      attempt_id: "attempt:pinned",
      case_id: "case:pinned",
      execution_status: "running",
      member_id: MEMBER_ID,
      ownership_epoch: "1",
      scientific_assessment: {
        evidence_artifact_count: 0,
        reason: null,
        status: "unassessed",
      },
      stage_id: "stage:pinned",
      task_id: "task:pinned",
    }],
    manifest_digest: `sha256:${"c".repeat(64)}`,
    next_after_member_id: null,
    project_id: projectId,
    revision: SOLUTION_REVISION,
    run_id: TARGET_RUN_ID,
    schema_version: "fullmag.analysis.solution_revision.v1",
    solution_set_id: SOLUTION_SET_ID,
  };
}

function solutionSetArtifactsPage(projectId = "project-pinned-materialized-dataset-1", _state = null) {
  const artifact = (artifactId, objectRef) => ({
    accepted_state: null,
    artifact_id: artifactId,
    byte_length: "4096",
    coverage: {
      committed_samples: "1",
      expected_samples: "1",
      segment_count: 1,
      state: "complete",
    },
    integrity: "not_verified",
    kind: "other",
    object_ref: objectRef,
    schema_id: MATERIALIZED_DATASET_SCHEMA,
    scientific_evidence: false,
  });
  const items = [
    artifact(POSITIVE_ARTIFACT_ID, MANIFEST_OBJECT_REF),
    artifact(F32_ARTIFACT_ID, F32_MANIFEST_OBJECT_REF),
    artifact(FORGED_ARTIFACT_ID, FORGED_ARTIFACT_OBJECT_REF),
  ];
  return {
    items,
    manifest_digest: `sha256:${"c".repeat(64)}`,
    member_id: MEMBER_ID,
    next_after_artifact_id: null,
    project_id: projectId,
    revision: SOLUTION_REVISION,
    run_id: TARGET_RUN_ID,
    schema_version: "fullmag.analysis.solution_revision.v1",
    solution_set_id: SOLUTION_SET_ID,
  };
}

function materializedDatasetResource(forged) {
  const source = {
    run_id: TARGET_RUN_ID,
    solution_set_id: SOLUTION_SET_ID,
    solution_revision: OWNER_REVISION,
    member_id: MEMBER_ID,
    artifact_id: "tensor:m",
    tensor_object_ref: "b".repeat(64),
    run_spec_digest: `sha256:${"e".repeat(64)}`,
  };
  const manifestObjectRef = forged ? FORGED_MANIFEST_OBJECT_REF : MANIFEST_OBJECT_REF;
  return {
    schema_version: MATERIALIZED_DATASET_RESOURCE_SCHEMA,
    project_id: "project-pinned-materialized-dataset-1",
    run_id: TARGET_RUN_ID,
    solution_set_id: SOLUTION_SET_ID,
    containing_solution_revision: SOLUTION_REVISION,
    owner_solution_revision: OWNER_REVISION,
    member_id: MEMBER_ID,
    artifact_id: forged ? FORGED_ARTIFACT_ID : POSITIVE_ARTIFACT_ID,
    manifest_object_ref: manifestObjectRef,
    manifest_byte_length: "4096",
    integrity: "verified",
    source,
    owner_execution_status: "running",
    owner_scientific_assessment: {
      status: "unassessed",
      reason: null,
      evidence_artifact_count: 0,
    },
    sample_id: "sample:pinned",
    item_id: "item:pinned",
    field_id: "field:m",
    dataset: {
      schema_version: "1.0.0",
      dataset_id: "dataset:pinned-m",
      revision: "1",
      definition_id: "definition:pinned-m",
      definition_revision: "1",
      source,
      status: { availability: "ready", reason: null, actions: [] },
    },
    definition: {
      schema_version: "1.0.0",
      definition_id: "definition:pinned-m",
      revision: "1",
      source,
      domain_selection: {
        selection_id: `sha256:${"f".repeat(64)}`,
        selection_revision: "1",
      },
      axes: [],
      transforms: [],
      evaluation_policy: {
        precision: "f64",
        approximation: "exact_only",
        unavailable_data: "fail",
      },
    },
    field: {
      sample_id: "sample:pinned",
      item_id: "item:pinned",
      field_id: "field:m",
      group_id: "group:pinned",
      producer_id: "producer:fem-p1",
      producer_version: "1",
      tensor_schema_id: "fullmag.tensor.v1",
      tensor_byte_length: "2048",
      plane: "values",
      accepted_state: null,
      tensor_artifact: {
        artifact_id: source.artifact_id,
        schema_id: "fullmag.tensor.v1",
        object_ref: source.tensor_object_ref,
        byte_length: "2048",
        accepted_state: null,
      },
      coverage: {
        total_elements: "70",
        component_count: "3",
        dtype: "f64",
        endian: "little",
        total_bytes: "1680",
        chunk_count: 1,
      },
      descriptor: {
        quantity_id: "m",
        unit: "1",
        tensor_rank: "1",
        frame: { kind: "laboratory", frame_id: "frame:global" },
        sample_location: "node",
        active_support: {
          support_fingerprint: `sha256:${"f".repeat(64)}`,
          selection: null,
        },
        function_space: {
          space_id: "space:h1",
          family: "H1",
          order: "1",
          vector_dimension: "3",
          ordering: "by_node",
          basis_id: "basis:h1",
          constraints_fingerprint: null,
          partition_fingerprint: null,
          orientation_mapping_ref: null,
        },
        topology_id: `sha256:${"1".repeat(64)}`,
        carrier_id: "carrier:mesh",
        layout_digest: `sha256:${"2".repeat(64)}`,
        axes: [
          { axis_id: "node", unit: "1", length: "70" },
          { axis_id: "component", unit: "1", length: "3" },
        ],
        component_axis: "component",
        complex_encoding: "real",
        harmonic_convention: null,
        normalization: "unit_vector",
        value_representation: "physical_field",
        modal_semantics: null,
        resolution: "quantitative",
      },
    },
  };
}

function activeMaterializedDatasetResource(variant, projectId, options = {}) {
  const forged = options.forged === true;
  const f32 = variant === "f32";
  const manifestObjectRef = f32 ? F32_MANIFEST_OBJECT_REF : MANIFEST_OBJECT_REF;
  const artifactId = f32 ? F32_ARTIFACT_ID : POSITIVE_ARTIFACT_ID;
  const tensorObjectRef = f32 ? F32_TENSOR_OBJECT_REF : F64_TENSOR_OBJECT_REF;
  const tensorArtifactId = f32 ? "tensor:m:f32" : "tensor:m:f64";
  const tensorByteLength = f32 ? "48" : "96";
  const layoutDigest = f32 ? F32_LAYOUT_DIGEST : F64_LAYOUT_DIGEST;
  const source = {
    run_id: TARGET_RUN_ID,
    solution_set_id: SOLUTION_SET_ID,
    solution_revision: OWNER_REVISION,
    member_id: MEMBER_ID,
    artifact_id: tensorArtifactId,
    tensor_object_ref: tensorObjectRef,
    run_spec_digest: `sha256:${"e".repeat(64)}`,
  };
  const descriptor = {
    quantity_id: "m",
    unit: "1",
    tensor_rank: "1",
    frame: { kind: "laboratory", frame_id: "frame:global" },
    sample_location: "node",
    active_support: {
      support_fingerprint: `sha256:${SAVED_SUPPORT_OBJECT_REF}`,
      selection: null,
    },
    function_space: {
      space_id: "space:h1",
      family: "H1",
      order: "1",
      vector_dimension: "3",
      ordering: "by_node",
      basis_id: "basis:h1",
      constraints_fingerprint: null,
      partition_fingerprint: null,
      orientation_mapping_ref: null,
    },
    topology_id: `sha256:${SAVED_TOPOLOGY_OBJECT_REF}`,
    carrier_id: "carrier:mesh",
    layout_digest: `sha256:${layoutDigest}`,
    axes: [
      { axis_id: "node", unit: "1", length: "4" },
      { axis_id: "component", unit: "1", length: "3" },
    ],
    component_axis: "component",
    complex_encoding: "real",
    harmonic_convention: null,
    normalization: "unit_vector",
    value_representation: "physical_field",
    modal_semantics: null,
    resolution: "quantitative",
  };
  const resource = {
    schema_version: MATERIALIZED_DATASET_RESOURCE_SCHEMA,
    project_id: projectId,
    run_id: TARGET_RUN_ID,
    solution_set_id: SOLUTION_SET_ID,
    containing_solution_revision: SOLUTION_REVISION,
    owner_solution_revision: OWNER_REVISION,
    member_id: MEMBER_ID,
    artifact_id: artifactId,
    manifest_object_ref: manifestObjectRef,
    manifest_byte_length: "4096",
    integrity: "verified",
    source,
    owner_execution_status: "running",
    owner_scientific_assessment: { status: "unassessed", reason: null, evidence_artifact_count: 0 },
    sample_id: "sample:pinned",
    item_id: "item:pinned",
    field_id: "field:m",
    dataset: {
      schema_version: "1.0.0",
      dataset_id: f32 ? "dataset:pinned-m-f32" : "dataset:pinned-m-f64",
      revision: "1",
      definition_id: f32 ? "definition:pinned-m-f32" : "definition:pinned-m-f64",
      definition_revision: "1",
      source,
      status: { availability: "ready", reason: null, actions: [] },
    },
    definition: {
      schema_version: "1.0.0",
      definition_id: f32 ? "definition:pinned-m-f32" : "definition:pinned-m-f64",
      revision: "1",
      source,
      domain_selection: { selection_id: `sha256:${sha256Hex("fullmag.p6-65.selection.v1")}`, selection_revision: "1" },
      axes: [],
      transforms: [],
      evaluation_policy: { precision: f32 ? "f32" : "f64", approximation: "exact_only", unavailable_data: "fail" },
    },
    field: {
      sample_id: "sample:pinned",
      item_id: "item:pinned",
      field_id: "field:m",
      group_id: "group:pinned",
      producer_id: "producer:fem-p1",
      producer_version: "1",
      tensor_schema_id: "fullmag.tensor.v1",
      tensor_byte_length: tensorByteLength,
      plane: "values",
      accepted_state: null,
      tensor_artifact: {
        artifact_id: tensorArtifactId,
        schema_id: "fullmag.tensor.v1",
        object_ref: tensorObjectRef,
        byte_length: tensorByteLength,
        accepted_state: null,
      },
      coverage: {
        total_elements: "4",
        component_count: "3",
        dtype: f32 ? "f32" : "f64",
        endian: "little",
        total_bytes: tensorByteLength,
        chunk_count: "1",
      },
      descriptor,
    },
  };
  if (forged) resource.manifest_object_ref = FORGED_MANIFEST_OBJECT_REF;
  return resource;
}

function activeSavedGeometryResource(variant, projectId) {
  const dataset = activeMaterializedDatasetResource(variant, projectId);
  const geometryManifestObjectRef = sha256Hex(`fullmag.p6-65.geometry-manifest-${variant}.v1`);
  const geometryPayloadObjectRef = sha256Hex(`fullmag.p6-65.geometry-payload-${variant}.v1`);
  return {
    schema_version: "fullmag.persistence.saved_field_geometry.v1",
    project_id: projectId,
    run_id: TARGET_RUN_ID,
    solution_set_id: SOLUTION_SET_ID,
    containing_solution_revision: SOLUTION_REVISION,
    owner_solution_revision: OWNER_REVISION,
    member_id: MEMBER_ID,
    source: {
      run_id: TARGET_RUN_ID,
      solution_set_id: SOLUTION_SET_ID,
      solution_revision: OWNER_REVISION,
      member_id: MEMBER_ID,
      tensor_artifact_id: dataset.source.artifact_id,
      tensor_object_ref: dataset.source.tensor_object_ref,
      run_spec_digest: dataset.source.run_spec_digest,
    },
    dataset_manifest: {
      artifact_id: dataset.artifact_id,
      schema_id: MATERIALIZED_DATASET_SCHEMA,
      object_ref: dataset.manifest_object_ref,
      byte_length: dataset.manifest_byte_length,
      kind: "other",
      accepted_state: null,
    },
    geometry_manifest: {
      artifact_id: `solution-field-geometry-${geometryManifestObjectRef}`,
      schema_id: "fullmag.solution_field_geometry.v1",
      object_ref: geometryManifestObjectRef,
      byte_length: "512",
      kind: "other",
      accepted_state: null,
    },
    geometry_payload: {
      schema_id: "fullmag.fem_p1_field_geometry.v1",
      object_ref: geometryPayloadObjectRef,
      byte_length: "512",
      accepted_state: null,
    },
    geometry_schema_version: "fullmag.fem_p1_field_geometry.v1",
    tensor_artifact: {
      artifact_id: dataset.field.tensor_artifact.artifact_id,
      schema_id: dataset.field.tensor_artifact.schema_id,
      object_ref: dataset.field.tensor_artifact.object_ref,
      byte_length: dataset.field.tensor_artifact.byte_length,
      accepted_state: null,
    },
    dataset: {
      dataset_id: dataset.dataset.dataset_id,
      revision: dataset.dataset.revision,
      sample_id: dataset.sample_id,
      item_id: dataset.item_id,
      field_id: dataset.field_id,
      group_id: dataset.field.group_id,
      descriptor: dataset.field.descriptor,
    },
    layout_digest: dataset.field.descriptor.layout_digest,
    topology_fingerprint: dataset.field.descriptor.topology_id,
    support_fingerprint: dataset.field.descriptor.active_support.support_fingerprint,
    producer_id: dataset.field.producer_id,
    producer_version: dataset.field.producer_version,
    coordinate_unit: "m",
    node_count: "4",
    cell_count: "1",
    facet_count: "4",
    active_node_count: "3",
    representation_evidence: "not_verified",
    topology_binary_schema: "fullmag.binary.fem_mesh_topology.v2",
    topology_binary_byte_length: String(SAVED_TOPOLOGY_BUFFER.length),
    topology_binary_sha256: SAVED_TOPOLOGY_OBJECT_REF,
    support_binary_schema: "fullmag.binary.saved_field_support.v1",
    support_binary_byte_length: String(SAVED_SUPPORT_BUFFER.length),
    support_binary_sha256: SAVED_SUPPORT_OBJECT_REF,
    geometry_decode_budget_bytes: String(64 * 1024 * 1024),
  };
}

function activeDatasetSliceBody(query, variant, corrupt, projectId) {
  const dataset = activeMaterializedDatasetResource(variant, projectId);
  const f32 = variant === "f32";
  const expectedBytes = f32 ? 48 : 96;
  assert.equal(query.get("expected_manifest_object_ref"), dataset.manifest_object_ref);
  const byteBudget = Number(query.get("max_response_bytes"));
  // Inspector requests a bounded 64 KiB preview; the viewport requests the
  // exact complete tensor size. Both receive the same four-node payload.
  assert.ok(Number.isSafeInteger(byteBudget) && byteBudget >= expectedBytes && byteBudget <= 65536);
  assert.equal(query.get("element_offset"), "0");
  assert.equal(query.get("element_count"), "4");
  const payload = savedTensorPayload(variant);
  const metadata = {
    schema_version: "fullmag.binary.materialized_dataset_slice.v1",
    project_id: dataset.project_id,
    run_id: dataset.run_id,
    solution_set_id: dataset.solution_set_id,
    containing_solution_revision: dataset.containing_solution_revision,
    member_id: dataset.member_id,
    artifact_id: dataset.artifact_id,
    manifest_object_ref: dataset.manifest_object_ref,
    manifest_byte_length: dataset.manifest_byte_length,
    source: dataset.source,
    descriptor: dataset.field.descriptor,
    integrity: "verified_returned_ranges",
    slice: {
      schema_version: "1.0.0",
      dataset_id: dataset.dataset.dataset_id,
      dataset_revision: dataset.dataset.revision,
      sample_id: dataset.sample_id,
      item_id: dataset.item_id,
      field_id: dataset.field_id,
      field_layout_digest: dataset.field.descriptor.layout_digest,
      element_offset: "0",
      element_count: "4",
      total_elements: "4",
      component_count: "3",
      precision: f32 ? "f32" : "f64",
      byte_order: "little_endian",
      payload_bytes: String(payload.length),
      parts: [{
        plane: "values",
        plane_offset_bytes: "0",
        object_offset_bytes: "0",
        object_ref: dataset.field.tensor_artifact.object_ref,
        byte_length: String(payload.length),
        range_sha256: `sha256:${sha256Hex(payload)}`,
      }],
    },
  };
  const json = Buffer.from(JSON.stringify(metadata));
  const header = Buffer.alloc(12);
  header.write("FMDS");
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt32LE(json.length, 8);
  const body = Buffer.concat([header, json, payload]);
  if (corrupt) body[body.length - 1] ^= 1;
  return body;
}

function assertSavedGeometryBinaryQuery(url, geometry, byteLength) {
  assert.equal(url.searchParams.get("expected_dataset_manifest_object_ref"), geometry.dataset_manifest.object_ref);
  assert.equal(url.searchParams.get("expected_geometry_manifest_object_ref"), geometry.geometry_manifest.object_ref);
  assert.equal(url.searchParams.get("expected_geometry_object_ref"), geometry.geometry_payload.object_ref);
  assert.equal(url.searchParams.get("max_response_bytes"), String(byteLength));
}

function datasetSliceBody(query, corrupt) {
  const dataset = materializedDatasetResource(false);
  assert.equal(query.get("expected_manifest_object_ref"), MANIFEST_OBJECT_REF);
  assert.equal(query.get("max_response_bytes"), "65536");
  const offset = Number(query.get("element_offset"));
  const count = Number(query.get("element_count"));
  assert.ok(Number.isSafeInteger(offset) && Number.isSafeInteger(count) && count > 0 && count <= 32 && offset + count <= 70);
  const payload = Buffer.alloc(count * 3 * 8);
  for (let index = 0; index < count * 3; index++) payload.writeDoubleLE(offset * 3 + index + 0.25, index * 8);
  const metadata = {
    schema_version: "fullmag.binary.materialized_dataset_slice.v1",
    project_id: dataset.project_id, run_id: dataset.run_id, solution_set_id: dataset.solution_set_id,
    containing_solution_revision: dataset.containing_solution_revision,
    member_id: dataset.member_id, artifact_id: dataset.artifact_id,
    manifest_object_ref: dataset.manifest_object_ref, manifest_byte_length: dataset.manifest_byte_length,
    source: dataset.source, descriptor: dataset.field.descriptor, integrity: "verified_returned_ranges",
    slice: {
      schema_version: "1.0.0", dataset_id: dataset.dataset.dataset_id, dataset_revision: dataset.dataset.revision,
      sample_id: dataset.sample_id, item_id: dataset.item_id, field_id: dataset.field_id,
      field_layout_digest: dataset.field.descriptor.layout_digest,
      element_offset: String(offset), element_count: String(count), total_elements: "70", component_count: "3",
      precision: "f64", byte_order: "little_endian", payload_bytes: String(payload.length),
      parts: [{ plane: "values", plane_offset_bytes: "0", object_offset_bytes: String(offset * 24),
        object_ref: "c".repeat(64), byte_length: String(payload.length),
        range_sha256: `sha256:${createHash("sha256").update(payload).digest("hex")}` }],
    },
  };
  const json = Buffer.from(JSON.stringify(metadata));
  const header = Buffer.alloc(12);
  header.write("FMDS"); header.writeUInt16LE(1, 4); header.writeUInt32LE(json.length, 8);
  if (corrupt) payload[0] ^= 1;
  return Buffer.concat([header, json, payload]);
}

function solutionProvenance() {
  return {
    acquisition_digest: `sha256:${"a".repeat(64)}`,
    discretization_digest: `sha256:${"b".repeat(64)}`,
    model_digest: `sha256:${"c".repeat(64)}`,
    physics_digest: `sha256:${"d".repeat(64)}`,
    resolved_plan_digest: `sha256:${"e".repeat(64)}`,
    run_spec_digest: `sha256:${"e".repeat(64)}`,
    seed_digest: null,
  };
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function makeSavedTopologyBuffer() {
  const buffer = Buffer.alloc(320);
  buffer.write("FMMT", 0, "ascii");
  buffer.writeUInt8(2, 4);
  buffer.writeUInt8(1, 5);
  buffer.writeUInt32LE(4, 8);
  buffer.writeUInt32LE(1, 12);
  buffer.writeUInt32LE(4, 16);
  buffer.writeUInt32LE(4, 20);
  buffer.writeUInt32LE(12, 24);
  buffer.writeUInt32LE(1, 28);
  buffer.writeUInt32LE(4, 32);
  buffer.writeUInt32LE(64, 36);
  buffer.writeUInt32LE(0, 40);
  buffer.writeUInt32LE(0, 44);
  const positions = [
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ];
  positions.forEach((value, index) => buffer.writeDoubleLE(value, 64 + index * 8));
  writeU32Array(buffer, 160, [1]);
  writeU32Array(buffer, 168, [0, 4]);
  writeU32Array(buffer, 176, [0, 1, 2, 3]);
  writeU32Array(buffer, 192, [1, 1, 1, 1]);
  writeU32Array(buffer, 208, [1, 1, 1, 1]);
  writeU32Array(buffer, 224, [0, 3, 6, 9, 12]);
  writeU32Array(buffer, 248, [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
  writeU32Array(buffer, 296, [1]);
  writeU32Array(buffer, 304, [1, 1, 1, 1]);
  return buffer;
}

function writeU32Array(buffer, offset, values) {
  values.forEach((value, index) => buffer.writeUInt32LE(value, offset + index * 4));
}

function makeSavedSupportBuffer() {
  const buffer = Buffer.alloc(25);
  buffer.write("FMSP", 0, "ascii");
  buffer.writeUInt16LE(1, 4);
  buffer.writeUInt16LE(0, 6);
  buffer.writeBigUInt64LE(4n, 8);
  buffer.writeBigUInt64LE(1n, 16);
  buffer[24] = 0b00001101;
  return buffer;
}

function savedTensorPayload(variant) {
  const buffer = Buffer.alloc(variant === "f32" ? 48 : 96);
  const values = variant === "f32"
    ? [0.9, 0.1, 0.2, 0.2, 0.8, 0.3, 0.3, 0.4, 0.95, 0.7, 0.6, 0.1]
    : [1, 0, 0, 0.5, 0.25, 0.75, 0, 1, 0.5, 0.25, 0.5, 1];
  values.forEach((value, index) => {
    if (variant === "f32") buffer.writeFloatLE(value, index * 4);
    else buffer.writeDoubleLE(value, index * 8);
  });
  return buffer;
}

function activeSessionStatusFixture() {
  return {
    api_contract_version: "1.0.0",
    capabilities: {
      algorithms_available: [],
      binary_fields: true,
      cell_fields: true,
      eigen_modes: false,
      explicit_topology: true,
      gpu_telemetry: false,
      node_fields: true,
      preview_2d: false,
      preview_3d: true,
      scalar_history: false,
      structured_grid: false,
    },
    display: {
      active_quantity_id: "m",
      auto_contrast: true,
      colormap: "viridis",
      contrast_max: null,
      contrast_min: null,
      field_component: "magnitude",
      max_points: 120000,
      slice_layer: 0,
      slice_mode: "xy",
      vector_density: 1,
      vector_glyphs: false,
      view_mode: "3d",
      x_chosen_size: 1,
      y_chosen_size: 1,
    },
    domain: { cell_count: 1, discretization: "fem", generation_id: 1 },
    energies: {},
    metrics: { steps_per_second: null, total_steps: 0, uptime_seconds: 0 },
    resources: {
      artifact_revision: 0,
      artifacts_revision: 0,
      command_completion_revision: 0,
      commands_revision: 0,
      display_revision: 1,
      domain_generation_id: 1,
      engine_log_revision: 0,
      field_catalog_revision: 1,
      field_revision: 1,
      fields_revision: 1,
      mesh_build_revision: 1,
      mesh_revision: 1,
      scalars_revision: 0,
      scene_revision: 1,
      slice_revision: 0,
      stages_revision: 0,
      topology_revision: 1,
      visualization_state_revision: 1,
      workspace_revision: 0,
    },
    run: null,
    runtime_bundle_version: "p6-65-saved-viewport-fixture",
    session: {
      created_at: "2026-10-01T00:00:00Z",
      name: "Pinned FEM active fixture",
      request_scope_epoch: "p6-65-request-scope@1",
      session_epoch: "p6-65-session@1",
      session_id: "session-pinned-fem",
      workspace_root: "/tmp/fullmag-p6-65-fixture",
    },
    solver: { state: "idle" },
  };
}

function activeVisualizationStateFixture() {
  return {
    active_quantity_id: "m",
    auto_contrast: true,
    camera: { position: [2.5, 2.5, 2.5], projection: "perspective", target: [0.25, 0.25, 0.25], up: [0, 0, 1] },
    clip: { enabled: false, normal_axis: "z", offset: 0 },
    colormap: "viridis",
    contrast_max: null,
    contrast_min: null,
    diagnostics: { warnings: [] },
    domains: { active_scope_id: null, active_scope_kind: "domain" },
    fem: { topology_mode: "surface", volume_edges_budget: 0 },
    field_component: "magnitude",
    layers: { bounds: { visible: true }, points: { visible: false }, surface: { visible: true }, wireframe: { visible: false } },
    revision: 1,
    vector_density: 1,
    vector_glyphs: false,
    view_mode: "3d",
  };
}

function activeQuantityCatalogFixture() {
  return {
    quantities: [],
    schema_version: "fullmag.quantity-catalog.v1",
  };
}

function activeModeCompositionFixture() {
  return {
    artifact_revision: "p6-65-active-mode-composition",
    composition_id: "active",
    layers: [],
    lifecycle: {
      artifact_revision: 1,
      mesh_revision: 1,
      run_id: TARGET_RUN_ID,
      session_id: "session-pinned-fem",
    },
    phase_clock: { master_rate_hz: 1, synchronized: true },
    revision: 1,
    run_id: TARGET_RUN_ID,
    schema_version: "mode-composition.v1",
    stage_id: "stage:pinned",
  };
}

function activeDomainMetaFixture() {
  return {
    bounds: { max: [1, 1, 1], min: [0, 0, 0] },
    coordinate_system: "cartesian",
    counts: { cells: 1, nodes: 4 },
    dimension: 3,
    discretization: "fem",
    domain_id: "p6-65-saved-viewport-domain",
    generation_id: 1,
    units: { length: "m" },
  };
}

function activeFieldDescriptorFixture() {
  return {
    available: true,
    components: 3,
    domain: "p6-65-saved-viewport-domain",
    domain_generation_id: "1",
    field_revision: 1,
    kind: "vector",
    label: "Magnetization",
    location: "node",
    materialization_error: null,
    materialization_reason_code: null,
    materialization_wall_time_ns: 1,
    materialized_at_unix_ms: 1,
    quantity_id: "m",
    resolved_capability: null,
    source_revision: 1,
    source_step: 0,
    source_time_seconds: 0,
    stale_by_steps: 0,
    state: "complete",
    ui_exposed: true,
    spatial: true,
    unit: "1",
  };
}

function activeFieldCatalogFixture() {
  return { domain_generation_id: "1", quantities: [activeFieldDescriptorFixture()], revision: 1 };
}

function activeFieldAvailabilityFixture(query) {
  return {
    carrier_id: `sha256:${SAVED_TOPOLOGY_OBJECT_REF}`,
    generation: "1",
    materialized: true,
    pending: false,
    quantity_id: "m",
    reason_code: null,
    revision: 1,
    scope_id: query.get("scope_id"),
    scope_kind: query.get("scope_kind") ?? "full",
    state: "ready",
    supported: true,
    target_id: query.get("target_id") ?? "domain",
  };
}

function activeFieldMetaFixture() {
  return {
    components: 3,
    domain_generation_id: "1",
    field_revision: 1,
    kind: "vector",
    label: "Magnetization",
    location: "node",
    materialization_error: null,
    materialization_reason_code: null,
    materialization_wall_time_ns: 1,
    materialized_at_unix_ms: 1,
    observation_frame: {
      domain_generation_id: "1",
      observation_frame_id: "live-frame-1",
      session_epoch: "p6-65-session@1",
      source_step: 0,
      source_time_seconds: 0,
      topology_revision: "1",
    },
    publication_bundle: null,
    quantity_id: "m",
    resolved_capability: null,
    source_revision: 1,
    source_step: 0,
    source_time_seconds: 0,
    stale_by_steps: 0,
    state: "complete",
    stats: { max: 1, mean: 0.5, min: 0 },
    unit: "1",
  };
}

function activeSceneFixture() {
  return { objects: [], revision: 1, schema_version: "fullmag.scene.v1" };
}

function activeUniverseFixture() {
  return {
    mesh_dirty: false,
    object_bounds_max: [1, 1, 1],
    object_bounds_min: [0, 0, 0],
    scene_revision: 1,
    study_universe_mesh: null,
    universe: null,
  };
}

function activeMeshManifestFixture() {
  return {
    source_scene_revision: 1,
    domain_id: "p6-65-saved-viewport-domain",
    generation_id: 1,
    mesh_id: "p6-65-saved-viewport-mesh",
    mesh_name: "p6-65-saved-viewport-mesh",
    mesh_parts: [{
      boundary_face_count: 4,
      boundary_face_indices: [0, 1, 2, 3],
      boundary_face_start: 0,
      bounds_max: [1, 1, 1],
      bounds_min: [0, 0, 0],
      element_count: 1,
      element_start: 0,
      id: "part-saved-domain",
      label: "Saved FEM domain",
      node_count: 4,
      node_start: 0,
      object_id: "saved-domain",
      role: "magnetic",
    }],
    regions: [],
    revision: 1,
    schema_version: "fullmag.fem.shared_domain_manifest.v1",
    topology_fingerprint: `sha256:${SAVED_TOPOLOGY_OBJECT_REF}`,
  };
}

function liveFieldVectorBuffer() {
  const metadata = Buffer.alloc(96, 0);
  metadata.write("FMMI", 0, "ascii");
  metadata.writeUInt16LE(2, 4);
  metadata.writeUInt16LE(0, 6);
  metadata.writeUInt16LE(1, 8);
  metadata.writeBigUInt64LE(1n, 16);
  Buffer.from(SAVED_TOPOLOGY_OBJECT_REF, "hex").copy(metadata, 24);
  metadata.writeUInt32LE(1, 56);
  metadata.writeUInt32LE(4, 60);
  metadata.writeUInt16LE(4, 64);
  metadata.writeUInt16LE(0, 66);
  Buffer.from("full", "utf8").copy(metadata, 68);
  Buffer.from("1", "utf8").copy(metadata, 72);
  let offset = 73;
  [0, 1, 2, 3].forEach((index) => {
    metadata.writeUInt32LE(index, offset);
    offset += 4;
  });
  const header = Buffer.alloc(48, 0);
  header.write("FMVP", 0, "ascii");
  header.writeUInt8(3, 4);
  header.writeUInt8(1, 5);
  header.writeUInt8(3, 6);
  header.writeUInt32LE(metadata.length, 8);
  header.writeUInt32LE(12, 12);
  header.writeUInt32LE(4, 16);
  header.writeUInt32LE(1, 20);
  header.writeUInt32LE(1, 24);
  header.write("m", 28, "ascii");
  const values = Buffer.alloc(96);
  [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0].forEach((value, index) => values.writeDoubleLE(value, index * 8));
  return Buffer.concat([header, metadata, values]);
}

async function assertRequiredRequests(state) {
  const paths = state.requests.map((request) => request.path);
  const expected = [
    "/v2/persistence/projects",
    `/v2/persistence/projects/${state.currentProjectId}/runs`,
  ];
  assertCondition(paths.includes(expected[0]), "Project create request was not observed.");
  assert.equal(
    state.projectCreateCount,
    5,
    "The browser fixture must exercise initial, project-switch, collection-error, identity-mismatch and active-session paths.",
  );
  assertCondition(paths.includes(expected[1]), "Project switch run-list request was not observed.");
  assertCondition(
    paths.filter((path) => path === "/v2/persistence/projects").length >= 2,
    "Both project creation requests were not observed.",
  );
  assertCondition(
    state.responses.some((response) => response.path.includes("/solution-sets") && response.status === 200),
    "No SolutionSet response was observed.",
  );
  assertCondition(
    state.metadataRequests.some((entry) => !entry.forged && entry.artifactId === POSITIVE_ARTIFACT_ID),
    "Positive materialized dataset metadata was not requested.",
  );
  assertCondition(
    state.metadataRequests.some((entry) => entry.forged && entry.artifactId === FORGED_ARTIFACT_ID),
    "Forged materialized dataset metadata was not requested.",
  );
  assertCondition(
    state.metadataRequests.some((entry) => !entry.forged && entry.artifactId === F32_ARTIFACT_ID),
    "F32 materialized dataset metadata was not requested.",
  );
  assertCondition(
    state.savedGeometryRequests.some((entry) => entry.kind === "geometry" && entry.artifactId === POSITIVE_ARTIFACT_ID),
    "Saved F64 geometry was not requested.",
  );
  assertCondition(
    state.savedGeometryRequests.some((entry) => entry.kind === "geometry" && entry.artifactId === F32_ARTIFACT_ID),
    "Saved F32 geometry was not requested.",
  );
  assert.ok(state.savedBinaryRequests.some((entry) => entry.kind === "topology"), "Saved topology was not requested.");
  assert.ok(state.savedBinaryRequests.some((entry) => entry.kind === "support"), "Saved support was not requested.");
  assert.ok(state.savedBinaryRequests.some((entry) => entry.kind === "slice"), "Saved FMDS slices were not requested.");
}

function assertResourceRequestBounds(state) {
  for (const mount of ["saved-workspace", "live-return"]) {
    const requestCount = state.liveResourceRequests.filter((request) => request.mount === mount).length;
    assert.ok(requestCount <= 64, `Active-session resource request count exceeded the fixture bound for ${mount}.`);
  }
  for (const artifactId of [POSITIVE_ARTIFACT_ID, F32_ARTIFACT_ID]) {
    const geometryCount = state.savedGeometryRequests.filter((entry) => entry.artifactId === artifactId && entry.kind === "geometry").length;
    const binaryCount = state.savedBinaryRequests.filter((entry) => entry.artifactId === artifactId).length;
    assert.ok(geometryCount <= 3, `Saved geometry request count exceeded the fixture bound for ${artifactId}.`);
    assert.ok(binaryCount <= 9, `Saved binary request count exceeded the fixture bound for ${artifactId}.`);
    for (const kind of ["topology", "support"]) {
      const requestCount = state.savedGeometryRequests.filter((entry) => entry.artifactId === artifactId && entry.kind === kind).length;
      assert.ok(requestCount <= 3, `Saved ${kind} request count exceeded the fixture bound for ${artifactId}.`);
    }
  }
}

async function captureScreenshot(page, state, fileName) {
  const path = resolve(reportDirectory, fileName);
  try {
    await page.screenshot({ path, fullPage: true });
    state.screenshots.push(path);
  } catch (error) {
    state.screenshotError = error instanceof Error ? error.message : String(error);
  }
}

async function writeReport({
  errors,
  failure,
  projectStorageRoot: storageRoot,
  proof,
  reportDirectory: directory,
  state,
  workspaceUrl: url,
}) {
  const report = {
    schema_version: "fullmag.browser.pinned_materialized_dataset_fixture.v1",
    status: failure ? "failed" : "passed",
    fixture_only: true,
    qualification: "NOT VERIFIED",
    http_backend: "NOT VERIFIED; page.route supplied fixture responses",
    managed_runtime: "NOT VERIFIED",
    scientific_qualification: "NOT VERIFIED",
    report_directory: directory,
    storage_root: storageRoot,
    workspace_url: url,
    screenshots: state.screenshots,
    viewport_proofs: state.viewportProofs,
    camera_snapshots: state.cameraSnapshots,
    screenshot_error: state.screenshotError ?? null,
    proof,
    requests: state.requests,
    responses: state.responses,
    live_resource_requests: state.liveResourceRequests,
    live_viewport_resource_requests: state.liveResourceRequests.filter(({ path }) =>
      isLiveViewportResourcePath(path),
    ),
    live_cross_scope_requests: liveCrossScopeRequests(state),
    metadata_requests: state.metadataRequests,
    slice_proof: state.sliceProof ?? null,
    camera_mutation_requests: state.cameraMutationRequests,
    visualization_client_ack_requests: state.visualizationAckRequests,
    saved_geometry_requests: state.savedGeometryRequests,
    saved_binary_requests: state.savedBinaryRequests,
    forbidden_runtime_requests: state.forbiddenRuntimeRequests,
    browser_errors: errors,
    shell_startup_warnings: state.startupWarnings,
    failure: failure?.message ?? null,
  };
  await writeFile(
    resolve(directory, "pinned-materialized-dataset.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
}

async function fulfillJson(route, body, status = 200) {
  if (status === 204) {
    await route.fulfill({
      headers: {
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "x-api-contract-version",
        "x-api-contract-version": "1.0.0",
      },
      status,
    });
    return;
  }
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "x-api-contract-version",
      "x-api-contract-version": "1.0.0",
    },
    status,
  });
}

async function fulfillBinary(route, body, status = 200, extraHeaders = {}) {
  await route.fulfill({
    body: Buffer.from(body),
    contentType: "application/octet-stream",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "content-range,etag,x-api-contract-version,x-fullmag-domain-generation-id",
      "x-api-contract-version": "1.0.0",
      ...extraHeaders,
    },
    status,
  });
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    try {
      return await import("@playwright/test");
    } catch {
      return null;
    }
  }
}

function requireAbsolutePath(name) {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) {
    throw new Error(`${name} must be configured as an absolute path.`);
  }
  return resolve(value);
}

function resolveReportDirectory(storageRoot, envName) {
  const value = process.env[envName];
  if (!value || !isAbsolute(value)) {
    throw new Error(`${envName} must be configured as an absolute path.`);
  }
  const directory = resolve(value);
  const fromRoot = relative(storageRoot, directory);
  if (
    fromRoot !== "" &&
    (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
  ) {
    throw new Error(`${envName} must remain below FULLMAG_PROJECT_STORAGE_ROOT.`);
  }
  return directory;
}

function cssEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

main().catch((error) => {
  console.error(`Pinned materialized dataset smoke failed: ${error.stack ?? error.message}`);
  process.exit(1);
});
