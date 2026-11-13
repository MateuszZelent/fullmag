const MAX_ACTION_TIMEOUT_MS = 30_000;
const MAX_EXPORT_DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_RESTORE_ACTION_TIMEOUT_MS = 3_000;
const MAX_BUFFER_RESTORE_TIMEOUT_MS = 8_000;
const CAPTURE_DIMENSION_TOLERANCE_PX = 1;
const INTERACTIVE_DPR = 1.25;

const BACKGROUND_OPTIONS = Object.freeze({
  matchViewport: "Match viewport",
  transparent: "Transparent",
});
const FRAME_OPTIONS = Object.freeze({
  floor: "Floor",
  off: "Off",
});

export async function runViewportExportBrowserQa(page, {
  assertCanvas,
  pngDecoder,
  timeout = 15_000,
  expectedCaptureDpr,
}) {
  if (typeof assertCanvas !== "function") {
    throw new Error("Viewport export QA requires the managed canvas assertion");
  }
  if (typeof pngDecoder?.sync?.read !== "function") {
    throw new Error("Pinned Playwright utilsBundle does not expose PNG.sync.read");
  }
  if (expectedCaptureDpr !== undefined &&
      (!Number.isFinite(expectedCaptureDpr) || expectedCaptureDpr <= 0)) {
    throw new Error("expectedCaptureDpr must be a finite positive number when supplied");
  }

  const timeoutMs = Number.isFinite(timeout) && timeout > 0
    ? Math.min(timeout, MAX_ACTION_TIMEOUT_MS)
    : 15_000;
  const routeBefore = page.url();
  const viewport = page.locator(".fm-viewport-3d");
  const dialog = page.getByRole("dialog", { name: "3D View Settings", exact: true });
  const originalDialogOpen = await dialog.isVisible().catch(() => false);
  let originalSettings = null;
  let canvasHandle = null;
  let operationError = null;
  let failureDiagnostics = null;
  const restorationErrors = [];
  let result = null;

  try {
    await viewport.waitFor({ state: "visible", timeout: timeoutMs });
    await withTimeout(assertCanvas("before viewport PNG export QA"), timeoutMs, "initial canvas assertion");
    await ensureSettingsOpen(page, dialog, timeoutMs);
    originalSettings = await readSettings(page, dialog, timeoutMs);
    if (expectedCaptureDpr === 2 && originalSettings.quality !== "Interactive") {
      throw new Error(
        "A 2x capture-resolution check requires the Interactive quality profile as its 1.25x baseline; found " +
        originalSettings.quality,
      );
    }
    if (expectedCaptureDpr !== undefined) {
      canvasHandle = await viewport.locator("canvas").first().elementHandle();
      if (!canvasHandle) throw new Error("Could not retain the viewport canvas for capture-resolution QA");
    }

    if (expectedCaptureDpr !== undefined) {
      await choose(page, "PNG resolution", `${expectedCaptureDpr}× viewport`, "fm-view-export-scale", timeoutMs);
    }
    if (originalSettings.frame !== FRAME_OPTIONS.floor) {
      await choose(page, "Reference frame", FRAME_OPTIONS.floor, "fm-view-frame", timeoutMs);
    }
    await choose(
      page,
      "PNG background",
      BACKGROUND_OPTIONS.matchViewport,
      "fm-view-export-background",
      timeoutMs,
    );
    await setAnnotations(page, dialog, true, timeoutMs);
    await waitForRenderedFrame(page);
    const opaqueWithAnnotations = await exportPng(page, dialog, {
      assertCanvas,
      expectedQuality: originalSettings.quality,
      label: "opaque with annotations",
      pngDecoder,
      canvasHandle,
      expectedCaptureDpr,
      timeout: timeoutMs,
    });
    const opaqueWithAnnotationsStats = assertOpaquePng(
      opaqueWithAnnotations.decoded,
      "opaque export with annotations",
    );

    await setAnnotations(page, dialog, false, timeoutMs);
    await waitForRenderedFrame(page);
    const opaqueWithoutAnnotations = await exportPng(page, dialog, {
      assertCanvas,
      expectedQuality: originalSettings.quality,
      label: "opaque without annotations",
      pngDecoder,
      canvasHandle,
      expectedCaptureDpr,
      timeout: timeoutMs,
    });
    const opaqueWithoutAnnotationsStats = assertOpaquePng(
      opaqueWithoutAnnotations.decoded,
      "opaque export without annotations",
    );
    const annotationDifference = compareRasters(
      opaqueWithAnnotations.decoded,
      opaqueWithoutAnnotations.decoded,
    );
    if (annotationDifference.changedPixels === 0) {
      throw new Error("Toggling Include annotations did not change the downloaded opaque PNG");
    }

    await choose(
      page,
      "PNG background",
      BACKGROUND_OPTIONS.transparent,
      "fm-view-export-background",
      timeoutMs,
    );
    await choose(page, "Reference frame", FRAME_OPTIONS.off, "fm-view-frame", timeoutMs);
    await setAnnotations(page, dialog, false, timeoutMs);
    await waitForRenderedFrame(page);
    const transparentWithoutAnnotations = await exportPng(page, dialog, {
      assertCanvas,
      expectedQuality: originalSettings.quality,
      label: "transparent geometry",
      pngDecoder,
      canvasHandle,
      expectedCaptureDpr,
      timeout: timeoutMs,
    });
    const transparentStats = assertTransparentGeometryPng(
      transparentWithoutAnnotations.decoded,
    );

    const qualityAfter = await readChoice(page, "Render quality", timeoutMs);
    if (qualityAfter !== originalSettings.quality) {
      throw new Error(
        "Export changed the selected render quality from " +
        originalSettings.quality +
        " to " +
        qualityAfter,
      );
    }
    const routeAfter = page.url();
    if (routeAfter !== routeBefore) {
      throw new Error("Export changed the workspace route from " + routeBefore + " to " + routeAfter);
    }

    result = {
      downloads: {
        opaque_with_annotations: {
          filename: opaqueWithAnnotations.filename,
          ...opaqueWithAnnotationsStats,
          ...(opaqueWithAnnotations.captureResolution
            ? { capture_resolution: opaqueWithAnnotations.captureResolution }
            : {}),
        },
        opaque_without_annotations: {
          filename: opaqueWithoutAnnotations.filename,
          ...opaqueWithoutAnnotationsStats,
          ...(opaqueWithoutAnnotations.captureResolution
            ? { capture_resolution: opaqueWithoutAnnotations.captureResolution }
            : {}),
        },
        transparent_without_annotations: {
          filename: transparentWithoutAnnotations.filename,
          ...transparentStats,
          ...(transparentWithoutAnnotations.captureResolution
            ? { capture_resolution: transparentWithoutAnnotations.captureResolution }
            : {}),
        },
      },
      annotations: {
        toggled_through_settings_switch: true,
        changed_pixels: annotationDifference.changedPixels,
        total_pixels: annotationDifference.totalPixels,
      },
      render_quality: {
        before: originalSettings.quality,
        after: qualityAfter,
        preserved: true,
      },
      route: {
        before: routeBefore,
        after: routeAfter,
        unchanged: true,
      },
      session: {
        mutations_requested: false,
        reload_or_navigation_performed: false,
        direct_identity_sampled: false,
        note: "This helper uses only viewport settings and export UI; the managed outer QA owns session identity checks.",
      },
      png_decode: {
        method: "download.createReadStream() decoded in memory by pinned PNG.sync.read",
        screenshot_written_to_disk: false,
      },
      original_settings_restored: false,
      original_dialog_open_state_restored: false,
    };
  } catch (error) {
    operationError = error;
    failureDiagnostics = await collectFailureDiagnostics({
      assertCanvas,
      dialog,
      page,
      routeBefore,
      timeout: timeoutMs,
    });
  } finally {
    const restoreTimeoutMs = Math.min(timeoutMs, MAX_RESTORE_ACTION_TIMEOUT_MS);
    if (originalSettings) {
      await restoreSetting(restorationErrors, "open settings", async () => {
        await ensureSettingsOpen(page, dialog, restoreTimeoutMs);
      });
      await restoreSetting(restorationErrors, "reference frame", async () => {
        await choose(page, "Reference frame", originalSettings.frame, "fm-view-frame", restoreTimeoutMs);
      });
      await restoreSetting(restorationErrors, "PNG background", async () => {
        await choose(
          page,
          "PNG background",
          originalSettings.background,
          "fm-view-export-background",
          restoreTimeoutMs,
        );
      });
      await restoreSetting(restorationErrors, "PNG resolution", async () => {
        await choose(page, "PNG resolution", originalSettings.scale, "fm-view-export-scale", restoreTimeoutMs);
      });
      await restoreSetting(restorationErrors, "Include annotations", async () => {
        await setAnnotations(page, dialog, originalSettings.annotations, restoreTimeoutMs);
      });
      await restoreSetting(restorationErrors, "render quality", async () => {
        const quality = await readChoice(page, "Render quality", restoreTimeoutMs);
        if (quality !== originalSettings.quality) {
          throw new Error("expected " + originalSettings.quality + ", found " + quality);
        }
      });
      await restoreSetting(restorationErrors, "settings verification", async () => {
        const restored = await readSettings(page, dialog, restoreTimeoutMs);
        if (!sameSettings(originalSettings, restored)) {
          throw new Error(
            "expected " +
            JSON.stringify(originalSettings) +
            ", found " +
            JSON.stringify(restored),
          );
        }
      });
    }

    if (originalDialogOpen) {
      await restoreSetting(restorationErrors, "original dialog-open state", async () => {
        await ensureSettingsOpen(page, dialog, restoreTimeoutMs);
      });
    } else {
      await restoreSetting(restorationErrors, "original dialog-closed state", async () => {
        if (await dialog.isVisible().catch(() => false)) {
          await dialog.getByRole("button", { name: "Close", exact: true }).click({ timeout: restoreTimeoutMs });
          await dialog.waitFor({ state: "hidden", timeout: restoreTimeoutMs });
        }
      });
    }

    if (page.url() !== routeBefore) {
      restorationErrors.push("workspace route changed from " + routeBefore + " to " + page.url());
    }
    if (canvasHandle) {
      await restoreSetting(restorationErrors, "capture canvas handle", async () => {
        await canvasHandle.dispose();
      });
    }
  }

  if (operationError || restorationErrors.length) {
    const details = failureDiagnostics
      ? " Observed failure state: " + JSON.stringify(failureDiagnostics) + "."
      : "";
    const restoration = restorationErrors.length
      ? " Settings restoration issues: " + restorationErrors.join("; ") + "."
      : "";
    throw new Error(
      "Viewport export browser QA " +
      (operationError ? "failed" : "restoration failed") +
      ": " +
      (operationError?.message ?? "no export error") +
      details +
      restoration,
    );
  }

  result.original_settings_restored = true;
  result.original_dialog_open_state_restored = true;
  return result;
}

async function ensureSettingsOpen(page, dialog, timeout) {
  if (await dialog.isVisible().catch(() => false)) return;
  const button = page.getByRole("button", { name: /view settings/i });
  await button.waitFor({ state: "visible", timeout });
  await button.click({ timeout });
  await dialog.waitFor({ state: "visible", timeout });
}

async function readSettings(page, dialog, timeout) {
  const [background, annotations, quality, frame, scale] = await Promise.all([
    readChoice(page, "PNG background", timeout),
    dialog.getByRole("switch", { name: "Include annotations", exact: true }).isChecked({ timeout }),
    readChoice(page, "Render quality", timeout),
    readChoice(page, "Reference frame", timeout),
    readChoice(page, "PNG resolution", timeout),
  ]);
  if (!Object.values(BACKGROUND_OPTIONS).includes(background)) {
    throw new Error("PNG background control exposed an unknown option: " + background);
  }
  if (!Object.values(FRAME_OPTIONS).includes(frame) && frame !== "Floor and vertical planes") {
    throw new Error("Reference frame control exposed an unknown option: " + frame);
  }
  return { annotations, background, frame, quality, scale };
}

async function readChoice(page, label, timeout = MAX_ACTION_TIMEOUT_MS) {
  return normalizeText(
    await page.getByRole("combobox", { name: label, exact: true }).innerText({ timeout }),
  );
}

async function choose(page, label, option, controlId, timeout) {
  const trigger = page.getByRole("combobox", { name: label, exact: true });
  if (await readChoice(page, label, timeout) === option) return;
  await trigger.scrollIntoViewIfNeeded({ timeout });
  await trigger.click({ timeout });
  await page.getByRole("option", { name: option, exact: true }).click({ timeout });
  await page.waitForFunction(({ id, expected }) => {
    const control = document.getElementById(id);
    return normalize(control?.textContent ?? "") === expected;
    function normalize(value) {
      return value.replace(/\s+/g, " ").trim();
    }
  }, { id: controlId, expected: option }, { timeout });
}

async function setAnnotations(page, dialog, enabled, timeout) {
  const control = dialog.getByRole("switch", {
    name: "Include annotations",
    exact: true,
  });
  if (await control.isChecked({ timeout }) !== enabled) await control.click({ timeout });
  await page.waitForFunction((expected) =>
    document.getElementById("fm-view-export-annotations")?.checked === expected,
  enabled, { timeout });
}

async function exportPng(page, dialog, {
  assertCanvas,
  canvasHandle,
  expectedQuality,
  expectedCaptureDpr,
  label,
  pngDecoder,
  timeout,
}) {
  const button = dialog.getByRole("button", { name: "Export PNG", exact: true });
  await button.scrollIntoViewIfNeeded({ timeout });
  const canvasBaseline = expectedCaptureDpr === undefined
    ? null
    : await readCanvasCaptureBaseline(canvasHandle);
  const downloadTimeout = Math.min(timeout, MAX_EXPORT_DOWNLOAD_TIMEOUT_MS);
  const downloadPromise = page.waitForEvent("download", { timeout: downloadTimeout });
  const [download] = await Promise.all([
    downloadPromise,
    button.click({ timeout }),
  ]);
  await dialog.waitFor({ state: "hidden", timeout });
  await withTimeout(assertCanvas("viewport PNG export " + label), timeout, "canvas assertion after " + label);
  const failure = await withTimeout(download.failure(), downloadTimeout, "download completion for " + label);
  if (failure) throw new Error("PNG download failed: " + failure);

  const stream = await withTimeout(download.createReadStream(), downloadTimeout, "download stream for " + label);
  if (!stream) throw new Error("Playwright did not expose an in-memory stream for the PNG download");
  let bytes;
  try {
    bytes = await withTimeout(readStreamToBuffer(stream), downloadTimeout, "download read for " + label);
  } catch (error) {
    stream.destroy();
    throw error;
  }
  if (bytes.length === 0) throw new Error("PNG download was empty");
  const decoded = pngDecoder.sync.read(bytes);
  validateDecodedPng(decoded, label);
  const captureResolution = expectedCaptureDpr === undefined
    ? null
    : await verifyCaptureResolution(page, {
        baseline: canvasBaseline,
        canvasHandle,
        decoded,
        expectedDpr: expectedCaptureDpr,
        label,
        timeout,
      });
  const filename = download.suggestedFilename();
  if (filename !== "fullmag-viewport-3d.png") {
    throw new Error("Unexpected PNG download filename: " + filename);
  }

  await ensureSettingsOpen(page, dialog, timeout);
  const quality = await readChoice(page, "Render quality", timeout);
  if (quality !== expectedQuality) {
    throw new Error(
      "Render quality was not restored after " +
      label +
      ": expected " +
      expectedQuality +
      ", found " +
      quality,
    );
  }
  return { captureResolution, decoded, filename };
}

async function readCanvasCaptureBaseline(canvasHandle) {
  if (!canvasHandle) throw new Error("Capture-resolution QA requires the retained viewport canvas");
  const snapshot = await canvasHandle.evaluate((canvas) => {
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    const rect = canvas.getBoundingClientRect();
    return {
      connected: canvas.isConnected,
      cssRect: { height: rect.height, width: rect.width },
      canvasSize: { height: canvas.height, width: canvas.width },
      drawingBuffer: {
        height: context?.drawingBufferHeight ?? 0,
        width: context?.drawingBufferWidth ?? 0,
      },
      contextAvailable: Boolean(context),
      contextLost: context?.isContextLost() ?? true,
    };
  });
  if (!snapshot.connected || !snapshot.contextAvailable || snapshot.contextLost ||
      snapshot.cssRect.width <= 0 || snapshot.cssRect.height <= 0 ||
      snapshot.drawingBuffer.width <= 0 || snapshot.drawingBuffer.height <= 0) {
    throw new Error("Viewport canvas did not have a healthy non-empty drawing buffer before export");
  }
  if (snapshot.canvasSize.width !== snapshot.drawingBuffer.width ||
      snapshot.canvasSize.height !== snapshot.drawingBuffer.height) {
    throw new Error("Viewport canvas dimensions did not match its WebGL drawing buffer before export");
  }
  return snapshot;
}

async function verifyCaptureResolution(page, {
  baseline,
  canvasHandle,
  decoded,
  expectedDpr,
  label,
  timeout,
}) {
  if (!baseline) throw new Error("Missing pre-export canvas baseline for " + label);
  if (expectedDpr === 2) {
    assertBufferDimensions(
      baseline.drawingBuffer,
      baseline.cssRect,
      INTERACTIVE_DPR,
      "Interactive baseline",
      label,
    );
  }
  assertPngDimensions(decoded, baseline.cssRect, expectedDpr, "capture", label);

  const waitTimeout = Math.min(timeout, MAX_BUFFER_RESTORE_TIMEOUT_MS);
  const restoredHandle = await page.waitForFunction(({ width, height }) => {
    const canvas = document.querySelector(".fm-viewport-3d canvas");
    const context = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    return Boolean(
      canvas?.isConnected &&
      canvas.width === width &&
      canvas.height === height &&
      context &&
      !context.isContextLost() &&
      context.drawingBufferWidth === width &&
      context.drawingBufferHeight === height,
    );
  }, baseline.drawingBuffer, { timeout: waitTimeout, polling: 50 }).catch((error) => {
    throw new Error(
      "Viewport drawing buffer did not return to its pre-export Interactive dimensions after " +
      label +
      ": " +
      (error?.message ?? String(error)),
    );
  });
  await restoredHandle.dispose();

  const sameCanvasAndHealthy = await canvasHandle.evaluate((canvas) => {
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    return canvas === document.querySelector(".fm-viewport-3d canvas") &&
      canvas.isConnected &&
      Boolean(context) &&
      !context.isContextLost();
  });
  if (!sameCanvasAndHealthy) {
    throw new Error("Viewport canvas was replaced or its WebGL context was lost after " + label);
  }
  const restored = await readCanvasCaptureBaseline(canvasHandle);
  if (restored.drawingBuffer.width !== baseline.drawingBuffer.width ||
      restored.drawingBuffer.height !== baseline.drawingBuffer.height) {
    throw new Error(
      "Viewport drawing buffer changed after " +
      label +
      ": expected " +
      baseline.drawingBuffer.width +
      "x" +
      baseline.drawingBuffer.height +
      ", found " +
      restored.drawingBuffer.width +
      "x" +
      restored.drawingBuffer.height,
    );
  }
  return {
    expected_capture_dpr: expectedDpr,
    css_rect: baseline.cssRect,
    baseline_drawing_buffer: baseline.drawingBuffer,
    png: { height: decoded.height, width: decoded.width },
    restored_drawing_buffer: restored.drawingBuffer,
    canvas_node_preserved: true,
    context_healthy: true,
  };
}

function assertPngDimensions(decoded, cssRect, dpr, phase, label) {
  assertBufferDimensions({ width: decoded.width, height: decoded.height }, cssRect, dpr, phase, label);
}

function assertBufferDimensions(dimensions, cssRect, dpr, phase, label) {
  const expected = {
    width: Math.floor(cssRect.width * dpr),
    height: Math.floor(cssRect.height * dpr),
  };
  const widthDelta = Math.abs(dimensions.width - expected.width);
  const heightDelta = Math.abs(dimensions.height - expected.height);
  if (widthDelta > CAPTURE_DIMENSION_TOLERANCE_PX ||
      heightDelta > CAPTURE_DIMENSION_TOLERANCE_PX) {
    throw new Error(
      "Viewport " + label + " dimensions did not match the " + phase + " DPR " + dpr +
      " dimensions: expected " + expected.width + "x" + expected.height +
      " ±" + CAPTURE_DIMENSION_TOLERANCE_PX + "px, found " + dimensions.width + "x" + dimensions.height,
    );
  }
}

function validateDecodedPng(decoded, label) {
  const { data, height, width } = decoded ?? {};
  if (!ArrayBuffer.isView(data) || !Number.isInteger(width) || width <= 0 ||
      !Number.isInteger(height) || height <= 0 || data.byteLength !== width * height * 4) {
    throw new Error("Downloaded " + label + " PNG did not decode to non-empty RGBA pixels");
  }
}

function assertOpaquePng(decoded, label) {
  validateDecodedPng(decoded, label);
  const { data, height, width } = decoded;
  let opaquePixels = 0;
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] === 255) opaquePixels += 1;
  }
  const totalPixels = width * height;
  if (opaquePixels !== totalPixels) {
    throw new Error(
      label +
      " should have an opaque PNG background; " +
      (totalPixels - opaquePixels) +
      " pixels were not alpha 255",
    );
  }
  return { width, height, alpha_255_pixels: opaquePixels, nonempty: data.length > 0 };
}

function assertTransparentGeometryPng(decoded) {
  validateDecodedPng(decoded, "transparent export");
  const { data, height, width } = decoded;
  let transparentPixels = 0;
  let visiblePixels = 0;
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] === 0) transparentPixels += 1;
    if (data[offset] > 0) visiblePixels += 1;
  }
  if (transparentPixels === 0 || visiblePixels === 0) {
    throw new Error(
      "Transparent PNG must contain transparent background and visible scene geometry; " +
      "alpha=0 pixels: " +
      transparentPixels +
      ", visible pixels: " +
      visiblePixels,
    );
  }
  return {
    width,
    height,
    transparent_pixels: transparentPixels,
    visible_scene_pixels_without_annotations: visiblePixels,
    geometry_visible: true,
  };
}

function compareRasters(left, right) {
  validateDecodedPng(left, "annotation-on export");
  validateDecodedPng(right, "annotation-off export");
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error("Annotation export images have different dimensions");
  }
  let changedPixels = 0;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    if (
      Math.abs(left.data[offset] - right.data[offset]) > 2 ||
      Math.abs(left.data[offset + 1] - right.data[offset + 1]) > 2 ||
      Math.abs(left.data[offset + 2] - right.data[offset + 2]) > 2 ||
      Math.abs(left.data[offset + 3] - right.data[offset + 3]) > 2
    ) {
      changedPixels += 1;
    }
  }
  return { changedPixels, totalPixels: left.width * left.height };
}

async function waitForRenderedFrame(page) {
  await withTimeout(page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })), 5_000, "rendered-frame wait");
  await page.waitForTimeout(40);
}

async function collectFailureDiagnostics({ assertCanvas, dialog, page, routeBefore, timeout }) {
  let canvas = null;
  let canvasError = null;
  let settingsVisible = false;
  let settings = null;
  let settingsError = null;
  let alerts = [];
  try {
    canvas = await withTimeout(assertCanvas("viewport PNG export failure diagnostics"), Math.min(timeout, 5_000), "failure canvas diagnostics");
  } catch (error) {
    canvasError = error?.message ?? String(error);
  }
  try {
    settingsVisible = await dialog.isVisible();
    if (settingsVisible) settings = await readSettings(page, dialog, Math.min(timeout, 5_000));
  } catch (error) {
    settingsError = error?.message ?? String(error);
  }
  try {
    alerts = await page.getByRole("alert").allInnerTexts();
  } catch (error) {
    alerts = ["Unable to read UI alerts: " + (error?.message ?? String(error))];
  }
  return {
    route_before: routeBefore,
    route_at_failure: page.url(),
    canvas,
    canvas_error: canvasError,
    settings_dialog_visible: settingsVisible,
    settings,
    settings_error: settingsError,
    ui_alerts: alerts,
    checked_at: "natural operation failure; no failure was injected",
    timeout_ms: timeout,
  };
}

async function readStreamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function withTimeout(promise, timeout, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + " timed out after " + timeout + "ms")), timeout);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

async function restoreSetting(errors, label, operation) {
  try {
    await operation();
  } catch (error) {
    errors.push(label + ": " + (error?.message ?? String(error)));
  }
}

function sameSettings(left, right) {
  return left.annotations === right.annotations &&
    left.background === right.background &&
    left.frame === right.frame &&
    left.quality === right.quality &&
    left.scale === right.scale;
}

function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}
