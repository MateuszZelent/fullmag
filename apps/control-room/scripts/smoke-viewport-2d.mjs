import fs from "node:fs/promises";
import path from "node:path";

const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://localhost:3194/workspace";
const apiBase = (
  process.env.CONTROL_ROOM_API_BASE_URL ?? new URL(workspaceUrl).origin
).replace(/\/$/, "");
const backend = process.env.CONTROL_ROOM_PLANAR_BACKEND ?? "fdm";
const outputDir =
  process.env.CONTROL_ROOM_PLANAR_OUTPUT_DIR ??
  path.resolve(".fullmag/reports/viewport-2d-planar-monitor-smoke/browser");
const timeoutMs = Number(
  process.env.CONTROL_ROOM_PLANAR_SMOKE_TIMEOUT_MS ?? 180_000,
);
const switchCount = Number(
  process.env.CONTROL_ROOM_PLANAR_SWITCH_COUNT ?? 100,
);

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    throw new Error("2D viewport smoke requires Playwright or @playwright/test");
  }
  await fs.mkdir(outputDir, { recursive: true });
  const monitors = await waitForMonitors();
  const ids = monitors.monitors.map((monitor) => monitor.id);
  const required =
    backend === "fem"
      ? ["xy-plane", "xy-slab", "object-surface"]
      : ["xy-plane", "xy-slab", "depth-mean", "oblique-plane"];
  for (const id of required) {
    if (!ids.includes(id)) throw new Error(`Missing planar monitor ${id}`);
  }

  const browser = await playwright.chromium.launch({
    args: ["--enable-precise-memory-info"],
  });
  const page = await browser.newPage({
    reducedMotion: "reduce",
    viewport: { height: 900, width: 1440 },
  });
  const errors = [];
  const observedPlanarMeta = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", async (response) => {
    const requestUrl = new URL(response.url());
    const match = requestUrl.pathname.match(
      /^\/v2\/sessions\/current\/data\/fields\/([^/]+)\/planar-monitors\/([^/]+)\/meta$/,
    );
    if (!match || response.status() !== 200) return;
    try {
      observedPlanarMeta.push({
        monitorId: decodeURIComponent(match[2]),
        payload: await response.json(),
        quantityId: decodeURIComponent(match[1]),
      });
    } catch (error) {
      errors.push(`Planar meta inspection failed: ${String(error)}`);
    }
  });
  await page.addInitScript((baseUrl) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: baseUrl,
    };
  }, apiBase);

  try {
    const initialMonitor = monitorById(monitors, required[0]);
    await selectMonitor(initialMonitor.id, 128);
    await page.goto(workspaceUrl, {
      timeout: timeoutMs,
      waitUntil: "domcontentloaded",
    });
    const open2d = page.getByRole("button", { name: "2D", exact: true });
    await open2d.waitFor({ state: "visible", timeout: timeoutMs });
    const initialOpenStarted = performance.now();
    await open2d.click();
    const initialCanvas = await assertFieldMapCanvas(page);
    const initialEvidence = await assertPlanarEvidence(
      page,
      expectedPlanarEvidence(initialMonitor),
      observedPlanarMeta,
    );
    const initialOpenMs = performance.now() - initialOpenStarted;
    if (initialOpenMs > 10_000) {
      throw new Error(`initial 2D open exceeded 10 s: ${initialOpenMs}`);
    }
    const open3d = page.getByRole("button", { name: "3D", exact: true });
    await open3d.click();
    await page.keyboard.press("2");
    await assertFieldMapCanvas(page);
    await page.screenshot({
      fullPage: true,
      path: path.join(outputDir, "scalar-plane.png"),
    });

    const performanceMetrics = { initial_open_ms: initialOpenMs };
    const smokeEvidence = [initialEvidence];
    const smallSwitch = await timedMonitorSwitch(
      page,
      monitorById(monitors, "xy-slab"),
      128,
      path.join(outputDir, "slab-vectors.png"),
      observedPlanarMeta,
    );
    performanceMetrics.small_switch_ms = smallSwitch.duration;
    smokeEvidence.push(smallSwitch.evidence);
    const largeSwitch = await timedMonitorSwitch(
      page,
      initialMonitor,
      1024,
      undefined,
      observedPlanarMeta,
    );
    performanceMetrics.large_switch_ms = largeSwitch.duration;
    smokeEvidence.push(largeSwitch.evidence);
    if (backend === "fem") {
      const surfaceSwitch = await timedMonitorSwitch(
        page,
        monitorById(monitors, "object-surface"),
        256,
        path.join(outputDir, "surface-projection.png"),
        observedPlanarMeta,
      );
      performanceMetrics.surface_switch_ms = surfaceSwitch.duration;
      smokeEvidence.push(surfaceSwitch.evidence);
      const meshSwitch = await timedMonitorSwitch(
        page,
        monitorById(monitors, "xy-plane"),
        256,
        path.join(outputDir, "fem-mesh-overlay.png"),
        observedPlanarMeta,
      );
      smokeEvidence.push(meshSwitch.evidence);
    }
    await capturePlanarFramePreview(
      page,
      initialMonitor,
    );
    smokeEvidence.push(
      await assertPlanarEvidence(
        page,
        expectedPlanarEvidence(initialMonitor),
        observedPlanarMeta,
      ),
    );

    const memoryBefore = await usedHeap(page);
    for (let index = 0; index < switchCount; index += 1) {
      const monitor = monitorById(monitors, required[index % required.length]);
      await selectMonitor(monitor.id, 128);
      await waitForCanvasPaint(page);
      smokeEvidence.push(
        await assertPlanarEvidence(
          page,
          expectedPlanarEvidence(monitor),
          observedPlanarMeta,
        ),
      );
    }
    const memoryAfter = await usedHeap(page);
    const memoryGrowthBytes =
      memoryBefore == null || memoryAfter == null
        ? null
        : memoryAfter - memoryBefore;
    if (
      memoryGrowthBytes != null &&
      memoryGrowthBytes > 96 * 1024 * 1024
    ) {
      throw new Error(
        `100-switch heap growth exceeded 96 MiB: ${memoryGrowthBytes}`,
      );
    }
    if (errors.length > 0) {
      throw new Error(`Browser errors:\n${errors.join("\n")}`);
    }
    const report = {
      backend,
      canvas: "2d",
      canvas_proof: initialCanvas,
      evidence: smokeEvidence,
      keyboard_shortcut: "2",
      memory_after_bytes: memoryAfter,
      memory_before_bytes: memoryBefore,
      memory_growth_bytes: memoryGrowthBytes,
      pass: smokeEvidence.every((evidence) => evidence.status === "ready"),
      performance: performanceMetrics,
      reduced_motion: true,
      planar_frame_preview_3d: true,
      schema_version: "viewport-2d-browser-smoke-v2",
      switch_count: switchCount,
    };
    await fs.writeFile(
      path.join(outputDir, "browser-report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(`Viewport 2D browser smoke passed: ${outputDir}`);
  } finally {
    await browser.close();
  }
}

async function capturePlanarFramePreview(page, monitor) {
  if (!monitor?.name) {
    throw new Error("Cannot verify 3D frame preview without a monitor name");
  }
  const monitorNode = page.getByText(monitor.name, { exact: true }).first();
  await monitorNode.scrollIntoViewIfNeeded();
  await monitorNode.click();
  const showFrame = page.getByRole("button", { name: "Show frame in 3D" });
  await showFrame.waitFor({ state: "visible", timeout: timeoutMs });
  await showFrame.click();
  const canvas = page.locator(".fm-viewport-3d canvas").first();
  await canvas.waitFor({ state: "visible", timeout: timeoutMs });
  await page.waitForFunction(
    () => {
      const element = document.querySelector(".fm-viewport-3d canvas");
      if (!(element instanceof HTMLCanvasElement)) return false;
      const context =
        element.getContext("webgl2") ?? element.getContext("webgl");
      return Boolean(
        context &&
          !context.isContextLost() &&
          context.drawingBufferWidth > 0 &&
          context.drawingBufferHeight > 0,
      );
    },
    undefined,
    { timeout: timeoutMs },
  );
  await page.screenshot({
    fullPage: true,
    path: path.join(outputDir, "planar-frame-preview-3d.png"),
  });
  await page.keyboard.press("2");
  await assertFieldMapCanvas(page);
}

async function timedMonitorSwitch(
  page,
  monitor,
  resolution,
  screenshot,
  observedPlanarMeta,
) {
  const started = performance.now();
  await selectMonitor(monitor.id, resolution);
  await waitForCanvasPaint(page);
  const evidence = await assertPlanarEvidence(
    page,
    expectedPlanarEvidence(monitor),
    observedPlanarMeta,
  );
  const duration = performance.now() - started;
  if (duration > 10_000) {
    throw new Error(
      `${monitor.id} ${resolution}x${resolution} switch exceeded 10 s: ${duration}`,
    );
  }
  if (screenshot) await page.screenshot({ fullPage: true, path: screenshot });
  return { duration, evidence };
}

async function assertFieldMapCanvas(page) {
  await page.locator(".fm-field-map__canvas").first().waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await waitForCanvasPaint(page);
  const proof = await page.locator(".fm-field-map__canvas").first().evaluate(
    (canvas) => {
      const context = canvas.getContext("2d");
      if (!context) return { height: 0, nonTransparent: false, width: 0 };
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let nonTransparent = false;
      for (let index = 3; index < data.length; index += 4) {
        if (data[index] !== 0) {
          nonTransparent = true;
          break;
        }
      }
      return {
        height: canvas.height,
        nonTransparent,
        width: canvas.width,
      };
    },
  );
  if (proof.width <= 0 || proof.height <= 0 || !proof.nonTransparent) {
    throw new Error(`2D canvas is blank: ${JSON.stringify(proof)}`);
  }
  return proof;
}

function monitorById(monitors, monitorId) {
  const monitor = monitors.monitors.find((candidate) => candidate.id === monitorId);
  if (!monitor) throw new Error(`Missing planar monitor ${monitorId}`);
  return monitor;
}

function expectedPlanarEvidence(monitor) {
  if (typeof monitor.operator?.kind !== "string") {
    throw new Error(`Planar monitor ${monitor.id} has no operator kind`);
  }
  return {
    component: "magnitude",
    monitorId: monitor.id,
    operatorKind: monitor.operator.kind,
    quantityId: "m",
  };
}

async function assertPlanarEvidence(page, expected, observedPlanarMeta) {
  const evidence = await page.waitForFunction(
    (request) => {
      const raw = document
        .querySelector("[aria-label='Planar field evidence']")
        ?.getAttribute("data-planar-evidence");
      if (!raw) return null;
      try {
        const evidence = JSON.parse(raw);
        if (evidence.status === "error") return evidence;
        return evidence.status === "ready" &&
          evidence.monitorId === request.monitorId &&
          evidence.operatorKind === request.operatorKind &&
          evidence.quantityId === request.quantityId &&
          evidence.component === request.component
          ? evidence
          : null;
      } catch {
        return null;
      }
    },
    expected,
    { timeout: timeoutMs },
  );
  const value = await evidence.jsonValue();
  if (value.status !== "ready") {
    throw new Error(`Planar evidence entered ${value.status}: ${JSON.stringify(value)}`);
  }
  if (!value.raster?.checksum || !Number.isFinite(value.raster.min) || !Number.isFinite(value.raster.max)) {
    throw new Error(`Planar evidence has no raster proof: ${JSON.stringify(value)}`);
  }
  if (value.raster.min > value.raster.max) {
    throw new Error(`Planar evidence has an inverted raster range: ${JSON.stringify(value)}`);
  }
  if (!Number.isInteger(value.glyphCount) || value.glyphCount < 0) {
    throw new Error(`Planar evidence has an invalid glyph count: ${JSON.stringify(value)}`);
  }
  for (const [name, count] of Object.entries(value.overlayCounts ?? {})) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`Planar evidence has invalid ${name}: ${JSON.stringify(value)}`);
    }
  }
  const matchingMeta = await waitForObservedPlanarMeta(observedPlanarMeta, value, expected);
  if (matchingMeta.field_revision !== value.fieldRevision) {
    throw new Error(`Planar field revision mismatch: ${JSON.stringify({ evidence: value, meta: matchingMeta })}`);
  }
  if (matchingMeta.etag !== value.sampleIdentity) {
    throw new Error(`Planar sample identity mismatch: ${JSON.stringify({ evidence: value, meta: matchingMeta })}`);
  }
  return value;
}

async function waitForObservedPlanarMeta(observedPlanarMeta, evidence, expected) {
  const deadline = Date.now() + Math.min(timeoutMs, 10_000);
  while (Date.now() < deadline) {
    const match = [...observedPlanarMeta].reverse().find(
      (entry) =>
        entry.monitorId === expected.monitorId &&
        entry.quantityId === expected.quantityId &&
        entry.payload?.etag === evidence.sampleIdentity,
    );
    if (match) return match.payload;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No browser-consumed planar meta matched ${JSON.stringify({ evidence, expected })}`);
}

async function waitForCanvasPaint(page) {
  try {
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector(".fm-field-map__canvas");
        if (!(canvas instanceof HTMLCanvasElement)) return false;
        const context = canvas.getContext("2d");
        if (!context || canvas.width <= 0 || canvas.height <= 0) return false;
        const pixels = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        ).data;
        for (let index = 3; index < pixels.length; index += 4) {
          if (pixels[index] !== 0) return true;
        }
        return false;
      },
      undefined,
      { timeout: timeoutMs },
    );
  } catch (error) {
    const diagnostic = await page.evaluate(() => {
      const canvas = document.querySelector(".fm-field-map__canvas");
      const activeModule = document
        .querySelector("[data-slot-id='viewport-main']")
        ?.getAttribute("data-active-module-id");
      if (!(canvas instanceof HTMLCanvasElement)) {
        return {
          activeModule,
          canvas: null,
          status: document.querySelector(".fm-field-map")?.textContent,
        };
      }
      const context = canvas.getContext("2d");
      const center =
        context && canvas.width > 0 && canvas.height > 0
          ? Array.from(
              context.getImageData(
                Math.floor(canvas.width / 2),
                Math.floor(canvas.height / 2),
                1,
                1,
              ).data,
            )
          : null;
      const rect = canvas.getBoundingClientRect();
      return {
        activeModule,
        canvas: {
          center,
          cssHeight: rect.height,
          cssWidth: rect.width,
          height: canvas.height,
          width: canvas.width,
        },
        status: document.querySelector(".fm-field-map")?.textContent,
      };
    });
    throw new Error(
      `2D canvas paint timed out: ${JSON.stringify(diagnostic)}`,
      { cause: error },
    );
  }
}

async function selectMonitor(monitorId, resolution) {
  await patchJson("/v2/sessions/current/visualization/state", {
    planar: {
      active_monitor_id: monitorId,
      component: "magnitude",
      layers: {
        boundaries: true,
        contours: true,
        mesh: true,
        probes: true,
        raster: true,
        vectors: true,
      },
      quality: "interactive",
      quantity_id: "m",
      resolution: {
        height: resolution,
        vector_budget: 256,
        width: resolution,
      },
    },
  });
}

async function waitForMonitors() {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const resource = await getJson(
        "/v2/sessions/current/model/planar-monitors",
      );
      if (resource.monitors?.length) return resource;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Planar monitors did not become ready: ${lastError}`);
}

async function getJson(resourcePath) {
  const response = await fetch(apiBase + resourcePath);
  if (!response.ok) {
    throw new Error(`${resourcePath} failed with HTTP ${response.status}`);
  }
  return response.json();
}

async function patchJson(resourcePath, body) {
  const response = await fetch(apiBase + resourcePath, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  if (!response.ok) {
    throw new Error(
      `${resourcePath} failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return response.json();
}

async function usedHeap(page) {
  return page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
}

async function loadPlaywright() {
  for (const packageName of ["playwright", "@playwright/test"]) {
    try {
      return await import(packageName);
    } catch {}
  }
  return null;
}

await main();
