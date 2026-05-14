import { inflateSync } from "node:zlib";

const url = process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
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
const keepGeometrySmokeObjects =
  process.env.CONTROL_ROOM_SMOKE_KEEP_OBJECTS === "1";
const CANVAS_SMOKE_TOP_OVERLAY_EXCLUSION_PX = 48;
const GEOMETRY_FLOW_TIMEOUT_MS = 20_000;

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
const errors = [];
const sceneResponses = [];
const realtimeMessages = [];
let sceneResponseSequence = 0;

if (apiBase) {
  await page.addInitScript((baseUrl) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: baseUrl,
    };
  }, apiBase);
}

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
  if (isModelSceneUrl(response.url()) && status < 400) {
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

  if (status < 400 || isAllowedMissingSessionResponse(response.url(), status)) {
    return;
  }

  errors.push(`${status} ${response.url()}`);
});

try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const canvas = page.locator(".fm-viewport-3d canvas");
  await canvas.waitFor({ state: "visible", timeout: 15_000 });
  await canvas.evaluate((node) =>
    new Promise((resolve) => {
      const deadline = performance.now() + 5_000;
      const ready = () => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const tick = () => {
        if (ready() || performance.now() > deadline) {
          resolve(undefined);
          return;
        }
        requestAnimationFrame(tick);
      };
      if (ready()) {
        resolve(undefined);
        return;
      }
      requestAnimationFrame(tick);
    }),
  );

  const hasContext = await canvas.evaluate((node) => {
    const canvasNode = node;
    const context = canvasNode.getContext("webgl2") ?? canvasNode.getContext("webgl");
    return Boolean(context);
  });
  const drawingBuffer = await canvas.evaluate((node) => {
    const canvasNode = node;
    const context = canvasNode.getContext("webgl2") ?? canvasNode.getContext("webgl");
    return {
      height: context?.drawingBufferHeight ?? 0,
      width: context?.drawingBufferWidth ?? 0,
    };
  });
  const pixelSample = await sampleCanvasComposite(page, canvas);

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
    throw new Error(`Browser console errors:\n${errors.join("\n")}`);
  }
  if (requireGeometryFlow) {
    await verifyGeometryAuthoringFlow({
      canvas,
      canvasBaseline: pixelSample,
      page,
      realtimeMessages,
      sceneResponses,
    });
  }

  console.log(`Viewport 3D smoke passed at ${url}.`);
} finally {
  await browser.close();
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
    await fillDraftField(page, "X", "9e-7");
    await fillDraftField(page, "Y", "7e-7");
    await fillDraftField(page, "Z", "1e-7");
    await fillDraftField(page, "TX", "-1.6e-6");

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
    let createdObject = findCreatedObject(
      sceneObjects(committedScene),
      knownObjectIds,
      objectName,
    );

    if (!createdObject) {
      const sceneWithCreatedObject = await waitForSceneResponse(
        sceneResponses,
        (record) =>
          record.sequence >= sceneSequenceBeforeCommit &&
          sceneObjects(record.body).some((object) => sceneObjectName(object) === objectName),
        "model/scene refetch containing the committed smoke object",
      );
      cleanupRevision = sceneRevision(sceneWithCreatedObject.body) ?? cleanupRevision;
      createdObject = sceneObjects(sceneWithCreatedObject.body).find(
        (object) => sceneObjectName(object) === objectName,
      );
    }

    const objectId = sceneObjectId(createdObject);
    if (!objectId) {
      throw new Error("Committed geometry object has no id in SceneDocument.");
    }
    cleanupObjectIds.push(objectId);

    const uiScene = await waitForSceneResponse(
      sceneResponses,
      (record) =>
        record.sequence >= sceneSequenceBeforeCommit &&
        sceneObjects(record.body).some((object) => sceneObjectId(object) === objectId),
      "GET /v2/sessions/current/model/scene refetch after UI object commit",
    );
    cleanupRevision = sceneRevision(uiScene.body) ?? cleanupRevision;
    await verifyObjectInViewportRenderModel(page, objectId);
    await verifyObjectInExplorerViewportAndInspector(page, objectId);
    const uiCanvasSample = await waitForCanvasChange(
      page,
      canvas,
      canvasBaseline,
      "3D viewport canvas change after UI object commit",
    );

    const externalObjectName = `Smoke WS Box ${Date.now().toString(36)}`;
    const externalObjectId = `smoke-ws-${Date.now().toString(36)}`;
    const externalBaseRevision =
      sceneRevision(uiScene.body) ?? transaction.scene_revision ?? null;
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
    const realtimeSceneChange = await waitForRealtimeBatchChanged(
      realtimeMessages,
      "/v2/sessions/current/model/scene",
      "resource.batch_changed for externally committed model/scene",
      realtimeMessageStartIndex,
    );
    const externalScene = await waitForSceneResponse(
      sceneResponses,
      (record) =>
        record.sequence >= sceneSequenceBeforeExternalCommit &&
        record.timestamp >= realtimeSceneChange.timestamp &&
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
      uiCanvasSample,
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
  const viewport = page.locator(
    `.fm-viewport-3d[data-primitive-object-ids~="${cssAttributeValue(objectId)}"]`,
  );
  await viewport.waitFor({ state: "visible", timeout: GEOMETRY_FLOW_TIMEOUT_MS });
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

async function waitForCanvasChange(page, canvas, baseline, label) {
  return waitForCondition(label, async () => {
    const current = await sampleCanvasComposite(page, canvas);
    const diff = canvasCompositeDifference(baseline, current);
    if (diff.changed) return current;
    throw new Error(
      `canvas changed ${diff.changedPixels}/${diff.sampledPixels} sampled pixels; ` +
        `threshold=${diff.minimumChangedPixels}`,
    );
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

async function sampleCanvasComposite(page, canvas) {
  const box = await canvas.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      height: rect.height,
      width: rect.width,
      x: rect.x,
      y: rect.y,
    };
  });
  if (box.width <= 0 || box.height <= 0) {
    throw new Error(
      `3D viewport canvas has no measurable bounding box: ${box.width}x${box.height}.`,
    );
  }

  const background = await canvas.evaluate((node) => {
    const viewport = node.closest(".fm-viewport-3d");
    return viewport ? getComputedStyle(viewport).backgroundColor : "";
  });
  const backgroundRgb = parseCssRgb(background);
  const png = await page.screenshot({
    clip: {
      height: Math.max(
        1,
        Math.floor(box.height - CANVAS_SMOKE_TOP_OVERLAY_EXCLUSION_PX),
      ),
      width: Math.max(1, Math.floor(box.width)),
      x: Math.max(0, Math.floor(box.x)),
      y: Math.max(0, Math.floor(box.y + CANVAS_SMOKE_TOP_OVERLAY_EXCLUSION_PX)),
    },
  });
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
}

function canvasCompositeDifference(before, after) {
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
  const minimumChangedPixels = Math.max(6, Math.floor(sampledPixels * 0.005));
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
