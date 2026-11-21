import { ensureViewportSettingsSection, getViewportSettingsRegion, readViewportInspectorState, restoreViewportInspectorState, selectViewportInspectorContext } from "./viewport-export-browser-qa.mjs";
import { createHash } from "node:crypto";
import { visitSequentially } from "./visitSequentially.mjs";

const VIEWPORT_SELECTOR = ".fm-viewport-3d";
const CANVAS_SELECTOR = `${VIEWPORT_SELECTOR} canvas`;
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

/** Exercise the bottom dock through its actual tabs and panel controls. */
export async function checkFooterReadability(page, { assertCanvas, timeout }) {
  const footer = page.locator(".fm-footer");
  const tabs = footer.getByRole("tablist", { name: "Bottom diagnostics", exact: true });
  const frame = page.locator('[data-panel-frame="panel-bottom"]');
  await tabs.waitFor({ state: "visible", timeout });
  const [originalTab, originalMode] = await Promise.all([
    tabs.locator('[aria-selected="true"]').innerText(),
    frame.getAttribute("data-panel-mode"),
  ]);
  const samples = [];
  const compactLayouts = [];
  const captures = [];
  let notificationErrors = [];
  await page.evaluate(() => {
    const errors = [];
    const seen = new Set();
    const collect = () => {
      for (const node of document.querySelectorAll('.fm-notifications__toast[data-kind="error"]')) {
        const text = node.textContent?.trim();
        if (text && !seen.has(text) && errors.length < 10) {
          seen.add(text);
          errors.push(text);
        }
      }
    };
    const observer = new MutationObserver(collect);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.__FM_FOOTER_ERROR_PROBE__ = { errors, observer };
    collect();
  });
  const assertNoResourceFailures = async () => {
    notificationErrors = await page.evaluate(() => [...window.__FM_FOOTER_ERROR_PROBE__.errors]);
    if (notificationErrors.length) throw new Error(`Footer resource failures: ${JSON.stringify(notificationErrors)}`);
  };
  let lowPanel = null;
  let floatingBounds = null;
  let originalDividerY = null;
  const divider = page.getByRole("separator", { name: "Resize bottom diagnostics", exact: true });
  const dragDivider = async (targetY) => {
    const box = await divider.boundingBox();
    if (!box) throw new Error("Bottom dock divider is unavailable");
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, targetY, { steps: 4 });
    await page.mouse.up();
    await waitForLayoutFrame(page);
  };
  const captureFooter = async (theme, variant) => {
    await assertNoResourceFailures();
    const image = await footer.screenshot({ type: "png", animations: "disabled", timeout });
    if (image.length > NARROW_PNG_LIMIT_BYTES) throw new Error("Footer screenshot exceeded bounded output size");
    captures.push({ theme, variant, png_base64: image.toString("base64"), sha256: createHash("sha256").update(image).digest("hex") });
  };
  const labels = ["Logs", "Telemetry", "Diagnostics", "Engine", "Operations", "Problems", "Quick Chart"];
  const menuAction = async (name) => {
    await frame.getByRole("button", { name: "Diagnostics panel menu", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  };
  try {
    if (await tabs.getByRole("tab").count() !== labels.length) throw new Error("Footer omitted a diagnostic tab");
    for (const theme of THEME_PALETTES) {
      await switchThemeThroughUi(page, theme.mode, timeout);
      await visitSequentially(labels, async (label) => {
        await tabs.getByRole("tab", { name: label, exact: true }).click();
        await waitForLayoutFrame(page);
        const sample = await footer.evaluate((root) => {
          const selected = root.querySelector('.fm-footer__tabs [aria-selected="true"]');
          const panels = [...root.querySelectorAll(':scope > [role="tabpanel"]')].filter((panel) => !panel.hidden);
          const rgb = (value) => {
            const srgb = value.match(/^color\(srgb ([^/]+?)(?:\s*\/\s*([\d.]+))?\)$/);
            if (srgb) return [...srgb[1].trim().split(/\s+/).map((channel) => Number(channel) * 255), Number(srgb[2] ?? 1)];
            const match = value.match(/^rgba?\(([^)]+)\)$/);
            if (match) return match[1].split(/[ ,/]+/).map(Number);
            // Other color spaces (oklab/oklch from color-mix) are converted to
            // sRGB by painting one pixel and reading it back.
            if (!/^(?:oklab|oklch|lab|lch|color|hsla?|hwb)\(/.test(value)) {
              throw new Error(`Unsupported computed color in footer QA: ${value}`);
            }
            const context = new OffscreenCanvas(1, 1).getContext("2d", { colorSpace: "srgb" });
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = value;
            context.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
            return [r, g, b, a / 255];
          };
          const luminance = (color) => color.slice(0, 3).reduce((sum, channel, index) => {
            const c = channel / 255;
            return sum + (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index];
          }, 0);
          const leaves = [...root.querySelectorAll('button, th, td, span, strong, summary, h3, p, [role="status"]')].filter((node) => {
            if (!node.textContent?.trim() || node.querySelector('button, th, td, span, strong, h3, p, [role="status"]')) return false;
            if (node.closest('[disabled], [aria-disabled="true"]')) return false;
            const style = getComputedStyle(node);
            const box = node.getBoundingClientRect();
            if (style.visibility !== "visible" || style.display === "none" || Number(style.opacity) !== 1 || box.width <= 0 || box.height <= 0) return false;
            let left = box.left, right = box.right, top = box.top, bottom = box.bottom;
            for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
              const style = getComputedStyle(ancestor), clip = ancestor.getBoundingClientRect();
              if (/auto|scroll|hidden|clip/.test(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
              if (/auto|scroll|hidden|clip/.test(style.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
              if (ancestor === root) break;
            }
            return right > left && bottom > top;
          });
          if (leaves.length > 2000) throw new Error("Footer contrast sample exceeded its bounded DOM budget");
          const ratios = leaves.map((node) => {
            const foreground = rgb(getComputedStyle(node).color);
            let background = [0, 0, 0, 0];
            for (let ancestor = node; ancestor && background[3] < 1; ancestor = ancestor.parentElement) {
              const color = rgb(getComputedStyle(ancestor).backgroundColor);
              const alpha = color[3] ?? 1;
              const nextAlpha = background[3] + alpha * (1 - background[3]);
              if (nextAlpha > 0) {
                background = [0, 1, 2].map((i) => (background[i] * background[3] + color[i] * alpha * (1 - background[3])) / nextAlpha).concat(nextAlpha);
              }
            }
            const a = luminance(foreground), b = luminance(background);
            return { text: node.textContent.trim().slice(0, 80), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
          });
          return {
            selected: selected?.textContent.trim(), panels: panels.length,
            checked_texts: ratios.length,
            checked_panel_texts: leaves.filter((node) => panels[0]?.contains(node)).length,
            lowest_contrast: ratios.reduce((min, row) => Math.min(min, row.ratio), 100),
            failures: ratios.filter((row) => row.ratio < 4.5),
          };
        });
        if (sample.selected !== label || sample.panels !== 1 || sample.checked_panel_texts === 0 || sample.failures.length) {
          throw new Error(`Footer ${theme.mode}/${label}: ${JSON.stringify(sample)}`);
        }
        await assertNoResourceFailures();
        samples.push({ theme: theme.mode, tab: label, ...sample });
      });
      await tabs.getByRole("tab", { name: "Telemetry", exact: true }).click();
      await waitForLayoutFrame(page);
      const overviewFooter = await footer.boundingBox();
      const overviewDivider = await divider.boundingBox();
      if (!overviewDivider) throw new Error("Cannot capture the expanded footer overview");
      originalDividerY = overviewDivider.y + overviewDivider.height / 2;
      await dragDivider(originalDividerY + overviewFooter.height - 300);
      await captureFooter(theme.mode, "overview");
      const initialFooter = await footer.boundingBox();
      if (initialFooter.height > 110) {
        const box = await divider.boundingBox();
        if (!box) throw new Error("Cannot test the footer at its minimum dock height");
        await dragDivider(box.y + box.height / 2 + initialFooter.height - 104);
      }
      const compact = await footer.evaluate((root) => {
        const chrome = root.querySelector('.fm-footer__bar');
        const navigation = root.querySelector('[aria-label="Telemetry views"]');
        const bounds = root.getBoundingClientRect();
        const visible = [...root.querySelectorAll('.fm-footer-telemetry__metric')].filter((metric) => {
          const value = metric.querySelector('.fm-footer-telemetry__metric-value').getBoundingClientRect();
          const x = (value.left + value.right) / 2, y = (value.top + value.bottom) / 2;
          return value.top >= bounds.top && value.bottom <= bounds.bottom && metric.contains(document.elementFromPoint(x, y));
        });
        return { height: bounds.height, visible_values: visible.length, navigation_in_header: chrome.contains(navigation) };
      });
      if (compact.height > 110 || !compact.navigation_in_header || compact.visible_values < 1) throw new Error(`Compact footer hid all values: ${JSON.stringify(compact)}`);
      compactLayouts.push({ theme: theme.mode, ...compact });
      await captureFooter(theme.mode, "compact");
      if (originalDividerY !== null) {
        await dragDivider(originalDividerY);
        originalDividerY = null;
      }
    }
    if (originalMode !== "docked") throw new Error("Footer QA requires the standard docked starting layout");
    await menuAction("Float panel");
    floatingBounds = await frame.boundingBox();
    const resize = frame.getByRole("button", { name: "Resize Diagnostics with arrow keys", exact: true });
    await resize.focus();
    // 40px keyboard steps, bounded by PanelFrame's own minimum dimensions.
    await visitSequentially(Array.from({ length: 10 }), () => resize.press("Shift+ArrowUp"));
    await visitSequentially(Array.from({ length: 3 }), () => resize.press("Shift+ArrowLeft"));
    const first = tabs.getByRole("tab", { name: "Logs", exact: true });
    await first.click();
    await first.press("End");
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Quick Chart", null, { timeout });
    if (await tabs.locator('[aria-selected="true"]').innerText() !== "Logs") throw new Error("Arrow navigation activated an expensive footer panel before confirmation");
    await page.keyboard.press("Enter");
    const last = tabs.getByRole("tab", { name: "Quick Chart", exact: true });
    await page.waitForFunction(() => document.querySelector('.fm-footer__tabs [aria-selected="true"]')?.textContent?.trim() === "Quick Chart", null, { timeout });
    if (await last.getAttribute("aria-selected") !== "true") throw new Error("End/Enter failed to reach last footer tab");
    await last.press("Home");
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Logs", null, { timeout });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('.fm-footer__tabs [aria-selected="true"]')?.textContent?.trim() === "Logs", null, { timeout });
    await tabs.getByRole("tab", { name: "Telemetry", exact: true }).click();
    const metrics = footer.locator(".fm-footer-telemetry__metrics-grid");
    if (await metrics.count()) {
      const lastMetric = metrics.locator(".fm-footer-telemetry__metric").last();
      await lastMetric.scrollIntoViewIfNeeded();
      lowPanel = await metrics.evaluate((node) => ({
        display: getComputedStyle(node).display, height: node.clientHeight,
        scroll_height: node.scrollHeight, scroll_top: node.scrollTop,
        metrics: node.querySelectorAll('.fm-footer-telemetry__metric').length,
      }));
      if (lowPanel.display === "none" || lowPanel.height <= 0 || lowPanel.metrics === 0) throw new Error("Low footer hid its metrics");
      const reachable = await lastMetric.evaluate((node) => {
        const viewport = node.closest('.fm-footer-telemetry__metrics-grid').getBoundingClientRect();
        const box = node.getBoundingClientRect();
        const x = Math.max(viewport.left, box.left) + Math.min(viewport.width, box.width) / 2;
        const top = Math.max(viewport.top, box.top), bottom = Math.min(viewport.bottom, box.bottom);
        return bottom > top && node.contains(document.elementFromPoint(x, (top + bottom) / 2));
      });
      if (!reachable) throw new Error("Last metric is clipped or covered in a low footer");
      // Method notes are a contextual tooltip: keyboard focus opens it, Escape closes it.
      const tooltip = page.locator(".fm-footer-telemetry__tooltip");
      await lastMetric.focus();
      await tooltip.waitFor({ state: "visible", timeout });
      await page.keyboard.press("Escape");
      await tooltip.waitFor({ state: "hidden", timeout });
      lowPanel.keyboard_details = "tooltip focus/escape verified";
    } else throw new Error("Telemetry fixture omitted the metrics container");
    await assertNoResourceFailures();
  } catch (error) {
    error.footerReadability = { samples, captures, compact_layouts: compactLayouts, low_panel: lowPanel, notification_errors: notificationErrors };
    throw error;
  } finally {
    await page.evaluate(() => {
      window.__FM_FOOTER_ERROR_PROBE__?.observer.disconnect();
      delete window.__FM_FOOTER_ERROR_PROBE__;
    });
    if (await frame.getAttribute("data-panel-mode") === "floating" && originalMode === "docked") {
      if (floatingBounds) {
        const current = await frame.boundingBox();
        const resize = frame.getByRole("button", { name: "Resize Diagnostics with arrow keys", exact: true });
    const resizeOperations = [];
    for (const [axis, positive, negative] of [["height", "ArrowDown", "ArrowUp"], ["width", "ArrowRight", "ArrowLeft"]]) {
      const delta = Math.round(floatingBounds[axis] - current[axis]);
      const key = delta > 0 ? positive : negative;
      const steps = Math.round(Math.abs(delta) / 10);
      if (steps > 100) throw new Error("Footer size restoration exceeded bounded keyboard budget");
      resizeOperations.push(
        ...Array.from({ length: Math.floor(steps / 4) }, () => `Shift+${key}`),
        ...Array.from({ length: steps % 4 }, () => key),
      );
    }
    await visitSequentially(resizeOperations, (key) => resize.press(key));
      }
      await menuAction("Dock panel");
    }
    await tabs.getByRole("tab", { name: originalTab.trim(), exact: true }).click();
    if (originalDividerY !== null) await dragDivider(originalDividerY);
  }
  await assertCanvas("after footer tab and low-panel checks");
  return { state: "passed", samples, captures, compact_layouts: compactLayouts, low_panel: lowPanel, keyboard: "End/Home + Enter verified" };
}

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
  const settingsDialog = getViewportSettingsRegion(page);
  let originalDialogOpen = null;
  let originalInspectorState = null;
  let originalTheme = null;
  let originalThemePreference = null;
  let originalThemeStorage = { available: false, value: null };
  let operationError = null;
  const restorationErrors = [];
  const captures = [];
  let initialDpr = null;
  let footerReadability = null;

  try {
    await viewport.waitFor({ state: "visible", timeout });
    await canvas.first().waitFor({ state: "visible", timeout });
    if (await canvas.count() !== 1) {
      throw new Error("Viewport layout QA requires exactly one visible 3D canvas");
    }

    originalInspectorState = await readViewportInspectorState(page);
    originalDialogOpen = await settingsDialog.isVisible().catch(() => false);
    originalTheme = await readThemeMode(page);
    originalThemePreference = await page.locator("html").getAttribute("data-theme-preference");
    if (!["dark", "light", "system"].includes(originalThemePreference)) throw new Error("Document omitted its theme preference");
    originalThemeStorage = await readThemePreference(page);
    initialDpr = await readDevicePixelRatio(page);
    assertExpectedDpr(initialDpr, expectedDpr, "initial browser context");
    await setDialogOpen(page, settingsDialog, false, timeout);
    footerReadability = await checkFooterReadability(page, { assertCanvas, timeout });

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
        await restoreViewportInspectorState(page, originalInspectorState, restoreTimeout);
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
      footer_readability: operationError?.footerReadability ?? footerReadability,
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
    footer_readability: footerReadability,
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
  const group = page.getByRole("radiogroup", { name: /^Color theme:/ });
  await group.waitFor({ state: "visible", timeout });
  if (await group.count() !== 1) throw new Error("Expected one visible color theme control");
  const label = { dark: "Dark", light: "Light", system: "System" }[targetTheme];
  await group.getByRole("radio", { name: label, exact: true }).click({ timeout });
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
  if (open) await ensureViewportSettingsSection(page, "View", timeout);
  else await selectViewportInspectorContext(page, "selection", timeout);
  await dialog.waitFor({ state: open ? "visible" : "hidden", timeout });
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
