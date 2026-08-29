import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const workspaceUrl = process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const apiBaseUrl = (
  process.env.CONTROL_ROOM_API_BASE_URL ?? new URL(workspaceUrl).origin
).replace(/\/$/, "");
const outputDir = resolve(
  process.cwd(),
  process.env.CONTROL_ROOM_FROZEN_SPINS_REPORT_DIR ?? ".fullmag/reports/frozen-spins-browser",
);
const runId = `frozen-spins-browser-${randomUUID()}`;

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function apiJson(path, init) {
  const response = await fetch(`${apiBaseUrl}${path}`, init);
  const body = await response.text();
  let value = null;
  try {
    value = body ? JSON.parse(body) : null;
  } catch {
    // Preserve the raw response in the thrown diagnostic below.
  }
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${body.slice(0, 500)}`);
  }
  return { response, value };
}

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  console.error("Frozen spins smoke requires Playwright or @playwright/test.");
  process.exit(2);
}

await mkdir(outputDir, { recursive: true });
let browser;
try {
  browser = await playwright.chromium.launch({ headless: true });
} catch (error) {
  if (!String(error).includes("Executable doesn't exist")) throw error;
  browser = await playwright.chromium.launch({ channel: "chrome", headless: true });
}
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const consoleErrors = [];
const consoleWarnings = [];
const networkLog = [];
let previousVisualizationState = null;

page.on("console", (message) => {
  if (message.type() === "error") {
    consoleErrors.push(message.text());
  }
  if (message.type() === "warning") {
    consoleWarnings.push(message.text());
  }
});
page.on("pageerror", (error) => {
  consoleErrors.push(error.stack ?? error.message);
});
page.on("response", (response) => {
  const url = response.url();
  if (url.includes("/v2/")) {
    networkLog.push({ method: response.request().method(), status: response.status(), url });
  }
});

try {
  const quantityCatalog = (await apiJson("/v2/sessions/current/data/quantities")).value;
  const quantity = quantityCatalog?.quantities?.find((entry) => entry.id === "frozen_spins");
  assert(quantity, "Quantity catalog must advertise frozen_spins");
  assert(quantity.shape === "spatial_scalar", "frozen_spins must be a spatial scalar");
  assert(quantity.unit === "1", "frozen_spins must be dimensionless");
  assert(quantity.location === "node", "frozen_spins must use canonical node location");
  assert(quantity.supports_preview_3d === true, "frozen_spins must support 3D preview");

  const fieldCatalog = (await apiJson("/v2/sessions/current/data/fields")).value;
  const field = fieldCatalog?.quantities?.find(
    (entry) => entry.quantity_id === "frozen_spins" && entry.available === true,
  );
  assert(field, "Current session must publish an available frozen_spins field");

  const fieldMeta = (
    await apiJson("/v2/sessions/current/data/fields/frozen_spins/meta?component=full")
  ).value;
  assert(fieldMeta?.quantity_id === "frozen_spins", "Field meta must preserve quantity id");
  assert(fieldMeta?.components === 1, "Frozen Spins field payload must have one component");
  assert(
    typeof fieldMeta?.publication_bundle?.field?.carrier_fingerprint === "string" ||
      fieldMeta?.resolved_capability?.carriers?.some(
        (carrier) => typeof carrier.carrier_fingerprint === "string",
      ),
    "Frozen Spins field meta must publish a carrier fingerprint",
  );

  previousVisualizationState = (
    await apiJson("/v2/sessions/current/visualization/state")
  ).value;
  const objectQuantityOverrides = (
  previousVisualizationState?.targets?.objects ?? []
  ).map((target) => ({
    display: {
      surface: { opacity: 1, visible: true },
      visible: true,
    },
    quantity: { active_quantity_id: "frozen_spins" },
    scope: "object",
    scope_id: target.scope_id,
    style: {
      surface_color_source: "colormap",
      viewport_colorbar_visible: true,
    },
  }));
  assert(
    objectQuantityOverrides.length > 0,
    "Frozen Spins smoke requires at least one magnetic object render target",
  );

  console.log(`Navigating to workspace at ${workspaceUrl}...`);
  await page.goto(workspaceUrl, { waitUntil: "networkidle", timeout: 30_000 });

  // 1. Check Explorer and Ribbon
  const ribbon = await page.waitForSelector(".fm-ribbon", { timeout: 10_000 });
  assert(ribbon !== null, "Ribbon bar must be visible");

  // 2. Check 3D Viewport canvas and WebGL context
  const canvas = await page.waitForSelector(".fm-viewport-3d canvas", { timeout: 15_000 });
  assert(canvas !== null, "Viewport 3D canvas must be rendered");

  const webglStatus = await page.evaluate(() => {
    const el = document.querySelector(".fm-viewport-3d canvas");
    if (!el) return { found: false };
    const gl = el.getContext("webgl2") || el.getContext("webgl");
    if (!gl) return { found: true, hasContext: false };
    return {
      found: true,
      hasContext: true,
      isContextLost: gl.isContextLost(),
      width: gl.drawingBufferWidth,
      height: gl.drawingBufferHeight,
    };
  });

  assert(webglStatus.found, "Canvas element must be found in DOM");
  assert(webglStatus.hasContext, "Canvas must have an active WebGL context");
  assert(!webglStatus.isContextLost, "WebGL context must not be lost");
  assert(webglStatus.width > 0 && webglStatus.height > 0, "WebGL drawing buffer must be > 0");

  console.log("WebGL context verified successfully:", webglStatus);

  const visualizationState = (
    await apiJson("/v2/sessions/current/visualization/state", {
      body: JSON.stringify({
        active_quantity_id: "frozen_spins",
        overrides: objectQuantityOverrides,
        quantity: { active_quantity_id: "frozen_spins" },
        view_mode: "3d",
      }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    })
  ).value;
  assert(
    visualizationState?.active_quantity_id === "frozen_spins" &&
      visualizationState?.quantity?.active_quantity_id === "frozen_spins",
    "Visualization state must resolve frozen_spins as the active standard quantity",
  );

  const renderRevision = visualizationState.revision;
  let renderedAck = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ackResource = (
      await apiJson("/v2/sessions/current/visualization/client-acks")
    ).value;
    renderedAck = ackResource?.entries?.find(
      (entry) => entry.revision >= renderRevision && entry.status === "rendered",
    );
    if (renderedAck) break;
    await page.waitForTimeout(250);
  }
  if (!renderedAck) {
    const ackResource = (
      await apiJson("/v2/sessions/current/visualization/client-acks")
    ).value;
    const viewportDiagnostics = await page.evaluate(() => {
      const viewport = document.querySelector(".fm-viewport-3d");
      return viewport
        ? {
            attributes: Object.fromEntries(
              [...viewport.attributes].map((attribute) => [
                attribute.name,
                attribute.value,
              ]),
            ),
            text: viewport.textContent?.slice(0, 2_000) ?? "",
          }
        : null;
    });
    console.error(
      "Frozen Spins render adoption diagnostics:",
      JSON.stringify(
        {
          ackResource,
          consoleErrors,
          consoleWarnings,
          networkLog,
          viewportDiagnostics,
          visualizationState,
        },
        null,
        2,
      ),
    );
  }
  assert(renderedAck, `Viewport must acknowledge rendered revision ${renderRevision}`);

  const frozenFieldRequests = networkLog.filter(
    (entry) =>
      entry.url.includes("/data/fields/frozen_spins/") &&
      entry.status >= 200 &&
      entry.status < 300,
  );
  assert(
    frozenFieldRequests.some((entry) => entry.url.includes("/samples/vector")),
    "Viewport must fetch the frozen_spins field through the HTTP v2 vector data plane",
  );

  // Filter out non-fatal errors if any, but ensure no WebGL context loss errors
  const criticalErrors = consoleErrors.filter(
    (err) =>
      err.includes("WebGLRenderer: Context Lost") ||
      err.includes("frozen_spins") ||
      err.includes("Uncaught Error"),
  );
  assert(criticalErrors.length === 0, `Encountered critical errors: ${criticalErrors.join("; ")}`);

  const screenshotPath = resolve(outputDir, `${runId}.png`);
  const evidencePath = resolve(outputDir, `${runId}.json`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  await writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        schema_version: "fullmag.frozen_spins.browser.quantity.evidence.v1",
        run_id: runId,
        workspace_url: workspaceUrl,
        api_base_url: apiBaseUrl,
        quantity: {
          id: quantity.id,
          shape: quantity.shape,
          unit: quantity.unit,
          location: quantity.location,
        },
        field_meta: fieldMeta,
        visualization_revision: renderRevision,
        rendered_ack: renderedAck,
        webgl: webglStatus,
        network: networkLog,
        console_errors: consoleErrors,
        screenshot: screenshotPath,
        status: "PASS",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`PASS: Frozen spins standard quantity browser/WebGL smoke verified: ${evidencePath}`);
} catch (error) {
  console.error("FAIL: Frozen spins browser smoke failed:", error);
  process.exitCode = 1;
} finally {
  if (previousVisualizationState?.active_quantity_id) {
    await apiJson("/v2/sessions/current/visualization/state", {
      body: JSON.stringify({
        active_quantity_id: previousVisualizationState.active_quantity_id,
        quantity: {
          active_quantity_id:
            previousVisualizationState.quantity?.active_quantity_id ??
            previousVisualizationState.active_quantity_id,
        },
      }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    }).catch(() => {});
  }
  await browser.close();
}
