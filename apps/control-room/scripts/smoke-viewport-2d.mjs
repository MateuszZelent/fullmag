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
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((baseUrl) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: baseUrl,
    };
  }, apiBase);

  try {
    await selectMonitor(required[0], 128);
    await page.goto(workspaceUrl, {
      timeout: timeoutMs,
      waitUntil: "domcontentloaded",
    });
    await page.keyboard.press("2");
    await assertFieldMapCanvas(page);
    await page.screenshot({
      fullPage: true,
      path: path.join(outputDir, "scalar-plane.png"),
    });

    const performance = {};
    performance.small_switch_ms = await timedMonitorSwitch(
      page,
      "xy-slab",
      128,
      path.join(outputDir, "slab-vectors.png"),
    );
    performance.large_switch_ms = await timedMonitorSwitch(
      page,
      required[0],
      1024,
    );
    if (backend === "fem") {
      performance.surface_switch_ms = await timedMonitorSwitch(
        page,
        "object-surface",
        256,
        path.join(outputDir, "surface-projection.png"),
      );
      await timedMonitorSwitch(
        page,
        "xy-plane",
        256,
        path.join(outputDir, "fem-mesh-overlay.png"),
      );
    }
    await capturePlanarFramePreview(
      page,
      monitors.monitors.find((monitor) => monitor.id === required[0]),
    );

    const memoryBefore = await usedHeap(page);
    for (let index = 0; index < switchCount; index += 1) {
      await selectMonitor(required[index % required.length], 128);
      await waitForCanvasPaint(page);
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
      keyboard_shortcut: "2",
      memory_after_bytes: memoryAfter,
      memory_before_bytes: memoryBefore,
      memory_growth_bytes: memoryGrowthBytes,
      pass: true,
      performance,
      reduced_motion: true,
      planar_frame_preview_3d: true,
      schema_version: "viewport-2d-browser-smoke-v1",
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

async function timedMonitorSwitch(page, monitorId, resolution, screenshot) {
  const started = performance.now();
  await selectMonitor(monitorId, resolution);
  await waitForCanvasPaint(page);
  const duration = performance.now() - started;
  if (duration > 10_000) {
    throw new Error(
      `${monitorId} ${resolution}x${resolution} switch exceeded 10 s: ${duration}`,
    );
  }
  if (screenshot) await page.screenshot({ fullPage: true, path: screenshot });
  return duration;
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
}

async function waitForCanvasPaint(page) {
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector(".fm-field-map__canvas");
      if (!(canvas instanceof HTMLCanvasElement)) return false;
      const context = canvas.getContext("2d");
      if (!context || canvas.width <= 0 || canvas.height <= 0) return false;
      const pixel = context.getImageData(
        Math.floor(canvas.width / 2),
        Math.floor(canvas.height / 2),
        1,
        1,
      ).data;
      return pixel[3] !== 0;
    },
    undefined,
    { timeout: timeoutMs },
  );
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
