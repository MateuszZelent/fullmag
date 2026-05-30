import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { inflateSync } from "node:zlib";

const url = process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const WORKFLOW_TIMEOUT_MS = 20_000;
const VISUALIZATION_STATE_PATH = "/v2/sessions/current/visualization/state";
const CROSS_SECTION_PATH =
  "/v2/sessions/current/meshing/meshes/shared-domain/cross-section";
const CROSS_SECTION_IMAGE_PATH =
  "/v2/sessions/current/meshing/meshes/shared-domain/cross-section/image";
const CROSS_SECTION_QUALITY_PATH =
  "/v2/sessions/current/meshing/meshes/shared-domain/cross-section/quality";

let visualizationState = visualizationStateFixture();
const fixtureRequests = [];
const errors = [];

const fixtureServer = await startFixtureServer();
const browser = await startChromium();
const cdp = await connectCdp(browser.wsUrl);
let sessionId = null;

try {
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", {
    flatten: true,
    targetId: target.targetId,
  });
  sessionId = attached.sessionId;

  cdp.on("Runtime.exceptionThrown", (event) => {
    errors.push(event.exceptionDetails?.text ?? "Runtime exception");
  });
  cdp.on("Log.entryAdded", (event) => {
    if (event.entry?.level === "error") {
      const text = event.entry.text ?? "";
      if (!isIgnorableConsoleError(text)) errors.push(text);
    }
  });

  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Log.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `window.__FULLMAG_CONFIG__ = { ...(window.__FULLMAG_CONFIG__ || {}), allowMissingSessionSmoke: true, controlRoomApiBase: ${JSON.stringify(fixtureServer.baseUrl)} };`,
    },
    sessionId,
  );
  await cdp.send("Page.navigate", { url }, sessionId);
  await waitForEvaluate(
    "() => document.readyState === 'interactive' || document.readyState === 'complete'",
  );

  await waitForWebGLCanvasReady(".fm-viewport-3d canvas", "3D viewport");
  const baseline3d = await sampleCanvasComposite(".fm-viewport-3d canvas", ".fm-viewport-3d");

  await clickTabByText("View");
  await clickSelector('[data-action-id="ribbon.cross-section.begin-draft"]');

  await waitForVisible('[data-node-id="model:visualizations-2d"]');
  await waitForVisible('[data-node-id="model:visualizations-2d:draft"]');
  await waitForText(".fm-inspector", "Cut Frame");
  await waitForCondition("clip state enabled", () => {
    if (
      visualizationState.clip.enabled &&
      visualizationState.clip.axis === "z" &&
      visualizationState.clip.position_percent === 50
    ) {
      return true;
    }
    throw new Error(`clip=${JSON.stringify(visualizationState.clip)}`);
  });
  await waitForCanvasCompositeChange(
    ".fm-viewport-3d canvas",
    ".fm-viewport-3d",
    baseline3d,
    "3D cut-frame overlay renders after 2D Cross",
  );

  await fillInputByAriaLabel("Name", "Smoke 2D Cross");
  await fillInputByAriaLabel("Position", "62.5");
  await fillInputByAriaLabel("Rotation", "17");
  await clickButtonByText("Generate Image");

  await waitForVisible('[data-node-id="model:visualizations-2d:plot-1"]');
  for (const suffix of ["frame", "plane", "quality", "render"]) {
    await waitForVisible(`[data-node-id="model:visualizations-2d:plot-1:${suffix}"]`);
  }
  await waitForText(
    '[data-node-id="model:visualizations-2d:plot-1:frame"]',
    "Universe / 17 deg",
  );
  await waitForText(
    '[data-node-id="model:visualizations-2d:plot-1:plane"]',
    "XY 62.5%",
  );

  await waitForVisible(".fm-cross-section-image__img");
  await waitForText(".fm-cross-section-image", "Smoke 2D Cross");
  const imageState = await evaluate(`(() => {
    const image = document.querySelector(".fm-cross-section-image__img");
    return image ? {
      complete: image.complete,
      naturalHeight: image.naturalHeight,
      naturalWidth: image.naturalWidth
    } : null;
  })()`);
  if (!imageState?.complete || imageState.naturalWidth <= 0 || imageState.naturalHeight <= 0) {
    throw new Error(`Cross-section PNG did not load: ${JSON.stringify(imageState)}`);
  }
  await assertNoViewport3DCanvas("Cross-section image tab");

  const imageRequest = fixtureRequests.find(
    (request) => request.path === CROSS_SECTION_IMAGE_PATH,
  );
  if (!imageRequest) {
    throw new Error("Cross-section image module did not request the PNG resource.");
  }
  const imageParams = new URLSearchParams(imageRequest.search);
  if (imageParams.get("rotation_degrees") !== "17") {
    throw new Error(
      `Cross-section PNG request did not include rotation_degrees=17: ${imageRequest.search}`,
    );
  }

  const non3dRequestStart = fixtureRequests.length;
  await clickTabByText("Analysis");
  await waitForText(".fm-analysis-plots", "No scalar samples");
  await assertNoViewport3DCanvas("Analysis tab");
  assertNo3DResourceRequestsSince(non3dRequestStart, "Analysis tab");

  await clickTabByText("3D Viewport");
  await waitForWebGLCanvasReady(".fm-viewport-3d canvas", "3D viewport after tab restore");

  const requestedPaths = new Set(fixtureRequests.map((request) => request.path));
  if (!requestedPaths.has(CROSS_SECTION_IMAGE_PATH)) {
    throw new Error("Cross-section image module did not request the PNG resource.");
  }
  if (errors.length > 0) {
    throw new Error(`Browser console/runtime errors:\n${errors.join("\n")}`);
  }

  console.log(
    [
      "Cross-section workflow smoke passed:",
      "driver=cdp",
      "ribbon=2D Cross",
      "3d=cut-frame",
      "explorer=draft+plot-1+parameters",
      "inspector=commit",
      "cross-section-image=png",
      "analysis=no-3d",
      `requests=${fixtureRequests.length}`,
    ].join(" "),
  );
} finally {
  await cdp.close().catch(() => undefined);
  await stopChromium(browser.process);
  await fixtureServer.close();
  rmSync(browser.userDataDir, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 100,
  });
}

async function startFixtureServer() {
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = requestUrl.pathname;
    fixtureRequests.push({
      method: request.method ?? "GET",
      path,
      search: requestUrl.search,
    });

    if (request.method === "OPTIONS") {
      writeEmpty(response, 204);
      return;
    }

    if (path === "/v2/sessions/current/status") {
      writeJson(response, statusFixture());
      return;
    }
    if (path === VISUALIZATION_STATE_PATH) {
      if (request.method === "PATCH") {
        visualizationState = applyVisualizationPatch(
          visualizationState,
          await readJsonBody(request),
        );
      }
      writeJson(response, visualizationState);
      return;
    }
    if (path === "/v2/sessions/current/data/domain/meta") {
      writeJson(response, femDomainMetaFixture());
      return;
    }
    if (path === "/v2/sessions/current/data/domain/topology") {
      writeBinary(response, makeTopologyBuffer(), '"topology-fixture"');
      return;
    }
    if (path === "/v2/sessions/current/model/scene") {
      writeJson(response, { objects: [], revision: 0, schema_version: 1 });
      return;
    }
    if (path === "/v2/sessions/current/model/universe") {
      writeJson(response, universeFixture());
      return;
    }
    if (path === "/v2/sessions/current/meshing/meshes/shared-domain/manifest") {
      writeJson(response, sharedDomainManifestFixture());
      return;
    }
    if (path === CROSS_SECTION_IMAGE_PATH) {
      writeBinary(
        response,
        makeCrossSectionPngBuffer(),
        '"cross-section-image-fixture"',
        200,
        "image/png",
      );
      return;
    }
    if (path === CROSS_SECTION_PATH) {
      writeBinary(response, makeCrossSectionBuffer(), '"cross-section-fixture"');
      return;
    }
    if (path === CROSS_SECTION_QUALITY_PATH) {
      writeBinary(
        response,
        makeCrossSectionQualityBuffer(),
        '"cross-section-quality-fixture"',
      );
      return;
    }

    writeEmpty(response, 204);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture server did not bind to a TCP port.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function writeJson(response, body, status = 200) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    ...fixtureHeaders({
      "content-length": String(payload.byteLength),
      "content-type": "application/json",
    }),
  });
  response.end(payload);
}

function writeBinary(
  response,
  arrayBuffer,
  etag,
  status = 200,
  contentType = "application/octet-stream",
) {
  const payload = Buffer.from(arrayBuffer);
  response.writeHead(status, {
    ...fixtureHeaders({
      "content-length": String(payload.byteLength),
      "content-type": contentType,
      etag,
    }),
  });
  response.end(payload);
}

function writeEmpty(response, status = 204) {
  response.writeHead(status, fixtureHeaders());
  response.end();
}

function fixtureHeaders(extra = {}) {
  return {
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "x-api-contract-version,etag,x-request-id",
    "x-api-contract-version": "1.0.0",
    ...extra,
  };
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function startChromium() {
  const executable = findChromiumExecutable();
  const userDataDir = mkdtempSync(join(tmpdir(), "fullmag-cross-section-smoke-"));
  const args = [
    "--headless=new",
    "--disable-dev-shm-usage",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--no-sandbox",
    "--remote-debugging-port=0",
    "--use-angle=swiftshader-webgl",
    "--use-gl=angle",
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ];
  const child = spawn(executable, args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const wsUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for Chromium DevTools endpoint."));
    }, WORKFLOW_TIMEOUT_MS);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Chromium exited before DevTools was ready: code=${code} signal=${signal}`));
    });
    child.stderr.on("data", (chunk) => {
      const match = String(chunk).match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
  });
  return { process: child, userDataDir, wsUrl };
}

async function stopChromium(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve(undefined);
    });
    child.kill("SIGTERM");
  });
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

function findChromiumExecutable() {
  const explicit =
    process.env.CHROME_BIN ??
    process.env.CHROMIUM_BIN ??
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit) return explicit;

  const candidates = [
    "/home/kkingstoun/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
    "/home/kkingstoun/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  return candidates.find((candidate) => {
    try {
      return Boolean(candidate && requireFsAccess(candidate));
    } catch {
      return false;
    }
  }) ?? candidates[0];
}

function requireFsAccess(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("CDP WebSocket timed out.")), 5_000);
    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve(undefined);
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("CDP WebSocket failed to connect."));
    }, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (message) => {
    const payload = JSON.parse(String(message.data));
    if (payload.id && pending.has(payload.id)) {
      const entry = pending.get(payload.id);
      pending.delete(payload.id);
      if (payload.error) {
        entry.reject(new Error(payload.error.message ?? JSON.stringify(payload.error)));
      } else {
        entry.resolve(payload.result ?? {});
      }
      return;
    }
    const handlers = listeners.get(payload.method);
    if (!handlers) return;
    for (const handler of handlers) handler(payload.params ?? {});
  });

  return {
    close: () => new Promise((resolve) => {
      ws.addEventListener("close", resolve, { once: true });
      ws.close();
    }),
    on: (method, handler) => {
      const handlers = listeners.get(method) ?? [];
      handlers.push(handler);
      listeners.set(method, handlers);
    },
    send: (method, params = {}, session = null) => {
      const id = nextId++;
      const message = session
        ? { id, method, params, sessionId: session }
        : { id, method, params };
      ws.send(JSON.stringify(message));
      return new Promise((resolve, reject) => {
        pending.set(id, { reject, resolve });
      });
    },
  };
}

async function evaluate(expression) {
  const source = expression.trim();
  const wrappedExpression =
    source.startsWith("() =>") || source.startsWith("async () =>")
      ? `(${source})()`
      : expression;
  const result = await cdp.send(
    "Runtime.evaluate",
    {
      awaitPromise: true,
      expression: wrappedExpression,
      returnByValue: true,
    },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "Runtime.evaluate failed");
  }
  return result.result?.value;
}

async function waitForEvaluate(functionSource) {
  await waitForCondition(`evaluate ${functionSource}`, async () =>
    evaluate(`(${functionSource})()`),
  );
}

async function waitForVisible(selector) {
  await waitForEvaluate(
    `() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }`,
  );
}

async function waitForText(selector, text) {
  await waitForEvaluate(
    `() => (document.querySelector(${JSON.stringify(selector)})?.textContent || "").includes(${JSON.stringify(text)})`,
  );
}

async function clickSelector(selector) {
  await waitForVisible(selector);
  await evaluate(
    `() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      node.scrollIntoView({ block: "center", inline: "center" });
      node.click();
      return true;
    }`,
  );
}

async function clickTabByText(text) {
  await waitForEvaluate(
    `() => Array.from(document.querySelectorAll('[role="tab"]')).some((node) => (node.textContent || "").trim() === ${JSON.stringify(text)})`,
  );
  await evaluate(
    `() => {
      const node = Array.from(document.querySelectorAll('[role="tab"]')).find((entry) => (entry.textContent || "").trim() === ${JSON.stringify(text)});
      node.click();
      return true;
    }`,
  );
}

async function clickButtonByText(text) {
  await waitForEvaluate(
    `() => Array.from(document.querySelectorAll('button')).some((node) => (node.textContent || "").includes(${JSON.stringify(text)}))`,
  );
  await evaluate(
    `() => {
      const node = Array.from(document.querySelectorAll('button')).find((entry) => (entry.textContent || "").includes(${JSON.stringify(text)}));
      node.click();
      return true;
    }`,
  );
}

async function fillInputByAriaLabel(label, value) {
  await waitForVisible(`.fm-cross-section-inspector input[aria-label="${cssAttributeValue(label)}"]`);
  await evaluate(
    `() => {
      const node = document.querySelector('.fm-cross-section-inspector input[aria-label="${cssAttributeValue(label)}"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(node, ${JSON.stringify(value)});
      else node.value = ${JSON.stringify(value)};
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      node.blur();
      return true;
    }`,
  );
}

async function waitForWebGLCanvasReady(selector, label) {
  await waitForEvaluate(
    `() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const gl = node.getContext("webgl2") || node.getContext("webgl");
      return rect.width > 0 && rect.height > 0 && gl && !gl.isContextLost() && gl.drawingBufferWidth > 0 && gl.drawingBufferHeight > 0;
    }`,
  ).catch((error) => {
    return evaluate(
      `() => ({
        bodyText: document.body?.innerText?.slice(0, 1000) || "",
        canvasCount: document.querySelectorAll("canvas").length,
        canvases: Array.from(document.querySelectorAll("canvas")).map((node) => {
          const rect = node.getBoundingClientRect();
          const gl2 = node.getContext("webgl2");
          const gl1 = gl2 ? null : node.getContext("webgl");
          const gl = gl2 || gl1;
          return {
            className: node.className,
            contextLost: gl?.isContextLost?.() ?? null,
            drawingBufferHeight: gl?.drawingBufferHeight ?? null,
            drawingBufferWidth: gl?.drawingBufferWidth ?? null,
            height: node.height,
            rectHeight: rect.height,
            rectWidth: rect.width,
            webgl: Boolean(gl1),
            webgl2: Boolean(gl2),
            width: node.width
          };
        }),
        hasCrossSectionImage: Boolean(document.querySelector(".fm-cross-section-image")),
        hasViewport3d: Boolean(document.querySelector(".fm-viewport-3d")),
        location: window.location.href,
        title: document.title
      })`,
    ).then((diagnostic) => {
      throw new Error(
        `${label} WebGL canvas was not ready: ${error.message}; diagnostic=${JSON.stringify(diagnostic)}`,
      );
    });
  });
}

async function sampleCanvasComposite(canvasSelector, viewportSelector) {
  const box = await evaluate(
    `() => {
      const rect = document.querySelector(${JSON.stringify(canvasSelector)}).getBoundingClientRect();
      return { height: rect.height, width: rect.width, x: rect.x, y: rect.y };
    }`,
  );
  const background = await evaluate(
    `() => getComputedStyle(document.querySelector(${JSON.stringify(viewportSelector)})).backgroundColor`,
  );
  const screenshot = await cdp.send(
    "Page.captureScreenshot",
    {
      clip: {
        height: Math.max(1, Math.floor(box.height)),
        scale: 1,
        width: Math.max(1, Math.floor(box.width)),
        x: Math.max(0, Math.floor(box.x)),
        y: Math.max(0, Math.floor(box.y)),
      },
      format: "png",
    },
    sessionId,
  );
  const bitmap = parsePng(Buffer.from(screenshot.data, "base64"));
  const backgroundRgb = parseCssRgb(background);
  const stride = Math.max(1, Math.floor(Math.min(bitmap.width, bitmap.height) / 64));
  const signature = [];
  let sampledPixels = 0;
  let variedPixels = 0;

  for (let y = 0; y < bitmap.height; y += stride) {
    for (let x = 0; x < bitmap.width; x += stride) {
      sampledPixels += 1;
      const offset = (y * bitmap.width + x) * 4;
      const rgb = [
        bitmap.rgba[offset],
        bitmap.rgba[offset + 1],
        bitmap.rgba[offset + 2],
      ];
      signature.push(...rgb);
      if (pixelDiffers(rgb, backgroundRgb)) variedPixels += 1;
    }
  }

  return {
    nonBlank: variedPixels > 0,
    sampledPixels,
    signature,
    variedPixels,
  };
}

async function waitForCanvasCompositeChange(
  canvasSelector,
  viewportSelector,
  baseline,
  label,
) {
  const deadline = Date.now() + WORKFLOW_TIMEOUT_MS;
  let lastDelta = null;
  while (Date.now() <= deadline) {
    const current = await sampleCanvasComposite(canvasSelector, viewportSelector);
    const delta = canvasCompositeDifference(baseline, current);
    if (current.nonBlank && delta.changed) return current;
    lastDelta = delta;
    await delay(100);
  }
  const suffix = lastDelta
    ? `${lastDelta.changedPixels}/${lastDelta.sampledPixels} sampled pixels changed; threshold=${lastDelta.minimumChangedPixels}`
    : "no canvas sample was collected";
  throw new Error(`${label} timed out: ${suffix}.`);
}

async function assertNoViewport3DCanvas(label) {
  const state = await evaluate(
    `() => ({
      canvasCount: document.querySelectorAll(".fm-viewport-3d canvas").length,
      viewportCount: document.querySelectorAll(".fm-viewport-3d").length
    })`,
  );
  if (state.viewportCount > 0 || state.canvasCount > 0) {
    throw new Error(
      `${label} still has a 3D viewport mounted: ${JSON.stringify(state)}`,
    );
  }
}

function assertNo3DResourceRequestsSince(startIndex, label) {
  const unexpected = fixtureRequests
    .slice(startIndex)
    .filter((request) => is3DOnlyResourcePath(request.path));
  if (unexpected.length > 0) {
    throw new Error(
      `${label} triggered 3D-only resources: ${unexpected.map(formatRequest).join(", ")}`,
    );
  }
}

function is3DOnlyResourcePath(path) {
  return (
    path === "/v2/sessions/current/data/domain/meta" ||
    path === "/v2/sessions/current/data/domain/topology" ||
    path === "/v2/sessions/current/model/scene" ||
    path === "/v2/sessions/current/model/universe" ||
    path === "/v2/sessions/current/meshing/meshes/shared-domain/manifest" ||
    path.startsWith("/v2/sessions/current/data/fields")
  );
}

function formatRequest(request) {
  return `${request.method} ${request.path}${request.search ?? ""}`;
}

async function waitForCondition(label, predicate) {
  const deadline = Date.now() + WORKFLOW_TIMEOUT_MS;
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
  throw new Error(`${label} timed out after ${WORKFLOW_TIMEOUT_MS}ms.${suffix}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applyVisualizationPatch(state, patch) {
  const next = { ...state, revision: state.revision + 1 };
  if (patch.clip && typeof patch.clip === "object") {
    next.clip = { ...state.clip, ...withoutUndefined(patch.clip) };
  }
  if (patch.slice && typeof patch.slice === "object") {
    next.slice = { ...state.slice, ...withoutUndefined(patch.slice) };
  }
  if (patch.quantity && typeof patch.quantity === "object") {
    next.quantity = { ...state.quantity, ...withoutUndefined(patch.quantity) };
  }
  return next;
}

function withoutUndefined(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

function statusFixture() {
  return {
    api_contract_version: "1.0.0",
    capabilities: {
      algorithms_available: [],
      binary_fields: true,
      cell_fields: false,
      eigen_modes: false,
      explicit_topology: true,
      gpu_telemetry: false,
      node_fields: true,
      preview_2d: true,
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
      vector_density: 0,
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
      field_catalog_revision: 0,
      field_revision: 0,
      fields_revision: 0,
      mesh_build_revision: 1,
      mesh_revision: 1,
      scalars_revision: 0,
      scene_revision: 0,
      slice_revision: 1,
      stages_revision: 0,
      topology_revision: 1,
      visualization_state_revision: visualizationState.revision,
      workspace_revision: 0,
    },
    run: null,
    runtime_bundle_version: "cross-section-smoke-fixture",
    session: {
      created_at: "0",
      name: "cross-section-smoke-fixture",
      session_id: "cross-section-fixture",
      workspace_root: "/tmp/fullmag-cross-section-fixture",
    },
    solver: { state: "idle" },
  };
}

function femDomainMetaFixture() {
  return {
    bounds: { max: [1.0e-6, 8.0e-7, 3.0e-7], min: [-1.0e-6, -8.0e-7, -3.0e-7] },
    coordinate_system: "cartesian",
    counts: { cells: 1 },
    dimension: 3,
    discretization: "fem",
    domain_id: "cross-section-fem-domain",
    generation_id: 1,
    grid: null,
    units: { length: "m" },
  };
}

function universeFixture() {
  return {
    mesh_dirty: false,
    object_bounds_max: [1.0e-6, 8.0e-7, 3.0e-7],
    object_bounds_min: [-1.0e-6, -8.0e-7, -3.0e-7],
    scene_revision: 0,
    study_universe_mesh: null,
    universe: {
      bounds_max: [1.0e-6, 8.0e-7, 3.0e-7],
      bounds_min: [-1.0e-6, -8.0e-7, -3.0e-7],
    },
  };
}

function sharedDomainManifestFixture() {
  return {
    domain_mesh_mode: "shared_domain",
    generation_id: "cross-section-fixture",
    mesh_id: "shared-domain",
    mesh_name: "Shared-domain FEM mesh",
    mesh_parts: [
      {
        boundary_face_count: 4,
        boundary_face_indices: [0, 1, 2, 3],
        boundary_face_start: 0,
        bounds_max: [1.0e-6, 8.0e-7, 3.0e-7],
        bounds_min: [-1.0e-6, -8.0e-7, -3.0e-7],
        element_count: 1,
        element_start: 0,
        geometry_id: "body_geom",
        id: "part-body",
        label: "Body",
        material_id: "material-1",
        node_count: 4,
        node_indices: [0, 1, 2, 3],
        node_start: 0,
        object_id: "body",
        role: "magnetic",
        surface_faces: [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]],
      },
    ],
    object_segments: [],
    regions: [],
    revision: 1,
    source_scene_revision: 0,
  };
}

function visualizationStateFixture() {
  return {
    active_quantity_id: "m",
    auto_contrast: true,
    camera: {
      position: [1.8e-6, 1.4e-6, 1.1e-6],
      projection: "perspective",
      target: [0, 0, 0],
      up: [0, 0, 1],
    },
    clip: { axis: "z", enabled: false, flipped: false, position_percent: 50 },
    colormap: "viridis",
    contrast_max: null,
    contrast_min: null,
    diagnostics: { warnings: [] },
    domains: { active_scope: "domain", object_id: null, part_id: null },
    fdm: { x_chosen_size: 1, y_chosen_size: 1 },
    fem: { topology_mode: "surface", volume_edges_budget: 0 },
    field_component: "magnitude",
    layers: {
      airbox: {
        bounds: { opacity: 1, visible: false },
        opacity: 0.18,
        points: { opacity: 1, visible: false },
        surface: { opacity: 0.18, visible: false },
        vectors: { density: 0, domain: "full_domain", visible: false },
        visible: false,
        wireframe: { opacity: 1, visible: false },
      },
      bounds: { opacity: 1, visible: true },
      points: { opacity: 1, visible: false },
      primitives: { opacity: 1, visible: true },
      quantity_overlay: { opacity: 1, visible: false },
      surface: { opacity: 0.92, visible: true },
      vectors: { density: 0, domain: "full_domain", visible: false },
      volume_mesh: { opacity: 1, visible: false },
      wireframe: { opacity: 1, visible: true },
    },
    max_points: 120000,
    overrides: [],
    quantity: {
      active_quantity_id: "m",
      auto_contrast: true,
      colormap: "viridis",
      contrast_max: null,
      contrast_min: null,
      field_component: "magnitude",
    },
    revision: 1,
    sampling: {
      max_bytes: null,
      max_glyphs: 0,
      max_points: 120000,
      profile: "interactive",
      progressive: true,
    },
    schema_version: 1,
    slice: {
      airbox_render_mode: "zero",
      auto_contrast: true,
      axis: "z",
      colormap: "viridis",
      component: "magnitude",
      layer_index: 0,
      mesh_color_scale: "jet",
      mesh_filter_expression: "",
      mesh_quality_metric: "skewness",
      mesh_shrink_factor: 1,
      mode: "plane",
      position_percent: 50,
      projection_include_air_as_zero: false,
      projection_reduction: "mean",
      projection_resolution: 256,
      projection_samples: 32,
      quantity_id: "m",
      render_mode: "mesh_quality",
      show_airbox: false,
      show_airbox_vectors: false,
      show_magnetic_texture: false,
      show_mesh: true,
      show_primitives: true,
      show_quantity: false,
      show_vectors: false,
    },
    slice_layer: 0,
    slice_mode: "xy",
    targets: {
      airbox: { id: "airbox", label: "Airbox", parts: [], source: "airbox" },
      objects: [],
      parts: [],
    },
    trim: {
      axes: {
        x: { max: 1, min: 0 },
        y: { max: 1, min: 0 },
        z: { max: 1, min: 0 },
      },
      enabled: false,
    },
    vector_density: 0,
    vector_glyphs: false,
    vector_style: {
      alpha: 1,
      color_mode: "orientation",
      ferromagnet_visibility: "ghost",
      length_scale: 1,
      mono_color: "#89b4fa",
      thickness: 1.4,
    },
    view_mode: "3d",
    x_chosen_size: 1,
    y_chosen_size: 1,
  };
}

function makeTopologyBuffer() {
  const nodeCount = 4;
  const elementCount = 1;
  const boundaryFaceCount = 4;
  const markerCount = 1;
  const byteLength =
    32 +
    nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT +
    elementCount * 4 * Uint32Array.BYTES_PER_ELEMENT +
    boundaryFaceCount * 3 * Uint32Array.BYTES_PER_ELEMENT +
    markerCount * Uint32Array.BYTES_PER_ELEMENT +
    boundaryFaceCount * Uint32Array.BYTES_PER_ELEMENT;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMMT"].entries()) view.setUint8(index, code.charCodeAt(0));
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint32(8, nodeCount, true);
  view.setUint32(12, elementCount, true);
  view.setUint32(16, boundaryFaceCount, true);
  view.setUint32(20, markerCount, true);
  view.setUint32(24, boundaryFaceCount, true);
  let offset = 32;
  new Float64Array(buffer, offset, nodeCount * 3).set([
    -1.0e-6, -8.0e-7, -3.0e-7,
    1.0e-6, -8.0e-7, -3.0e-7,
    -1.0e-6, 8.0e-7, -3.0e-7,
    0, 0, 3.0e-7,
  ]);
  offset += nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, 4).set([0, 1, 2, 3]);
  offset += 4 * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, boundaryFaceCount * 3).set([
    0, 1, 2,
    0, 1, 3,
    0, 2, 3,
    1, 2, 3,
  ]);
  offset += boundaryFaceCount * 3 * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, 1).set([1]);
  offset += Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, boundaryFaceCount).set([1, 1, 1, 1]);
  return buffer;
}

function makeCrossSectionBuffer() {
  const polygonCount = 1;
  const vertexCount = 4;
  const segmentCount = 4;
  const byteLength =
    64 +
    vertexCount * 2 * Float32Array.BYTES_PER_ELEMENT +
    (polygonCount + 1) * Uint32Array.BYTES_PER_ELEMENT +
    polygonCount * Uint32Array.BYTES_PER_ELEMENT +
    segmentCount * 4 * Float32Array.BYTES_PER_ELEMENT +
    vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT +
    vertexCount * 2 * Uint32Array.BYTES_PER_ELEMENT +
    vertexCount * Float32Array.BYTES_PER_ELEMENT +
    vertexCount * Uint32Array.BYTES_PER_ELEMENT;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMCS"].entries()) view.setUint8(index, code.charCodeAt(0));
  view.setUint32(4, 2, true);
  view.setUint32(8, polygonCount, true);
  view.setUint32(12, vertexCount, true);
  view.setUint32(16, segmentCount, true);
  view.setUint32(20, polygonCount, true);
  view.setUint32(24, vertexCount, true);
  view.setUint32(28, 1, true);
  view.setFloat64(32, -4.0e-7, true);
  view.setFloat64(40, 4.0e-7, true);
  view.setFloat64(48, -3.0e-7, true);
  view.setFloat64(56, 3.0e-7, true);
  let offset = 64;
  new Float32Array(buffer, offset, vertexCount * 2).set([
    -4.0e-7, -3.0e-7,
    4.0e-7, -3.0e-7,
    4.0e-7, 3.0e-7,
    -4.0e-7, 3.0e-7,
  ]);
  offset += vertexCount * 2 * Float32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, polygonCount + 1).set([0, 4]);
  offset += (polygonCount + 1) * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, polygonCount).set([8]);
  offset += polygonCount * Uint32Array.BYTES_PER_ELEMENT;
  new Float32Array(buffer, offset, segmentCount * 4).set([
    -4.0e-7, -3.0e-7, 4.0e-7, -3.0e-7,
    4.0e-7, -3.0e-7, 4.0e-7, 3.0e-7,
    4.0e-7, 3.0e-7, -4.0e-7, 3.0e-7,
    -4.0e-7, 3.0e-7, -4.0e-7, -3.0e-7,
  ]);
  offset += segmentCount * 4 * Float32Array.BYTES_PER_ELEMENT;
  new Float32Array(buffer, offset, vertexCount * 3).set([
    -4.0e-7, -3.0e-7, 0,
    4.0e-7, -3.0e-7, 0,
    4.0e-7, 3.0e-7, 0,
    -4.0e-7, 3.0e-7, 0,
  ]);
  offset += vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, vertexCount * 2).set([0, 1, 1, 3, 2, 3, 0, 2]);
  offset += vertexCount * 2 * Uint32Array.BYTES_PER_ELEMENT;
  new Float32Array(buffer, offset, vertexCount).set([0.5, 0.5, 0.5, 0.5]);
  offset += vertexCount * Float32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, vertexCount).set([1, 0, 0, 0]);
  return buffer;
}

function makeCrossSectionQualityBuffer() {
  const buffer = new ArrayBuffer(24);
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMQS"].entries()) view.setUint8(index, code.charCodeAt(0));
  view.setUint32(4, 1, true);
  view.setUint32(8, 1, true);
  view.setFloat32(12, 0.18, true);
  view.setFloat32(16, 0.18, true);
  new Float32Array(buffer, 20, 1).set([0.18]);
  return buffer;
}

function makeCrossSectionPngBuffer() {
  const buffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAGElEQVR42mP8z8BQz0AEYBxVSFUBAA2TAYPdiun8AAAAAElFTkSuQmCC",
    "base64",
  );
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function parsePng(buffer) {
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
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
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(`Unsupported PNG format: bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const sourceStride = width * bytesPerPixel;
  const targetStride = width * 4;
  const rgba = Buffer.alloc(width * height * 4);
  let sourceOffset = 0;
  let previous = Buffer.alloc(sourceStride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[sourceOffset++];
    const scanline = Buffer.from(raw.subarray(sourceOffset, sourceOffset + sourceStride));
    sourceOffset += sourceStride;
    unfilterScanline(scanline, previous, filter, bytesPerPixel);
    if (colorType === 6) {
      scanline.copy(rgba, y * targetStride);
    } else {
      for (let x = 0; x < width; x += 1) {
        const source = x * 3;
        const target = y * targetStride + x * 4;
        rgba[target] = scanline[source];
        rgba[target + 1] = scanline[source + 1];
        rgba[target + 2] = scanline[source + 2];
        rgba[target + 3] = 255;
      }
    }
    previous = scanline;
  }
  return { height, rgba, width };
}

function unfilterScanline(scanline, previous, filter, bytesPerPixel) {
  for (let index = 0; index < scanline.length; index += 1) {
    const left = index >= bytesPerPixel ? scanline[index - bytesPerPixel] : 0;
    const up = previous[index] ?? 0;
    const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] ?? 0 : 0;
    let value = scanline[index];
    if (filter === 1) value = (value + left) & 0xff;
    else if (filter === 2) value = (value + up) & 0xff;
    else if (filter === 3) value = (value + Math.floor((left + up) / 2)) & 0xff;
    else if (filter === 4) value = (value + paethPredictor(left, up, upLeft)) & 0xff;
    else if (filter !== 0) throw new Error(`Unsupported PNG filter: ${filter}`);
    scanline[index] = value;
  }
}

function paethPredictor(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

function canvasCompositeDifference(before, after) {
  const length = Math.min(before.signature.length, after.signature.length);
  let changedPixels = 0;
  for (let offset = 0; offset < length; offset += 3) {
    const delta =
      Math.abs(before.signature[offset] - after.signature[offset]) +
      Math.abs(before.signature[offset + 1] - after.signature[offset + 1]) +
      Math.abs(before.signature[offset + 2] - after.signature[offset + 2]);
    if (delta > 18) changedPixels += 1;
  }
  const sampledPixels = Math.floor(length / 3);
  const minimumChangedPixels = Math.max(6, Math.floor(sampledPixels * 0.003));
  return { changed: changedPixels >= minimumChangedPixels, changedPixels, minimumChangedPixels, sampledPixels };
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

function cssAttributeValue(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function isIgnorableConsoleError(text) {
  return (
    text === "Failed to load resource: the server responded with a status of 404 (Not Found)" ||
    (text.includes("/v2/sessions/current/events/ws") &&
      (text.includes("Unexpected response code: 404") ||
        text.includes("Unexpected response code: 204")))
  );
}
