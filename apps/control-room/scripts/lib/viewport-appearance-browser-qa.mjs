import { runViewportExportBrowserQa } from "./viewport-export-browser-qa.mjs";

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
  const dialog = page.getByRole("dialog", { name: "3D View Settings", exact: true });
  const originalDialogOpen = await dialog.isVisible().catch(() => false);
  const storageBefore = await readAppearanceStorage(page);
  let originalControls = null;
  let presentationRendering = null;
  let result = null;
  let operationError = null;
  let restorationError = null;
  let preferenceStorageRestored = false;
  const pixelSnapshots = new Map();

  try {
    await viewport.waitFor({ state: "visible", timeout });
    if (originalDialogOpen) {
      await dialog.getByRole("button", { name: "Close", exact: true }).click({ timeout });
      await dialog.waitFor({ state: "hidden", timeout });
    }
    await ensureSettingsOpen(page, dialog, false, timeout);
    originalControls = await readControls(page, dialog);

    try {
      presentationRendering = await checkPresentationRendering(page, dialog, {
        assertCanvas, pngDecoder, timeout, pixelSnapshots, lightingAudit: await page.evaluate(() => window.__FULLMAG_READ_VIEWPORT_3D_LIGHTING__?.()),
      });
    } catch (error) {
      if (error.partialProof) error.partialProof = { presentation_rendering: error.partialProof };
      throw error;
    }


    await choose(page, "Background", BACKGROUND_OPTIONS.gradient, "fm-view-background", timeout);
    await setRangeValue(page, "#fm-view-background-strength", 1);
    await waitForRenderedFrame(page);
    const gradient = await readCanvasPixels(page, dialog, "gradient", pixelSnapshots, pngDecoder, assertCanvas, timeout);

    await choose(page, "Background", BACKGROUND_OPTIONS.solid, "fm-view-background", timeout);
    await waitForRenderedFrame(page);
    const solid = await readCanvasPixels(page, dialog, "solid", pixelSnapshots, pngDecoder, assertCanvas, timeout);
    const backgroundDifference = comparePixelSnapshots(pixelSnapshots, "gradient", "solid");
    const upperDifference = colorDistance(gradient.upper_mean, solid.upper_mean);
    const lowerDifference = colorDistance(gradient.lower_mean, solid.lower_mean);
    if (Math.max(upperDifference, lowerDifference) < 4 || backgroundDifference.changed_pixels < 8) {
      throw new Error("Gradient-to-solid did not change the canvas background probes");
    }

    await choose(page, "Background", BACKGROUND_OPTIONS.gradient, "fm-view-background", timeout);
    await waitForRenderedFrame(page);
    const gradientRestored = await readCanvasPixels(page, dialog, "gradient-restored", pixelSnapshots, pngDecoder, assertCanvas, timeout);
    const restoredUpperDifference = colorDistance(gradient.upper_mean, gradientRestored.upper_mean);
    const restoredLowerDifference = colorDistance(gradient.lower_mean, gradientRestored.lower_mean);
    if (restoredUpperDifference > 3 || restoredLowerDifference > 3) {
      throw new Error("Restoring the gradient did not restore the upper and lower canvas probes");
    }
    clearPixelSnapshots(pixelSnapshots, ["gradient", "solid", "gradient-restored"]);

    if (originalControls.frameMode === "off") {
      await choose(page, "Reference frame", FRAME_OPTIONS.floor, "fm-view-frame", timeout);
    }
    await choose(page, "Scale coordinates", ORIGIN_OPTIONS["frame-center"], "fm-view-origin", timeout);
    const frameCenterOriginText = await readChoice(page, "Scale coordinates");
    if (frameCenterOriginText !== ORIGIN_OPTIONS["frame-center"]) {
      throw new Error("Frame-center coordinate mode did not publish its selected HUD setting text");
    }
    await waitForRenderedFrame(page);
    const frameCenterPixels = await readCanvasPixels(page, dialog, "frame-center", pixelSnapshots, pngDecoder, assertCanvas, timeout);
    await choose(page, "Scale coordinates", ORIGIN_OPTIONS.world, "fm-view-origin", timeout);
    await waitForRenderedFrame(page);
    const worldPixels = await readCanvasPixels(page, dialog, "world", pixelSnapshots, pngDecoder, assertCanvas, timeout);
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
      await readCanvasPixels(page, dialog, "studio-zero", pixelSnapshots, pngDecoder, assertCanvas, timeout);
      await choose(page, "Geometry appearance", "Flat", "fm-view-lighting", timeout);
      if (!await page.locator("#fm-view-light-strength").isDisabled()) {
        throw new Error("Flat geometry must explain its inactive studio light controls");
      }
      await readCanvasPixels(page, dialog, "flat-zero", pixelSnapshots, pngDecoder, assertCanvas, timeout);
      await choose(page, "Geometry appearance", "Studio", "fm-view-lighting", timeout);
      await setRangeValue(page, "#fm-view-light-strength", 2);
      await readCanvasPixels(page, dialog, "studio-two", pixelSnapshots, pngDecoder, assertCanvas, timeout);
      await choose(page, "Geometry appearance", "Flat", "fm-view-lighting", timeout);
      await readCanvasPixels(page, dialog, "flat-two", pixelSnapshots, pngDecoder, assertCanvas, timeout);
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
    const effectReasons = await dialog.getByRole("status").allInnerTexts();
    const diagnostics = Object.fromEntries(effectReasons.map((text) => {
      const separator = text.indexOf(":");
      return separator < 0
        ? [text, text]
        : [text.slice(0, separator).trim(), text.slice(separator + 1).trim()];
    }));
    const protectedReason = "Quantitative field colors are protected";
    const protectedEffects = ["ambientOcclusion", "bloom"]
      .filter((effect) => diagnostics[effect] === protectedReason);
    const postProcessingUnavailableReason = Object.values(diagnostics).find((reason) =>
      reason === "Post-processing is disabled by browser configuration.",
    ) ?? null;
    if (protectedEffects.length === 1) {
      throw new Error("Quantitative color protection was not reported for both AO and Bloom");
    }


    const narrowLayout = await checkNarrowViewport(page, dialog, timeout);
    await page.setViewportSize(originalViewport);
    await page.waitForTimeout(100);

    const sessionBeforeReload = await getSessionIdentity();
    assertSameSession(expectedSession, sessionBeforeReload, "before appearance preference reload");
    const persistence = storageBefore.available && new URL(page.url()).pathname.startsWith("/workspace")
      ? await verifyPreferenceReload(page, {
          assertCanvas,
          dialog,
          expectedSession,
          getSessionIdentity,
          timeout,
        })
      : {
          state: "skipped",
          reason: storageBefore.available
            ? "The active page is not the current workspace route."
            : "Browser local storage is unavailable.",
        };

    result = {
      presentation_rendering: presentationRendering,
      settings_dialog: {
        opened_from_view_settings: true,
        title: "3D View Settings",
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
      await cleanup(() => ensureSettingsOpen(page, dialog, true, timeout));
      await cleanup(() => restoreControls(page, dialog, originalControls, timeout));
    }
    await cleanup(async () => {
      preferenceStorageRestored = await restoreAppearanceStorage(page, storageBefore);
    });
    if (originalDialogOpen) {
      await cleanup(() => ensureSettingsOpen(page, dialog, true, timeout));
    } else {
      await cleanup(async () => {
        if (await dialog.isVisible().catch(() => false)) {
          await dialog.getByRole("button", { name: "Close", exact: true }).click({ timeout });
          await dialog.waitFor({ state: "hidden", timeout });
        }
      });
    }
    if (cleanupErrors.length) restorationError = new Error(cleanupErrors.join("; "));
  }

  if (operationError && restorationError) {
    throw new Error(
      `Appearance QA failed: ${operationError?.message ?? operationError}; ` +
      `preference restoration failed: ${restorationError?.message ?? restorationError}`,
    );
  }
  if (operationError) throw operationError;
  if (restorationError) throw restorationError;
  result.original_controls_restored = true;
  result.original_preference_storage = preferenceStorageRestored ? "verified" : "unavailable";
  return result;
}

async function ensureSettingsOpen(page, dialog, allowAlreadyOpen, timeout) {
  if (allowAlreadyOpen && await dialog.isVisible().catch(() => false)) return;
  const button = page.getByRole("button", { name: /view settings/i });
  await button.waitFor({ state: "visible", timeout });
  await button.click({ timeout });
  await dialog.waitFor({ state: "visible", timeout });
}

async function readControls(page, dialog) {
  const background = await readChoice(page, "Background");
  const origin = await readChoice(page, "Scale coordinates");
  const frame = await readChoice(page, "Reference frame");
  const strength = Number(await page.locator("#fm-view-background-strength").inputValue());
  const ambientOcclusion = await dialog.getByRole("switch", { name: "Ambient occlusion", exact: true }).isChecked();
  const bloom = await dialog.getByRole("switch", { name: "Bloom (Glow)", exact: true }).isChecked();
  const lightingMode = await readChoice(page, "Geometry appearance");
  const lightingIntensity = Number(await page.locator("#fm-view-light-strength").inputValue());
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

async function readChoice(page, label) {
  return normalizeText(await page.getByRole("combobox", { name: label, exact: true }).innerText());
}

async function choose(page, label, option, id, timeout) {
  const trigger = page.getByRole("combobox", { name: label, exact: true });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click({ timeout });
  await page.getByRole("option", { name: option, exact: true }).click({ timeout });
  await page.waitForFunction(({ controlId, expected }) => {
    const control = document.getElementById(controlId);
    return (control?.textContent ?? "").replace(/\s+/g, " ").trim().includes(expected);
  }, { controlId: id, expected: option }, { timeout });
}

async function setRangeValue(page, selector, target) {
  const input = page.locator(selector);
  const range = await input.evaluate((element) => ({
    max: Number(element.max),
    min: Number(element.min),
    step: Number(element.step),
  }));
  if (!Number.isFinite(range.step) || range.step <= 0 || target < range.min || target > range.max) {
    throw new Error(`Range target ${target} is outside ${selector}`);
  }
  const targetSteps = Math.round((target - range.min) / range.step);
  if (Math.abs(range.min + targetSteps * range.step - target) > range.step * 0.01) {
    throw new Error(`Range target ${target} does not align with ${selector} steps`);
  }
  await input.focus();
  await input.press("Home");
  for (let step = 0; step < targetSteps; step += 1) {
    await input.press("ArrowRight");
  }
  const actual = Number(await input.inputValue());
  if (Math.abs(actual - target) > range.step * 0.01) {
    throw new Error(`Range ${selector} resolved to ${actual}, expected ${target}`);
  }
}

async function setSwitch(page, label, checked, timeout) {
  const inputId = {
    "Ambient occlusion": "fm-viewport-3d-effect-ambient-occlusion",
    "Bloom (Glow)": "fm-viewport-3d-effect-bloom",
    "Soft shadows": "fm-view-shadows",
  }[label];
  if (!inputId) throw new Error(`Unknown appearance switch ${label}`);
  const control = page.getByRole("switch", { name: label, exact: true });
  if (await control.isChecked() !== checked) await control.click();
  await page.waitForFunction(({ id, expected }) =>
    document.getElementById(id)?.checked === expected,
  { id: inputId, expected: checked }, { timeout });
}

async function waitForRenderedFrame(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  await page.waitForTimeout(40);
}

async function readCanvasPixels(page, dialog, name, snapshots, pngDecoder, assertCanvas, timeout) {
  if (!await dialog.isVisible().catch(() => false)) {
    throw new Error("Appearance pixel capture expects the settings dialog to be open");
  }

  let capture = null;
  let captureError = null;
  let reopenError = null;
  try {
    await dialog.getByRole("button", { name: "Close", exact: true }).click({ timeout });
    await dialog.waitFor({ state: "hidden", timeout });
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
      await ensureSettingsOpen(page, dialog, true, timeout);
    } catch (error) {
      reopenError = error;
    }
  }
  if (captureError && reopenError) {
    throw new Error(
      `Canvas screenshot failed: ${captureError?.message ?? captureError}; ` +
      `settings dialog restoration failed: ${reopenError?.message ?? reopenError}`,
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

async function checkNarrowViewport(page, dialog, timeout) {
  await page.setViewportSize({ width: 480, height: 320 });
  await page.waitForTimeout(100);
  const targets = [
    page.getByRole("combobox", { name: "Background", exact: true }),
    page.locator("#fm-view-background-strength"),
    page.getByRole("combobox", { name: "Scale coordinates", exact: true }),
    dialog.getByRole("button", { name: "Close", exact: true }),
  ];
  const visibleCounts = [];
  for (const target of targets) {
    await target.scrollIntoViewIfNeeded();
    await target.waitFor({ state: "visible", timeout });
    const box = await target.boundingBox();
    const dialogBox = await dialog.boundingBox();
    if (!box || !dialogBox || box.x < 0 || box.y < 0 || box.x + box.width > 480 || box.y + box.height > 320 ||
        box.x < dialogBox.x - 1 || box.y < dialogBox.y - 1 ||
        box.x + box.width > dialogBox.x + dialogBox.width + 1 ||
        box.y + box.height > dialogBox.y + dialogBox.height + 1) {
      throw new Error("A required viewport setting is clipped at 480x320");
    }
    const layout = await readVisibleControlLayout(dialog);
    if (layout.collisions.length) {
      throw new Error(`Viewport settings controls overlap at 480x320: ${layout.collisions.join(", ")}`);
    }
    visibleCounts.push(layout.visibleControls);
  }
  return {
    width: 480,
    height: 320,
    visible_controls_checked: targets.length,
    visible_control_counts: visibleCounts,
    collisions: 0,
    device_pixel_ratio_changed: false,
  };
}

async function readVisibleControlLayout(dialog) {
  return dialog.evaluate((element) => {
    const container = element.getBoundingClientRect();
    const controls = [...element.querySelectorAll('button, [role="combobox"], input[type="range"], input[type="checkbox"]')]
      .filter((control) => {
        const style = getComputedStyle(control);
        const rect = control.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 &&
          rect.width > 0 && rect.height > 0 && rect.left < container.right && rect.right > container.left &&
          rect.top < container.bottom && rect.bottom > container.top && rect.left < innerWidth && rect.right > 0 &&
          rect.top < innerHeight && rect.bottom > 0;
      })
      .map((control) => ({
        name: control.getAttribute("aria-label") || control.textContent?.trim() || control.id || control.tagName,
        rect: control.getBoundingClientRect().toJSON(),
      }));
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
  dialog,
  expectedSession,
  getSessionIdentity,
  timeout,
}) {
  await page.reload({ waitUntil: "domcontentloaded", timeout });
  if (!new URL(page.url()).pathname.startsWith("/workspace")) {
    throw new Error("Preference reload did not stay on the current workspace route");
  }
  await page.locator("#fm-main-content.fm-workspace-body").waitFor({ state: "visible", timeout });
  await page.locator(".fm-viewport-3d").waitFor({ state: "visible", timeout });
  await assertCanvas("after appearance preference reload");
  const session = await getSessionIdentity();
  assertSameSession(expectedSession, session, "after appearance preference reload");
  await ensureSettingsOpen(page, dialog, false, timeout);

  const background = await readChoice(page, "Background");
  const strength = Number(await page.locator("#fm-view-background-strength").inputValue());
  const frame = await readChoice(page, "Reference frame");
  const origin = await readChoice(page, "Scale coordinates");
  const ambientOcclusion = await dialog.getByRole("switch", { name: "Ambient occlusion", exact: true }).isChecked();
  const bloom = await dialog.getByRole("switch", { name: "Bloom (Glow)", exact: true }).isChecked();
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

async function restoreControls(page, dialog, original, timeout) {
  await choose(page, "Geometry appearance", "Studio", "fm-view-lighting", timeout);
  await setRangeValue(page, "#fm-view-light-strength", original.lightingIntensity);
  await choose(page, "Geometry appearance", original.lightingMode, "fm-view-lighting", timeout);
  await choose(page, "Background", BACKGROUND_OPTIONS.gradient, "fm-view-background", timeout);
  await setRangeValue(page, "#fm-view-background-strength", original.strength);
  await choose(page, "Scale coordinates", ORIGIN_OPTIONS[original.originMode], "fm-view-origin", timeout);
  await choose(page, "Reference frame", FRAME_OPTIONS[original.frameMode], "fm-view-frame", timeout);
  await setSwitch(page, "Ambient occlusion", original.ambientOcclusion, timeout);
  await setSwitch(page, "Bloom (Glow)", original.bloom, timeout);
  await choose(page, "Background", BACKGROUND_OPTIONS[original.backgroundMode], "fm-view-background", timeout);
  const restored = await readControls(page, dialog);
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


async function checkPresentationRendering(page, dialog, { assertCanvas, pngDecoder, timeout, pixelSnapshots, lightingAudit }) {
  const [originalMode, originalQuality, originalLighting, originalAo] = await Promise.all([
    readChoice(page, "Visualization mode"),
    readChoice(page, "Render quality"),
    readChoice(page, "Geometry appearance"),
    dialog.getByRole("switch", { name: "Ambient occlusion", exact: true }).isChecked(),
  ]);
  let originalRoughness;
  let originalMetalness;
  let originalShadows;
  let difference = null;
  let presentationPng = null;
  const profiles = ["Interactive Lite", "Interactive", "Balanced", "Figure"];
  const isolatedQaBox = new Set(lightingAudit?.litPrimitiveObjectIds ?? []).has("qa-studio-box");
  try {
    await choose(page, "Visualization mode", "Presentation — PBR and studio HDRI", "fm-view-render-mode", timeout);
    await choose(page, "Geometry appearance", "Studio", "fm-view-lighting", timeout);
    await setSwitch(page, "Ambient occlusion", false, timeout);
    originalShadows = await dialog.getByRole("switch", { name: "Soft shadows", exact: true }).isChecked();
    await setSwitch(page, "Soft shadows", false, timeout);
    originalRoughness = Number(await page.locator("#fm-view-roughness").inputValue());
    originalMetalness = Number(await page.locator("#fm-view-metalness").inputValue());
    await setRangeValue(page, "#fm-view-metalness", 1);
    await setRangeValue(page, "#fm-view-roughness", 0.1);
    const polishedAudit = await page.evaluate(() => window.__FULLMAG_READ_VIEWPORT_3D_LIGHTING__?.());
    await readCanvasPixels(page, dialog, "presentation-polished", pixelSnapshots, pngDecoder, assertCanvas, timeout);
    await setRangeValue(page, "#fm-view-roughness", 0.9);
    await readCanvasPixels(page, dialog, "presentation-rough", pixelSnapshots, pngDecoder, assertCanvas, timeout);
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
      await choose(page, "Render quality", profile, "fm-view-quality", timeout);
      await waitForRenderedFrame(page);
      await assertCanvas("presentation quality " + profile);
      const snapshotName = `presentation-quality-${index}`;
      await readCanvasPixels(page, dialog, snapshotName, pixelSnapshots, pngDecoder, assertCanvas, timeout);
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
    await choose(page, "Render quality", "Interactive", "fm-view-quality", timeout);
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
  } finally {
    if (originalShadows !== undefined) await setSwitch(page, "Soft shadows", originalShadows, timeout);
    if (originalRoughness !== undefined) await setRangeValue(page, "#fm-view-roughness", originalRoughness);
    if (originalMetalness !== undefined) await setRangeValue(page, "#fm-view-metalness", originalMetalness);
    await choose(page, "Render quality", originalQuality, "fm-view-quality", timeout);
    await choose(page, "Geometry appearance", originalLighting, "fm-view-lighting", timeout);
    await choose(page, "Visualization mode", originalMode, "fm-view-render-mode", timeout);
    await setSwitch(page, "Ambient occlusion", originalAo, timeout);
    clearPixelSnapshots(pixelSnapshots, ["presentation-polished", "presentation-rough", ...profiles.map((_, index) => `presentation-quality-${index}`)]);
  }
}
