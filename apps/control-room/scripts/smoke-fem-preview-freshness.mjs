import { createHash } from "node:crypto";

import {
  classifyFieldRequestFailure,
  classifyFieldResponseInspectionFailure,
  isPreterminalPendingOrStaleField,
  observeFirstTerminalAt,
  selectPreterminalFieldResponse,
  selectTerminalFieldResponse,
} from "./smoke-fem-preview-freshness-timeline.mjs";

const apiBase = (process.env.CONTROL_ROOM_API_BASE_URL ?? "http://localhost:8197").replace(/\/$/, "");
const workspaceUrl = process.env.CONTROL_ROOM_URL ?? "http://localhost:3197/workspace";
const mode = process.env.FULLMAG_PREVIEW_MATRIX_MODE ?? "m";
const cadence = Number(process.env.FULLMAG_PREVIEW_EVERY_N ?? 10);
const expectedSourceStep = Number(process.env.FULLMAG_PREVIEW_MATRIX_MAX_STEPS ?? 52);
const timeoutMs = Number(process.env.CONTROL_ROOM_PREVIEW_MATRIX_TIMEOUT_MS ?? 180_000);
const pollIntervalMs = Number(process.env.CONTROL_ROOM_PREVIEW_MATRIX_POLL_MS ?? 100);
const requireRetainedInterval = process.env.CONTROL_ROOM_REQUIRE_RETAINED_INTERVAL === "1";
const selectedQuantity = mode === "H_demag" || mode === "full_cache" ? "H_demag" : "m";

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  throw new Error("FEM preview freshness smoke requires Playwright or @playwright/test.");
}

const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
const consoleErrors = [];
const errors = [];
const fieldRequests = [];
const fieldRequestFailures = [];
const fieldResponseAttempts = [];
const fieldResponseInspectionFailures = [];
const fieldResponses = [];
const requestAttemptIds = new WeakMap();
const requestFailureByAttemptId = new Map();
const pageLifecycle = [];
const pageErrors = [];
const responseTasks = new Set();
const stageObservations = [];
let firstTerminalObservedAt = null;
let selectedDisplay = null;
let requestAttemptSequence = 0;

await page.addInitScript((controlRoomApiBase) => {
  window.__FULLMAG_CONFIG__ = {
    ...(window.__FULLMAG_CONFIG__ ?? {}),
    controlRoomApiBase,
  };
}, apiBase);

page.on("console", (message) => {
  if (message.type() !== "error") return;
  const text = message.text();
  if (!text.includes("404 (Not Found)")) {
    consoleErrors.push(text);
    errors.push(text);
  }
});
page.on("pageerror", (error) => {
  pageErrors.push(error.message);
  errors.push(error.message);
});
page.on("close", () => pageLifecycle.push({ event: "close", observedAt: performance.now() }));
page.on("crash", () => pageLifecycle.push({ event: "crash", observedAt: performance.now() }));
page.on("request", (request) => {
  const attemptId = requestAttemptId(request);
  const url = new URL(request.url());
  if (url.pathname.includes("/v2/sessions/current/data/fields/")) {
    fieldRequests.push({
      method: request.method(),
      observedAt: performance.now(),
      attemptId,
      url: `${url.pathname}${url.search}`,
    });
  }
});
page.on("requestfailed", (request) => {
  const attemptId = requestAttemptId(request);
  const url = new URL(request.url());
  if (!url.pathname.includes("/v2/sessions/current/data/fields/")) return;
  const errorText = request.failure()?.errorText ?? "unknown error";
  const intentionalStaleInflightAbort =
    errorText === "net::ERR_ABORTED" &&
    url.pathname.endsWith("/samples/vector");
  requestFailureByAttemptId.set(attemptId, { errorText });
  fieldRequestFailures.push({
    attemptId,
    errorText,
    intentionalStaleInflightAbort,
    method: request.method(),
    observedAt: performance.now(),
    url: `${url.pathname}${url.search}`,
  });
});
page.on("response", (response) => {
  const receivedAt = performance.now();
  const attemptId = requestAttemptId(response.request());
  const url = new URL(response.url());
  const quantityPath = `/v2/sessions/current/data/fields/${selectedQuantity}`;
  if (!url.pathname.includes(quantityPath)) return;
  const task = (async () => {
    const contentType = response.headers()["content-type"] ?? "";
    const attempt = {
      attemptId,
      contentType,
      encoding: response.headers()["x-fullmag-encoding"] ?? null,
      etag: response.headers().etag ?? null,
      fieldRevision: response.headers()["x-fullmag-field-revision"] ?? null,
      quantityId: response.headers()["x-fullmag-quantity-id"] ?? null,
      receivedAt,
      scopeId: response.headers()["x-fullmag-scope-id"] ?? null,
      scopeKind: response.headers()["x-fullmag-scope-kind"] ?? null,
      status: response.status(),
      url: response.url(),
    };
    fieldResponseAttempts.push(attempt);
    if (!response.ok() || !contentType.includes("application/octet-stream")) return;
    if (attempt.quantityId && attempt.quantityId !== selectedQuantity) {
      throw new Error(
        `field response quantity mismatch: expected ${selectedQuantity}, got ${attempt.quantityId}`,
      );
    }
    const payload = Buffer.from(await response.body());
    fieldResponses.push({
      ...canonicalFmvpHashes(payload),
      ...attempt,
      receivedAt,
      responseUrl: response.url(),
    });
  })().catch((error) => {
    fieldResponseInspectionFailures.push({
      attemptId,
      errorMessage: error.message,
      receivedAt,
      requestFailure: response.request().failure(),
      responseUrl: response.url(),
    });
  });
  responseTasks.add(task);
  void task.finally(() => responseTasks.delete(task));
});

try {
  if (mode === "full_cache") {
    selectedDisplay = await patchJson("/v2/sessions/current/visualization/display", {
      active_quantity_id: selectedQuantity,
      vector_density: cadence,
    });
    if (selectedDisplay.active_quantity_id !== selectedQuantity) {
      throw new Error(`display patch did not select ${selectedQuantity}: ${JSON.stringify(selectedDisplay)}`);
    }
  }
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
  console.log("FEM preview browser observer ready");
  await waitForRunningStage();
  let preterminalResponse = null;
  let preterminalCanvasSha256 = null;
  let preterminalMaterializationState = null;
  let retainedCanvasSha256 = null;
  let retainedMaterializationState = null;
  if (mode === "full_cache") {
    const preterminalMeta = await poll("pre-terminal pending/stale field metadata", async () => {
      const execution = await getJsonOrNull(
        "/v2/sessions/current/simulation/stages/execution",
      );
      recordExecutionObservation("preterminal", execution);
      if (executionIsTerminal(execution)) return null;
      const value = await getJsonOrNull(
        `/v2/sessions/current/data/fields/${encodeURIComponent(selectedQuantity)}/meta`,
      );
      return isPreterminalPendingOrStaleField(value, expectedSourceStep)
        ? value
        : null;
    });
    preterminalMaterializationState = preterminalMeta.state;
    preterminalCanvasSha256 = createHash("sha256")
      .update(await canvas.screenshot())
      .digest("hex");
    const preterminalContext = await readCanvasContext(canvas);
    if (preterminalContext.contextLost || preterminalContext.width <= 0 || preterminalContext.height <= 0) {
      throw new Error(
        `viewport lost its pre-terminal pending/stale frame: ${JSON.stringify(preterminalContext)}`,
      );
    }
  } else if (mode !== "disabled") {
    preterminalResponse = await poll("pre-terminal viewport field response", async () => {
      await Promise.all([...responseTasks]);
      const execution = await getJsonOrNull(
        "/v2/sessions/current/simulation/stages/execution",
      );
      recordExecutionObservation("preterminal", execution);
      return selectPreterminalFieldResponse(
        fieldResponses,
        firstTerminalObservedAt,
      );
    });
    preterminalCanvasSha256 = createHash("sha256")
      .update(await canvas.screenshot())
      .digest("hex");
    const preterminalContext = await readCanvasContext(canvas);
    if (preterminalContext.contextLost || preterminalContext.width <= 0 || preterminalContext.height <= 0) {
      throw new Error(
        `viewport lost its pre-terminal field frame: ${JSON.stringify(preterminalContext)}`,
      );
    }
    if (requireRetainedInterval) {
      const retainedMeta = await poll("pending/stale retained-frame interval", async () => {
        const execution = await getJsonOrNull(
          "/v2/sessions/current/simulation/stages/execution",
        );
        if (executionIsTerminal(execution)) return null;
        const value = await getJsonOrNull(
          `/v2/sessions/current/data/fields/${encodeURIComponent(selectedQuantity)}/meta`,
        );
        return value &&
          ["pending", "stale_complete", "superseded"].includes(value.state) &&
          value.source_step < expectedSourceStep
          ? value
          : null;
      });
      retainedMaterializationState = retainedMeta.state;
      retainedCanvasSha256 = createHash("sha256")
        .update(await canvas.screenshot())
        .digest("hex");
      const retainedContext = await readCanvasContext(canvas);
      if (
        retainedContext.contextLost ||
        retainedContext.width <= 0 ||
        retainedContext.height <= 0
      ) {
        throw new Error(
          `viewport lost its frame during ${retainedMeta.state}: ${JSON.stringify(retainedContext)}`,
        );
      }
    }
  }
  await waitForTerminalStage();
  const solverProfile = await getJson("/v2/sessions/current/diagnostics/solver-profile");
  let meta = null;
  let maskSha256 = null;
  let payloadSha256 = null;
  let proofResponse = preterminalResponse;
  let terminalCanvasSha256 = null;
  let terminalFieldResponseObserved = null;
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
    if (mode === "full_cache") {
      proofResponse = await poll("terminal viewport field response", async () => {
        await Promise.all([...responseTasks]);
        return selectTerminalFieldResponse(
          fieldResponses,
          firstTerminalObservedAt,
        );
      });
      terminalFieldResponseObserved = true;
      terminalCanvasSha256 = createHash("sha256")
        .update(await canvas.screenshot())
        .digest("hex");
    }
    maskSha256 = proofResponse.maskSha256;
    payloadSha256 = proofResponse.payloadSha256;
  }

  await Promise.all([...responseTasks]);
  for (const failure of fieldRequestFailures) {
    if (!failure.intentionalStaleInflightAbort) {
      failure.intentionalStaleInflightAbort =
        classifyFieldRequestFailure({
          failure,
          firstTerminalObservedAt,
          responseAttempts: fieldResponseAttempts,
          validResponses: fieldResponses,
        }).intentionalStaleInflightAbort;
    }
    if (!failure.intentionalStaleInflightAbort) {
      errors.push(
        `field request failed: ${failure.method} ${failure.url}: ${failure.errorText}`,
      );
    }
  }
  for (const failure of fieldResponseInspectionFailures) {
    const requestFailure =
      failure.requestFailure ??
      requestFailureByAttemptId.get(failure.attemptId) ??
      null;
    const classification = classifyFieldResponseInspectionFailure({
      ...failure,
      requestFailure,
      requestFailureAttemptId: requestFailure ? failure.attemptId : null,
      validResponses: fieldResponses,
    });
    failure.intentionalStaleInflightAbort =
      classification.intentionalStaleInflightAbort;
    if (!classification.intentionalStaleInflightAbort) {
      errors.push(`field response inspection failed: ${failure.errorMessage}`);
    }
  }

  context = await canvas.evaluate((node) => {
    const gl = node.getContext("webgl2") ?? node.getContext("webgl");
    return {
      contextLost: gl?.isContextLost() ?? true,
      height: gl?.drawingBufferHeight ?? 0,
      width: gl?.drawingBufferWidth ?? 0,
    };
  });
  if (context.contextLost || context.width <= 0 || context.height <= 0) {
    throw new Error(`viewport lost its rendered frame: ${JSON.stringify(context)}`);
  }

  if (errors.length > 0) {
    throw new Error(`browser errors:\n${errors.join("\n")}`);
  }
  console.log(
    `FEM preview browser proof: ${JSON.stringify({
      cadence,
      consoleErrorCount: consoleErrors.length,
      context,
      fieldRequestCount: fieldRequests.length,
      fieldRequestFailureCount: fieldRequestFailures.length,
      fieldRequestFailureUrls: [
        ...new Set(fieldRequestFailures.map((failure) => failure.url)),
      ],
      firstTerminalObservedAt,
      intentionalFieldResponseInspectionAbortCount:
        fieldResponseInspectionFailures.filter(
          (failure) => failure.intentionalStaleInflightAbort,
        ).length,
      materializationState: meta?.state ?? null,
      maskSha256,
      mode,
      observedBeforeTerminal: mode === "disabled" ? null : true,
      pageErrorCount: pageErrors.length,
      payloadSha256,
      preterminalCanvasSha256,
      preterminalMaterializationState,
      responseBodySha256: proofResponse?.bodySha256 ?? null,
      responseEncoding: proofResponse?.encoding ?? null,
      responseEtag: proofResponse?.etag ?? null,
      responseFieldRevision: proofResponse?.fieldRevision ?? null,
      responseReceivedAt: proofResponse?.receivedAt ?? null,
      responseUrl: proofResponse?.responseUrl ?? null,
      retainedCanvasSha256,
      retainedFrameObserved: requireRetainedInterval ? true : null,
      retainedMaterializationState,
      terminalCanvasSha256,
      terminalFieldResponseObserved,
      sourceRevision: meta?.source_revision ?? null,
      sourceStep: meta?.source_step ?? null,
      unexpectedFieldRequestFailureCount: fieldRequestFailures.filter(
        (failure) => !failure.intentionalStaleInflightAbort,
      ).length,
      unexpectedFieldResponseInspectionFailureCount:
        fieldResponseInspectionFailures.filter(
          (failure) => !failure.intentionalStaleInflightAbort,
        ).length,
    })}`,
  );
} catch (error) {
  console.error(
    `FEM preview browser diagnostics: ${JSON.stringify({
      consoleErrors,
      errors,
      fieldRequests,
      fieldRequestFailures,
      fieldResponseAttempts,
      fieldResponseInspectionFailures,
      fieldResponses: fieldResponses.map(({ bodySha256, maskSha256, payloadSha256, receivedAt, responseUrl }) => ({
        bodySha256,
        maskSha256,
        payloadSha256,
        receivedAt,
        responseUrl,
      })),
      firstTerminalObservedAt,
      mode,
      pageLifecycle,
      pageErrors,
      selectedDisplay,
      selectedQuantity,
      stageObservations,
    })}`,
  );
  throw error;
} finally {
  await browser.close();
}

function requestAttemptId(request) {
  let attemptId = requestAttemptIds.get(request);
  if (!attemptId) {
    requestAttemptSequence += 1;
    attemptId = `request-${requestAttemptSequence}`;
    requestAttemptIds.set(request, attemptId);
  }
  return attemptId;
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
    bodySha256: createHash("sha256").update(payload).digest("hex"),
    maskSha256: createHash("sha256").update(mask).digest("hex"),
    payloadSha256: createHash("sha256").update(payload.subarray(valueOffset)).digest("hex"),
  };
}

async function readCanvasContext(canvas) {
  return canvas.evaluate((node) => {
    const gl = node.getContext("webgl2") ?? node.getContext("webgl");
    return {
      contextLost: gl?.isContextLost() ?? true,
      height: gl?.drawingBufferHeight ?? 0,
      width: gl?.drawingBufferWidth ?? 0,
    };
  });
}

function executionIsTerminal(execution) {
  const stages = execution?.stages ?? [];
  return stages.length > 0 &&
    stages.every((stage) =>
      ["completed", "failed", "cancelled", "rejected", "skipped"].includes(stage.status),
    );
}

async function waitForTerminalStage() {
  return poll("terminal FEM stage", async () => {
    const execution = await getJsonOrNull(
      "/v2/sessions/current/simulation/stages/execution",
    );
    recordExecutionObservation("terminal", execution);
    return executionIsTerminal(execution) ? execution : null;
  });
}

async function waitForRunningStage() {
  return poll("running FEM stage", async () => {
    const execution = await getJsonOrNull(
      "/v2/sessions/current/simulation/stages/execution",
    );
    recordExecutionObservation("running", execution);
    const stages = execution?.stages ?? [];
    return stages.some((stage) => ["running", "stopping"].includes(stage.status))
      ? execution
      : null;
  });
}

function recordExecutionObservation(phase, execution) {
  const observedAt = performance.now();
  const terminal = executionIsTerminal(execution);
  firstTerminalObservedAt = observeFirstTerminalAt(
    firstTerminalObservedAt,
    terminal,
    observedAt,
  );
  const stages = (execution?.stages ?? []).map((stage) => ({
    id: stage.id ?? stage.stage_id ?? null,
    status: stage.status ?? null,
  }));
  const signature = JSON.stringify(stages);
  const previous = stageObservations.at(-1);
  if (!previous || previous.signature !== signature) {
    stageObservations.push({ observedAt, phase, signature, stages, terminal });
  }
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
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
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
