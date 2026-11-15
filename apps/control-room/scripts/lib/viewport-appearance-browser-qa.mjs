import { createHash } from "node:crypto";
import {
  ensureViewportSettingsSection,
  getViewportSettingsRegion,
  getViewportCameraRegion,
  readViewportInspectorState,
  restoreViewportInspectorState,
  runViewportExportBrowserQa,
  selectViewportInspectorContext,
} from "./viewport-export-browser-qa.mjs";

const APPEARANCE_STORAGE_KEY =
  "fullmag.control-room.viewport-3d.appearance-preferences";

const BACKGROUND_OPTIONS = {
  gradient: "Subtle gradient",
  solid: "Solid",
};
const ORIGIN_OPTIONS = {
  "frame-center": "Relative to frame center",
  world: "World coordinates",
};
const FRAME_OPTIONS = {
  floor: "Floor",
  cage: "Floor and vertical planes",
  off: "Off",
};
const SETTING_SECTIONS_BY_LABEL = Object.freeze({
  "Background": "Appearance",
  "Geometry appearance": "Appearance",
  "Visualization mode": "Appearance",
  "Grid and axes": "View",
  "Scale coordinates": "View",
  "Requested quality": "Quality",
});
const RANGE_SECTIONS_BY_ID = Object.freeze({
  "fm-view-background-strength": "Appearance",
  "fm-view-light-strength": "Appearance",
  "fm-view-metalness": "Appearance",
  "fm-view-roughness": "Appearance",
});

export async function runViewportAppearanceBrowserQa(page, {
  assertCanvas,
  getSessionIdentity,
  expectedSession,
  pngDecoder,
  timeout,
}) {
  if (typeof pngDecoder?.sync?.read !== "function") {
    throw new Error("Pinned Playwright utilsBundle does not expose PNG.sync.read");
  }
  const originalViewport = page.viewportSize();
  if (!originalViewport) throw new Error("Appearance QA requires a fixed browser viewport");

  const viewport = page.locator(".fm-viewport-3d");
  const settings = getViewportSettingsRegion(page);
  let originalInspectorState = null;
  const storageBefore = await readAppearanceStorage(page);
  let originalControls = null;
  let presentationRendering = null;
  let inspectorInteraction = null;
  let result = null;
  let operationError = null;
  let restorationError = null;
  let preferenceStorageRestored = false;
  const pixelSnapshots = new Map();

  try {
    await viewport.waitFor({ state: "visible", timeout });
    originalInspectorState = await readViewportInspectorState(page);
    await ensureSettingsOpen(page, "Appearance", timeout, { forceCommand: true });
    originalControls = await readControls(page, settings, timeout);
    inspectorInteraction = await checkInspectorInteraction(page, { assertCanvas, timeout });

    try {
      presentationRendering = await checkPresentationRendering(page, settings, {
        assertCanvas, pngDecoder, timeout, pixelSnapshots, lightingAudit: await page.evaluate(() => window.__FULLMAG_READ_VIEWPORT_3D_LIGHTING__?.()),
      });
    } catch (error) {
      if (error.partialProof) error.partialProof = { presentation_rendering: error.partialProof };
      throw error;
    }


    await choose(page, "Background", BACKGROUND_OPTIONS.gradient, "fm-view-background", timeout);
    await setRangeValue(page, "#fm-view-background-strength", 1);
    await waitForRenderedFrame(page);
    const gradient = await readCanvasPixels(page, settings, "gradient", pixelSnapshots, pngDecoder, assertCanvas, timeout);

    await choose(page, "Background", BACKGROUND_OPTIONS.solid, "fm-view-background", timeout);
    await waitForRenderedFrame(page);
    const solid = await readCanvasPixels(page, settings, "solid", pixelSnapshots, pngDecoder, assertCanvas, timeout);
    const backgroundDifference = comparePixelSnapshots(pixelSnapshots, "gradient", "solid");
    const upperDifference = colorDistance(gradient.upper_mean, solid.upper_mean);
    const lowerDifference = colorDistance(gradient.lower_mean, solid.lower_mean);
    if (Math.max(upperDifference, lowerDifference) < 4 || backgroundDifference.changed_pixels < 8) {
      throw new Error("Gradient-to-solid did not change the canvas background probes");
    }

    await choose(page, "Background", BACKGROUND_OPTIONS.gradient, "fm-view-background", timeout);
    await waitForRenderedFrame(page);
    const gradientRestored = await readCanvasPixels(page, settings, "gradient-restored", pixelSnapshots, pngDecoder, assertCanvas, timeout);
    const restoredUpperDifference = colorDistance(gradient.upper_mean, gradientRestored.upper_mean);
    const restoredLowerDifference = colorDistance(gradient.lower_mean, gradientRestored.lower_mean);
    if (restoredUpperDifference > 3 || restoredLowerDifference > 3) {
      throw new Error("Restoring the gradient did not restore the upper and lower canvas probes");
    }
    clearPixelSnapshots(pixelSnapshots, ["gradient", "solid", "gradient-restored"]);

    if (originalControls.frameMode === "off") {
      await choose(page, "Grid and axes", FRAME_OPTIONS.floor, "fm-view-frame", timeout);
    }
    await choose(page, "Scale coordinates", ORIGIN_OPTIONS["frame-center"], "fm-view-origin", timeout);
    const frameCenterOriginText = await readChoice(page, "Scale coordinates");
    if (frameCenterOriginText !== ORIGIN_OPTIONS["frame-center"]) {
      throw new Error("Frame-center coordinate mode did not publish its selected HUD setting text");
    }
    await waitForRenderedFrame(page);
    const frameCenterPixels = await readCanvasPixels(page, settings, "frame-center", pixelSnapshots, pngDecoder, assertCanvas, timeout);
    await choose(page, "Scale coordinates", ORIGIN_OPTIONS.world, "fm-view-origin", timeout);
    await waitForRenderedFrame(page);
    const worldPixels = await readCanvasPixels(page, settings, "world", pixelSnapshots, pngDecoder, assertCanvas, timeout);
    const originRenderDifference = comparePixelSnapshots(pixelSnapshots, "frame-center", "world");
    const worldOriginText = await readChoice(page, "Scale coordinates");
    if (worldOriginText !== ORIGIN_OPTIONS.world) {
      throw new Error("World coordinate mode did not publish its selected HUD setting text");
    }
    clearPixelSnapshots(pixelSnapshots, ["frame-center", "world"]);

    let studioDifference = null;
    let flatDifference = null;
    await choose(page, "Geometry appearance", "Studio", "fm-view-lighting", timeout);
    await waitForRenderedFrame(page);
    const lightingAudit = await page.evaluate(() =>
      window.__FULLMAG_READ_VIEWPORT_3D_LIGHTING__?.() ?? null);
    if (lightingAudit?.litPrimitiveMeshCount > 0 && lightingAudit.otherSurfaceMeshCount === 0) {
      await setSwitch(page, "Ambient occlusion", false, timeout);
      await setSwitch(page, "Bloom (Glow)", false, timeout);
      await choose(page, "Geometry appearance", "Studio", "fm-view-lighting", timeout);
      await setRangeValue(page, "#fm-view-light-strength", 0);
      await readCanvasPixels(page, settings, "studio-zero", pixelSnapshots, pngDecoder, assertCanvas, timeout);
      await choose(page, "Geometry appearance", "Flat", "fm-view-lighting", timeout);
      if (!await settings.locator("#fm-view-light-strength-number").isDisabled()) {
        throw new Error("Flat geometry must explain its inactive studio light controls");
      }
      await readCanvasPixels(page, settings, "flat-zero", pixelSnapshots, pngDecoder, assertCanvas, timeout);
      await choose(page, "Geometry appearance", "Studio", "fm-view-lighting", timeout);
      await setRangeValue(page, "#fm-view-light-strength", 2);
      await readCanvasPixels(page, settings, "studio-two", pixelSnapshots, pngDecoder, assertCanvas, timeout);
      await choose(page, "Geometry appearance", "Flat", "fm-view-lighting", timeout);
      await readCanvasPixels(page, settings, "flat-two", pixelSnapshots, pngDecoder, assertCanvas, timeout);
      studioDifference = comparePixelSnapshots(pixelSnapshots, "studio-zero", "studio-two");
      flatDifference = comparePixelSnapshots(pixelSnapshots, "flat-zero", "flat-two");
      if (studioDifference.changed_pixels < 8) {
        throw new Error("Studio light intensity did not change the rendered geometry");
      }
      if (flatDifference.changed_pixels !== 0) {
        throw new Error("Flat geometry changed when only stored studio intensity differed");
      }
      clearPixelSnapshots(pixelSnapshots, ["studio-zero", "studio-two", "flat-zero", "flat-two"]);
      await choose(page, "Geometry appearance", "Studio", "fm-view-lighting", timeout);
      await setRangeValue(page, "#fm-view-light-strength", originalControls.lightingIntensity);
    }
    await choose(page, "Geometry appearance", originalControls.lightingMode, "fm-view-lighting", timeout);

    await setSwitch(page, "Ambient occlusion", true, timeout);
    await setSwitch(page, "Bloom (Glow)", true, timeout);
    await page.waitForTimeout(100);
    await ensureSettingsOpen(page, "Quality", timeout);
    const effectReasons = await settings.getByRole("status").allInnerTexts();
    const diagnostics = parseViewportEffectStatuses(effectReasons);
    const protectedReason = "Quantitative field colors are protected";
    const protectedEffects = ["ambientOcclusion", "bloom"]
      .filter((effect) => diagnostics[effect] === protectedReason);
    const postProcessingUnavailableReason = Object.values(diagnostics).find((reason) =>
      reason === "Post-processing is disabled by browser configuration.",
    ) ?? null;
    if (protectedEffects.length === 1) {
      throw new Error("Quantitative color protection was not reported for both AO and Bloom");
    }


    const narrowLayout = await checkNarrowViewport(page, settings, timeout);
    await page.setViewportSize(originalViewport);
    await page.waitForTimeout(100);

    const sessionBeforeReload = await getSessionIdentity();
    assertSameSession(expectedSession, sessionBeforeReload, "before appearance preference reload");
    const persistence = storageBefore.available
      ? await verifyPreferenceReload(page, {
          assertCanvas, settings, expectedSession, getSessionIdentity, timeout,
        })
      : { state: "skipped", reason: "Browser local storage is unavailable." };

    result = {
      inspector_interaction: inspectorInteraction,
      presentation_rendering: presentationRendering,
      settings_panel: {
        opened_from_command_palette: true,
        region: "3D View Settings",
      },
      pixel_capture: {
        method: "Playwright canvas screenshot decoded by pinned utilsBundle PNG.sync.read",
        screenshot_written_to_disk: false,
      },
      background: {
        transition: "gradient-solid-gradient",
        upper_probe_delta: upperDifference,
        lower_probe_delta: lowerDifference,
        changed_pixels: backgroundDifference.changed_pixels,
        restored_upper_delta: restoredUpperDifference,
        restored_lower_delta: restoredLowerDifference,
        upper_probe: gradient.upper_mean,
        lower_probe: gradient.lower_mean,
        solid_upper_probe: solid.upper_mean,
        solid_lower_probe: solid.lower_mean,
      },
      coordinate_origin: {
        frame_center_text: ORIGIN_OPTIONS["frame-center"],
        world_text: worldOriginText,
        rendered_pixels_changed: originRenderDifference.changed_pixels > 0,
        changed_pixels: originRenderDifference.changed_pixels,
        frame_center_hash: frameCenterPixels.hash,
        world_hash: worldPixels.hash,
      },
      geometry_lighting: studioDifference && flatDifference ? {
        state: "passed",
        renderable_candidate_audit: lightingAudit,
        studio_intensities: [0, 2],
        studio_changed_pixels: studioDifference.changed_pixels,
        flat_changed_pixels: flatDifference.changed_pixels,
        flat_controls_disabled: true,
        limitation: "Geometry preview only; quantitative fields and FEM are not established by this check.",
      } : { state: "NOT VERIFIED", renderable_candidate_audit: lightingAudit,
        reason: "No isolated in-frustum Lambert primitive candidate was established; quantitative field colors must not be required to change with studio light." },
      quantitative_effects: {
        requested: ["Ambient occlusion", "Bloom (Glow)"],
        protection_reason: protectedEffects.length === 2 ? protectedReason : null,
        protected_effects: protectedEffects,
        browser_disable_reason: postProcessingUnavailableReason,
        state: protectedEffects.length === 2
          ? "protected"
          : postProcessingUnavailableReason
            ? "browser-disabled"
            : "not-observed",
        diagnostics,
      },
      narrow_layout: narrowLayout,
      preference_reload: persistence,
      idle_render_frames: {
        state: "unknown",
        reason: "No runtime idle-frame counter is exposed by the browser QA surface.",
      },
      export_download: {
        state: "not-run",
        reason: "The exporter integration is not part of this QA harness.",
      },
    };
  } catch (error) {
    if (presentationRendering) error.partialProof = { ...error.partialProof, presentation_rendering: presentationRendering };
    if (inspectorInteraction) error.partialProof = { ...error.partialProof, inspector_interaction: inspectorInteraction };
    operationError = error;
  } finally {
    pixelSnapshots.clear();
    const cleanupErrors = [];
    const cleanup = async (operation) => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(error?.message ?? String(error));
      }
    };
    await cleanup(() => page.setViewportSize(originalViewport));
    if (originalControls) {
      await cleanup(() => viewport.waitFor({ state: "visible", timeout }));
      await cleanup(() => ensureSettingsOpen(page, "Appearance", timeout));
      await cleanup(() => restoreControls(page, settings, originalControls, timeout));
    }
    await cleanup(async () => {
      preferenceStorageRestored = await restoreAppearanceStorage(page, storageBefore);
    });
    if (originalInspectorState) {
      await cleanup(() => restoreViewportInspectorState(page, originalInspectorState, timeout));
    }
    if (cleanupErrors.length) restorationError = new Error(cleanupErrors.join("; "));
  }

  if (operationError && restorationError) {
    const failure = new Error(
      `Appearance QA failed: ${operationError?.stack ?? operationError}; ` +
      `preference restoration failed: ${restorationError?.message ?? restorationError}`,
    );
    failure.partialProof = operationError.partialProof;
    throw failure;
  }
  if (operationError) throw operationError;
  if (restorationError) throw restorationError;
  result.original_controls_restored = true;
  result.original_preference_storage = preferenceStorageRestored ? "verified" : "unavailable";
  return result;
}

export function parseViewportEffectStatuses(texts) {
  const keys = { "Ambient occlusion": "ambientOcclusion", Bloom: "bloom", "Anti-Aliasing": "antialias", "Soft shadows": "shadows" };
  const diagnostics = {};
  for (const text of texts) {
    const match = text.match(/^([^:]+): (requested|not requested), (effective|inactive)(?: — (.*))?\.$/);
    if (match && keys[match[1]]) diagnostics[keys[match[1]]] = match[4] ?? match[3];
  }
  if (!("ambientOcclusion" in diagnostics) || !("bloom" in diagnostics)) {
    throw new Error("Quality settings omitted Ambient occlusion or Bloom effect status");
  }
  return diagnostics;
}

async function ensureSettingsOpen(page, section, timeout, options) {
  return ensureViewportSettingsSection(page, section, timeout, options);
}

async function readControls(page, settings, timeout) {
  await ensureSettingsOpen(page, "Appearance", timeout);
  const background = await readChoice(page, "Background", timeout);
  const strength = await readRangeValue(settings, "fm-view-background-strength");
  const lightingMode = await readChoice(page, "Geometry appearance", timeout);
  const lightingIntensity = await readRangeValue(settings, "fm-view-light-strength");
  await ensureSettingsOpen(page, "View", timeout);
  const origin = await readChoice(page, "Scale coordinates", timeout);
  const frame = await readChoice(page, "Grid and axes", timeout);
  await ensureSettingsOpen(page, "Quality", timeout);
  const ambientOcclusion = await settings.getByRole("switch", { name: "Ambient occlusion", exact: true }).isChecked();
  const bloom = await settings.getByRole("switch", { name: "Bloom (Glow)", exact: true }).isChecked();
  const backgroundMode = background === BACKGROUND_OPTIONS.gradient
    ? "gradient"
    : background === BACKGROUND_OPTIONS.solid
      ? "solid"
      : null;
  const originMode = origin === ORIGIN_OPTIONS.world
    ? "world"
    : origin === ORIGIN_OPTIONS["frame-center"]
      ? "frame-center"
      : null;
  const frameMode = Object.entries(FRAME_OPTIONS).find(([, label]) => label === frame)?.[0] ?? null;
  if (!backgroundMode || !originMode || !frameMode || !Number.isFinite(strength) ||
      !["Studio", "Flat"].includes(lightingMode) || !Number.isFinite(lightingIntensity)) {
    throw new Error("Viewport appearance controls do not expose the expected selected values");
  }
  return { ambientOcclusion, backgroundMode, bloom, frameMode, originMode, strength,
    lightingMode, lightingIntensity };
}

async function readChoice(page, label, timeout = 15_000) {
  const section = SETTING_SECTIONS_BY_LABEL[label];
  if (!section) throw new Error(`No 3D View Settings section is registered for ${label}`);
  const settings = await ensureSettingsOpen(page, section, timeout);
  return normalizeText(await settings.getByRole("combobox", { name: label, exact: true }).innerText({ timeout }));
}

async function choose(page, label, option, id, timeout) {
  const section = SETTING_SECTIONS_BY_LABEL[label];
  if (!section) throw new Error(`No 3D View Settings section is registered for ${label}`);
  const settings = await ensureSettingsOpen(page, section, timeout);
  const trigger = settings.getByRole("combobox", { name: label, exact: true });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click({ timeout });
  await page.getByRole("option", { name: option, exact: true }).click({ timeout });
  await page.getByRole("listbox").waitFor({ state: "hidden", timeout });
  await page.waitForFunction(({ controlId, expected }) => {
    const control = document.getElementById(controlId);
    return (control?.textContent ?? "").replace(/\s+/g, " ").trim().includes(expected);
  }, { controlId: id, expected: option }, { timeout });
}

async function setRangeValue(page, selector, target, timeout = 15_000) {
  const id = selector.replace(/^#/, "");
  const section = RANGE_SECTIONS_BY_ID[id];
  if (!section) throw new Error(`No 3D View Settings section is registered for ${selector}`);
  const settings = await ensureSettingsOpen(page, section, timeout);
  const input = settings.locator(`#${id}-number`);
  const advanced = {
    "fm-view-light-azimuth": "Advanced light direction",
    "fm-view-light-elevation": "Advanced light direction",
    "fm-view-ao-intensity": "Advanced ambient occlusion",
    "fm-view-ao-radius": "Advanced ambient occlusion",
  }[id];
  if (advanced && await input.count() === 0) {
    const trigger = settings.getByRole("button", { name: advanced, exact: true });
    if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click({ timeout });
  }
  const range = await input.evaluate((element) => ({
    max: Number(element.max),
    min: Number(element.min),
    step: Number(element.step),
  }));
  if (!Number.isFinite(range.step) || range.step <= 0 || target < range.min || target > range.max) {
    throw new Error(`Range target ${target} is outside ${selector}`);
  }
  if (Math.abs((target - range.min) / range.step - Math.round((target - range.min) / range.step)) > 0.01) {
    throw new Error(`Range target ${target} does not align with ${selector} steps`);
  }
  await input.fill(String(target));
  await input.press("Enter");
  await page.waitForFunction(({ controlId, expected, tolerance }) => {
    const number = Number(document.getElementById(`${controlId}-number`)?.value);
    const slider = document.getElementById(controlId)?.querySelector('[role="slider"]');
    const sliderValue = Number(slider?.getAttribute("aria-valuenow"));
    return Number.isFinite(number) && Number.isFinite(sliderValue) &&
      Math.abs(number - expected) <= tolerance && Math.abs(sliderValue - expected) <= tolerance;
  }, { controlId: id, expected: target, tolerance: range.step * 0.01 }, { timeout });
}

async function readRangeValue(settings, id) {
  const value = Number(await settings.locator(`#${id}-number`).inputValue());
  if (!Number.isFinite(value)) throw new Error(`Numeric control ${id}-number did not expose a finite value`);
  return value;
}

async function setSwitch(page, label, checked, timeout) {
  const controlInfo = {
    "Ambient occlusion": { id: "fm-viewport-3d-effect-ambient-occlusion", section: "Quality" },
    "Bloom (Glow)": { id: "fm-viewport-3d-effect-bloom", section: "Quality" },
    "Soft shadows": { id: "fm-view-shadows", section: "Quality" },
  }[label];
  if (!controlInfo) throw new Error(`Unknown appearance switch ${label}`);
  const settings = await ensureSettingsOpen(page, controlInfo.section, timeout);
  const control = settings.getByRole("switch", { name: label, exact: true });
  if (await control.isChecked() !== checked) await control.click();
  await page.waitForFunction(({ id, expected }) =>
    document.getElementById(id)?.getAttribute("aria-checked") === String(expected),
  { id: controlInfo.id, expected: checked }, { timeout });
}

async function waitForRenderedFrame(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  await page.waitForTimeout(40);
}

async function readCanvasPixels(page, settings, name, snapshots, pngDecoder, assertCanvas, timeout) {
  const inspectorState = await readViewportInspectorState(page);
  if (inspectorState.context !== "view") {
    throw new Error("Appearance pixel capture expects the 3D View Inspector context to be open");
  }

  let capture = null;
  let captureError = null;
  let reopenError = null;
  try {
    await selectViewportInspectorContext(page, "selection", timeout);
    await waitForRenderedFrame(page);

    const canvasState = await assertCanvas(`appearance screenshot ${name}`);
    const canvas = page.locator(".fm-viewport-3d canvas");
    await canvas.first().waitFor({ state: "visible", timeout });
    if (await canvas.count() !== 1) {
      throw new Error("Appearance QA requires exactly one viewport canvas");
    }
    const screenshot = await canvas.first().screenshot({ type: "png" });
    const decoded = pngDecoder.sync.read(screenshot);
    const { data, width, height } = decoded;
    if (!(data instanceof Uint8Array) || width <= 0 || height <= 0 || data.length !== width * height * 4) {
      throw new Error("Playwright canvas screenshot did not decode to non-empty RGBA pixels");
    }
    snapshots.set(name, { data, height, width });

    const sampleRow = (fromTop) => {
      const y = Math.max(0, Math.min(height - 1, Math.round(height * fromTop)));
      const samples = [0.08, 0.5, 0.92].map((fraction) => {
        const x = Math.max(0, Math.min(width - 1, Math.round(width * fraction)));
        const offset = (y * width + x) * 4;
        return [data[offset], data[offset + 1], data[offset + 2]];
      });
      return {
        mean: [0, 1, 2].map((channel) => Math.round(samples.reduce((sum, sample) => sum + sample[channel], 0) / samples.length)),
        samples,
      };
    };
    let hash = 2166136261;
    for (let offset = 0; offset < data.length; offset += 16) {
      hash = Math.imul(hash ^ data[offset], 16777619);
    }
    capture = {
      height,
      hash: (hash >>> 0).toString(16).padStart(8, "0"),
      lower_mean: sampleRow(0.95).mean,
      preserve_drawing_buffer: canvasState.preserve_drawing_buffer ?? null,
      upper_mean: sampleRow(0.05).mean,
      width,
    };
  } catch (error) {
    captureError = error;
  } finally {
    try {
      await ensureSettingsOpen(page, inspectorState.section, timeout);
    } catch (error) {
      reopenError = error;
    }
  }
  if (captureError && reopenError) {
    throw new Error(
      `Canvas screenshot failed: ${captureError?.message ?? captureError}; ` +
      `settings panel restoration failed: ${reopenError?.message ?? reopenError}`,
    );
  }
  if (captureError) throw captureError;
  if (reopenError) throw reopenError;
  return capture;
}

function comparePixelSnapshots(snapshots, leftName, rightName) {
  const leftSnapshot = snapshots.get(leftName);
  const rightSnapshot = snapshots.get(rightName);
  if (!leftSnapshot || !rightSnapshot || leftSnapshot.width !== rightSnapshot.width ||
      leftSnapshot.height !== rightSnapshot.height) {
    throw new Error("Viewport pixel snapshots are missing or have different dimensions");
  }
  const { data: left } = leftSnapshot;
  const { data: right } = rightSnapshot;
  let changedPixels = 0;
  for (let offset = 0; offset < left.length; offset += 4) {
    if (Math.abs(left[offset] - right[offset]) > 2 ||
        Math.abs(left[offset + 1] - right[offset + 1]) > 2 ||
        Math.abs(left[offset + 2] - right[offset + 2]) > 2) {
      changedPixels += 1;
    }
  }
  return { changed_pixels: changedPixels, total_pixels: left.length / 4 };
}

function colorDistance(left, right) {
  return left.reduce((sum, value, index) => sum + Math.abs(value - right[index]), 0) / left.length;
}

function clearPixelSnapshots(snapshots, names) {
  for (const name of names) snapshots.delete(name);
}

async function checkNarrowViewport(page, settings, timeout) {
  await page.setViewportSize({ width: 480, height: 320 });
  await page.waitForTimeout(100);
  await ensureSettingsOpen(page, "Appearance", timeout);
  const targets = [
    settings.getByRole("combobox", { name: "Background", exact: true }),
    settings.locator("#fm-view-background-strength-number"),
    settings.getByRole("slider", { name: "Gradient strength", exact: true }),
  ];
  const visibleCounts = [];
  for (const target of targets) {
    await target.scrollIntoViewIfNeeded();
    await target.waitFor({ state: "visible", timeout });
    const box = await target.boundingBox();
    const settingsBox = await settings.boundingBox();
    if (!box || !settingsBox || box.x < 0 || box.y < 0 || box.x + box.width > 480 || box.y + box.height > 320 ||
        box.x < settingsBox.x - 1 || box.y < settingsBox.y - 1 ||
        box.x + box.width > settingsBox.x + settingsBox.width + 1 ||
        box.y + box.height > settingsBox.y + settingsBox.height + 1) {
      throw new Error(`A required viewport setting is clipped at 480x320: ${JSON.stringify({ control: box, settings: settingsBox })}`);
    }
    const reachable = await target.evaluate(control => {
      const rect = control.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return hit === control || control.contains(hit);
    });
    if (!reachable) throw new Error("A required viewport setting is obscured at 480x320");
    const layout = await readVisibleControlLayout(settings);
    if (layout.visibleControls === 0) throw new Error("Visible settings controls were omitted by the collision probe");
    if (layout.collisions.length) {
      throw new Error(`Viewport settings controls overlap at 480x320: ${layout.collisions.join(", ")}`);
    }
    visibleCounts.push(layout.visibleControls);
  }
  await ensureSettingsOpen(page, "View", timeout);
  const coordinateControl = settings.getByRole("combobox", { name: "Scale coordinates", exact: true });
  await coordinateControl.scrollIntoViewIfNeeded();
  await coordinateControl.waitFor({ state: "visible", timeout });
  const coordinateBox = await coordinateControl.boundingBox();
  const settingsBox = await settings.boundingBox();
  if (!coordinateBox || !settingsBox || coordinateBox.x < 0 || coordinateBox.y < 0 ||
      coordinateBox.x + coordinateBox.width > 480 || coordinateBox.y + coordinateBox.height > 320 ||
      coordinateBox.x < settingsBox.x - 1 || coordinateBox.y < settingsBox.y - 1 ||
      coordinateBox.x + coordinateBox.width > settingsBox.x + settingsBox.width + 1 ||
      coordinateBox.y + coordinateBox.height > settingsBox.y + settingsBox.height + 1) {
    throw new Error("A required viewport setting is clipped at 480x320");
  }
  const viewLayout = await readVisibleControlLayout(settings);
  if (viewLayout.visibleControls === 0) throw new Error("Visible View controls were omitted by the collision probe");
  if (viewLayout.collisions.length) {
    throw new Error(`Viewport settings controls overlap at 480x320: ${viewLayout.collisions.join(", ")}`);
  }
  visibleCounts.push(viewLayout.visibleControls);
  return {
    width: 480,
    height: 320,
    visible_controls_checked: targets.length + 1,
    visible_control_counts: visibleCounts,
    collisions: 0,
    device_pixel_ratio_changed: false,
  };
}

async function readVisibleControlLayout(settings) {
  return settings.evaluate((element) => {
    const container = element.getBoundingClientRect();
    const controls = [...element.querySelectorAll('button, [role="combobox"], [role="slider"], input[type="number"], input[type="checkbox"]')]
      .flatMap((control) => {
        const style = getComputedStyle(control);
        const box = control.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || box.width <= 0 || box.height <= 0) return [];
        const rect = {
          left: Math.max(0, container.left, box.left), right: Math.min(innerWidth, container.right, box.right),
          top: Math.max(0, container.top, box.top), bottom: Math.min(innerHeight, container.bottom, box.bottom),
        };
        // Rectangles of scrolled-out controls extend under the fixed tab bar.
        // Intersect every overflow clip before checking visible collisions.
        for (let parent = control.parentElement; parent; parent = parent.parentElement) {
          const parentStyle = getComputedStyle(parent);
          const bounds = parent.getBoundingClientRect();
          if (/auto|scroll|hidden|clip/.test(parentStyle.overflowX)) {
            rect.left = Math.max(rect.left, bounds.left + parent.clientLeft);
            rect.right = Math.min(rect.right, bounds.left + parent.clientLeft + parent.clientWidth);
          }
          if (/auto|scroll|hidden|clip/.test(parentStyle.overflowY)) {
            rect.top = Math.max(rect.top, bounds.top + parent.clientTop);
            rect.bottom = Math.min(rect.bottom, bounds.top + parent.clientTop + parent.clientHeight);
          }
          // Dock drawers are fixed above their collapsed, zero-size dock column.
          if (parentStyle.position === "fixed") break;
        }
        if (rect.right <= rect.left || rect.bottom <= rect.top) return [];
        return [{ name: control.getAttribute("aria-label") || control.textContent?.trim() || control.id || control.tagName, rect }];
      });
    const collisions = [];
    for (let leftIndex = 0; leftIndex < controls.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < controls.length; rightIndex += 1) {
        const left = controls[leftIndex];
        const right = controls[rightIndex];
        const overlapWidth = Math.min(left.rect.right, right.rect.right) - Math.max(left.rect.left, right.rect.left);
        const overlapHeight = Math.min(left.rect.bottom, right.rect.bottom) - Math.max(left.rect.top, right.rect.top);
        if (overlapWidth > 2 && overlapHeight > 2) collisions.push(`${left.name} / ${right.name}`);
      }
    }
    return { collisions, visibleControls: controls.length };
  });
}

async function verifyPreferenceReload(page, {
  assertCanvas,
  settings,
  expectedSession,
  getSessionIdentity,
  timeout,
}) {
  const routeBefore = page.url();
  await page.reload({ waitUntil: "domcontentloaded", timeout });
  if (page.url() !== routeBefore) {
    throw new Error("Preference reload did not stay on the current workspace route");
  }
  await page.locator("#fm-main-content.fm-workspace-body").waitFor({ state: "visible", timeout });
  await page.locator(".fm-viewport-3d").waitFor({ state: "visible", timeout });
  await assertCanvas("after appearance preference reload");
  const session = await getSessionIdentity();
  assertSameSession(expectedSession, session, "after appearance preference reload");
  await ensureSettingsOpen(page, "Appearance", timeout);
  const background = await readChoice(page, "Background", timeout);
  const strength = await readRangeValue(settings, "fm-view-background-strength");
  await ensureSettingsOpen(page, "View", timeout);
  const frame = await readChoice(page, "Grid and axes", timeout);
  const origin = await readChoice(page, "Scale coordinates", timeout);
  await ensureSettingsOpen(page, "Quality", timeout);
  const ambientOcclusion = await settings.getByRole("switch", { name: "Ambient occlusion", exact: true }).isChecked();
  const bloom = await settings.getByRole("switch", { name: "Bloom (Glow)", exact: true }).isChecked();
  if (background !== BACKGROUND_OPTIONS.gradient || Math.abs(strength - 1) > 0.001 ||
      frame !== FRAME_OPTIONS.floor || origin !== ORIGIN_OPTIONS.world || !ambientOcclusion || !bloom) {
    throw new Error("The selected appearance preferences did not survive a workspace reload");
  }
  return {
    state: "passed",
    preferences: {
      background,
      background_strength: strength,
      reference_frame: frame,
      coordinate_origin: origin,
      ambient_occlusion: ambientOcclusion,
      bloom,
    },
    session_identity_stable: true,
  };
}

async function restoreControls(page, settings, original, timeout) {
  await choose(page, "Geometry appearance", "Studio", "fm-view-lighting", timeout);
  await setRangeValue(page, "#fm-view-light-strength", original.lightingIntensity);
  await choose(page, "Geometry appearance", original.lightingMode, "fm-view-lighting", timeout);
  await choose(page, "Background", BACKGROUND_OPTIONS.gradient, "fm-view-background", timeout);
  await setRangeValue(page, "#fm-view-background-strength", original.strength);
  await choose(page, "Scale coordinates", ORIGIN_OPTIONS[original.originMode], "fm-view-origin", timeout);
  await choose(page, "Grid and axes", FRAME_OPTIONS[original.frameMode], "fm-view-frame", timeout);
  await setSwitch(page, "Ambient occlusion", original.ambientOcclusion, timeout);
  await setSwitch(page, "Bloom (Glow)", original.bloom, timeout);
  await choose(page, "Background", BACKGROUND_OPTIONS[original.backgroundMode], "fm-view-background", timeout);
  const restored = await readControls(page, settings, timeout);
  if (JSON.stringify(restored) !== JSON.stringify(original)) {
    throw new Error("Viewport appearance controls did not return to their original values");
  }
}

async function readAppearanceStorage(page) {
  return page.evaluate((key) => {
    try {
      return { available: true, value: window.localStorage.getItem(key), reason: null };
    } catch (error) {
      return { available: false, value: null, reason: String(error) };
    }
  }, APPEARANCE_STORAGE_KEY);
}

async function restoreAppearanceStorage(page, original) {
  if (!original.available) return false;
  await page.evaluate(({ key, value }) => {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  }, { key: APPEARANCE_STORAGE_KEY, value: original.value });
  const restored = await readAppearanceStorage(page);
  if (!restored.available || restored.value !== original.value) {
    throw new Error("Viewport appearance preference storage did not return to its original value");
  }
  return true;
}

function assertSameSession(expected, actual, label) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`Active session identity changed ${label}`);
  }
}

function normalizeText(value) {
  return String(value).replace(/\s+/g, " ").trim();
}


async function checkPresentationRendering(page, settings, { assertCanvas, pngDecoder, timeout, pixelSnapshots, lightingAudit }) {
  await ensureSettingsOpen(page, "Appearance", timeout);
  const originalMode = await readChoice(page, "Visualization mode", timeout);
  const originalLighting = await readChoice(page, "Geometry appearance", timeout);
  await ensureSettingsOpen(page, "Quality", timeout);
  const originalQuality = await readChoice(page, "Requested quality", timeout);
  const originalAo = await settings.getByRole("switch", { name: "Ambient occlusion", exact: true }).isChecked();
  let originalRoughness;
  let originalMetalness;
  let originalShadows;
  let difference = null;
  let presentationPng = null;
  const profiles = ["Interactive Lite", "Interactive", "Balanced", "Figure"];
  const isolatedQaBox = new Set(lightingAudit?.litPrimitiveObjectIds ?? []).has("qa-studio-box");
  let renderingError = null;
  try {
    await choose(page, "Visualization mode", "Presentation", "fm-view-render-mode", timeout);
    await choose(page, "Geometry appearance", "Studio", "fm-view-lighting", timeout);
    originalRoughness = await readRangeValue(settings, "fm-view-roughness");
    originalMetalness = await readRangeValue(settings, "fm-view-metalness");
    await setSwitch(page, "Ambient occlusion", false, timeout);
    originalShadows = await settings.getByRole("switch", { name: "Soft shadows", exact: true }).isChecked();
    await setSwitch(page, "Soft shadows", false, timeout);
    await setRangeValue(page, "#fm-view-metalness", 1);
    await setRangeValue(page, "#fm-view-roughness", 0.1);
    const polishedAudit = await page.evaluate(() => window.__FULLMAG_READ_VIEWPORT_3D_LIGHTING__?.());
    await readCanvasPixels(page, settings, "presentation-polished", pixelSnapshots, pngDecoder, assertCanvas, timeout);
    await setRangeValue(page, "#fm-view-roughness", 0.9);
    await readCanvasPixels(page, settings, "presentation-rough", pixelSnapshots, pngDecoder, assertCanvas, timeout);
    difference = comparePixelSnapshots(pixelSnapshots, "presentation-polished", "presentation-rough");
    const polishedPixels = pixelSnapshots.get("presentation-polished");
    if (polishedPixels) {
      const png = pngDecoder.sync.write(polishedPixels);
      if (png.length <= 2 * 1024 * 1024) presentationPng = png.toString("base64");
    }
    if (lightingAudit?.litPrimitiveMeshCount > 0 && lightingAudit.otherSurfaceMeshCount === 0 && difference.changed_pixels < 8) {
      const error = new Error("PBR roughness did not change an isolated uniform primitive under studio HDRI");
      error.partialProof = { difference, polishedAudit, roughAudit: await page.evaluate(() => window.__FULLMAG_READ_VIEWPORT_3D_LIGHTING__?.()), polished_png_base64: presentationPng };
      throw error;
    }
    await setSwitch(page, "Ambient occlusion", true, timeout);
    await setSwitch(page, "Soft shadows", true, timeout);
    const qualityPixels = [];
    for (const [index, profile] of profiles.entries()) {
      await choose(page, "Requested quality", profile, "fm-view-quality", timeout);
      await waitForRenderedFrame(page);
      await assertCanvas("presentation quality " + profile);
      const snapshotName = `presentation-quality-${index}`;
      await readCanvasPixels(page, settings, snapshotName, pixelSnapshots, pngDecoder, assertCanvas, timeout);
      const reference = pixelSnapshots.get("presentation-rough");
      const current = pixelSnapshots.get(snapshotName);
      let blackenedPixels = 0;
      if (reference && current && reference.data.length === current.data.length) {
        for (let offset = 0; offset < reference.data.length; offset += 4) {
          if (Math.max(reference.data[offset], reference.data[offset + 1], reference.data[offset + 2]) > 8 &&
              Math.max(current.data[offset], current.data[offset + 1], current.data[offset + 2]) <= 1) blackenedPixels += 1;
        }
      }
      if (isolatedQaBox && blackenedPixels > current.width * current.height * 0.1) {
        const error = new Error(`${profile} AO/shadows blackened the isolated QA box: ${blackenedPixels} pixels`);
        error.partialProof = { profile, blackenedPixels, polished_png_base64: presentationPng,
          current_png_base64: pngDecoder.sync.write(current).toString("base64") };
        throw error;
      }
      qualityPixels.push({ profile, blackened_pixels: blackenedPixels });
    }
    await choose(page, "Requested quality", "Interactive", "fm-view-quality", timeout);
    const exportProof = await runViewportExportBrowserQa(page, {
      assertCanvas, pngDecoder, timeout, expectedCaptureDpr: 1,
    });
    return {
      state: lightingAudit?.litPrimitiveMeshCount > 0 && lightingAudit.otherSurfaceMeshCount === 0 ? "passed" : "nonisolated-scene",
      roughness_changed_pixels: difference.changed_pixels,
      polished_png_base64: presentationPng,
      render_quality_profiles: profiles,
      context_checks: profiles.length,
      quality_pixel_checks: qualityPixels,
      presentation_png_export: exportProof,
      quantitative_data_protection: "Reported separately when quantitative data are visible",
    };
  } catch (error) {
    renderingError = error;
    throw error;
  } finally {
    try {
      if (originalRoughness !== undefined || originalMetalness !== undefined || originalShadows !== undefined) {
        await choose(page, "Visualization mode", "Presentation", "fm-view-render-mode", timeout);
      }
      if (originalShadows !== undefined) await setSwitch(page, "Soft shadows", originalShadows, timeout);
      if (originalRoughness !== undefined) await setRangeValue(page, "#fm-view-roughness", originalRoughness);
      if (originalMetalness !== undefined) await setRangeValue(page, "#fm-view-metalness", originalMetalness);
      await choose(page, "Requested quality", originalQuality, "fm-view-quality", timeout);
      await choose(page, "Geometry appearance", originalLighting, "fm-view-lighting", timeout);
      await choose(page, "Visualization mode", originalMode, "fm-view-render-mode", timeout);
      await setSwitch(page, "Ambient occlusion", originalAo, timeout);
      clearPixelSnapshots(pixelSnapshots, ["presentation-polished", "presentation-rough", ...profiles.map((_, index) => `presentation-quality-${index}`)]);
    } catch (restoreError) {
      if (renderingError) renderingError.message += `; presentation restoration failed: ${restoreError.message}`;
      else throw restoreError;
    }
  }
}


async function checkInspectorInteraction(page, { assertCanvas, timeout }) {
  const object = page.locator('[data-node-id="model:object:qa-offset-film-mvgw65uf"]');
  if (await object.count() !== 1) return { state: "not-run", reason: "The owned QA object is absent." };
  await selectViewportInspectorContext(page, "selection", timeout);
  const inspector = page.locator(".fm-inspector");
  if (!await inspector.locator(".fm-inspector__empty").isVisible().catch(() => false)) {
    await ensureViewportSettingsSection(page, "Appearance", timeout);
    return { state: "not-run", reason: "Preserving a pre-existing Inspector selection." };
  }
  const canvas = page.locator(".fm-viewport-3d canvas");
  const canvasNode = await canvas.elementHandle();
  const toolbar = page.getByRole("toolbar", { name: "3D view tools", exact: true });
  // The owned offset fixture must be in frame before PNG pixel assertions.
  await toolbar.getByRole("button", { name: "Fit view", exact: true }).click({ timeout });
  await waitForRenderedFrame(page);
  const buttons = toolbar.getByRole("button");
  const tabStops = await buttons.evaluateAll(nodes => nodes.filter(node => node.tabIndex === 0).length);
  if (tabStops !== 1) throw new Error(`3D toolbar exposes ${tabStops} tab stops instead of one`);
  await buttons.first().focus();
  await buttons.first().press("End");
  if (!await buttons.last().evaluate(node => node === document.activeElement)) throw new Error("Toolbar End did not focus the last control");
  await buttons.last().press("Home");
  if (!await buttons.first().evaluate(node => node === document.activeElement)) throw new Error("Toolbar Home did not focus the first control");

  const sceneUrl = new URL("/v2/sessions/current/model/scene", page.url()).toString();
  const before = await (await page.request.get(sceneUrl, { timeout })).json();
  await object.click({ timeout });
  const name = inspector.getByRole("textbox", { name: "Name", exact: true });
  await name.waitFor({ state: "visible", timeout });
  const originalName = await name.inputValue();
  const nameNode = await name.elementHandle();
  const inspectorNode = await inspector.elementHandle();
  const scroller = inspector.locator("[data-radix-scroll-area-viewport]").first();
  let cameraOriginal = null;
  let cameraField = null;
  let completed = false;
  let interactionProof = null;
  try {
    await name.fill(`${originalName} draft`, { timeout });
    const scrollBefore = await scroller.evaluate(node => { node.scrollTop = Math.min(64, node.scrollHeight - node.clientHeight); return node.scrollTop; });
    await toolbar.getByRole("button", { name: /settings/i }).click({ timeout });
    await ensureViewportSettingsSection(page, "View", timeout);
    const camera = getViewportCameraRegion(page);
    cameraField = camera.getByRole("spinbutton", { name: /FOV/i });
    cameraOriginal = await cameraField.inputValue();
    const cameraNode = await cameraField.elementHandle();
    const cameraDraft = String(Math.min(179, Number(cameraOriginal) + 1));
    await cameraField.fill(cameraDraft, { timeout });
    await selectViewportInspectorContext(page, "selection", timeout);
    if (await name.inputValue() !== `${originalName} draft`) throw new Error("Switching Inspector context lost the object draft");
    if (!await name.evaluate((node, original) => node === original, nameNode)) throw new Error("Switching Inspector context replaced the object input");
    if (!await inspector.evaluate((node, original) => node === original, inspectorNode)) throw new Error("Switching Inspector context replaced the selection panel");
    const scrollAfter = await scroller.evaluate(node => node.scrollTop);
    if (Math.abs(scrollAfter - scrollBefore) > 1) throw new Error(`Inspector scroll changed: ${scrollBefore} -> ${scrollAfter}`);
    await name.fill(originalName, { timeout });
    await selectViewportInspectorContext(page, "view", timeout);
    if (await cameraField.inputValue() !== cameraDraft || !await cameraField.evaluate((node, original) => node === original, cameraNode)) throw new Error("Switching Inspector context lost the camera draft");
    await camera.getByRole("button", { name: "Reset", exact: true }).click({ timeout });
    const projection = toolbar.getByRole("button", { name: "Projection", exact: true });
    const originalProjection = await projection.getAttribute("aria-pressed");
    await projection.click({ timeout });
    await page.waitForFunction(previous => document.querySelector('.fm-viewport-3d-toolbar button[aria-label="Projection"]')?.getAttribute("aria-pressed") !== previous, originalProjection, { timeout });
    await projection.click({ timeout });
    await page.waitForFunction(previous => document.querySelector('.fm-viewport-3d-toolbar button[aria-label="Projection"]')?.getAttribute("aria-pressed") === previous, originalProjection, { timeout });
    if (!await canvas.evaluate((node, original) => node === original, canvasNode)) throw new Error("Inspector interaction replaced the canvas");
    await assertCanvas("after Inspector context and toolbar projection checks");
    const after = await (await page.request.get(sceneUrl, { timeout })).json();
    if (after.revision !== before.revision) throw new Error("Draft-only Inspector checks changed authored data");
    completed = true;
    interactionProof = { state: "passed", toolbar_tab_stops: tabStops, toolbar_home_end: true, object_draft_preserved: true, selection_dom_preserved: true, scroll_before: scrollBefore, scroll_after: scrollAfter, camera_draft_preserved: true, projection_roundtrip: true, canvas_preserved: true, authored_revision_unchanged: true };
    return interactionProof;
  } finally {
    await selectViewportInspectorContext(page, "selection", timeout);
    if (await name.isVisible().catch(() => false)) await name.fill(originalName, { timeout });
    if (cameraField && cameraOriginal !== null) {
      await ensureViewportSettingsSection(page, "View", timeout);
      await getViewportCameraRegion(page).getByRole("button", { name: "Reset", exact: true }).click({ timeout });
      await selectViewportInspectorContext(page, "selection", timeout);
    }
    await canvas.click({ position: { x: 8, y: 8 }, timeout });
    await ensureViewportSettingsSection(page, "Appearance", timeout);
    if (completed) {
      await waitForRenderedFrame(page);
      const png = await page.screenshot({ type: "png", animations: "disabled", timeout });
      if (png.byteLength <= 512 * 1024) {
        // Bounded screenshot retained with the browser proof, not in source/build storage on the host.
        const preview = { mime_type: "image/png", byte_length: png.byteLength, sha256: createHash("sha256").update(png).digest("hex"), base64: png.toString("base64") };
        interactionProof.preview = preview;
      }
    }
  }
}
