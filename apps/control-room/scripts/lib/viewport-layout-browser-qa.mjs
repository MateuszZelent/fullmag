import { createHash } from "node:crypto";

const VIEWPORT_SELECTOR = ".fm-viewport-3d";
const CANVAS_SELECTOR = `${VIEWPORT_SELECTOR} canvas`;
const SETTINGS_DIALOG_NAME = "3D View Settings";
const THEME_STORAGE_KEY = "fullmag.control-room.theme";
const MAX_ACTION_TIMEOUT_MS = 30_000;
const MAX_RESTORE_TIMEOUT_MS = 4_000;
// Dock panels can leave less than one third of the window for the canvas.
const MAX_WINDOW_DIMENSION = 8_192;
const MIN_WINDOW_DIMENSION = 320;
const MAX_CALIBRATION_STEPS = 8;
const CANVAS_SIZE_TOLERANCE_PX = 3;
const NARROW_PNG_LIMIT_BYTES = 512 * 1024;
const TARGET_CANVAS_SIZES = Object.freeze([
  { id: "desktop", width: 1_200, height: 800 },
  { id: "narrow", width: 480, height: 320 },
]);
const THEME_PALETTES = Object.freeze([
  { mode: "dark", palette: "Mocha" },
  { mode: "light", palette: "Latte" },
]);

/**
 * Captures the real 3D canvas at two CSS sizes in both visible app themes.
 * The helper only resizes the current Playwright page and uses the app's
 * visible theme/settings controls. It does not create a browser context,
 * write screenshots to disk, or mutate viewport renderer/debug stores.
 */
export async function runViewportLayoutBrowserQa(page, options = {}) {
  const assertCanvas = options.assertCanvas;
  const pngDecoder = options.pngDecoder;
  const timeout = boundedTimeout(options.timeout);
  const expectedDpr = options.expectedDpr;
  if (typeof assertCanvas !== "function") {
    throw new Error("Viewport layout QA requires the managed canvas assertion");
  }
  if (typeof pngDecoder?.sync?.read !== "function") {
    throw new Error("Pinned Playwright utilsBundle does not expose PNG.sync.read");
  }
  if (expectedDpr !== undefined && (!Number.isFinite(expectedDpr) || expectedDpr <= 0)) {
    throw new RangeError("expectedDpr must be a positive finite number");
  }

  const originalViewport = page.viewportSize();
  if (
    !originalViewport ||
    !Number.isFinite(originalViewport.width) ||
    !Number.isFinite(originalViewport.height)
  ) {
    throw new Error("Viewport layout QA requires a fixed browser viewport");
  }
  if (
    originalViewport.width > MAX_WINDOW_DIMENSION ||
    originalViewport.height > MAX_WINDOW_DIMENSION
  ) {
    throw new RangeError(
      `Original browser viewport ${formatSize(originalViewport)} exceeds the ${MAX_WINDOW_DIMENSION}px bound`,
    );
  }

  const viewport = page.locator(VIEWPORT_SELECTOR);
  const canvas = page.locator(CANVAS_SELECTOR);
  const settingsDialog = page.getByRole("dialog", {
    exact: true,
    name: SETTINGS_DIALOG_NAME,
  });
  let originalDialogOpen = null;
  let originalTheme = null;
  let originalThemePreference = null;
  let originalThemeStorage = { available: false, value: null };
  let operationError = null;
  const restorationErrors = [];
  const captures = [];
  let initialDpr = null;

  try {
    await viewport.waitFor({ state: "visible", timeout });
    await canvas.first().waitFor({ state: "visible", timeout });
    if (await canvas.count() !== 1) {
      throw new Error("Viewport layout QA requires exactly one visible 3D canvas");
    }

    originalDialogOpen = await settingsDialog.isVisible().catch(() => false);
    originalTheme = await readThemeMode(page);
    originalThemePreference = await page.locator("html").getAttribute("data-theme-preference");
    if (!["dark", "light", "system"].includes(originalThemePreference)) throw new Error("Document omitted its theme preference");
    originalThemeStorage = await readThemePreference(page);
    initialDpr = await readDevicePixelRatio(page);
    assertExpectedDpr(initialDpr, expectedDpr, "initial browser context");
    await setDialogOpen(page, settingsDialog, false, timeout);

    for (const theme of THEME_PALETTES) {
      await switchThemeThroughUi(page, theme.mode, timeout);
      await waitForThemeAndFrame(page, theme.mode);

      for (const target of TARGET_CANVAS_SIZES) {
        const calibration = await calibrateCanvasSize(page, target, timeout);
        const capture = await captureCanvasAtSize(page, {
          assertCanvas,
          canvas,
          expectedDpr,
          pngDecoder,
          settingsDialog,
          target,
          theme,
        });
        captures.push({
          ...capture,
          calibration,
        });
      }
    }
  } catch (error) {
    operationError = error;
  } finally {
    const restoreTimeout = Math.min(timeout, MAX_RESTORE_TIMEOUT_MS);
    const restore = async (label, action) => {
      try {
        await action();
      } catch (error) {
        restorationErrors.push(`${label}: ${error?.message ?? String(error)}`);
      }
    };

    await restore("original browser viewport", async () => {
      await page.setViewportSize(originalViewport);
      await waitForLayoutFrame(page);
      const actual = page.viewportSize();
      if (!sameSize(actual, originalViewport)) {
        throw new Error(`expected ${formatSize(originalViewport)}, got ${formatSize(actual)}`);
      }
    });

    if (originalTheme !== null) {
      await restore("theme through visible UI", async () => {
        await switchThemeThroughUi(page, originalThemePreference ?? originalTheme, restoreTimeout);
        await waitForThemeAndFrame(page, originalTheme);
      });
    }
    if (originalThemeStorage.available) {
      await restore("persisted theme preference", async () => {
        await restoreThemePreference(page, originalThemeStorage.value);
      });
    }

    if (originalDialogOpen !== null) {
      await restore("original settings dialog state", async () => {
        await setDialogOpen(page, settingsDialog, originalDialogOpen, restoreTimeout);
        const actual = await settingsDialog.isVisible().catch(() => false);
        if (actual !== originalDialogOpen) {
          throw new Error(`expected open=${originalDialogOpen}, got open=${actual}`);
        }
      });
    }

    if (originalTheme !== null) {
      await restore("original theme verification", async () => {
        const actualTheme = await readThemeMode(page);
        if (actualTheme !== originalTheme) {
          throw new Error(`expected ${originalTheme}, got ${actualTheme}`);
        }
      });
    }
    if (originalThemeStorage.available) {
      await restore("persisted theme verification", async () => {
        const actual = await readThemePreference(page);
        if (!actual.available || actual.value !== originalThemeStorage.value) {
          throw new Error("the original local theme preference was not restored");
        }
      });
    }
  }

  if (operationError || restorationErrors.length) {
    const details = restorationErrors.length
      ? ` Restoration failed: ${restorationErrors.join("; ")}.`
      : "";
    const error = new Error(
      `Viewport layout QA failed: ${operationError?.message ?? "no operation error"}.${details}`,
      operationError ? { cause: operationError } : undefined,
    );
    error.partialProof = {
      captures,
      original_browser_viewport: originalViewport,
      original_dialog_open: originalDialogOpen,
      original_theme: originalTheme,
      original_theme_preference: originalThemePreference,
    };
    throw error;
  }

  return {
    schema: "fullmag.viewport-layout-browser-qa.v1",
    state: "passed",
    themes: THEME_PALETTES.map(({ mode, palette }) => ({
      mode,
      palette,
      changed_through_visible_button: true,
    })),
    expected_device_pixel_ratio: expectedDpr ?? null,
    browser_device_pixel_ratio: initialDpr,
    captures,
    restoration: {
      browser_viewport: "verified",
      original_theme: originalTheme,
      original_theme_preference: originalThemePreference,
      persisted_theme_preference: originalThemeStorage.available
        ? "restored-and-verified"
        : "not-verified-storage-unavailable",
      settings_dialog_open: originalDialogOpen,
      state: "verified",
    },
    limitations: [
      "HUD overlap checks cover only visible DOM overlay rectangles; canvas-rendered labels, axes, sprites, and the view cube are outside that check.",
      "Colorbar/legend pixel contrast was not measured.",
      "Drawing-buffer scale is reported from the observed buffer and CSS size; it is not required to equal window.devicePixelRatio because the renderer may cap interactive DPR.",
    ],
  };
}

async function captureCanvasAtSize(page, {
  assertCanvas,
  canvas,
  expectedDpr,
  pngDecoder,
  settingsDialog,
  target,
  theme,
}) {
  if (await settingsDialog.isVisible().catch(() => false)) {
    throw new Error("Canvas PNG capture requires the settings dialog to be closed");
  }

  await waitForLayoutFrame(page);
  await assertCanvas(`${theme.palette} ${target.id} canvas layout`);
  const [state, hudDom, viewIdentity] = await Promise.all([
    readCanvasState(canvas), readAndAssertHudDomLayout(page),
    page.locator(VIEWPORT_SELECTOR).evaluate((node) => ({
      coordinate_unit: "m",
      camera_position: node.getAttribute("data-camera-position"),
      camera_target: node.getAttribute("data-camera-target"),
      camera_up: node.getAttribute("data-camera-up"),
      camera_projection: node.getAttribute("data-camera-projection"),
      viewport_bounds: node.getAttribute("data-viewport-bounds"),
      primitive_object_count: node.getAttribute("data-primitive-object-count"),
      primitive_object_ids: node.getAttribute("data-primitive-object-ids"),
    })),
  ]);
  assertCanvasState(state, target, expectedDpr, `${theme.palette} ${target.id}`);

  const screenshot = await canvas.screenshot({ type: "png", scale: "css" });
  const decoded = pngDecoder.sync.read(screenshot);
  if (
    !decoded ||
    !(decoded.data instanceof Uint8Array) ||
    decoded.width <= 0 ||
    decoded.height <= 0 ||
    decoded.data.length !== decoded.width * decoded.height * 4
  ) {
    throw new Error("Canvas screenshot did not decode to non-empty RGBA pixels");
  }
  if (
    Math.abs(decoded.width - target.width) > CANVAS_SIZE_TOLERANCE_PX ||
    Math.abs(decoded.height - target.height) > CANVAS_SIZE_TOLERANCE_PX
  ) {
    throw new Error(
      `${theme.palette} ${target.id} PNG dimensions ` +
      `${decoded.width}x${decoded.height} differ from target ` +
      `${target.width}x${target.height} CSS pixels`,
    );
  }
  if (target.id === "narrow" && screenshot.byteLength > NARROW_PNG_LIMIT_BYTES) {
    throw new Error(
      `artifact-too-large: ${theme.palette} 480x320 canvas PNG is ` +
      `${screenshot.byteLength} bytes; limit is ${NARROW_PNG_LIMIT_BYTES}`,
    );
  }

  const image = {
    width: decoded.width,
    height: decoded.height,
    bytes: screenshot.byteLength,
    sha256: createHash("sha256").update(screenshot).digest("hex"),
  };
  if (target.id === "narrow") {
    image.png_base64 = screenshot.toString("base64");
  }

  return {
    theme: theme.mode,
    palette: theme.palette,
    target_canvas_css_pixels: { width: target.width, height: target.height },
    actual_canvas_css_pixels: {
      width: round(state.rect.width),
      height: round(state.rect.height),
    },
    device_pixel_ratio: state.devicePixelRatio,
    canvas: {
      context_type: state.contextType,
      context_lost: state.contextLost,
      element_buffer_pixels: { width: state.width, height: state.height },
      drawing_buffer_pixels: {
        width: state.drawingBufferWidth,
        height: state.drawingBufferHeight,
      },
      effective_buffer_scale: {
        x: round(state.drawingBufferWidth / state.rect.width),
        y: round(state.drawingBufferHeight / state.rect.height),
      },
      preserve_drawing_buffer: state.preserveDrawingBuffer,
    },
    png: image,
    public_hud_dom: hudDom,
    view_identity: viewIdentity,
  };
}

async function calibrateCanvasSize(page, target, timeout) {
  const history = [];
  for (let step = 0; step <= MAX_CALIBRATION_STEPS; step += 1) {
    await waitForLayoutFrame(page);
    const state = await readCanvasState(page.locator(CANVAS_SELECTOR));
    const windowSize = page.viewportSize();
    const measured = { width: state.rect.width, height: state.rect.height };
    history.push({
      step,
      window_css_pixels: windowSize,
      canvas_css_pixels: {
        width: round(measured.width),
        height: round(measured.height),
      },
    });

    if (canvasSizeMatches(measured, target)) {
      return {
        steps: step,
        history,
        target_canvas_css_pixels: { width: target.width, height: target.height },
        actual_canvas_css_pixels: {
          width: round(measured.width),
          height: round(measured.height),
        },
      };
    }
    if (step === MAX_CALIBRATION_STEPS) break;
    if (!windowSize || measured.width <= 0 || measured.height <= 0) {
      throw new Error(`${target.id} canvas cannot be calibrated from a zero-sized rectangle`);
    }

    const estimateDimension = (axis, fallback) => {
      const previous = history.slice(0, -1).reverse().find((sample) =>
        Math.abs(sample.window_css_pixels[axis] - windowSize[axis]) >= 8 &&
        Math.abs(sample.canvas_css_pixels[axis] - measured[axis]) >= 2);
      if (!previous) return fallback;
      const slope = (measured[axis] - previous.canvas_css_pixels[axis]) /
        (windowSize[axis] - previous.window_css_pixels[axis]);
      if (slope < 0.1 || slope > 2) return fallback;
      return Math.round(windowSize[axis] + (target[axis] - measured[axis]) / slope);
    };
    const nextWidth = clampWindowDimension(
      Math.abs(target.width - measured.width) <= CANVAS_SIZE_TOLERANCE_PX
        ? windowSize.width
        : estimateDimension("width", Math.round(windowSize.width * target.width / measured.width)),
    );
    const nextHeight = clampWindowDimension(
      Math.abs(target.height - measured.height) <= CANVAS_SIZE_TOLERANCE_PX
        ? windowSize.height
        : estimateDimension("height", Math.round(windowSize.height + target.height - measured.height)),
    );
    if (nextWidth === windowSize.width && Math.abs(target.width - measured.width) > CANVAS_SIZE_TOLERANCE_PX) {
      const direction = Math.sign(target.width - measured.width);
      const adjusted = clampWindowDimension(windowSize.width + direction);
      if (adjusted !== windowSize.width) {
        await page.setViewportSize({ width: adjusted, height: nextHeight });
      } else if (nextHeight !== windowSize.height) {
        await page.setViewportSize({ width: windowSize.width, height: nextHeight });
      } else {
        throw calibrationError(target, history, "window width reached its supported bound");
      }
    } else if (nextWidth === windowSize.width && nextHeight === windowSize.height) {
      throw calibrationError(target, history, "viewport resize made no progress");
    } else {
      await page.setViewportSize({ width: nextWidth, height: nextHeight });
    }
    await waitForLayoutFrame(page);
  }

  // One final measurement follows the last resize; it is recorded before
  // failing so the receipt shows the actual canvas rectangle we could reach.
  await waitForLayoutFrame(page);
  const finalState = await readCanvasState(page.locator(CANVAS_SELECTOR));
  const finalMeasured = { width: finalState.rect.width, height: finalState.rect.height };
  history.push({
    step: MAX_CALIBRATION_STEPS + 1,
    window_css_pixels: page.viewportSize(),
    canvas_css_pixels: {
      width: round(finalMeasured.width),
      height: round(finalMeasured.height),
    },
  });
  if (canvasSizeMatches(finalMeasured, target)) {
    return {
      steps: MAX_CALIBRATION_STEPS,
      history,
      target_canvas_css_pixels: { width: target.width, height: target.height },
      actual_canvas_css_pixels: {
        width: round(finalMeasured.width),
        height: round(finalMeasured.height),
      },
    };
  }
  throw calibrationError(target, history, `did not reach the target within ${timeout} ms budget`);
}

function calibrationError(target, history, reason) {
  return new Error(
    `Could not size actual canvas to ${target.width}x${target.height} CSS pixels ` +
    `within ${CANVAS_SIZE_TOLERANCE_PX}px: ${reason}; steps=${JSON.stringify(history)}`,
  );
}

async function readCanvasState(canvas) {
  if (await canvas.count() !== 1) {
    throw new Error("Viewport layout QA requires exactly one viewport canvas");
  }
  await canvas.waitFor({ state: "visible", timeout: 5_000 });
  return canvas.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const context = element.getContext("webgl2") ?? element.getContext("webgl");
    return {
      rect: { width: rect.width, height: rect.height },
      width: element.width,
      height: element.height,
      contextType: context?.constructor?.name ?? null,
      contextLost: context?.isContextLost?.() ?? null,
      drawingBufferWidth: context?.drawingBufferWidth ?? 0,
      drawingBufferHeight: context?.drawingBufferHeight ?? 0,
      preserveDrawingBuffer: context?.getContextAttributes?.().preserveDrawingBuffer ?? null,
      devicePixelRatio: window.devicePixelRatio,
    };
  });
}

function assertCanvasState(state, target, expectedDpr, label) {
  if (
    state.rect.width <= 0 ||
    state.rect.height <= 0 ||
    !state.contextType ||
    state.contextLost !== false ||
    state.drawingBufferWidth <= 0 ||
    state.drawingBufferHeight <= 0
  ) {
    throw new Error(`${label}: visible WebGL canvas, live context, or drawing buffer is invalid`);
  }
  if (!canvasSizeMatches(state.rect, target)) {
    throw new Error(
      `${label}: actual canvas ${round(state.rect.width)}x${round(state.rect.height)} ` +
      `is outside the ${target.width}x${target.height} target tolerance`,
    );
  }
  assertExpectedDpr(state.devicePixelRatio, expectedDpr, label);
}

async function readAndAssertHudDomLayout(page) {
  const viewport = page.locator(`${VIEWPORT_SELECTOR}:visible`);
  if (await viewport.count() !== 1) {
    throw new Error("Viewport HUD check requires exactly one visible 3D viewport");
  }
  const layout = await viewport.evaluate((root) => {
    const selector = [
      ".fm-viewport-3d__hud > *",
      ".fm-viewport-3d__method-badge",
      ".fm-viewport-3d__colorbar-stack",
      ".fm-viewport-3d__inspect-tooltip",
      ".fm-viewport-3d__refresh-countdown",
      ".fm-viewport-3d__orbit-debug",
    ].join(",");
    const rootRect = root.getBoundingClientRect();
    const elements = [...new Set(root.querySelectorAll(selector))];
    const items = elements.flatMap((element, index) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0" ||
        element.getClientRects().length === 0 ||
        rect.width <= 0 ||
        rect.height <= 0
      ) {
        return [];
      }
      const className = typeof element.className === "string" ? element.className : "";
      return [{
        id: element.getAttribute("aria-label") || className.trim() || `hud-item-${index}`,
        rect: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          right: rect.right,
          bottom: rect.bottom,
        },
        within_viewport: rect.left >= rootRect.left - 1 &&
          rect.top >= rootRect.top - 1 &&
          rect.right <= rootRect.right + 1 &&
          rect.bottom <= rootRect.bottom + 1,
      }];
    });
    const overlaps = [];
    for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
        const left = items[leftIndex];
        const right = items[rightIndex];
        const overlapWidth = Math.min(left.rect.right, right.rect.right) -
          Math.max(left.rect.x, right.rect.x);
        const overlapHeight = Math.min(left.rect.bottom, right.rect.bottom) -
          Math.max(left.rect.y, right.rect.y);
        if (overlapWidth > 2 && overlapHeight > 2) {
          overlaps.push({ left: left.id, right: right.id });
        }
      }
    }
    return { items, overlaps };
  });
  const outside = layout.items.filter((item) => !item.within_viewport);
  if (layout.items.length === 0) {
    throw new Error("No visible public viewport HUD DOM rectangles were found");
  }
  if (outside.length > 0) {
    throw new Error(`Viewport HUD DOM items escaped the viewport bounds: ${outside.map((item) => item.id).join(", ")}`);
  }
  if (layout.overlaps.length > 0) {
    throw new Error(`Viewport HUD DOM rectangles overlap: ${JSON.stringify(layout.overlaps)}`);
  }
  return {
    scope: "visible DOM HUD children and viewport overlay roots only",
    elements_checked: layout.items.length,
    overlap_count: 0,
    rectangles: layout.items.map(({ id, rect }) => ({
      id,
      x: round(rect.x),
      y: round(rect.y),
      width: round(rect.width),
      height: round(rect.height),
    })),
  };
}

async function switchThemeThroughUi(page, targetTheme, timeout) {
  const currentPreference = await page.locator("html").getAttribute("data-theme-preference");
  if (currentPreference === targetTheme) return;
  const toggle = page.getByRole("button", { name: /^Color theme:/ });
  await toggle.waitFor({ state: "visible", timeout });
  if (await toggle.count() !== 1) throw new Error("Expected one visible color theme menu");
  await toggle.click({ timeout });
  const label = { dark: "Dark", light: "Light", system: "System" }[targetTheme];
  await page.getByRole("menuitemradio", { name: label, exact: true }).click({ timeout });
  await page.waitForFunction(
    (theme) => document.documentElement.dataset.themePreference === theme &&
      document.documentElement.dataset.theme === (theme === "system"
        ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme),
    targetTheme,
    { timeout },
  );
}

async function readThemeMode(page) {
  const theme = await page.locator("html").getAttribute("data-theme");
  if (theme !== "dark" && theme !== "light") {
    throw new Error(`Document did not expose a supported theme; got ${String(theme)}`);
  }
  return theme;
}

async function readThemePreference(page) {
  return page.evaluate((key) => {
    try {
      return { available: true, value: window.localStorage.getItem(key) };
    } catch {
      return { available: false, value: null };
    }
  }, THEME_STORAGE_KEY);
}

async function restoreThemePreference(page, value) {
  const restored = await page.evaluate(({ key, storedValue }) => {
    try {
      if (storedValue === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, storedValue);
      return window.localStorage.getItem(key) === storedValue;
    } catch {
      return false;
    }
  }, { key: THEME_STORAGE_KEY, storedValue: value });
  if (!restored) throw new Error("Could not restore the original theme preference value");
}

async function setDialogOpen(page, dialog, open, timeout) {
  if (await dialog.isVisible().catch(() => false) === open) return;
  if (open) {
    const trigger = page.getByRole("button", { name: /view settings/i });
    await trigger.waitFor({ state: "visible", timeout });
    await trigger.click({ timeout });
    await dialog.waitFor({ state: "visible", timeout });
    return;
  }
  const close = dialog.getByRole("button", { exact: true, name: "Close" });
  await close.waitFor({ state: "visible", timeout });
  await close.click({ timeout });
  await dialog.waitFor({ state: "hidden", timeout });
}

async function waitForThemeAndFrame(page, theme) {
  await page.waitForFunction(
    (target) => document.documentElement.dataset.theme === target,
    theme,
    { timeout: 5_000 },
  );
  await waitForLayoutFrame(page);
  await page.waitForTimeout(80);
  await waitForLayoutFrame(page);
}

async function waitForLayoutFrame(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function readDevicePixelRatio(page) {
  return page.evaluate(() => window.devicePixelRatio);
}

function assertExpectedDpr(actual, expected, label) {
  if (!Number.isFinite(actual) || actual <= 0) {
    throw new Error(`${label}: browser devicePixelRatio is unavailable`);
  }
  if (expected !== undefined && Math.abs(actual - expected) > 0.01) {
    throw new Error(`${label}: expected devicePixelRatio ${expected}, got ${actual}`);
  }
}

function canvasSizeMatches(actual, target) {
  return Math.abs(actual.width - target.width) <= CANVAS_SIZE_TOLERANCE_PX &&
    Math.abs(actual.height - target.height) <= CANVAS_SIZE_TOLERANCE_PX;
}

function clampWindowDimension(value) {
  return Math.min(MAX_WINDOW_DIMENSION, Math.max(MIN_WINDOW_DIMENSION, value));
}

function boundedTimeout(value) {
  return Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_ACTION_TIMEOUT_MS)
    : 15_000;
}

function sameSize(left, right) {
  return left?.width === right.width && left?.height === right.height;
}

function formatSize(size) {
  return size ? `${size.width}x${size.height}` : "unknown";
}

function round(value) {
  return Math.round(value * 100) / 100;
}
