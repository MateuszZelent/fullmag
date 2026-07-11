import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const configuredUrl = process.env.CONTROL_ROOM_URL ?? null;
const auditPort = Number(process.env.CONTROL_ROOM_AUDIT_PORT ?? 3103);
const auditArtifactsDirectory = path.resolve(
  process.env.CONTROL_ROOM_AUDIT_ARTIFACTS_DIR ??
    ".artifacts/viewport-3d-browser-audit",
);
const apiBase =
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:8081";

// The gate measures ownership/lifecycle across many real WebGL uploads, not
// throughput at production field sizes. Keep the fixture dense enough to
// exercise every pass while bounded enough for 120 rendered transitions in CI.
const FIELD_GRID = [24, 16, 2];
const QUANTITY_SEQUENCE = Array.from(
  { length: 120 },
  (_, index) => ["m", "H_eff", "H_demag", "H_ex"][index % 4],
);
const WARM_QUANTITIES = ["m", "H_eff", "H_demag", "H_ex"];
const MAX_HEAP_GROWTH_BYTES = 25 * 1024 * 1024;
const QUANTITY_SWITCH_TIMEOUT_MS = 20_000;

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
    "Viewport 3D memory-churn audit requires Playwright or @playwright/test.",
  );
  process.exit(2);
}

const managedRuntime = configuredUrl ? null : await startAuditRuntime();
const url = configuredUrl ?? `http://localhost:${auditPort}/workspace`;
const browser = await playwright.chromium.launch({
  args: ["--js-flags=--expose-gc"],
});
const page = await browser.newPage({
  viewport: { height: 900, width: 1440 },
});
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
await cdp.send("HeapProfiler.enable").catch(() => undefined);

const errors = [];
const fixtureRequests = [];
const fieldRequests = [];
const topologyRequests = [];
const fixture = createFdmFixture();
let auditActive = false;

await installFdmFixtureApi(page, fixture, fixtureRequests);
await installBrowserAuditInstrumentation(page);
await page.addInitScript(({ baseUrl }) => {
  window.__FULLMAG_CONFIG__ = {
    ...(window.__FULLMAG_CONFIG__ ?? {}),
    allowMissingSessionSmoke: true,
    controlRoomApiBase: baseUrl,
    disableRealtime: true,
  };
}, { baseUrl: apiBase });

page.on("console", (message) => {
  if (message.type() !== "error") return;
  const text = message.text();
  if (
    text.includes("/v2/sessions/current/events/ws") &&
    text.includes("ERR_CONNECTION_REFUSED")
  ) {
    return;
  }
  errors.push(text);
});
page.on("pageerror", (error) => {
  errors.push(error.message);
});
page.on("response", (response) => {
  const status = response.status();
  if (status >= 400) errors.push(`${status} ${response.url()}`);
});
page.on("request", (request) => {
  if (!auditActive) return;
  const requestUrl = request.url();
  if (requestUrl.includes("/v2/sessions/current/data/fields/")) {
    fieldRequests.push(`${request.method()} ${requestUrl}`);
  }
  if (
    requestUrl.includes("/v2/sessions/current/data/domain/topology") ||
    requestUrl.includes(
      "/v2/sessions/current/meshing/meshes/shared-domain/topology",
    )
  ) {
    topologyRequests.push(`${request.method()} ${requestUrl}`);
  }
});

try {
  await mkdir(auditArtifactsDirectory, { recursive: true });
  auditLog("goto", url);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const viewport = page.locator(".fm-viewport-3d");
  const canvas = page.locator(".fm-viewport-3d canvas");
  auditLog("waiting for viewport canvas");
  await canvas.waitFor({ state: "visible", timeout: 15_000 });
  await waitForCanvasReady(canvas);
  auditLog("waiting for diagnostics hud");
  await waitForDiagnostics(viewport);

  for (const quantity of WARM_QUANTITIES) {
    auditLog("warming quantity", quantity);
    await withTimeout(
      setGlobalQuantity(page, fixture, fixtureRequests, quantity, {
        allowExistingFieldRequest: true,
        // The production-like no-session fixture may already have the selected
        // field in its browser resource cache during bootstrap.
        requireFieldRequest: false,
      }),
      QUANTITY_SWITCH_TIMEOUT_MS,
      `Timed out warming viewport quantity ${quantity}.`,
    );
  }
  await page.waitForTimeout(500);

  auditLog("reading baseline diagnostics");
  const baseline = {
    diagnostics: await readDiagnostics(viewport),
    gpu: await readBrowserAuditCounters(page),
    heapBytes: await readJsHeapBytes(cdp),
  };

  auditActive = true;
  for (const [index, quantity] of QUANTITY_SEQUENCE.entries()) {
    if (index % 12 === 0) {
      auditLog("switching cached quantity batch", `${index + 1}-${index + 12}`);
    }
    fixture.visualizationState = applyPatch(fixture.visualizationState, {
      active_quantity_id: quantity,
      field_component: index % 2 === 0 ? "x" : "magnitude",
      layers: {
        points: { visible: index % 3 === 0 },
        vectors: { visible: index % 4 !== 0 },
        wireframe: { visible: index % 5 !== 0 },
      },
      quantity: {
        active_quantity_id: quantity,
        field_component: index % 2 === 0 ? "x" : "magnitude",
      },
      vector_style: {
        color_mode: index % 2 === 0 ? "magnitude" : "orientation",
      },
    });
    fixture.visualizationState.revision += 1;
    fixture.status.resources.visualization_state_revision =
      fixture.visualizationState.revision;
    await page.evaluate(async (state) => {
      const hook = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
      if (!hook) throw new Error("Fullmag browser audit hook is not installed.");
      hook.publishVisualizationState(state);
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    }, fixture.visualizationState);
  }
  auditActive = false;
  await page.waitForTimeout(500);

  auditLog("reading final diagnostics");
  const after = {
    diagnostics: await readDiagnostics(viewport),
    heapBytes: await readJsHeapBytes(cdp),
  };

  const heapGrowth = after.heapBytes - baseline.heapBytes;
  const allowedHeapGrowth = Math.max(
    MAX_HEAP_GROWTH_BYTES,
    Math.floor(baseline.heapBytes * 0.35),
  );
  const cacheGrowth =
    after.diagnostics.cacheBytes - baseline.diagnostics.cacheBytes;
  const geometryGrowth = after.diagnostics.geo - baseline.diagnostics.geo;

  if (heapGrowth > allowedHeapGrowth) {
    throw new Error(
      `Viewport quantity churn grew JS heap by ${formatBytes(heapGrowth)}; allowed ${formatBytes(allowedHeapGrowth)}. baseline=${formatBytes(baseline.heapBytes)} after=${formatBytes(after.heapBytes)}.`,
    );
  }
  if (cacheGrowth > 6 * 1024 * 1024) {
    throw new Error(
      `Viewport quantity churn grew decoded cache by ${formatBytes(cacheGrowth)}; baseline=${formatBytes(baseline.diagnostics.cacheBytes)} after=${formatBytes(after.diagnostics.cacheBytes)}.`,
    );
  }
  if (geometryGrowth > 16) {
    throw new Error(
      `Viewport quantity churn leaked geometry resources: baseline=${baseline.diagnostics.geo}, after=${after.diagnostics.geo}.`,
    );
  }
  if (topologyRequests.length > 0) {
    throw new Error(
      `Quantity switching refetched topology resources:\n${topologyRequests.join("\n")}`,
    );
  }
  if (fieldRequests.length > 0) {
    throw new Error(
      `Cached quantity switching refetched field resources:\n${fieldRequests.join("\n")}`,
    );
  }
  if (errors.length > 0) {
    throw new Error(`Browser console/network errors:\n${errors.join("\n")}`);
  }

  const idle = await verifyViewportIdle(page, 5_000);
  await page.screenshot({ path: path.join(auditArtifactsDirectory, "settled-3d.png") });
  const gpuAfterStress = await readBrowserAuditCounters(page);
  const baselineLiveBuffers =
    baseline.gpu.buffersCreated - baseline.gpu.buffersDeleted;
  const stressLiveBuffers =
    gpuAfterStress.buffersCreated - gpuAfterStress.buffersDeleted;
  const createdDuringStress =
    gpuAfterStress.buffersCreated - baseline.gpu.buffersCreated;
  if (createdDuringStress < QUANTITY_SEQUENCE.length) {
    throw new Error(
      `GPU lifecycle gate did not observe every rendered transition: created ${createdDuringStress} buffers for ${QUANTITY_SEQUENCE.length} switches.`,
    );
  }
  if (stressLiveBuffers > baselineLiveBuffers + 16) {
    throw new Error(
      `Live WebGL buffers did not return to a post-warmup plateau: baseline=${baselineLiveBuffers}, after=${stressLiveBuffers}.`,
    );
  }

  await page.locator('[data-action-id="ws-2d"]').click();
  await page.locator(".fm-viewport-3d canvas").waitFor({ state: "detached", timeout: 10_000 });
  await page.waitForTimeout(300);
  const afterUnmount = await readBrowserAuditCounters(page);
  if (afterUnmount.buffersDeleted < gpuAfterStress.buffersDeleted) {
    throw new Error("WebGL buffer delete counter regressed after viewport unmount.");
  }
  const unmountedLiveBuffers =
    afterUnmount.buffersCreated - afterUnmount.buffersDeleted;
  if (unmountedLiveBuffers > 4) {
    throw new Error(
      `Viewport unmount retained ${unmountedLiveBuffers} WebGL buffers; allowed 4 instrumentation/runtime buffers.`,
    );
  }
  await page.screenshot({ path: path.join(auditArtifactsDirectory, "after-unmount.png") });
  await writeAuditArtifact({
    after,
    afterUnmount,
    baseline,
    fixtureRequests,
    gpuAfterStress,
    idle,
    topologyRequests,
    url,
  });

  console.log(
    "Viewport 3D memory-churn audit passed:",
    `switches=${QUANTITY_SEQUENCE.length}`,
    `heap=${formatBytes(baseline.heapBytes)}->${formatBytes(after.heapBytes)}`,
    `cache=${formatBytes(baseline.diagnostics.cacheBytes)}->${formatBytes(after.diagnostics.cacheBytes)}`,
    `geo=${baseline.diagnostics.geo}->${after.diagnostics.geo}`,
    `frames=${baseline.diagnostics.frames}->${after.diagnostics.frames}`,
    `fieldRequests=${fieldRequests.length}`,
    `fixtureRequests=${fixtureRequests.length}`,
    `gpuBuffers=${gpuAfterStress.buffersCreated}/${gpuAfterStress.buffersDeleted}`,
    `gpuUploaded=${formatBytes(gpuAfterStress.bufferBytesUploaded)}`,
  );
} catch (error) {
  await reportAuditFailure(page, fixture, {
    errors,
    fieldRequests,
    fixtureRequests,
    topologyRequests,
  });
  throw error;
} finally {
  auditActive = false;
  await browser.close();
  await managedRuntime?.stop();
}

async function readBrowserAuditCounters(page) {
  return page.evaluate(() => ({ ...(window.__FM_VIEWPORT_BROWSER_AUDIT__ ?? {}) }));
}

async function verifyViewportIdle(page, observeMs) {
  await page.waitForTimeout(500);
  const before = await readBrowserAuditCounters(page);
  await page.waitForTimeout(observeMs);
  const after = await readBrowserAuditCounters(page);
  const deltas = Object.fromEntries(
    Object.keys(after).map((key) => [key, Number(after[key]) - Number(before[key])]),
  );
  for (const metric of ["frames", "drawCalls"]) {
    if (deltas[metric] !== 0) {
      throw new Error(`Viewport rendered during ${observeMs}ms idle window: ${metric} +${deltas[metric]}.`);
    }
  }
  return { after, before, deltas, observeMs };
}

async function writeAuditArtifact(payload) {
  await mkdir(auditArtifactsDirectory, { recursive: true });
  await writeFile(
    path.join(auditArtifactsDirectory, "metrics.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

async function startAuditRuntime() {
  await runPnpm(["run", "build:audit:webpack"], {
    NEXT_PUBLIC_AUDIT_BUILD: "1",
  });
  const child = spawn("pnpm", ["exec", "next", "start", "--port", String(auditPort)], {
    cwd: process.cwd(),
    env: { ...process.env, NEXT_PUBLIC_AUDIT_BUILD: "1" },
    stdio: "pipe",
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const serverUrl = `http://localhost:${auditPort}/workspace`;
  try {
    await waitForHttp(serverUrl, 30_000);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`Audit server did not become ready: ${error.message}\n${output.join("")}`);
  }
  return {
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    },
  };
}

async function runPnpm(args, extraEnvironment) {
  await new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, {
      cwd: process.cwd(),
      env: { ...process.env, ...extraEnvironment },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`pnpm ${args.join(" ")} exited with ${code ?? "signal"}.`));
    });
  });
}

async function waitForHttp(targetUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(targetUrl, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // The process is still binding its port.
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${targetUrl}.`);
}

async function installBrowserAuditInstrumentation(page) {
  await page.addInitScript(() => {
    const counters = {
      bufferBytesUploaded: 0,
      buffersCreated: 0,
      buffersDeleted: 0,
      drawCalls: 0,
      frames: 0,
    };
    window.__FM_VIEWPORT_BROWSER_AUDIT__ = counters;

    const originalRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      originalRaf((timestamp) => {
        counters.frames += 1;
        callback(timestamp);
      });

    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) {
      const context = originalGetContext.apply(this, args);
      if (!context || !["webgl", "webgl2", "experimental-webgl"].includes(String(args[0]))) {
        return context;
      }
      const gl = context;
      if (gl.__fullmagAuditWrapped) return gl;
      gl.__fullmagAuditWrapped = true;
      for (const name of ["createBuffer", "deleteBuffer", "drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"]) {
        const original = gl[name];
        if (typeof original !== "function") continue;
        gl[name] = function (...methodArgs) {
          if (name === "createBuffer") counters.buffersCreated += 1;
          if (name === "deleteBuffer") counters.buffersDeleted += 1;
          if (name.startsWith("draw")) counters.drawCalls += 1;
          return original.apply(this, methodArgs);
        };
      }
      for (const name of ["bufferData", "bufferSubData"]) {
        const original = gl[name];
        if (typeof original !== "function") continue;
        gl[name] = function (...methodArgs) {
          const data = methodArgs[1];
          if (typeof data === "number") counters.bufferBytesUploaded += data;
          else if (data && typeof data.byteLength === "number") counters.bufferBytesUploaded += data.byteLength;
          return original.apply(this, methodArgs);
        };
      }
      return gl;
    };
  });
}

async function installFdmFixtureApi(page, fixture, requests) {
  await page.route("**/v2/sessions/current/**", async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    requests.push(`${request.method()} ${requestUrl.pathname}`);
    if (request.method() === "OPTIONS") {
      await fulfillEmpty(route, 204);
      return;
    }

    const path = requestUrl.pathname;
    if (path === "/v2/sessions/current/status") {
      await fulfillJson(route, fdmStatusFixture(fixture));
      return;
    }
    if (path === "/v2/sessions/current/visualization/state") {
      if (request.method() === "PATCH") {
        const patch = parsePatchBody(request);
        fixture.visualizationState = applyPatch(fixture.visualizationState, patch);
        fixture.visualizationState.revision += 1;
        fixture.patchCount += 1;
        fixture.status.resources.visualization_state_revision =
          fixture.visualizationState.revision;
      }
      await fulfillJson(route, fixture.visualizationState);
      return;
    }
    if (path === "/v2/sessions/current/data/domain/meta") {
      await fulfillJson(route, fdmDomainMetaFixture());
      return;
    }
    if (path === "/v2/sessions/current/data/domain/topology") {
      await fulfillEmpty(route, 204);
      return;
    }
    if (path.startsWith("/v2/sessions/current/data/fields/")) {
      const quantityId = decodeURIComponent(path.split("/")[6] ?? "m");
      const etag = `"fdm-memory-${quantityId}"`;
      if (request.headers()["if-none-match"] === etag) {
        await fulfillEmpty(route, 304, { etag });
        return;
      }
      await fulfillBinary(route, makeFdmFieldVectorBuffer(quantityId), 200, {
        etag,
      });
      return;
    }
    if (path === "/v2/sessions/current/model/scene") {
      await fulfillJson(route, { objects: [], revision: 0, schema_version: 1 });
      return;
    }
    if (path === "/v2/sessions/current/model/universe") {
      await fulfillJson(route, {
        mesh_dirty: false,
        object_bounds_max: [6e-7, 4e-7, 1e-7],
        object_bounds_min: [-6e-7, -4e-7, -1e-7],
        scene_revision: 0,
        study_universe_mesh: null,
        universe: null,
      });
      return;
    }
    if (path === "/v2/sessions/current/meshing/meshes/shared-domain/manifest") {
      await fulfillEmpty(route, 204);
      return;
    }

    await fulfillEmpty(route, 204);
  });
}

async function setGlobalQuantity(
  page,
  fixture,
  requests,
  quantityId,
  { allowExistingFieldRequest = false, requireFieldRequest = false } = {},
) {
  const previousFieldRequestCount = countFieldRequests(requests, quantityId);
  if (currentFixtureQuantity(fixture) === quantityId) {
    if (requireFieldRequest) {
      await waitForFieldRequest(requests, quantityId, {
        afterCount: allowExistingFieldRequest
          ? undefined
          : previousFieldRequestCount,
      });
    }
    return;
  }

  await setAuditStep(page, `quantity:${quantityId}:audit-hook`);
  await page.evaluate(async (expected) => {
    const hook = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
    if (!hook) {
      throw new Error("Fullmag browser audit hook is not installed.");
    }
    await hook.setGlobalQuantity(expected);
  }, quantityId);
  await setAuditStep(page, `quantity:${quantityId}:wait-patch`);
  await waitForCondition(
    () => currentFixtureQuantity(fixture) === quantityId,
    5_000,
    `Timed out waiting for visualization PATCH to persist quantity ${quantityId}.`,
  );
  if (requireFieldRequest) {
    await setAuditStep(page, `quantity:${quantityId}:wait-field-request`);
    await waitForFieldRequest(requests, quantityId, {
      afterCount: allowExistingFieldRequest
        ? undefined
        : previousFieldRequestCount,
    });
  }
  await page.waitForTimeout(120);
}

async function waitForFieldRequest(
  requests,
  quantityId,
  { afterCount = undefined } = {},
) {
  await waitForCondition(
    () => {
      const count = countFieldRequests(requests, quantityId);
      return afterCount === undefined ? count > 0 : count > afterCount;
    },
    15_000,
    `Timed out waiting for field vector request ${quantityId}.`,
  );
}

function countFieldRequests(requests, quantityId) {
  const expected = fieldVectorRequest(quantityId);
  return requests.filter((request) => request === expected).length;
}

function fieldVectorRequest(quantityId) {
  return `GET /v2/sessions/current/data/fields/${encodeURIComponent(quantityId)}/samples/vector`;
}

async function reportAuditFailure(
  page,
  fixture,
  { errors, fieldRequests, fixtureRequests, topologyRequests },
) {
  const snapshot = await page
    .evaluate(() => {
      const hud = Array.from(
        document.querySelectorAll(".fm-viewport-3d__hud span"),
      ).map((node) => node.textContent?.trim() ?? "");
      const menuItems = Array.from(
        document.querySelectorAll('[role="menuitemradio"]'),
      ).map((node) => ({
        box: (() => {
          const rect = node.getBoundingClientRect();
          return {
            height: rect.height,
            width: rect.width,
            x: rect.x,
            y: rect.y,
          };
        })(),
        checked: node.getAttribute("aria-checked"),
        disabled: node.getAttribute("aria-disabled"),
        text: node.textContent?.trim() ?? "",
      }));
      const actionIds = Array.from(document.querySelectorAll("[data-action-id]"))
        .map((node) => ({
          box: (() => {
            const rect = node.getBoundingClientRect();
            return {
              height: rect.height,
              width: rect.width,
              x: rect.x,
              y: rect.y,
            };
          })(),
          id: node.getAttribute("data-action-id"),
          text: node.textContent?.trim() ?? "",
        }))
        .slice(0, 80);
      return {
        actionIds,
        auditEvents: window.__FM_VIEWPORT_AUDIT_EVENTS__ ?? [],
        auditStep: window.__FM_VIEWPORT_AUDIT_STEP__ ?? null,
        hud,
        menuItems,
        url: window.location.href,
      };
    })
    .catch((innerError) => ({
      error: innerError instanceof Error ? innerError.message : String(innerError),
    }));
  console.error(
    "Viewport 3D memory-churn audit failure context:",
    JSON.stringify(
      {
        browser: snapshot,
        errors: errors.slice(-10),
        fieldRequests: fieldRequests.slice(-10),
        fixtureRequests: fixtureRequests.slice(-20),
        topologyRequests: topologyRequests.slice(-10),
        visualizationState: fixture.visualizationState,
      },
      null,
      2,
    ),
  );
}

async function setAuditStep(page, step) {
  await page.evaluate((nextStep) => {
    window.__FM_VIEWPORT_AUDIT_STEP__ = nextStep;
  }, step);
}

async function waitForCondition(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error(message);
}

async function waitForCanvasReady(canvas) {
  await canvas.evaluate((node) =>
    new Promise((resolve) => {
      const deadline = performance.now() + 5_000;
      const tick = () => {
        const rect = node.getBoundingClientRect();
        if ((rect.width > 0 && rect.height > 0) || performance.now() > deadline) {
          resolve(undefined);
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    }),
  );
}

async function waitForDiagnostics(viewport) {
  await viewport.evaluate((node) =>
    new Promise((resolve, reject) => {
      const deadline = performance.now() + 15_000;
      const tick = () => {
        const spans = Array.from(node.querySelectorAll(".fm-viewport-3d__hud span"));
        if (spans.some((span) => span.textContent?.includes("geo:"))) {
          resolve(undefined);
          return;
        }
        if (performance.now() > deadline) {
          reject(new Error("Timed out waiting for viewport diagnostics HUD."));
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    }),
  );
}

async function readDiagnostics(viewport) {
  const value = await viewport.evaluate((node) => {
    const spans = Array.from(node.querySelectorAll(".fm-viewport-3d__hud span"));
    return spans.find((span) => span.textContent?.includes("geo:"))?.textContent ?? "";
  });
  return {
    cacheBytes: parseCacheBytes(readDiagnosticToken(value, "cache")),
    frames: Number(readDiagnosticToken(value, "frames") ?? 0),
    geo: Number(readDiagnosticToken(value, "geo") ?? 0),
    raw: value,
  };
}

async function readJsHeapBytes(cdp) {
  await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
  const result = await cdp.send("Performance.getMetrics");
  const metric = result.metrics.find((entry) => entry.name === "JSHeapUsedSize");
  if (!metric || !Number.isFinite(metric.value)) {
    throw new Error("Chromium did not expose JSHeapUsedSize.");
  }
  return Number(metric.value);
}

function readDiagnosticToken(value, key) {
  const match = value.match(new RegExp(`(?:^|\\s)${key}:([^\\s]+)`));
  return match?.[1] ?? null;
}

function parseCacheBytes(value) {
  if (!value) return 0;
  const match = value.match(/^([0-9]+)(B|KB|MB)$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  if (match[2] === "MB") return amount * 1024 * 1024;
  if (match[2] === "KB") return amount * 1024;
  return amount;
}

function formatBytes(value) {
  const amount = Math.max(0, Math.round(Number(value)));
  if (amount >= 1024 * 1024) return `${(amount / (1024 * 1024)).toFixed(1)}MB`;
  if (amount >= 1024) return `${(amount / 1024).toFixed(1)}KB`;
  return `${amount}B`;
}

function auditLog(...parts) {
  console.log("[viewport-memory-audit]", ...parts);
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timeoutId);
  });
}

function sleep(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function applyPatch(state, patch) {
  return mergeRecords(state, patch ?? {});
}

function parsePatchBody(request) {
  try {
    const value = request.postDataJSON();
    return isPlainObject(value) ? value : {};
  } catch {
    return {};
  }
}

function mergeRecords(current, patch) {
  const output = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const previous = output[key];
    output[key] =
      isPlainObject(previous) && isPlainObject(value)
        ? mergeRecords(previous, value)
        : value;
  }
  return output;
}

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({
    body: JSON.stringify(body),
    headers: fixtureHeaders({ "content-type": "application/json" }),
    status,
  });
}

async function fulfillBinary(route, arrayBuffer, status = 200, extra = {}) {
  await route.fulfill({
    body: Buffer.from(arrayBuffer),
    headers: fixtureHeaders({
      "content-type": "application/octet-stream",
      ...extra,
    }),
    status,
  });
}

async function fulfillEmpty(route, status = 204, extra = {}) {
  await route.fulfill({
    body: "",
    headers: fixtureHeaders(extra),
    status,
  });
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

function createFdmFixture() {
  const visualizationState = fdmVisualizationStateFixture();
  const status = fdmStatusFixture({ visualizationState });
  return { patchCount: 0, status, visualizationState };
}

function fdmStatusFixture(fixture) {
  const revision = fixture.visualizationState?.revision ?? 1;
  const quantityId =
    fixture.visualizationState?.quantity?.active_quantity_id ??
    fixture.visualizationState?.active_quantity_id ??
    "m";
  return {
    api_contract_version: "1.0.0",
    capabilities: {
      algorithms_available: [],
      binary_fields: true,
      cell_fields: true,
      eigen_modes: false,
      explicit_topology: false,
      gpu_telemetry: false,
      node_fields: false,
      preview_2d: false,
      preview_3d: true,
      scalar_history: false,
      structured_grid: true,
    },
    display: {
      active_quantity_id: quantityId,
      auto_contrast: true,
      colormap: "viridis",
      contrast_max: null,
      contrast_min: null,
      field_component: "magnitude",
      max_points: 120000,
      slice_layer: 0,
      slice_mode: "xy",
      vector_density: 2,
      vector_glyphs: true,
      view_mode: "3d",
      x_chosen_size: 1,
      y_chosen_size: 1,
    },
    domain: {
      cell_count: FIELD_GRID[0] * FIELD_GRID[1] * FIELD_GRID[2],
      discretization: "fdm",
      generation_id: 1,
    },
    energies: {},
    metrics: {
      steps_per_second: null,
      total_steps: 0,
      uptime_seconds: 0,
    },
    resources: {
      artifact_revision: 0,
      artifacts_revision: 0,
      command_completion_revision: 0,
      commands_revision: 0,
      display_revision: revision,
      domain_generation_id: 1,
      engine_log_revision: 0,
      field_catalog_revision: 1,
      field_revision: 1,
      fields_revision: 1,
      mesh_build_revision: 0,
      mesh_revision: 0,
      scalars_revision: 0,
      scene_revision: 0,
      slice_revision: 0,
      stages_revision: 0,
      topology_revision: 0,
      visualization_state_revision: revision,
      workspace_revision: 0,
    },
    run: null,
    runtime_bundle_version: "memory-churn-fixture",
    session: {
      created_at: "0",
      name: "fdm-memory-churn-fixture",
      session_id: "fdm-memory-churn-fixture",
      workspace_root: "/tmp/fullmag-fdm-memory-fixture",
    },
    solver: {
      state: "idle",
    },
  };
}

function fdmDomainMetaFixture() {
  return {
    bounds: {
      max: [6e-7, 4e-7, 1e-7],
      min: [-6e-7, -4e-7, -1e-7],
    },
    coordinate_system: "cartesian",
    counts: { cells: FIELD_GRID[0] * FIELD_GRID[1] * FIELD_GRID[2] },
    dimension: 3,
    discretization: "fdm",
    domain_id: "fdm-memory-churn-domain",
    generation_id: 1,
    grid: {
      origin: [-6e-7, -4e-7, -1e-7],
      shape: FIELD_GRID,
      spacing: [1.25e-8, 1.25e-8, 5e-8],
    },
    units: { length: "m" },
  };
}

function fdmVisualizationStateFixture() {
  return {
    active_quantity_id: "m",
    auto_contrast: true,
    camera: {
      position: [1.4e-6, 1.0e-6, 8e-7],
      projection: "perspective",
      target: [0, 0, 0],
      up: [0, 0, 1],
    },
    clip: {
      enabled: false,
      normal_axis: "z",
      offset: 0,
    },
    colormap: "viridis",
    contrast_max: null,
    contrast_min: null,
    diagnostics: { warnings: [] },
    domains: {
      active_scope_id: null,
      active_scope_kind: "domain",
    },
    fdm: {
      x_chosen_size: 1,
      y_chosen_size: 1,
    },
    fem: {
      topology_mode: "surface",
      volume_edges_budget: 0,
    },
    field_component: "magnitude",
    layers: {
      bounds: { visible: true },
      points: { visible: false },
      quantity_overlay: { visible: true },
      surface: { opacity: 0.94, visible: true },
      vectors: { density: 2, domain: "full_domain", visible: true },
      wireframe: { visible: true },
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
      max_glyphs: 192,
      max_points: 120000,
    },
    schema_version: 1,
    slice: {
      layer: 0,
      mode: "xy",
    },
    slice_layer: 0,
    slice_mode: "xy",
    trim: {
      enabled: false,
      max: [1, 1, 1],
      min: [0, 0, 0],
    },
    vector_density: 2,
    vector_glyphs: true,
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

function makeFdmFieldVectorBuffer(quantityId) {
  const pointCount = FIELD_GRID[0] * FIELD_GRID[1] * FIELD_GRID[2];
  const valueCount = pointCount * 3;
  const buffer = new ArrayBuffer(
    48 + valueCount * Float64Array.BYTES_PER_ELEMENT,
  );
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMVP"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 2);
  view.setUint8(5, 1);
  view.setUint8(6, 3);
  view.setUint32(12, valueCount, true);
  view.setUint32(16, FIELD_GRID[0], true);
  view.setUint32(20, FIELD_GRID[1], true);
  view.setUint32(24, FIELD_GRID[2], true);
  new TextEncoder().encodeInto(quantityId, new Uint8Array(buffer, 28, 16));

  const values = new Float64Array(buffer, 48);
  const phase = quantityPhase(quantityId);
  let offset = 0;
  for (let z = 0; z < FIELD_GRID[2]; z += 1) {
    for (let y = 0; y < FIELD_GRID[1]; y += 1) {
      for (let x = 0; x < FIELD_GRID[0]; x += 1) {
        const centeredX = (x - (FIELD_GRID[0] - 1) / 2) / ((FIELD_GRID[0] - 1) / 2);
        const centeredY = (y - (FIELD_GRID[1] - 1) / 2) / ((FIELD_GRID[1] - 1) / 2);
        const centeredZ = (z - (FIELD_GRID[2] - 1) / 2) / ((FIELD_GRID[2] - 1) / 2);
        const vx = Math.sin(centeredX * Math.PI + phase);
        const vy = Math.cos(centeredY * Math.PI - phase);
        const vz = Math.sin(centeredZ * Math.PI * 0.5 + phase * 0.5);
        const length = Math.hypot(vx, vy, vz) || 1;
        values[offset++] = vx / length;
        values[offset++] = vy / length;
        values[offset++] = vz / length;
      }
    }
  }

  return buffer;
}

function quantityPhase(quantityId) {
  if (quantityId === "H_eff") return 0.7;
  if (quantityId === "H_demag") return 1.4;
  if (quantityId === "H_ex") return 2.1;
  return 0.0;
}

function currentFixtureQuantity(fixture) {
  return (
    fixture.visualizationState?.quantity?.active_quantity_id ??
    fixture.visualizationState?.active_quantity_id ??
    "m"
  );
}
