import { inflateSync } from "node:zlib";

const url = process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const VIEWPORT_3D_SELECTOR = ".fm-viewport-3d";
const VIEWPORT_3D_CANVAS_SELECTOR = ".fm-viewport-3d canvas";
const apiBase =
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE ??
  process.env.NEXT_PUBLIC_API_URL ??
  null;
const allowMissingSession =
  process.env.CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION === "1";
const requireGeometryFlow =
  !allowMissingSession && process.env.CONTROL_ROOM_SMOKE_GEOMETRY_FLOW !== "0";
const cameraOnlySmoke = process.env.CONTROL_ROOM_SMOKE_CAMERA_ONLY === "1";
const hysteresisReplaySmoke =
  process.env.CONTROL_ROOM_SMOKE_HYSTERESIS_REPLAY === "1";
const hysteresisReplayOnly =
  process.env.CONTROL_ROOM_SMOKE_HYSTERESIS_REPLAY_ONLY === "1";
const hysteresisReplaySnapshotId =
  process.env.CONTROL_ROOM_SMOKE_HYSTERESIS_SNAPSHOT_ID ??
  "hysteresis_point_smoke";
const hysteresisReplayStageId =
  process.env.CONTROL_ROOM_SMOKE_HYSTERESIS_STAGE_ID ?? "hysteresis-smoke";
const hysteresisReplayPointId = Number(
  process.env.CONTROL_ROOM_SMOKE_HYSTERESIS_POINT_ID ?? 1,
);
const skipCameraGestureSmoke =
  process.env.CONTROL_ROOM_SMOKE_SKIP_CAMERA_GESTURES === "1";
const regionOnlyObjectId =
  process.env.CONTROL_ROOM_SMOKE_REGION_ONLY_OBJECT_ID ?? null;
const keepGeometrySmokeObjects =
  process.env.CONTROL_ROOM_SMOKE_KEEP_OBJECTS === "1";
const CANVAS_SCREENSHOT_TIMEOUT_MS = Number(
  process.env.CONTROL_ROOM_CANVAS_SCREENSHOT_TIMEOUT_MS ?? 60_000,
);
const GEOMETRY_FLOW_TIMEOUT_MS = 20_000;
const VISUALIZATION_STATE_PATH = "/v2/sessions/current/visualization/state";
const CAMERA_GESTURE_FORBIDDEN_REQUEST_PREFIXES = [
  "/v2/sessions/current/data/",
  "/v2/sessions/current/model/",
  "/v2/sessions/current/meshing/",
  "/v2/sessions/current/visualization/state",
];
const VIEWPORT_3D_COMPUTE_MEASURE_NAMES = [
  "fullmag.viewport3d.buildViewport3DTopologyRenderModel",
  "fullmag.viewport3d.buildMeshQualityVertexColors",
  "fullmag.viewport3d.buildFdmCuboidInstanceModel",
  "fullmag.viewport3d.buildViewport3DFieldRenderModel",
  "fullmag.viewport3d.buildVectorGlyphInstances",
  "fullmag.viewport3d.uploadVectorGlyphColors",
  "fullmag.viewport3d.uploadVectorGlyphMatrices",
];
const REACT_RENDER_MEASURE_NAMES = [
  "fullmag.react.render.ExplorerModule.mount",
  "fullmag.react.render.ExplorerModule.update",
  "fullmag.react.render.RibbonModule.mount",
  "fullmag.react.render.RibbonModule.update",
  "fullmag.react.render.Viewport3DModule.mount",
  "fullmag.react.render.Viewport3DModule.update",
  "fullmag.react.render.FooterModule.mount",
  "fullmag.react.render.FooterModule.update",
  "fullmag.react.render.WorkspaceDockLayout.mount",
  "fullmag.react.render.WorkspaceDockLayout.update",
];
const COMPUTE_PERFORMANCE_MEASURE_NAMES = [
  ...VIEWPORT_3D_COMPUTE_MEASURE_NAMES,
  ...REACT_RENDER_MEASURE_NAMES,
];

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

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  console.error(
    "Viewport 3D smoke requires Playwright or @playwright/test in the current environment.",
  );
  process.exit(2);
}

const browser = await playwright.chromium.launch();
const page = await browser.newPage({
  viewport: { height: 900, width: 1440 },
});
if (allowMissingSession) {
  await installMissingSessionFastFailRoutes(page);
}
await installComputePerformanceProbe(page);
const errors = [];
const sceneResponses = [];
const fieldVectorRequests = [];
const realtimeMessages = [];
const cameraGestureRequests = [];
const activeInitialForbiddenResourceRequests = new Map();
const viewport3DPerformancePhases = [];
let sceneResponseSequence = 0;
let lastInitialForbiddenResourceRequestAt = 0;
let recordCameraGestureRequests = false;

async function installMissingSessionFastFailRoutes(page) {
  await page.route("**/v2/sessions/current/**", async (route) => {
    const request = route.request();
    if (request.method() === "PATCH" || request.method() === "POST") {
      await route.fulfill({ body: "", status: 204 });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({ error: "missing controlled smoke session" }),
      contentType: "application/json",
      status: 404,
    });
  });
}

await page.addInitScript(
  ({ allowMissingSessionSmoke, baseUrl, enableAuditHooks }) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      ...(baseUrl ? { controlRoomApiBase: baseUrl } : {}),
      ...(allowMissingSessionSmoke ? { allowMissingSessionSmoke: true } : {}),
      ...(enableAuditHooks ? { enableAuditHooks: true } : {}),
    };
  },
  {
    allowMissingSessionSmoke: allowMissingSession,
    baseUrl: apiBase,
    enableAuditHooks: hysteresisReplaySmoke,
  },
);

page.on("console", (message) => {
  if (message.type() === "error") {
    const text = message.text();
    if (isIgnorableConsoleError(text)) {
      return;
    }
    errors.push(text);
  }
});
page.on("pageerror", (error) => {
  errors.push(error.message);
});
page.on("request", (request) => {
  const url = request.url();
  const path = pathnameFromUrl(url);
  if (!path.startsWith("/v2/sessions/current/")) return;
  const method = request.method();
  if (isFieldVectorSamplesPath(path)) {
    fieldVectorRequests.push({
      method,
      path,
      search: searchFromUrl(url),
      url,
    });
  }
  if (!allowMissingSession && isCameraGestureForbiddenRequestPath(path)) {
    activeInitialForbiddenResourceRequests.set(request, { method, path, url });
    lastInitialForbiddenResourceRequestAt = Date.now();
  }
  if (!recordCameraGestureRequests) return;
  cameraGestureRequests.push({
    method,
    path,
    url,
  });
});
page.on("requestfinished", markInitialForbiddenResourceRequestSettled);
page.on("requestfailed", markInitialForbiddenResourceRequestSettled);
page.on("websocket", (websocket) => {
  if (!isRealtimeWebsocketUrl(websocket.url())) {
    return;
  }

  websocket.on("framereceived", (event) => {
    const text = framePayloadText(event.payload);
    const parsed = parseJsonOrNull(text);
    realtimeMessages.push({
      parsed,
      text,
      timestamp: Date.now(),
      url: websocket.url(),
    });
  });
});
page.on("response", (response) => {
  const status = response.status();
  if (!cameraOnlySmoke && isModelSceneUrl(response.url()) && status < 400) {
    const sequence = sceneResponseSequence;
    const timestamp = Date.now();
    sceneResponseSequence += 1;
    void response
      .json()
      .then((body) => {
        sceneResponses.push({
          body,
          sequence,
          status,
          timestamp,
          url: response.url(),
        });
      })
      .catch((error) => {
        errors.push(`Failed to parse model/scene response: ${error.message}`);
      });
  }

  if (
    status < 400 ||
    isAllowedMissingSessionResponse(response.url(), status) ||
    isAllowedOptionalActiveSessionResponse(response.url(), status)
  ) {
    return;
  }

  errors.push(`${status} ${response.url()}`);
});

try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const canvas = page.locator(VIEWPORT_3D_CANVAS_SELECTOR);
  await canvas.waitFor({ state: "visible", timeout: 15_000 });
  await waitForCanvasClipBox(page);

  const { drawingBuffer, hasContext } = await readCanvasContextState(page);
  const pixelSample = await sampleCanvasComposite(page);

  if (!hasContext) {
    throw new Error("3D viewport canvas has no WebGL context.");
  }
  if (drawingBuffer.width <= 0 || drawingBuffer.height <= 0) {
    throw new Error(
      `3D viewport WebGL drawing buffer is empty: ${drawingBuffer.width}x${drawingBuffer.height}.`,
    );
  }
  if (!pixelSample.nonBlank) {
    throw new Error(
      `3D viewport canvas composite is blank: ${pixelSample.variedPixels}/${pixelSample.sampledPixels} sampled pixels differ from background.`,
    );
  }
  if (errors.length > 0) {
    throw new Error("Browser console errors:\n" + errors.join("\n"));
  }
  viewport3DPerformancePhases.push(
    await collectViewport3DPerformancePhase(page, "startup-to-canvas"),
  );
  await waitForInitialViewport3DResourceQuiet(page);
  if (hysteresisReplaySmoke) {
    await verifyHysteresisReplaySmoke(page);
    viewport3DPerformancePhases.push(
      await collectViewport3DPerformancePhase(page, "hysteresis-replay"),
    );
  }
  if (hysteresisReplayOnly) {
    logViewport3DPerformancePhases(viewport3DPerformancePhases);
    console.log(`Viewport 3D smoke passed at ${url}.`);
  } else {
    if (!skipCameraGestureSmoke) {
      viewport3DPerformancePhases.push(
        ...(await verifyCameraGesturesStayLocal({ page })),
      );
    }
    if (cameraOnlySmoke) {
      logViewport3DPerformancePhases(viewport3DPerformancePhases);
      console.log(`Viewport 3D camera smoke passed at ${url}.`);
    } else {
      if (!regionOnlyObjectId) {
        await verifyProjectionRoundTrip({ canvas, page });
        viewport3DPerformancePhases.push(
          await collectViewport3DPerformancePhase(page, "projection-round-trip"),
        );
        await verifyDimensionFrameCage({ canvas, page });
        viewport3DPerformancePhases.push(
          await collectViewport3DPerformancePhase(page, "dimension-frame-cage"),
        );
      }
      if (requireGeometryFlow) {
        if (regionOnlyObjectId) {
          await verifyObjectInViewportRenderModel(page, regionOnlyObjectId);
          await verifyRegionAuthoringOverlayFlow({
            baseline: pixelSample,
            objectId: regionOnlyObjectId,
            page,
          });
        } else {
          await verifyGeometryAuthoringFlow({
            canvas,
            canvasBaseline: pixelSample,
            page,
            realtimeMessages,
            sceneResponses,
          });
        }
        viewport3DPerformancePhases.push(
          await collectViewport3DPerformancePhase(page, "geometry-authoring"),
        );
      }

      const computeMetrics = await collectComputePerformanceProbe(
        page,
        "viewport-3d-smoke",
        { scope: "all" },
      );
      logViewport3DPerformancePhases(viewport3DPerformancePhases);
      logComputePerformanceProbe(computeMetrics);
      console.log(`Viewport 3D smoke passed at ${url}.`);
    }
  }
} finally {
  await browser.close();
}

async function verifyCameraGesturesStayLocal({ page }) {
  const gesturePerformancePhases = [];
  const box = await readCanvasClipBox(page);
  if (box.width <= 0 || box.height <= 0) {
    throw new Error("Cannot run camera gesture smoke: viewport canvas has no bounds.");
  }
  const x = box.x + box.width * 0.5;
  const y = box.y + box.height * 0.5;
  const startIndex = cameraGestureRequests.length;

  await assertCameraGestureDoesNotFetch(page, "viewport focus", async () => {
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
  });
  gesturePerformancePhases.push(
    await collectViewport3DPerformancePhase(page, "viewport-focus"),
  );

  const initialCameraSignature = await readViewportCameraSignature(page);

  await assertCameraGestureDoesNotFetch(page, "orbit rotate", async () => {
    await page.mouse.move(x, y);
    await page.mouse.down({ button: "left" });
    await page.mouse.move(x + 120, y + 42, { steps: 8 });
    await page.mouse.up({ button: "left" });
  });
  const rotateCameraSignature = await waitForCameraSignatureChange(
    page,
    initialCameraSignature,
    "left-button orbit rotate changes the viewport camera state",
    "Viewport camera state did not change after left-button orbit rotate",
  );
  await assertViewportCameraUpIsWorldUp(page, "left-button orbit rotate");
  gesturePerformancePhases.push(
    await collectViewport3DPerformancePhase(page, "camera-orbit-rotate"),
  );

  await assertCameraGestureDoesNotFetch(page, "orbit zoom", async () => {
    await page.mouse.move(x, y);
    for (let index = 0; index < 4; index += 1) {
      await page.mouse.wheel(0, -240);
    }
  });
  const wheelCameraSignature = await waitForCameraSignatureChange(
    page,
    rotateCameraSignature,
    "camera wheel changes the viewport camera state",
    "Viewport camera state did not change after camera wheel",
  );
  await assertViewportCameraUpIsWorldUp(page, "camera wheel zoom");
  const wheelZoomPhase = await collectViewport3DPerformancePhase(
    page,
    "camera-wheel-zoom",
  );
  assertSmoothCameraWheelZoomPhase(wheelZoomPhase);
  gesturePerformancePhases.push(wheelZoomPhase);

  await assertCameraGestureDoesNotFetch(page, "orbit pan", async () => {
    await page.mouse.down({ button: "right" });
    await page.mouse.move(x + 80, y + 36, { steps: 8 });
    await page.mouse.up({ button: "right" });
  });
  const rightPanPhase = await collectViewport3DPerformancePhase(
    page,
    "camera-right-pan",
  );
  assertResponsiveCameraRightPanPhase(rightPanPhase);
  gesturePerformancePhases.push(rightPanPhase);
  await waitForCameraSignatureChange(
    page,
    wheelCameraSignature,
    "right-button free-camera pan changes the viewport camera state",
    "Viewport camera state did not change after right-button free-camera pan",
  );
  await assertViewportCameraUpIsWorldUp(page, "right-button orbit pan");

  const gestureRequests = cameraGestureRequests.slice(startIndex);
  const visualizationStatePatches = gestureRequests.filter(
    (request) =>
      request.method === "PATCH" &&
      request.path === VISUALIZATION_STATE_PATH,
  );
  const backgroundResourceRequests = unexpectedCameraGestureRequests(
    gestureRequests,
  );
  const unexpectedGestureRequests = [
    ...visualizationStatePatches,
    ...backgroundResourceRequests,
  ];
  if (unexpectedGestureRequests.length > 0) {
    throw new Error(
      "Camera rotate/wheel/pan gestures emitted background resource work: " +
        unexpectedGestureRequests
          .map((request) => `${request.method} ${request.url ?? request.path}`)
          .join(", "),
    );
  }

  const pixelSample = await sampleCanvasComposite(page);
  if (!pixelSample.nonBlank) {
    throw new Error(
      `3D viewport canvas became blank after camera gestures: ${pixelSample.variedPixels}/${pixelSample.sampledPixels} sampled pixels differ from background.`,
    );
  }
  console.log(
    `Camera gesture smoke passed: visualization_state_patches=0 background_resource_requests=0 session_requests=${gestureRequests.length}`,
  );
  return gesturePerformancePhases;
}

async function verifyHysteresisReplaySmoke(page) {
  if (!Number.isFinite(hysteresisReplayPointId)) {
    throw new Error(
      `Invalid CONTROL_ROOM_SMOKE_HYSTERESIS_POINT_ID=${process.env.CONTROL_ROOM_SMOKE_HYSTERESIS_POINT_ID}`,
    );
  }

  const startIndex = fieldVectorRequests.length;
  const usedChart = await verifyHysteresisChartReplaySmoke(page);
  if (!usedChart) {
    await page.evaluate(
      ({ pointId, snapshotId, stageId }) => {
        const audit = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
        if (!audit?.loadHysteresisReplaySnapshot) {
          throw new Error("Missing __FULLMAG_CONTROL_ROOM_AUDIT__.loadHysteresisReplaySnapshot.");
        }
        audit.loadHysteresisReplaySnapshot({
          fieldVal: pointId,
          mVal: 0,
          pointId,
          snapshotId,
          stageId,
        });
      },
      {
        pointId: hysteresisReplayPointId,
        snapshotId: hysteresisReplaySnapshotId,
        stageId: hysteresisReplayStageId,
      },
    );
  }

  await waitForCondition("hysteresis replay viewport target", async () => {
    const attrs = await page.evaluate((selector) => {
      const node = document.querySelector(selector);
      return {
        snapshotId: node?.getAttribute("data-hysteresis-replay-snapshot-id") ?? "",
        stageId: node?.getAttribute("data-hysteresis-replay-stage-id") ?? "",
        text: node?.textContent ?? "",
      };
    }, VIEWPORT_3D_SELECTOR);
    if (
      attrs.snapshotId === hysteresisReplaySnapshotId &&
      attrs.stageId === hysteresisReplayStageId &&
      attrs.text.includes(hysteresisReplaySnapshotId)
    ) {
      return attrs;
    }
    throw new Error(
      `Hysteresis replay target not visible: snapshot=${attrs.snapshotId || "missing"} stage=${attrs.stageId || "missing"}.`,
    );
  });

  await waitForCondition("hysteresis replay field-vector request", () => {
    const matching = fieldVectorRequests
      .slice(startIndex)
      .find((request) => {
        const params = new URLSearchParams(request.search);
        return (
          request.method === "GET" &&
          params.get("snapshot_id") === hysteresisReplaySnapshotId &&
          params.get("stage_id") === hysteresisReplayStageId &&
          params.get("component") === "full" &&
          params.get("scope_kind") === "full"
        );
      });
    if (matching) return matching;
    throw new Error(
      `No field-vector request for hysteresis snapshot ${hysteresisReplaySnapshotId}.`,
    );
  });

  const pixelSample = await sampleCanvasComposite(page);
  if (!pixelSample.nonBlank) {
    throw new Error(
      `3D viewport canvas became blank after hysteresis replay selection: ${pixelSample.variedPixels}/${pixelSample.sampledPixels} sampled pixels differ from background.`,
    );
  }
  console.log(
    `Hysteresis replay smoke passed: snapshot_id=${hysteresisReplaySnapshotId} stage_id=${hysteresisReplayStageId} source=${usedChart ? "chart" : "audit"}`,
  );

  const returnStartIndex = fieldVectorRequests.length;
  const returnSource = await returnHysteresisReplayToLive(page);
  await waitForCondition("hysteresis replay viewport target cleared", async () => {
    const attrs = await page.evaluate((selector) => {
      const node = document.querySelector(selector);
      return {
        snapshotId: node?.getAttribute("data-hysteresis-replay-snapshot-id") ?? "",
        stageId: node?.getAttribute("data-hysteresis-replay-stage-id") ?? "",
      };
    }, VIEWPORT_3D_SELECTOR);
    if (!attrs.snapshotId && !attrs.stageId) return attrs;
    throw new Error(
      `Hysteresis replay target still active after Return to live: snapshot=${attrs.snapshotId || "missing"} stage=${attrs.stageId || "missing"}.`,
    );
  });
  await waitForCondition("hysteresis replay return-to-live field-vector request", () => {
    const matching = fieldVectorRequests
      .slice(returnStartIndex)
      .find((request) => {
        const params = new URLSearchParams(request.search);
        return (
          request.method === "GET" &&
          params.get("snapshot_id") == null &&
          params.get("stage_id") == null &&
          params.get("component") === "full" &&
          params.get("scope_kind") === "full"
        );
      });
    if (matching) return matching;
    throw new Error("No live field-vector request after hysteresis Return to live.");
  });
  const livePixelSample = await sampleCanvasComposite(page);
  if (!livePixelSample.nonBlank) {
    throw new Error(
      `3D viewport canvas became blank after hysteresis Return to live: ${livePixelSample.variedPixels}/${livePixelSample.sampledPixels} sampled pixels differ from background.`,
    );
  }
  console.log(
    `Hysteresis replay return-to-live smoke passed: stage_id=${hysteresisReplayStageId} source=${returnSource}`,
  );
}

async function verifyHysteresisChartReplaySmoke(page) {
  const chart = page.locator(".fm-hysteresis-container").first();
  if (!(await chart.isVisible().catch(() => false))) {
    return false;
  }

  await waitForCondition("hysteresis chart point data", async () => {
    const attrs = await chart.evaluate((node) => ({
      activeSnapshotId: node.getAttribute("data-hysteresis-active-snapshot-id") ?? "",
      pointCount: Number(node.getAttribute("data-hysteresis-point-count") ?? "0"),
      stageId: node.getAttribute("data-hysteresis-stage-id") ?? "",
    }));
    if (attrs.stageId !== hysteresisReplayStageId) {
      throw new Error(
        `chart stage=${attrs.stageId || "missing"}, expected ${hysteresisReplayStageId}`,
      );
    }
    if (!Number.isFinite(attrs.pointCount) || attrs.pointCount <= 0) {
      throw new Error(`chart point-count=${attrs.pointCount}`);
    }
    return attrs;
  });

  const activeSnapshotId = await chart.getAttribute(
    "data-hysteresis-active-snapshot-id",
  );
  if (activeSnapshotId !== hysteresisReplaySnapshotId) {
    const scrubber = chart.getByRole("slider", {
      name: "Hysteresis point scrubber",
    });
    if (!(await scrubber.isVisible().catch(() => false))) {
      throw new Error("Hysteresis chart has points but no visible point scrubber.");
    }
    await scrubber.fill(String(hysteresisReplayPointId));
    await waitForCondition("hysteresis chart selected replay snapshot", async () => {
      const snapshotId = await chart.getAttribute(
        "data-hysteresis-active-snapshot-id",
      );
      if (snapshotId === hysteresisReplaySnapshotId) return snapshotId;
      throw new Error(
        `active snapshot=${snapshotId || "missing"}, expected ${hysteresisReplaySnapshotId}`,
      );
    });
  }

  await chart.getByRole("button", { name: "Load in 3D" }).click();
  return true;
}

async function returnHysteresisReplayToLive(page) {
  const returnToLiveButton = page
    .getByRole("button", { name: /^(Return to live|Live)$/ })
    .first();
  if (await returnToLiveButton.isVisible().catch(() => false)) {
    await returnToLiveButton.click();
    return "button";
  }
  await page.evaluate((stageId) => {
    const audit = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
    if (!audit?.returnHysteresisReplayToLive) {
      throw new Error("Missing __FULLMAG_CONTROL_ROOM_AUDIT__.returnHysteresisReplayToLive.");
    }
    return audit.returnHysteresisReplayToLive({ stageId });
  }, hysteresisReplayStageId);
  return "audit";
}

async function assertCameraGestureDoesNotFetch(page, gestureName, gesture) {
  const startIndex = cameraGestureRequests.length;
  recordCameraGestureRequests = true;
  try {
    await gesture();
    await waitForCameraGestureSettle(page);
  } finally {
    recordCameraGestureRequests = false;
  }

  const gestureRequests = cameraGestureRequests.slice(startIndex);
  const unexpectedGestureRequests = unexpectedCameraGestureRequests(gestureRequests);
  if (unexpectedGestureRequests.length > 0) {
    throw new Error(
      `${gestureName} triggered unexpected resource work: ` +
        unexpectedGestureRequests
          .map((request) => `${request.method} ${request.url ?? request.path}`)
          .join(", "),
    );
  }
}

function unexpectedCameraGestureRequests(gestureRequests) {
  return gestureRequests.filter((request) => {
    if (
      allowMissingSession &&
      request.method === "GET" &&
      request.path.startsWith("/v2/sessions/current/")
    ) {
      return false;
    }

    return isCameraGestureForbiddenRequestPath(request.path);
  });
}

function assertSmoothCameraWheelZoomPhase(phase) {
  const viewportFrameDelta = phase.viewportFrameDelta ?? 0;
  if (viewportFrameDelta < 2) {
    throw new Error(
      `Camera wheel zoom was applied in too few viewport frames: viewportFrameDelta=${viewportFrameDelta}.`,
    );
  }
}

function assertResponsiveCameraRightPanPhase(phase) {
  if (cameraPhaseHasBlockingLongAnimationFrames(phase)) {
    throw new Error(
      `Camera right-button pan produced blocking long animation frames: longAnimationFrameCount=${phase.longAnimationFrameCount ?? 0}, maxLongAnimationFrameMs=${phase.maxLongAnimationFrameMs ?? 0}, longAnimationFrameBlockingMs=${phase.longAnimationFrameBlockingMs ?? 0}, topInvokers=${JSON.stringify(phase.longAnimationFrameTopInvokers ?? [])}.`,
    );
  }
  const viewportMeasureCount = phase.viewportMeasureCount ?? 0;
  if (viewportMeasureCount > 0) {
    throw new Error(
      `Camera right-button pan rebuilt viewport data during interaction: viewportMeasureCount=${viewportMeasureCount}, viewportMeasureTotals=${JSON.stringify(phase.viewportMeasureTotals ?? {})}.`,
    );
  }
}

function cameraPhaseHasBlockingLongAnimationFrames(phase) {
  const longAnimationFrameBlockingMs = phase.longAnimationFrameBlockingMs ?? 0;
  if (longAnimationFrameBlockingMs > 0) return true;

  return (phase.longAnimationFrameTopInvokers ?? []).some(
    (invoker) =>
      invoker.invokerType &&
      invoker.invoker !== "unknown-frame" &&
      (invoker.maxDurationMs ?? 0) > 50,
  );
}

function markInitialForbiddenResourceRequestSettled(request) {
  if (!activeInitialForbiddenResourceRequests.delete(request)) return;
  lastInitialForbiddenResourceRequestAt = Date.now();
}

function isCameraGestureForbiddenRequestPath(path) {
  return CAMERA_GESTURE_FORBIDDEN_REQUEST_PREFIXES.some((prefix) =>
    path.startsWith(prefix),
  );
}

async function waitForInitialViewport3DResourceQuiet(page) {
  const quietStartedAt = Date.now();
  const quietWindowMs = 1_000;
  const timeoutMs = 20_000;
  const deadline = quietStartedAt + timeoutMs;

  while (Date.now() <= deadline) {
    await waitForBrowserPaint(page);
    const now = Date.now();
    const quietElapsed =
      lastInitialForbiddenResourceRequestAt > 0
        ? now - lastInitialForbiddenResourceRequestAt
        : now - quietStartedAt;
    if (
      activeInitialForbiddenResourceRequests.size === 0 &&
      (allowMissingSession || quietElapsed >= quietWindowMs)
    ) {
      return;
    }
    await delay(50);
  }

  const active = [...activeInitialForbiddenResourceRequests.values()]
    .map((request) => `${request.method} ${request.url ?? request.path}`)
    .join(", ");
  throw new Error(
    `Timed out waiting for initial viewport 3D resource requests to settle: ${active || "none active"}.`,
  );
}

async function waitForCameraGestureSettle(page) {
  await waitForBrowserPaint(page);
  await delay(25);
}

async function readViewportCameraSignature(page) {
  return page.evaluate((selector) => {
    const node = document.querySelector(selector);
    return [
      node?.getAttribute("data-camera-position") ?? "",
      node?.getAttribute("data-camera-target") ?? "",
      node?.getAttribute("data-camera-up") ?? "",
      node?.getAttribute("data-camera-projection") ?? "",
    ].join("|");
  }, VIEWPORT_3D_SELECTOR);
}

async function assertViewportCameraUpIsWorldUp(page, label) {
  const up = await page.evaluate((selector) => {
    const raw = document
      .querySelector(selector)
      ?.getAttribute("data-camera-up");
    return String(raw ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((value) => Number(value));
  }, VIEWPORT_3D_SELECTOR);
  const expected = [0, 0, 1];
  const matchesWorldUp =
    up.length === expected.length &&
    up.every(
      (value, index) =>
        Number.isFinite(value) && Math.abs(value - expected[index]) < 1e-9,
    );
  if (!matchesWorldUp) {
    throw new Error(
      `${label} changed viewport camera up vector: expected ${expected.join(
        " ",
      )}, got ${up.join(" ") || "missing"}.`,
    );
  }
}

async function readCanvasContextState(page) {
  return page.evaluate((selector) => {
    const node = document.querySelector(selector);
    if (!(node instanceof HTMLCanvasElement)) {
      return {
        drawingBuffer: { height: 0, width: 0 },
        hasContext: false,
      };
    }
    const context = node.getContext("webgl2") ?? node.getContext("webgl");
    return {
      drawingBuffer: {
        height: context?.drawingBufferHeight ?? 0,
        width: context?.drawingBufferWidth ?? 0,
      },
      hasContext: Boolean(context),
    };
  }, VIEWPORT_3D_CANVAS_SELECTOR);
}

async function waitForCanvasClipBox(page) {
  const deadline = Date.now() + 15_000;
  while (Date.now() <= deadline) {
    const box = await readCanvasClipBox(page);
    if (box.width > 0 && box.height > 0) return box;
    await delay(100);
  }
  throw new Error("Timed out waiting for measurable 3D viewport canvas bounds.");
}

async function readCanvasClipBox(page) {
  return page.evaluate((selector) => {
    const node = document.querySelector(selector);
    if (!(node instanceof HTMLCanvasElement)) {
      return { height: 0, width: 0, x: 0, y: 0 };
    }
    const rect = node.getBoundingClientRect();
    return {
      height: rect.height,
      width: rect.width,
      x: rect.x,
      y: rect.y,
    };
  }, VIEWPORT_3D_CANVAS_SELECTOR);
}

async function readCanvasBackground(page) {
  return page.evaluate(
    ({ canvasSelector, viewportSelector }) => {
      const canvas = document.querySelector(canvasSelector);
      const viewport =
        canvas?.closest(viewportSelector) ??
        document.querySelector(viewportSelector);
      return viewport ? getComputedStyle(viewport).backgroundColor : "";
    },
    {
      canvasSelector: VIEWPORT_3D_CANVAS_SELECTOR,
      viewportSelector: VIEWPORT_3D_SELECTOR,
    },
  );
}

async function installComputePerformanceProbe(page) {
  await page.addInitScript((measureNames) => {
    window.__FULLMAG_REACT_PROFILER__ = true;
    function readViewportDiagnosticsSnapshot() {
      const spans = Array.from(
        document.querySelectorAll(".fm-viewport-3d__hud span"),
      );
      const raw =
        spans.find((span) => span.textContent?.includes("frames:"))
          ?.textContent ?? "";
      return {
        cacheBytes: parseDiagnosticBytes(readDiagnosticToken(raw, "cache")),
        frames: parseDiagnosticNumber(readDiagnosticToken(raw, "frames")),
        geo: parseDiagnosticNumber(readDiagnosticToken(raw, "geo")),
        raw,
      };
    }

    function readDiagnosticToken(value, key) {
      const match = value.match(new RegExp(`(?:^|\\s)${key}:([^\\s]+)`));
      return match?.[1] ?? null;
    }

    function parseDiagnosticNumber(value) {
      const number = Number(value);
      return Number.isFinite(number) ? number : 0;
    }

    function parseDiagnosticBytes(value) {
      if (!value) return 0;
      const match = value.match(/^([0-9]+)(B|KB|MB)$/);
      if (!match) return 0;
      const amount = Number(match[1]);
      if (!Number.isFinite(amount)) return 0;
      if (match[2] === "MB") return amount * 1024 * 1024;
      if (match[2] === "KB") return amount * 1024;
      return amount;
    }

    const state = {
      longAnimationFrames: [],
      longTasks: [],
      measures: [],
      phaseStartTime: 0,
      phaseViewportDiagnostics: readViewportDiagnosticsSnapshot(),
      nextProbeWindowId: 1,
      probeWindows: [],
      resources: [],
      supportedEntryTypes:
        typeof PerformanceObserver === "undefined"
          ? []
          : PerformanceObserver.supportedEntryTypes ?? [],
    };
    window.__FULLMAG_COMPUTE_PERFORMANCE__ = state;
    window.__FULLMAG_READ_VIEWPORT_3D_DIAGNOSTICS__ =
      readViewportDiagnosticsSnapshot;
    window.__FULLMAG_RESET_VIEWPORT_3D_PERFORMANCE__ = () => {
      state.phaseStartTime = performance.now();
      state.phaseViewportDiagnostics = readViewportDiagnosticsSnapshot();
    };
    window.__FULLMAG_BEGIN_VIEWPORT_3D_PROBE__ = () => {
      const id = state.nextProbeWindowId;
      state.nextProbeWindowId += 1;
      state.probeWindows.push({
        endTime: Number.POSITIVE_INFINITY,
        id,
        startTime: performance.now(),
      });
      return id;
    };
    window.__FULLMAG_END_VIEWPORT_3D_PROBE__ = (id) => {
      const windowRecord = state.probeWindows.find((item) => item.id === id);
      if (windowRecord) {
        windowRecord.endTime = performance.now();
      }
    };

    function observePerformanceEntries(type, handler) {
      if (typeof PerformanceObserver === "undefined") return;
      if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return;
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            handler(entry);
          }
        });
        observer.observe({ buffered: true, type });
      } catch {
        // Browser support for buffered observers differs across Chromium versions.
      }
    }

    observePerformanceEntries("longtask", (entry) => {
      state.longTasks.push({
        duration: entry.duration,
        name: entry.name,
        startTime: entry.startTime,
      });
    });

    observePerformanceEntries("long-animation-frame", (entry) => {
      state.longAnimationFrames.push({
        blockingDuration: entry.blockingDuration ?? 0,
        duration: entry.duration,
        renderStart: entry.renderStart ?? 0,
        scripts: Array.from(entry.scripts ?? []).map((script) => ({
          duration: script.duration ?? 0,
          forcedStyleAndLayoutDuration:
            script.forcedStyleAndLayoutDuration ?? 0,
          invoker: String(script.invoker ?? ""),
          invokerType: String(script.invokerType ?? ""),
          pauseDuration: script.pauseDuration ?? 0,
          sourceFunctionName: String(script.sourceFunctionName ?? ""),
          sourceURL: String(script.sourceURL ?? ""),
        })),
        startTime: entry.startTime,
        styleAndLayoutStart: entry.styleAndLayoutStart ?? 0,
      });
    });

    observePerformanceEntries("measure", (entry) => {
      if (!measureNames.includes(entry.name)) return;
      state.measures.push({
        duration: entry.duration,
        name: entry.name,
        startTime: entry.startTime,
      });
    });

    observePerformanceEntries("resource", (entry) => {
      if (!String(entry.name).includes("/v2/sessions/current/")) return;
      state.resources.push({
        duration: entry.duration,
        initiatorType: entry.initiatorType,
        name: entry.name,
        startTime: entry.startTime,
        transferSize: entry.transferSize,
      });
    });
  }, COMPUTE_PERFORMANCE_MEASURE_NAMES);
}

async function resetViewport3DPerformanceProbe(page) {
  await page.evaluate(() => {
    window.__FULLMAG_RESET_VIEWPORT_3D_PERFORMANCE__?.();
  });
}

async function collectViewport3DPerformancePhase(page, label) {
  const metrics = await collectComputePerformanceProbe(page, label, {
    scope: "phase",
  });
  await resetViewport3DPerformanceProbe(page);
  return metrics;
}

async function collectComputePerformanceProbe(page, label, { scope = "all" } = {}) {
  return page.evaluate(({ label, measureNames, scope }) => {
    const state = window.__FULLMAG_COMPUTE_PERFORMANCE__ ?? {
      longAnimationFrames: [],
      longTasks: [],
      measures: [],
      phaseStartTime: 0,
      phaseViewportDiagnostics: null,
      probeWindows: [],
      resources: [],
      supportedEntryTypes: [],
    };
    const viewportDiagnostics =
      window.__FULLMAG_READ_VIEWPORT_3D_DIAGNOSTICS__?.() ?? null;
    const phaseViewportDiagnostics =
      scope === "phase"
        ? state.phaseViewportDiagnostics ?? viewportDiagnostics
        : null;
    const viewportFrameDelta =
      scope === "phase" && viewportDiagnostics && phaseViewportDiagnostics
        ? Math.max(
            0,
            viewportDiagnostics.frames - phaseViewportDiagnostics.frames,
          )
        : viewportDiagnostics?.frames ?? 0;
    const startTime =
      scope === "phase" && Number.isFinite(state.phaseStartTime)
        ? state.phaseStartTime
        : 0;
    const phaseElapsedMs = Math.max(0, performance.now() - startTime);
    const sessionResourceEntries = performance
      .getEntriesByType("resource")
      .filter((entry) => String(entry.name).includes("/v2/sessions/current/"))
      .map((entry) => ({
        duration: entry.duration,
        initiatorType: entry.initiatorType,
        name: entry.name,
        startTime: entry.startTime,
        transferSize: entry.transferSize,
      }));
    const measureEntries = performance
      .getEntriesByType("measure")
      .filter((entry) => measureNames.includes(entry.name))
      .map((entry) => ({
        duration: entry.duration,
        name: entry.name,
        startTime: entry.startTime,
      }));
    const resources = dedupePerformanceRows([
      ...state.resources,
      ...sessionResourceEntries,
    ]).filter((entry) => entry.startTime >= startTime);
    const measuredEntries = dedupePerformanceRows([
      ...state.measures,
      ...measureEntries,
    ]).filter((entry) => entry.startTime >= startTime);
    const reactRenderMeasureNames = measureNames.filter((name) =>
      name.startsWith("fullmag.react.render."),
    );
    const viewportMeasureNames = measureNames.filter(
      (name) => !name.startsWith("fullmag.react.render."),
    );
    const viewportMeasures = measuredEntries.filter((entry) =>
      viewportMeasureNames.includes(entry.name),
    );
    const reactRenderMeasures = measuredEntries.filter((entry) =>
      reactRenderMeasureNames.includes(entry.name),
    );
    const probeWindows = state.probeWindows ?? [];
    const longTasks = state.longTasks.filter(
      (entry) =>
        entry.startTime >= startTime &&
        !longTaskOverlapsProbeWindow(entry, probeWindows),
    );
    const longAnimationFrames = (state.longAnimationFrames ?? []).filter(
      (entry) =>
        entry.startTime >= startTime &&
        !longTaskOverlapsProbeWindow(entry, probeWindows),
    );
    const maxLongTaskMs = Math.max(0, ...longTasks.map((entry) => entry.duration));
    const totalLongTaskMs = longTasks.reduce(
      (total, entry) => total + entry.duration,
      0,
    );
    const maxLongAnimationFrameMs = Math.max(
      0,
      ...longAnimationFrames.map((entry) => entry.duration),
    );
    const totalLongAnimationFrameMs = longAnimationFrames.reduce(
      (total, entry) => total + entry.duration,
      0,
    );
    const totalLongAnimationFrameBlockingMs = longAnimationFrames.reduce(
      (total, entry) => total + (entry.blockingDuration ?? 0),
      0,
    );
    const viewportMeasureTotals = summarizeMeasureTotals(
      viewportMeasureNames,
      viewportMeasures,
    );
    const reactRenderMeasureTotals = summarizeMeasureTotals(
      reactRenderMeasureNames,
      reactRenderMeasures,
    );

    return {
      compute_metrics: true,
      label,
      longAnimationFrameBlockingMs: totalLongAnimationFrameBlockingMs,
      longAnimationFrameCount: longAnimationFrames.length,
      longAnimationFrameTopInvokers:
        summarizeLongAnimationFrameInvokers(longAnimationFrames),
      longTaskCount: longTasks.length,
      maxLongAnimationFrameMs,
      maxLongTaskMs,
      phaseElapsedMs,
      reactRenderMeasureCount: reactRenderMeasures.length,
      reactRenderMeasureTotals,
      sessionRequestCount: resources.length,
      scope,
      supportedEntryTypes: state.supportedEntryTypes,
      totalLongAnimationFrameMs,
      totalLongTaskMs,
      viewportDiagnostics: {
        current: viewportDiagnostics,
        phaseStart: phaseViewportDiagnostics,
      },
      viewportFrameDelta,
      viewportMeasureCount: viewportMeasures.length,
      viewportMeasureTotals,
    };

    function summarizeMeasureTotals(names, entries) {
      return Object.fromEntries(
        names.map((name) => {
          const rows = entries.filter((entry) => entry.name === name);
          return [
            name,
            {
              count: rows.length,
              maxDurationMs: Math.max(0, ...rows.map((entry) => entry.duration)),
              totalDurationMs: rows.reduce(
                (total, entry) => total + entry.duration,
                0,
              ),
            },
          ];
        }),
      );
    }

    function summarizeLongAnimationFrameInvokers(entries) {
      const totals = new Map();
      for (const entry of entries) {
        const scripts = Array.isArray(entry.scripts) ? entry.scripts : [];
        if (scripts.length === 0) {
          addLongAnimationFrameInvoker(totals, {
            duration: entry.duration,
            forcedStyleAndLayoutDuration: 0,
            invoker: "unknown-frame",
            invokerType: "",
            pauseDuration: 0,
            sourceFunctionName: "",
            sourceURL: "",
          });
          continue;
        }
        for (const script of scripts) {
          addLongAnimationFrameInvoker(totals, script);
        }
      }
      return Array.from(totals.values())
        .sort((left, right) => right.totalDurationMs - left.totalDurationMs)
        .slice(0, 8);
    }

    function addLongAnimationFrameInvoker(totals, script) {
      const invoker =
        script.invoker ||
        script.sourceFunctionName ||
        shortSourceURL(script.sourceURL) ||
        "unknown-script";
      const current =
        totals.get(invoker) ?? {
          count: 0,
          invoker,
          invokerType: script.invokerType || "",
          maxDurationMs: 0,
          source: shortSourceURL(script.sourceURL),
          sourceFunctionName: script.sourceFunctionName || "",
          totalDurationMs: 0,
          totalForcedStyleAndLayoutMs: 0,
          totalPauseMs: 0,
        };
      const duration = script.duration ?? 0;
      current.count += 1;
      current.maxDurationMs = Math.max(current.maxDurationMs, duration);
      current.totalDurationMs += duration;
      current.totalForcedStyleAndLayoutMs +=
        script.forcedStyleAndLayoutDuration ?? 0;
      current.totalPauseMs += script.pauseDuration ?? 0;
      totals.set(invoker, current);
    }

    function shortSourceURL(sourceURL) {
      if (!sourceURL) return "";
      try {
        const url = new URL(sourceURL);
        return url.pathname.split("/").slice(-2).join("/");
      } catch {
        return String(sourceURL).split("/").slice(-2).join("/");
      }
    }

    function dedupePerformanceRows(rows) {
      const seen = new Set();
      return rows.filter((row) => {
        const key = `${row.name}:${row.startTime}:${row.duration}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    function longTaskOverlapsProbeWindow(entry, probeWindows) {
      const taskStart = entry.startTime;
      const taskEnd = entry.startTime + entry.duration;
      return probeWindows.some(
        (probeWindow) =>
          taskStart < probeWindow.endTime && taskEnd > probeWindow.startTime,
      );
    }
  }, { label, measureNames: COMPUTE_PERFORMANCE_MEASURE_NAMES, scope });
}

function logComputePerformanceProbe(metrics) {
  console.log(`Viewport 3D compute metrics: ${JSON.stringify(metrics)}`);
}

function logViewport3DPerformancePhases(phases) {
  console.log(`Viewport 3D phased compute metrics: ${JSON.stringify(phases)}`);
}

async function verifyProjectionRoundTrip({ canvas, page }) {
  await page.getByRole("tab", { name: "View" }).first().click();
  const projectionToggle = page.locator(`[data-action-id="view-projection"]`);
  await projectionToggle.waitFor({
    state: "visible",
    timeout: GEOMETRY_FLOW_TIMEOUT_MS,
  });

  const initialActive = await projectionToggle.getAttribute("data-active");
  const firstExpectedActive = initialActive === "true" ? "false" : "true";
  const secondExpectedActive = initialActive === "true" ? "true" : "false";
  const initialProjectionSample = await sampleCanvasComposite(page);

  await projectionToggle.click();
  await waitForCondition(
    "projection toggle changes from initial state",
    async () => {
      const active = await projectionToggle.getAttribute("data-active");
      if (active === firstExpectedActive) return true;
      throw new Error("data-active=" + active);
    },
  );
  const firstProjectionSample = await waitForCanvasCompositeChange(
    page,
    canvas,
    initialProjectionSample,
    "projection canvas renders after first toggle",
    "Viewport canvas did not visually change after first projection toggle",
  );

  await projectionToggle.click();
  await waitForCondition(
    "projection toggle returns to initial state",
    async () => {
      const active = await projectionToggle.getAttribute("data-active");
      if (active === secondExpectedActive) return true;
      throw new Error("data-active=" + active);
    },
  );
  await waitForCanvasCompositeChange(
    page,
    canvas,
    firstProjectionSample,
    "projection canvas renders after second toggle",
    "Viewport canvas did not visually leave orthographic projection after second toggle",
  );

  console.log(
    "Viewport 3D projection round-trip passed (initial active=" +
      (initialActive ?? "null") +
      ").",
  );
}

async function verifyDimensionFrameCage({ canvas, page }) {
  const commandId = "viewport-3d.dimension-frame-cage";
  await selectDimensionFrameMode(page, "Off");
  const offSample = await sampleCanvasComposite(page);
  await selectDimensionFrameMode(page, "Floor + vertical");
  await waitForCanvasCompositeChange(
    page,
    canvas,
    offSample,
    "dimension frame canvas renders after cage mode",
    "Viewport canvas did not visually change after enabling dimension frame cage",
    { minimumChangedPixels: 1 },
  );

  console.log(`Viewport 3D dimension frame cage passed (command=${commandId}).`);
}

async function selectDimensionFrameMode(page, name) {
  await page.getByRole("tab", { name: "View" }).first().click({ force: true });
  await clickFreshAction(page, '[data-action-id="view-dimension-frame"]', "open dimension frame menu");
  await page
    .getByRole("menuitemradio", { exact: true, name })
    .click({ force: true });
  await waitForBrowserPaint(page);
}

async function clickFreshAction(page, selector, label) {
  await waitForCondition(label, async () => {
    const action = page.locator(selector).first();
    await action.waitFor({ state: "visible", timeout: 2_000 });
    await action.click({ force: true, timeout: 2_000 });
    return true;
  });
}

async function verifyGeometryAuthoringFlow({
  canvas,
  canvasBaseline,
  page,
  realtimeMessages,
  sceneResponses,
}) {
  const initialScene = await waitForSceneResponse(
    sceneResponses,
    (record) => Array.isArray(sceneObjects(record.body)),
    "initial GET /v2/sessions/current/model/scene",
  );
  const cleanupObjectIds = [];
  let cleanupRevision = sceneRevision(initialScene.body);
  const knownObjectIds = new Set(
    sceneObjects(initialScene.body).map(sceneObjectId).filter(Boolean),
  );
  const objectName = `Smoke Box ${Date.now().toString(36)}`;
  const sceneSequenceBeforeCommit = sceneResponseSequence;

  try {
    await page.getByRole("tab", { name: "Geometry" }).click();
    const addBox = page.locator('[data-action-id="geometry.add-box"]');
    await addBox.waitFor({ state: "visible", timeout: GEOMETRY_FLOW_TIMEOUT_MS });
    await addBox.click();

    const draftName = page.locator('.fm-inspector-panel input[aria-label="Name"]').first();
    await draftName.waitFor({ state: "visible", timeout: GEOMETRY_FLOW_TIMEOUT_MS });
    await fillDraftInput(draftName, objectName);
    await fillDraftField(page, "Size X", "9e-7");
    await fillDraftField(page, "Size Y", "7e-7");
    await fillDraftField(page, "Size Z", "1e-7");
    await fillDraftField(page, "Translation X", "-1.6e-6");

    const transactionResponsePromise = page.waitForResponse(
      (response) =>
        isModelTransactionUrl(response.url()) &&
        response.request().method() === "POST" &&
        response.status() < 400,
      { timeout: GEOMETRY_FLOW_TIMEOUT_MS },
    );
    await page
      .locator(".fm-inspector-panel button")
      .filter({ hasText: "Apply Draft" })
      .first()
      .click();

    const transactionResponse = await transactionResponsePromise;
    const transaction = await transactionResponse.json();
    cleanupRevision =
      transaction.scene_revision ?? sceneRevision(transaction.committed_scene) ?? cleanupRevision;
    const committedScene = transaction.committed_scene ?? null;
    const committedSceneWithObject = findCreatedObject(
      sceneObjects(committedScene),
      knownObjectIds,
      objectName,
    )
      ? committedScene
      : null;

    const uiScene =
      committedSceneWithObject ??
      (
        await waitForSceneResponse(
          sceneResponses,
          (record) =>
            record.sequence >= sceneSequenceBeforeCommit &&
            sceneObjects(record.body).some((object) => sceneObjectName(object) === objectName),
          "model/scene fallback refetch after UI object commit",
        )
      ).body;
    cleanupRevision = sceneRevision(uiScene) ?? cleanupRevision;
    const createdObject = findCreatedObject(
      sceneObjects(uiScene),
      knownObjectIds,
      objectName,
    );

    if (!createdObject) {
      throw new Error("Committed geometry object is missing from SceneDocument.");
    }

    const objectId = sceneObjectId(createdObject);
    if (!objectId) {
      throw new Error("Committed geometry object has no id in SceneDocument.");
    }
    cleanupObjectIds.push(objectId);
    await verifyObjectInViewportRenderModel(page, objectId);
    await verifyObjectInExplorerViewportAndInspector(page, objectId);
    const uiCanvasSample = await waitForCanvasChange(
      page,
      canvas,
      canvasBaseline,
      "3D viewport canvas change after UI object commit",
    );
    const regionCanvasSample = await verifyRegionAuthoringOverlayFlow({
      baseline: uiCanvasSample,
      objectId,
      page,
    });

    const externalObjectName = `Smoke WS Box ${Date.now().toString(36)}`;
    const externalObjectId = `smoke-ws-${Date.now().toString(36)}`;
    const externalBaseRevision =
      sceneRevision(uiScene) ?? transaction.scene_revision ?? null;
    if (typeof externalBaseRevision !== "number") {
      throw new Error(
        "Cannot run websocket refetch check: current SceneDocument revision is missing.",
      );
    }

    const realtimeMessageStartIndex = realtimeMessages.length;
    const sceneSequenceBeforeExternalCommit = sceneResponseSequence;
    const externalTransaction = await commitExternalObjectTransaction(page, {
      baseRevision: externalBaseRevision,
      objectId: externalObjectId,
      objectName: externalObjectName,
    });
    cleanupRevision = externalTransaction.scene_revision ?? cleanupRevision;
    cleanupObjectIds.push(externalObjectId);
    await waitForRealtimeBatchChanged(
      realtimeMessages,
      "/v2/sessions/current/model/scene",
      "resource.batch_changed for externally committed model/scene",
      realtimeMessageStartIndex,
    );
    const externalScene = await waitForSceneResponse(
      sceneResponses,
      (record) =>
        record.sequence >= sceneSequenceBeforeExternalCommit &&
        sceneObjects(record.body).some(
          (object) => sceneObjectId(object) === externalObjectId,
        ),
      "GET /v2/sessions/current/model/scene refetch after websocket invalidation",
    );
    cleanupRevision = sceneRevision(externalScene.body) ?? cleanupRevision;
    await verifyObjectInViewportRenderModel(page, externalObjectId);
    await verifyObjectInExplorerViewportAndInspector(
      page,
      externalObjectId,
    );
    await waitForCanvasChange(
      page,
      canvas,
      regionCanvasSample,
      "3D viewport canvas change after websocket scene refetch",
    );
    if (!keepGeometrySmokeObjects) {
      await cleanupGeometrySmokeObjects(page, {
        baseRevision: cleanupRevision,
        objectIds: [...cleanupObjectIds].reverse(),
      });
      cleanupObjectIds.length = 0;
    }
    logGeometryFlowSuccess(transaction, objectId, externalObjectId);
  } finally {
    if (!keepGeometrySmokeObjects && cleanupObjectIds.length > 0) {
      try {
        await cleanupGeometrySmokeObjects(page, {
          baseRevision: cleanupRevision,
          objectIds: [...cleanupObjectIds].reverse(),
        });
      } catch (error) {
        console.warn(
          `Smoke object cleanup after failure did not complete: ${error.message}`,
        );
      }
    }
  }
}

async function verifyRegionAuthoringOverlayFlow({
  baseline,
  objectId,
  page,
}) {
  const regionName = `Smoke Region ${Date.now().toString(36)}`;
  const regionsNode = page.locator(
    `[data-node-id="${cssAttributeValue(`model:object:${objectId}:regions`)}"]`,
  );
  await ensureExplorerNodeVisible(page, objectId, regionsNode);
  await clickExplorerRow(regionsNode);

  await page
    .locator(".fm-inspector-panel button")
    .filter({ hasText: "Add Region" })
    .first()
    .click();
  await fillDraftField(page, "Name", regionName);
  const shapeSelect = page
    .locator('.fm-inspector-panel select[aria-label="Shape"]')
    .first();
  await shapeSelect.waitFor({
    state: "visible",
    timeout: GEOMETRY_FLOW_TIMEOUT_MS,
  });
  await shapeSelect.selectOption("cylinder");
  const createButton = page
    .locator(".fm-inspector-panel button")
    .filter({ hasText: /^Create$/ })
    .first();
  await createButton.waitFor({
    state: "visible",
    timeout: GEOMETRY_FLOW_TIMEOUT_MS,
  });
  await waitForCondition("region create button enabled", async () => {
    return (await createButton.isEnabled().catch(() => false)) ? true : null;
  });

  const createRegionResponsePromise = page.waitForResponse(
    (response) =>
      isObjectRegionCreateUrl(response.url(), objectId) &&
      response.request().method() === "POST" &&
      response.status() < 400,
    { timeout: GEOMETRY_FLOW_TIMEOUT_MS },
  );
  const scriptSyncResponsePromise = waitForRegionAuthoringScriptSync(page);
  await createButton.evaluate((node) => {
    if ("click" in node && typeof node.click === "function") {
      node.click();
    }
  });

  const createRegionResponse = await createRegionResponsePromise;
  await scriptSyncResponsePromise;
  const scene = await createRegionResponse.json();
  const object = sceneObjects(scene).find(
    (candidate) => sceneObjectId(candidate) === objectId,
  );
  const region = objectRegions(object).find(
    (candidate) => candidate?.name === regionName,
  );
  const regionId =
    typeof region?.region_id === "string"
      ? region.region_id
      : typeof region?.id === "string"
        ? region.id
        : null;
  if (!regionId) {
    throw new Error("Created object region is missing from SceneDocument response.");
  }

  const regionNode = page.locator(
    `[data-node-id="${cssAttributeValue(
      `model:object:${objectId}:regions:${regionId}`,
    )}"]`,
  );
  if (!(await regionNode.isVisible().catch(() => false))) {
    await ensureExplorerNodeVisible(page, objectId, regionsNode);
    await ensureExplorerNodeExpanded(regionsNode);
  }
  await regionNode.waitFor({
    state: "visible",
    timeout: GEOMETRY_FLOW_TIMEOUT_MS,
  });
  await page
    .locator(".fm-viewport-3d")
    .getByRole("button", { name: "Hide regions" })
    .waitFor({ state: "visible", timeout: GEOMETRY_FLOW_TIMEOUT_MS });
  await assertViewportTopologyNotStale(page, "region authoring");
  const canvasSample = await waitForCanvasChange(
    page,
    page.locator(VIEWPORT_3D_CANVAS_SELECTOR),
    baseline,
    "3D viewport canvas change after object region overlay commit",
  );
  console.log(
    [
      "Region overlay smoke passed:",
      `object=${objectId}`,
      `region=${regionId}`,
      "scene=published",
      "script=region-authoring-synced",
      "mesh=preserved",
      "viewport=overlay+canvas-delta",
    ].join(" "),
  );
  return canvasSample;
}

async function waitForRegionAuthoringScriptSync(page) {
  return page.waitForResponse(
    (response) =>
      pathnameFromUrl(response.url()) === "/v2/sessions/current/model/syncs" &&
      response.request().method() === "POST" &&
      response.status() < 400,
    { timeout: GEOMETRY_FLOW_TIMEOUT_MS },
  );
}

async function ensureExplorerNodeVisible(page, objectId, node) {
  if (await node.isVisible().catch(() => false)) return;
  const objectRow = page.locator(
    `[data-node-id="${cssAttributeValue(`model:object:${objectId}`)}"]`,
  );
  await objectRow.waitFor({
    state: "visible",
    timeout: GEOMETRY_FLOW_TIMEOUT_MS,
  });
  await clickExplorerRow(objectRow);
  if (!(await node.isVisible().catch(() => false))) {
    await ensureExplorerNodeExpanded(objectRow);
  }
  await node.waitFor({ state: "visible", timeout: GEOMETRY_FLOW_TIMEOUT_MS });
}

async function ensureExplorerNodeExpanded(node) {
  if ((await node.getAttribute("aria-expanded")) === "false") {
    await node.dblclick();
  }
}

async function verifyObjectInExplorerViewportAndInspector(
  page,
  objectId,
) {
  const explorerRow = page.locator(
    `[data-node-id="${cssAttributeValue(`model:object:${objectId}`)}"]`,
  );
  await explorerRow.waitFor({ state: "visible", timeout: GEOMETRY_FLOW_TIMEOUT_MS });

  await clickExplorerRow(explorerRow);
  const inspector = page.locator(".fm-inspector");
  await waitForLocatorText(inspector, objectId, "Inspector object id");
  await waitForLocatorText(inspector, "SceneDocument", "Inspector source");
}

async function clickExplorerRow(explorerRow) {
  await explorerRow.evaluate((node) => {
    node.scrollIntoView({ block: "center", inline: "nearest" });
    if ("click" in node && typeof node.click === "function") {
      node.click();
    }
  });
}

async function verifyObjectInViewportRenderModel(page, objectId) {
  await waitForCondition("Viewport primitive render model", async () => {
    const ids = await page
      .locator(".fm-viewport-3d")
      .first()
      .getAttribute("data-primitive-object-ids")
      .catch(() => "");
    if (String(ids ?? "").split(/\s+/).includes(objectId)) {
      return ids;
    }
    throw new Error(`primitive ids: ${ids ?? ""}`);
  });
}

function logGeometryFlowSuccess(transaction, objectId, externalObjectId) {
  console.log(
    [
      "Geometry flow smoke passed:",
      `object=${objectId}`,
      `websocket_object=${externalObjectId}`,
      `scene_revision=${transaction.scene_revision ?? "unknown"}`,
      "model/scene=refetched",
      "realtime=resource.batch_changed",
      "explorer=selected",
      "viewport=render-model+canvas-delta",
      "inspector=SceneDocument",
    ].join(" "),
  );
}

async function commitExternalObjectTransaction(
  page,
  { baseRevision, objectId, objectName },
) {
  return commitExternalModelTransaction(page, {
    baseRevision,
    geometry: {
      geometry_kind: "Box",
      geometry_params: { size: [9e-7, 7e-7, 1e-7] },
    },
    kind: "create_object",
    name: objectName,
    object_id: objectId,
    transform: {
      pivot: [0, 0, 0],
      rotation_quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
      translation: [1.6e-6, 0, 0],
    },
  });
}

async function cleanupGeometrySmokeObjects(page, { baseRevision, objectIds }) {
  let revision = baseRevision;
  if (typeof revision !== "number") {
    throw new Error("Cannot clean up smoke objects: scene revision is missing.");
  }

  for (const objectId of objectIds) {
    const response = await commitExternalModelTransaction(page, {
      baseRevision: revision,
      kind: "delete_object",
      object_id: objectId,
    });
    if (typeof response.scene_revision !== "number") {
      throw new Error(
        `Smoke object cleanup for ${objectId} did not return a scene_revision.`,
      );
    }
    revision = response.scene_revision;
  }
}

async function commitExternalModelTransaction(page, request) {
  return page.evaluate(
    async ({ apiBase, request }) => {
      const config = window.__FULLMAG_CONFIG__ ?? {};
      const configuredBase =
        apiBase ??
        config.controlRoomApiBase ??
        config.runtimeHttpBase ??
        config.apiBase ??
        (["localhost", "127.0.0.1"].includes(window.location.hostname)
          ? `${window.location.protocol}//${window.location.hostname}:8081`
          : window.location.origin);
      const base = String(configuredBase)
        .replace(/\/+$/, "")
        .replace(/\/v2$/, "");
      const response = await fetch(
        `${base}/v2/sessions/current/model/transactions`,
        {
          body: JSON.stringify({
            ...request,
            base_revision: request.baseRevision,
            baseRevision: undefined,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );

      if (!response.ok) {
        throw new Error(
          `External geometry transaction failed: ${response.status} ${await response.text()}`,
        );
      }

      return response.json();
    },
    { apiBase, request },
  );
}

async function waitForSceneResponse(records, predicate, label) {
  return waitForCondition(label, () => records.find(predicate) ?? null);
}

async function waitForRealtimeBatchChanged(
  messages,
  recommendedFetch,
  label,
  startIndex = 0,
) {
  return waitForCondition(label, () => {
    return (
      messages.slice(startIndex).find((message) =>
        realtimeBatchChangedMatches(message.parsed, recommendedFetch),
      ) ?? null
    );
  });
}

async function waitForLocatorText(locator, expectedText, label) {
  await waitForCondition(label, async () => {
    const text = await locator.textContent().catch(() => "");
    return text?.includes(expectedText) ? text : null;
  });
}

async function fillDraftField(page, label, value) {
  const field = page
    .locator(`.fm-inspector-panel input[aria-label="${cssAttributeValue(label)}"]`)
    .first();
  await field.waitFor({ state: "visible", timeout: GEOMETRY_FLOW_TIMEOUT_MS });
  await fillDraftInput(field, value);
}

async function fillDraftInput(field, value) {
  await field.scrollIntoViewIfNeeded({ timeout: GEOMETRY_FLOW_TIMEOUT_MS });
  await field.fill(value, { force: true, timeout: GEOMETRY_FLOW_TIMEOUT_MS });
}

async function waitForCanvasCompositeChange(
  page,
  canvas,
  baseline,
  label,
  failureMessage,
  options = {},
) {
  return waitForCondition(label, async () => {
    const current = await sampleCanvasComposite(page);
    if (!current.nonBlank) {
      throw new Error(
        failureMessage +
          ": viewport is blank (" +
          current.variedPixels +
          "/" +
          current.sampledPixels +
          " sampled pixels differ from background).",
      );
    }

    const diff = canvasCompositeDifference(baseline, current, options);
    if (diff.changed) return current;
    throw new Error(
      failureMessage +
        ": " +
        diff.changedPixels +
        "/" +
        diff.sampledPixels +
        " sampled pixels changed; threshold=" +
        diff.minimumChangedPixels +
        ".",
    );
  });
}

async function waitForCanvasChange(page, canvas, baseline, label) {
  return waitForCondition(label, async () => {
    const current = await sampleCanvasComposite(page);
    const diff = canvasCompositeDifference(baseline, current);
    if (diff.changed) return current;
    throw new Error(
      `canvas changed ${diff.changedPixels}/${diff.sampledPixels} sampled pixels; ` +
        `threshold=${diff.minimumChangedPixels}`,
    );
  });
}

async function waitForCameraSignatureChange(page, baseline, label, failureMessage) {
  return waitForCondition(label, async () => {
    const current = await readViewportCameraSignature(page);
    if (current !== baseline) return current;
    throw new Error(failureMessage + `: camera=${current}.`);
  });
}

async function waitForCondition(label, predicate) {
  const deadline = Date.now() + GEOMETRY_FLOW_TIMEOUT_MS;
  let lastError = null;

  while (Date.now() <= deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }

  const suffix = lastError ? ` Last error: ${lastError.message}` : "";
  throw new Error(`${label} timed out after ${GEOMETRY_FLOW_TIMEOUT_MS}ms.${suffix}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBrowserPaint(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(resolve);
        });
      }),
  );
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) {
      clearTimeout(timer);
    }
  });
}

async function withViewport3DPerformanceProbePaused(page, run) {
  const probeWindowId = await page.evaluate(() =>
    window.__FULLMAG_BEGIN_VIEWPORT_3D_PROBE__?.(),
  );
  try {
    return await run();
  } finally {
    await page.evaluate((id) => {
      if (typeof id === "number") {
        window.__FULLMAG_END_VIEWPORT_3D_PROBE__?.(id);
      }
    }, probeWindowId);
  }
}

async function sampleCanvasComposite(page) {
  return withViewport3DPerformanceProbePaused(page, async () => {
    const box = await waitForCanvasClipBox(page);
    if (box.width <= 0 || box.height <= 0) {
      throw new Error(
        `3D viewport canvas has no measurable bounding box: ${box.width}x${box.height}.`,
      );
    }

    const background = await readCanvasBackground(page);
    const backgroundRgb = parseCssRgb(background);
    const webglSample = await sampleCanvasWebGLPixels(page, backgroundRgb);
    if (webglSample?.nonBlank) return webglSample;

    const png = await withTimeout(
      page.screenshot({
        clip: {
          height: Math.max(1, box.height),
          width: Math.max(1, box.width),
          x: box.x,
          y: box.y,
        },
        timeout: CANVAS_SCREENSHOT_TIMEOUT_MS,
      }),
      CANVAS_SCREENSHOT_TIMEOUT_MS,
      "3D viewport canvas composite screenshot",
    );
    const bitmap = parsePng(png);
    const stride = Math.max(1, Math.floor(Math.min(bitmap.width, bitmap.height) / 64));
    const signature = [];
    let sampledPixels = 0;
    let variedPixels = 0;

    for (let y = 0; y < bitmap.height; y += stride) {
      for (let x = 0; x < bitmap.width; x += stride) {
        sampledPixels += 1;
        const offset = (y * bitmap.width + x) * 4;
        const alpha = bitmap.rgba[offset + 3];
        if (alpha === 0) {
          continue;
        }

        const rgb = [
          bitmap.rgba[offset],
          bitmap.rgba[offset + 1],
          bitmap.rgba[offset + 2],
        ];
        signature.push(...rgb);
        if (pixelDiffers(rgb, backgroundRgb)) {
          variedPixels += 1;
        }
      }
    }

    return {
      nonBlank: variedPixels > 0,
      sampledPixels,
      signature,
      variedPixels,
    };
  });
}

async function sampleCanvasWebGLPixels(page, backgroundRgb) {
  return page.evaluate(
    ({ backgroundRgb, selector }) => {
      const node = document.querySelector(selector);
      if (!(node instanceof HTMLCanvasElement)) return null;
      const context = node.getContext("webgl2") ?? node.getContext("webgl");
      if (!context || context.isContextLost()) return null;

      const width = context.drawingBufferWidth;
      const height = context.drawingBufferHeight;
      if (width <= 0 || height <= 0) return null;

      const rgba = new Uint8Array(width * height * 4);
      context.readPixels(
        0,
        0,
        width,
        height,
        context.RGBA,
        context.UNSIGNED_BYTE,
        rgba,
      );

      const stride = Math.max(1, Math.floor(Math.min(width, height) / 64));
      const signature = [];
      let sampledPixels = 0;
      let variedPixels = 0;

      for (let y = 0; y < height; y += stride) {
        for (let x = 0; x < width; x += stride) {
          sampledPixels += 1;
          const offset = (y * width + x) * 4;
          const alpha = rgba[offset + 3] / 255;
          const rgb = [
            Math.round(rgba[offset] * alpha + backgroundRgb[0] * (1 - alpha)),
            Math.round(rgba[offset + 1] * alpha + backgroundRgb[1] * (1 - alpha)),
            Math.round(rgba[offset + 2] * alpha + backgroundRgb[2] * (1 - alpha)),
          ];
          signature.push(...rgb);
          if (
            rgb.some(
              (channel, index) => Math.abs(channel - backgroundRgb[index]) > 8,
            )
          ) {
            variedPixels += 1;
          }
        }
      }

      return {
        nonBlank: variedPixels > 0,
        sampledPixels,
        signature,
        variedPixels,
      };
    },
    { backgroundRgb, selector: VIEWPORT_3D_CANVAS_SELECTOR },
  );
}

function canvasCompositeDifference(before, after, options = {}) {
  const length = Math.min(before.signature.length, after.signature.length);
  if (length === 0) return { changed: false, changedPixels: 0, sampledPixels: 0 };

  let changedPixels = 0;
  for (let offset = 0; offset < length; offset += 3) {
    const delta =
      Math.abs(before.signature[offset] - after.signature[offset]) +
      Math.abs(before.signature[offset + 1] - after.signature[offset + 1]) +
      Math.abs(before.signature[offset + 2] - after.signature[offset + 2]);
    if (delta > 18) {
      changedPixels += 1;
    }
  }

  const sampledPixels = Math.floor(length / 3);
  const minimumChangedPixels =
    options.minimumChangedPixels ??
    Math.max(6, Math.floor(sampledPixels * 0.005));
  return {
    changed: changedPixels >= minimumChangedPixels,
    changedPixels,
    minimumChangedPixels,
    sampledPixels,
  };
}

function isModelSceneUrl(responseUrl) {
  return pathnameFromUrl(responseUrl) === "/v2/sessions/current/model/scene";
}

function isModelTransactionUrl(responseUrl) {
  return pathnameFromUrl(responseUrl) === "/v2/sessions/current/model/transactions";
}

function isRealtimeWebsocketUrl(websocketUrl) {
  return pathnameFromUrl(websocketUrl) === "/v2/sessions/current/events/ws";
}

function pathnameFromUrl(rawUrl) {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return "";
  }
}

function searchFromUrl(rawUrl) {
  try {
    return new URL(rawUrl).search;
  } catch {
    return "";
  }
}

function isFieldVectorSamplesPath(path) {
  return /^\/v2\/sessions\/current\/data\/fields\/[^/]+\/samples\/vector$/.test(path);
}

function framePayloadText(payload) {
  if (typeof payload === "string") return payload;
  if (payload instanceof Buffer) return payload.toString("utf8");
  if (payload && typeof payload.toString === "function") return payload.toString();
  return "";
}

function parseJsonOrNull(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sceneObjects(scene) {
  return Array.isArray(scene?.objects) ? scene.objects : [];
}

function objectRegions(object) {
  return Array.isArray(object?.regions) ? object.regions : [];
}

function sceneRevision(scene) {
  const revision = scene?.revision ?? scene?.scene_revision;
  return typeof revision === "number" ? revision : null;
}

function sceneObjectId(object) {
  return typeof object?.id === "string" && object.id.length > 0 ? object.id : null;
}

function sceneObjectName(object) {
  return typeof object?.name === "string" && object.name.length > 0
    ? object.name
    : null;
}

function findCreatedObject(objects, knownObjectIds, objectName) {
  const byName = objects.find((object) => sceneObjectName(object) === objectName);
  if (byName) return byName;

  return (
    objects.find((object) => {
      const objectId = sceneObjectId(object);
      return objectId && !knownObjectIds.has(objectId);
    }) ?? null
  );
}

function realtimeBatchChangedMatches(event, recommendedFetch) {
  if (!event || event.type !== "resource.batch_changed") return false;
  const changes = Array.isArray(event.payload?.changes) ? event.payload.changes : [];

  return changes.some((change) => change?.recommended_fetch === recommendedFetch);
}

function isObjectRegionCreateUrl(value, objectId) {
  const path = pathnameFromUrl(value);
  return (
    path ===
    `/v2/sessions/current/model/objects/${encodeURIComponent(objectId)}/regions`
  );
}

async function assertViewportTopologyNotStale(page, label) {
  await waitForCondition(`${label} topology remains renderable`, async () => {
    const viewport = page.locator(".fm-viewport-3d").first();
    const freshness = await viewport
      .getAttribute("data-topology-freshness")
      .catch(() => "");
    const text = await viewport.textContent().catch(() => "");
    if (
      freshness === "unknown" ||
      String(text).includes("edge-only safety view") ||
      String(text).includes("Mesh topology is stale")
    ) {
      throw new Error(
        `topology freshness=${freshness}; hud=${String(text).slice(0, 240)}`,
      );
    }
    return true;
  });
}

function cssAttributeValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function parsePng(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) {
    throw new Error("Screenshot is not a PNG image.");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = buffer.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }

    offset = dataEnd + 4;
  }

  if (bitDepth !== 8 || interlace !== 0 || ![2, 6].includes(colorType)) {
    throw new Error(
      `Unsupported PNG screenshot format: bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace}.`,
    );
  }

  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const source = inflateSync(Buffer.concat(idat));
  const rowLength = width * bytesPerPixel;
  const raw = Buffer.alloc(height * rowLength);
  let sourceOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = source[sourceOffset];
    sourceOffset += 1;
    const rowOffset = y * rowLength;

    for (let x = 0; x < rowLength; x += 1) {
      const value = source[sourceOffset + x];
      const left = x >= bytesPerPixel ? raw[rowOffset + x - bytesPerPixel] : 0;
      const up = y > 0 ? raw[rowOffset - rowLength + x] : 0;
      const upLeft =
        y > 0 && x >= bytesPerPixel
          ? raw[rowOffset - rowLength + x - bytesPerPixel]
          : 0;
      raw[rowOffset + x] = unfilterPngByte(filter, value, left, up, upLeft);
    }

    sourceOffset += rowLength;
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const sourceIndex = index * bytesPerPixel;
    const targetIndex = index * 4;
    rgba[targetIndex] = raw[sourceIndex];
    rgba[targetIndex + 1] = raw[sourceIndex + 1];
    rgba[targetIndex + 2] = raw[sourceIndex + 2];
    rgba[targetIndex + 3] = colorType === 6 ? raw[sourceIndex + 3] : 255;
  }

  return { height, rgba, width };
}

function unfilterPngByte(filter, value, left, up, upLeft) {
  if (filter === 0) return value;
  if (filter === 1) return (value + left) & 255;
  if (filter === 2) return (value + up) & 255;
  if (filter === 3) return (value + Math.floor((left + up) / 2)) & 255;
  if (filter === 4) return (value + paeth(left, up, upLeft)) & 255;
  throw new Error(`Unsupported PNG filter: ${filter}.`);
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

function parseCssRgb(value) {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) return [0, 0, 0];

  const channels = match[1].split(",").map((channel) => Number(channel.trim()));
  return [
    Number.isFinite(channels[0]) ? channels[0] : 0,
    Number.isFinite(channels[1]) ? channels[1] : 0,
    Number.isFinite(channels[2]) ? channels[2] : 0,
  ];
}

function pixelDiffers(rgb, backgroundRgb) {
  return rgb.some((channel, index) => Math.abs(channel - backgroundRgb[index]) > 8);
}

function isIgnorableConsoleError(text) {
  if (text === "Failed to load resource: the server responded with a status of 404 (Not Found)") {
    return true;
  }

  if (allowMissingSession && text.includes("net::ERR_CONNECTION_REFUSED")) {
    return true;
  }

  return (
    allowMissingSession &&
    text.includes("/v2/sessions/current/events/ws") &&
    text.includes("Unexpected response code: 404")
  );
}

function isAllowedMissingSessionResponse(responseUrl, status) {
  if (!allowMissingSession || status !== 404) {
    return false;
  }

  try {
    const pathname = new URL(responseUrl).pathname;
    return pathname.startsWith("/v2/sessions/current/");
  } catch {
    return false;
  }
}

function isAllowedOptionalActiveSessionResponse(responseUrl, status) {
  if (allowMissingSession || status !== 404) {
    return false;
  }

  const optionalPaths = new Set([
    "/v2/sessions/current/meshing/builds/current",
    "/v2/sessions/current/meshing/builds/latest-successful",
    "/v2/sessions/current/meshing/meshes/shared-domain/quality-gates",
    "/v2/sessions/current/meshing/meshes/shared-domain/realized-size-fields",
    "/v2/sessions/current/meshing/summary",
    "/v2/sessions/current/simulation/runs/current",
    "/v2/sessions/current/simulation/stages/execution",
  ]);

  try {
    return optionalPaths.has(new URL(responseUrl).pathname);
  } catch {
    return false;
  }
}
