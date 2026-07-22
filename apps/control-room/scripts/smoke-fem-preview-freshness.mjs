import { createHash } from "node:crypto";

const apiBase = (process.env.CONTROL_ROOM_API_BASE_URL ?? "http://localhost:8197").replace(/\/$/, "");
const workspaceUrl = process.env.CONTROL_ROOM_URL ?? "http://localhost:3197/workspace";
const mode = process.env.FULLMAG_PREVIEW_MATRIX_MODE ?? "m";
const cadence = Number(process.env.FULLMAG_PREVIEW_EVERY_N ?? 10);
const expectedSourceStep = Number(process.env.FULLMAG_PREVIEW_MATRIX_MAX_STEPS ?? 52);
const timeoutMs = Number(process.env.CONTROL_ROOM_PREVIEW_MATRIX_TIMEOUT_MS ?? 180_000);
const selectedQuantity = mode === "H_demag" || mode === "full_cache" ? "H_demag" : "m";

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  throw new Error("FEM preview freshness smoke requires Playwright or @playwright/test.");
}

const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
const errors = [];
const fieldRequests = [];

await page.addInitScript((controlRoomApiBase) => {
  window.__FULLMAG_CONFIG__ = {
    ...(window.__FULLMAG_CONFIG__ ?? {}),
    controlRoomApiBase,
  };
}, apiBase);

page.on("console", (message) => {
  if (message.type() !== "error") return;
  const text = message.text();
  if (!text.includes("404 (Not Found)")) errors.push(text);
});
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.pathname.includes("/v2/sessions/current/data/fields/")) {
    fieldRequests.push(`${request.method()} ${url.pathname}${url.search}`);
  }
});

try {
  await page.goto(workspaceUrl, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
  const canvas = page.locator(".fm-viewport-3d canvas");
  await canvas.waitFor({ state: "visible", timeout: timeoutMs });
  let context = await canvas.evaluate((node) => {
    const gl = node.getContext("webgl2") ?? node.getContext("webgl");
    return {
      contextLost: gl?.isContextLost() ?? true,
      height: gl?.drawingBufferHeight ?? 0,
      width: gl?.drawingBufferWidth ?? 0,
    };
  });
  if (context.contextLost || context.width <= 0 || context.height <= 0) {
    throw new Error(`invalid viewport WebGL context: ${JSON.stringify(context)}`);
  }

  await waitForTerminalStage();
  if (mode === "full_cache") {
    const display = await patchJson("/v2/sessions/current/visualization/display", {
      active_quantity_id: selectedQuantity,
      vector_density: cadence,
    });
    if (display.active_quantity_id !== selectedQuantity) {
      throw new Error(`display patch did not select ${selectedQuantity}: ${JSON.stringify(display)}`);
    }
    await page.reload({ timeout: timeoutMs, waitUntil: "domcontentloaded" });
    await canvas.waitFor({ state: "visible", timeout: timeoutMs });
    context = await canvas.evaluate((node) => {
      const gl = node.getContext("webgl2") ?? node.getContext("webgl");
      return {
        contextLost: gl?.isContextLost() ?? true,
        height: gl?.drawingBufferHeight ?? 0,
        width: gl?.drawingBufferWidth ?? 0,
      };
    });
    if (context.contextLost || context.width <= 0 || context.height <= 0) {
      throw new Error(`invalid reloaded viewport WebGL context: ${JSON.stringify(context)}`);
    }
  }

  const solverProfile = await getJson("/v2/sessions/current/diagnostics/solver-profile");
  let meta = null;
  let maskSha256 = null;
  let payloadSha256 = null;
  if (mode === "disabled") {
    if (!solverProfile.preview_3d_disabled) {
      throw new Error("disabled matrix row did not publish preview_3d_disabled=true");
    }
  } else {
    meta = await poll("complete field metadata", async () => {
      const value = await getJsonOrNull(
        `/v2/sessions/current/data/fields/${encodeURIComponent(selectedQuantity)}/meta`,
      );
      return value &&
        ["complete", "stale_complete"].includes(value.state) &&
        value.source_step === expectedSourceStep
        ? value
        : null;
    });
    const response = await fetch(
      `${apiBase}/v2/sessions/current/data/fields/${encodeURIComponent(selectedQuantity)}` +
        "/samples/vector?component=full&scope_kind=full",
      { headers: { accept: "application/octet-stream" } },
    );
    if (!response.ok) {
      throw new Error(`field vector returned ${response.status}: ${await response.text()}`);
    }
    const payload = Buffer.from(await response.arrayBuffer());
    ({ maskSha256, payloadSha256 } = canonicalFmvpHashes(payload));
    try {
      await poll("viewport field subscriber request", async () =>
        fieldRequests.some((request) => request.includes(`/fields/${selectedQuantity}/`))
          ? true
          : null,
      );
    } catch (error) {
      throw new Error(`${error.message}; observed requests: ${JSON.stringify(fieldRequests)}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`browser errors:\n${errors.join("\n")}`);
  }
  console.log(
    `FEM preview browser proof: ${JSON.stringify({
      cadence,
      context,
      fieldRequestCount: fieldRequests.length,
      materializationState: meta?.state ?? null,
      maskSha256,
      mode,
      payloadSha256,
      sourceRevision: meta?.source_revision ?? null,
      sourceStep: meta?.source_step ?? null,
    })}`,
  );
} finally {
  await browser.close();
}

function canonicalFmvpHashes(payload) {
  if (payload.length < 48 || payload.subarray(0, 4).toString("ascii") !== "FMVP") {
    throw new Error("field response is not a valid FMVP payload");
  }
  const version = payload.readUInt8(4);
  const nComp = payload.readUInt8(6);
  const metadataLength = version === 3 ? payload.readUInt32LE(8) : 0;
  const valueCount = payload.readUInt32LE(12);
  const valueOffset = 48 + metadataLength;
  if (![2, 3].includes(version) || nComp === 0 || payload.length !== valueOffset + valueCount * 8) {
    throw new Error("field response has inconsistent FMVP header lengths");
  }
  let mask;
  if (version === 2) {
    mask = Buffer.alloc(22);
    mask.write("legacy_count_only:", 0, "ascii");
    mask.writeUInt32LE(valueCount / nComp, 18);
  } else {
    const metadata = payload.subarray(48, valueOffset);
    if (metadata.length < 68 || metadata.subarray(0, 4).toString("ascii") !== "FMMI") {
      throw new Error("FMVP v3 metadata is invalid");
    }
    const indexing = metadata.readUInt32LE(56);
    const nodeCount = metadata.readUInt32LE(60);
    const scopeKindLength = metadata.readUInt16LE(64);
    const scopeIdLength = metadata.readUInt16LE(66);
    const nodeStart = 68 + scopeKindLength + scopeIdLength;
    const nodeEnd = nodeStart + nodeCount * 4;
    if (nodeEnd > metadata.length) throw new Error("FMVP v3 node-index mask exceeds metadata");
    mask = Buffer.alloc(8 + nodeCount * 4);
    mask.writeUInt32LE(indexing, 0);
    mask.writeUInt32LE(nodeCount, 4);
    metadata.copy(mask, 8, nodeStart, nodeEnd);
  }
  return {
    maskSha256: createHash("sha256").update(mask).digest("hex"),
    payloadSha256: createHash("sha256").update(payload.subarray(valueOffset)).digest("hex"),
  };
}

async function waitForTerminalStage() {
  return poll("terminal FEM stage", async () => {
    const execution = await getJsonOrNull(
      "/v2/sessions/current/simulation/stages/execution",
    );
    const stages = execution?.stages ?? [];
    return stages.length > 0 &&
      stages.every((stage) =>
        ["completed", "failed", "cancelled", "rejected", "skipped"].includes(stage.status),
      )
      ? execution
      : null;
  });
}

async function poll(label, read) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function getJson(path) {
  const response = await fetch(apiBase + path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function getJsonOrNull(path) {
  const response = await fetch(apiBase + path, { headers: { accept: "application/json" } });
  if ([204, 404, 409].includes(response.status)) return null;
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function patchJson(path, body) {
  const response = await fetch(apiBase + path, {
    body: JSON.stringify(body),
    headers: { accept: "application/json", "content-type": "application/json" },
    method: "PATCH",
  });
  if (!response.ok) throw new Error(`PATCH ${path} returned ${response.status}: ${await response.text()}`);
  return response.json();
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
