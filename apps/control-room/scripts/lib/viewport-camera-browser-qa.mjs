import { createHash } from "node:crypto";

const VIEWPORT_SELECTOR = ".fm-viewport-3d";
const CANVAS_SELECTOR = `${VIEWPORT_SELECTOR} canvas`;
const CAMERA_DIALOG_NAME = "Camera Parameters";
const COMMAND_PALETTE_NAME = "Command palette";
const MAX_ACTION_TIMEOUT_MS = 30_000;
const MAX_RESTORE_TIMEOUT_MS = 4_000;
const MAX_EMBEDDED_PNG_BYTES = 512 * 1024;
const UP_TOLERANCE = 1e-6;
const SCENE_RELATIVE_TOLERANCE = 1e-6;
const SCALAR_RELATIVE_TOLERANCE = 1e-6;
const SI_ABSOLUTE_FLOOR = 1e-18;
const WORLD_UP = [0, 0, 1];

const CAMERA_POSES = Object.freeze([
  { name: "oblique-xy-positive", direction: [1, 1, 1] },
  { name: "oblique-x-negative", direction: [-1, 1, 1] },
  { name: "oblique-xy-negative", direction: [-1, -1, 1] },
  { name: "oblique-y-negative", direction: [1, -1, 1] },
  { name: "under-floor", direction: [1, 1, -1] },
  { name: "axis-x-positive", direction: [1, 0, 0] },
  { name: "axis-x-negative", direction: [-1, 0, 0] },
  { name: "axis-y-positive", direction: [0, 1, 0] },
  { name: "axis-y-negative", direction: [0, -1, 0] },
  { name: "axis-z-positive", direction: [0, 0, 1] },
  { name: "axis-z-negative", direction: [0, 0, -1] },
]);

/**
 * Exercises the visible 3D camera dialog and command palette, then restores
 * the original camera through the same user-facing controls. PNGs are decoded
 * in Node from Playwright canvas screenshots; nothing is written to disk.
 */
export async function runViewportCameraBrowserQa(page, options = {}) {
  const assertCanvas = options.assertCanvas;
  const pngDecoder = options.pngDecoder;
  const timeout = boundedTimeout(options.timeout);
  if (typeof assertCanvas !== "function") {
    throw new Error("Viewport camera QA requires the managed canvas assertion");
  }
  if (typeof pngDecoder?.sync?.read !== "function") {
    throw new Error("Pinned Playwright utilsBundle does not expose PNG.sync.read");
  }

  const viewport = page.locator(VIEWPORT_SELECTOR);
  const canvas = page.locator(CANVAS_SELECTOR);
  const cameraDialog = page.getByRole("dialog", {
    exact: true,
    name: CAMERA_DIALOG_NAME,
  });
  const commandPalette = page.getByRole("dialog", {
    exact: true,
    name: COMMAND_PALETTE_NAME,
  });

  let originalCameraDialogOpen = null;
  let originalCommandPaletteOpen = null;
  let originalCamera = null;
  let originalDialogValues = null;
  let originalCanvasHandle = null;
  let mutationStarted = false;
  let operationError = null;
  const restorationErrors = [];
  const commands = [];
  const captures = [];
  const poses = [];
  const fovChecks = [];
  let fovChangedPixels = null;
  let fovFitChangedPosition = null;
  let pointerGestures = null;
  const snapshots = new Map();

  try {
    await viewport.waitFor({ state: "visible", timeout });
    await canvas.first().waitFor({ state: "visible", timeout });
    if (await canvas.count() !== 1) {
      throw new Error("Viewport camera QA requires exactly one visible 3D canvas");
    }
    originalCanvasHandle = await canvas.elementHandle();
    if (!originalCanvasHandle) {
      throw new Error("Viewport camera QA could not retain the original canvas element");
    }
    originalCameraDialogOpen = await cameraDialog.isVisible().catch(() => false);
    originalCommandPaletteOpen = await commandPalette.isVisible().catch(() => false);
    if (originalCommandPaletteOpen) {
      throw new Error("Close the command palette before starting viewport camera QA");
    }

    originalCamera = await readCamera(viewport);
    validateCameraPrecondition(originalCamera);
    await assertCanvas("before viewport camera QA");

    await setCameraDialogOpen(page, cameraDialog, true, timeout);
    originalDialogValues = await readDialogValues(cameraDialog);
    validateDialogValues(originalCamera, originalDialogValues);

    captures.push(await captureCanvas(page, {
      assertCanvas,
      cameraDialog,
      canvas,
      name: "initial",
      pngDecoder,
      preserveDialogOpen: true,
      timeout,
      snapshots,
      embedPng: true,
    }));

    // The ring example reproduces the original depth regression: the eye is
    // inside the universe bounds, while the 50 nm ring and 1.6 nm film are ahead.
    if (options.ringDepthRegression === true) {
      const originalRibbonTabId = await page.locator('.fm-ribbon__tab[aria-selected="true"]').getAttribute("id");
      if (!/^fm-ribbon-tab-[a-zA-Z0-9_.:-]+$/.test(originalRibbonTabId ?? "")) {
        throw new Error("Selected ribbon tab has no stable identity");
      }
      await setCameraDialogOpen(page, cameraDialog, false, timeout);
      const originalSurfacePasses = await readSurfacePasses(page, timeout);
      try {
        for (const pose of [
          { name: "ring-close-oblique", position: [1.6710714031932422e-7, -6.101199092239823e-7, 2.0428454917790962e-7], target: [0, 0, 1.55e-7], projection: "perspective" },
          { name: "ring-close-front", position: [6e-7, 0, 1.608e-7], target: [0, 0, 1.608e-7], projection: "perspective" },
          { name: "ring-close-ortho", position: [6e-7, 0, 1.608e-7], target: [0, 0, 1.608e-7], projection: "orthographic" },
        ]) {
          await setCameraDialogOpen(page, cameraDialog, true, timeout);
          await fillVector(cameraDialog, "Position (m)", pose.position);
          await fillVector(cameraDialog, "Target (m)", pose.target);
          await getProjectionInput(cameraDialog).selectOption(pose.projection);
          await getScalarInput(cameraDialog, "FOV").fill("45");
          await getScalarInput(cameraDialog, "Ortho scale").fill("6e-7");
          mutationStarted = true;
          await cameraDialog.getByRole("button", { exact: true, name: "Apply" }).click({ timeout });
          await waitForCamera(page, viewport, pose, timeout);
          for (const mode of ["Shaded surface", "Shaded + wireframe", "Wireframe"]) {
            await setCameraDialogOpen(page, cameraDialog, false, timeout);
            await setSurfaceRenderMode(page, mode, timeout);
            const capture = await captureCanvas(page, {
              assertCanvas, cameraDialog, canvas,
              name: `${pose.name}-${mode.toLowerCase().replace(/[^a-z]+/g, "-")}`, pngDecoder,
              preserveDialogOpen: true, timeout, snapshots, embedPng: true,
            });
            capture.surface_render_mode = mode;
            const { near, far } = capture.live_depth_range;
            const depth = distance(pose.position, pose.target);
            const resolution = pose.projection === "orthographic"
              ? (far - near) / (2 ** 24 - 1)
              : (depth * depth * (far - near)) / (far * near * (2 ** 24 - 1));
            if (near >= depth / 10 || far <= depth || resolution > 1.6e-9 / 20) {
              throw new Error(`Ring depth range loses thin-film precision at ${pose.name}: ${JSON.stringify({ near, far, resolution })}`);
            }
            capture.estimated_24bit_depth_step_m = resolution;
            captures.push(capture);
            // This fixed fixture has a red CoFeB ring. HUD axes alone must not
            // qualify a blank canvas after a topology resource failure.
            if (mode !== "Wireframe") assertRingSurfacePixels(capture);
          }
        }
      } finally {
        await setCameraDialogOpen(page, cameraDialog, false, timeout);
        await restoreSurfacePasses(page, originalSurfacePasses, timeout);
        await page.locator(`.fm-ribbon__tab[id="${originalRibbonTabId}"]`).click({ timeout });
        await setCameraDialogOpen(page, cameraDialog, true, timeout);
      }
      await restoreCamera(page, cameraDialog, originalCamera, originalDialogValues, timeout);
    }

    const pointerRadius = distance(originalCamera.position, originalCamera.target);
    const pointerDirection = normalize([1, 0.1, 0.1]);
    const pointerPosition = originalCamera.target.map((value, index) =>
      value + pointerRadius * pointerDirection[index]);
    await fillVector(cameraDialog, "Position (m)", pointerPosition);
    mutationStarted = true;
    await cameraDialog.getByRole("button", { exact: true, name: "Apply" }).click({ timeout });
    await waitForCamera(page, viewport, { position: pointerPosition }, timeout);
    await setCameraDialogOpen(page, cameraDialog, false, timeout);
    pointerGestures = await exercisePointerGestures(page, { viewport, canvas, assertCanvas, timeout });
    await setCameraDialogOpen(page, cameraDialog, true, timeout);
    await restoreCamera(page, cameraDialog, originalCamera, originalDialogValues, timeout);

    for (let toggleIndex = 0; toggleIndex < 2; toggleIndex += 1) {
      const before = await readCamera(viewport);
      const expectedProjection = before.projection === "perspective"
        ? "orthographic"
        : "perspective";
      await setCameraDialogOpen(page, cameraDialog, false, timeout);
      mutationStarted = true;
      await executeVisibleCommand(page, commandPalette, "Toggle projection", timeout);
      const after = await waitForCamera(page, viewport, {
        projection: expectedProjection,
      }, timeout);
      commands.push({
        title: "Toggle projection",
        invocation: "visible-command-palette",
        from: before.projection,
        to: after.projection,
        observed: true,
      });
      await assertCanvas(`after ${after.projection} projection`);
      captures.push(await captureCanvas(page, {
        assertCanvas,
        cameraDialog,
        canvas,
        name: `projection-${after.projection}`,
        pngDecoder,
        preserveDialogOpen: false,
        timeout,
        snapshots,
        embedPng: false,
      }));
    }

    for (const fovDegrees of [35, 70]) {
      await setCameraDialogOpen(page, cameraDialog, true, timeout);
      await fillVector(cameraDialog, "Position (m)", originalCamera.position);
      await fillVector(cameraDialog, "Target (m)", originalCamera.target);
      await getProjectionInput(cameraDialog).selectOption("perspective");
      await getScalarInput(cameraDialog, "FOV").fill(String(fovDegrees));
      mutationStarted = true;
      await cameraDialog.getByRole("button", { exact: true, name: "Apply" }).click({ timeout });
      const actual = await waitForCamera(page, viewport, {
        position: originalCamera.position, target: originalCamera.target,
        projection: "perspective", up: originalCamera.up,
      }, timeout);
      captures.push(await captureCanvas(page, {
        assertCanvas, cameraDialog, canvas, name: `fov-${fovDegrees}`, pngDecoder,
        preserveDialogOpen: false, timeout, snapshots, embedPng: false,
      }));
      await executeVisibleCommand(page, commandPalette, "Fit 3D View", timeout);
      await page.waitForTimeout(250);
      const fitted = await readCamera(viewport);
      assertCameraFinite(fitted, `Fit at FOV ${fovDegrees}`);
      await assertCanvas(`Fit at FOV ${fovDegrees}`);
      fovChecks.push({ fov_degrees: fovDegrees, camera_before_fit: actual, camera_after_fit: fitted });
    }
    const narrowFov = snapshots.get("fov-35");
    const wideFov = snapshots.get("fov-70");
    if (!narrowFov?.pixels || !wideFov?.pixels ||
        narrowFov.width !== wideFov.width || narrowFov.height !== wideFov.height) {
      throw new Error("FOV captures must contain comparable decoded canvas pixels");
    }
    fovChangedPixels = 0;
    for (let offset = 0; offset < narrowFov.pixels.length; offset += 4) {
      if (!narrowFov.pixels.subarray(offset, offset + 4).equals(wideFov.pixels.subarray(offset, offset + 4))) {
        fovChangedPixels += 1;
      }
    }
    if (fovChangedPixels === 0) throw new Error("Changing FOV at a fixed camera pose did not change the rendered image");
    fovFitChangedPosition = !sameCamera(fovChecks[0].camera_after_fit, fovChecks[1].camera_after_fit);
    if (!fovFitChangedPosition) throw new Error("Fit did not respond to the changed perspective FOV");
    await setCameraDialogOpen(page, cameraDialog, true, timeout);
    await restoreCamera(page, cameraDialog, originalCamera, originalDialogValues, timeout);

    const target = [...originalCamera.target];
    const radius = distance(originalCamera.position, originalCamera.target);
    if (!Number.isFinite(radius) || radius <= 0) {
      throw new Error("Initial camera position and target do not define a usable radius");
    }

    for (const pose of CAMERA_POSES) {
      const direction = normalize(pose.direction);
      const position = target.map((value, index) => value + radius * direction[index]);
      await setCameraDialogOpen(page, cameraDialog, true, timeout);
      await fillVector(cameraDialog, "Position (m)", position);
      await fillVector(cameraDialog, "Target (m)", target);
      mutationStarted = true;
      await cameraDialog.getByRole("button", { exact: true, name: "Apply" }).click({ timeout });
      const actualCamera = await waitForCamera(page, viewport, {
        position,
        target,
        projection: originalCamera.projection,
        up: originalCamera.up,
      }, timeout);
      await assertCanvas(`after camera pose ${pose.name}`);
      const capture = await captureCanvas(page, {
        assertCanvas,
        cameraDialog,
        canvas,
        name: pose.name,
        pngDecoder,
        preserveDialogOpen: true,
        timeout,
        snapshots,
        embedPng: pose.name === "under-floor" || pose.name === "axis-z-positive",
      });
      captures.push(capture);
      poses.push({
        name: pose.name,
        source: "visible-camera-dialog",
        requested_direction: direction,
        requested_position: position,
        target,
        actual_camera: actualCamera,
        capture: capture.name,
        view_cube_interaction: "NOT VERIFIED",
      });
    }

    const beforeFit = await readCamera(viewport);
    await setCameraDialogOpen(page, cameraDialog, false, timeout);
    mutationStarted = true;
    await executeVisibleCommand(page, commandPalette, "Fit 3D View", timeout);
    await page.waitForTimeout(180);
    const afterFit = await readCamera(viewport);
    await assertCameraFinite(afterFit, "after Fit 3D View");
    const fitChangedCamera = !sameCamera(beforeFit, afterFit);
    commands.push({
      title: "Fit 3D View",
      invocation: "visible-command-palette",
      camera_changed: fitChangedCamera,
      observation: fitChangedCamera ? "camera-change-observed" : "no-camera-change-observed",
      before: beforeFit,
      after: afterFit,
    });
    await assertCanvas("after Fit 3D View");
    captures.push(await captureCanvas(page, {
      assertCanvas,
      cameraDialog,
      canvas,
      name: "fit-3d-view",
      pngDecoder,
      preserveDialogOpen: false,
      timeout,
      snapshots,
      embedPng: false,
    }));

    if (new Set([...snapshots.values()].map(({ pixelSha256 }) => pixelSha256)).size < 2) {
      throw new Error("Camera QA screenshots did not contain distinct decoded canvas pixels");
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

    await restore("close transient command palette", async () => {
      if (
        originalCommandPaletteOpen !== true &&
        await commandPalette.isVisible().catch(() => false)
      ) {
        await page.keyboard.press("Escape");
        await commandPalette.waitFor({ state: "hidden", timeout: restoreTimeout });
      }
    });

    if (mutationStarted && originalCamera && originalDialogValues) {
      await restore("restore original camera through visible dialog", async () => {
        await setCameraDialogOpen(page, cameraDialog, true, restoreTimeout);
        await restoreCamera(page, cameraDialog, originalCamera, originalDialogValues, restoreTimeout);
      });
    }

    if (originalCamera) {
      await restore("verify original camera attributes", async () => {
        const actual = await waitForCamera(page, viewport, originalCamera, restoreTimeout);
        if (!sameCamera(originalCamera, actual)) {
          throw new Error(`camera attributes differ from the initial values: ${formatCamera(actual)}`);
        }
      });
    }

    if (originalCanvasHandle) {
      await restore("verify original canvas and healthy context", async () => {
        await assertCanvas("after viewport camera QA restoration");
        const sameCanvas = await originalCanvasHandle.evaluate((initialCanvas) =>
          initialCanvas.isConnected &&
          document.querySelectorAll(".fm-viewport-3d canvas").length === 1 &&
          document.querySelector(".fm-viewport-3d canvas") === initialCanvas,
        );
        if (!sameCanvas) {
          throw new Error("the original canvas element was replaced during camera QA");
        }
      });
    }

    if (originalCameraDialogOpen !== null) {
      await restore("restore original camera dialog visibility", async () => {
        await setCameraDialogOpen(page, cameraDialog, originalCameraDialogOpen, restoreTimeout);
        const actual = await cameraDialog.isVisible().catch(() => false);
        if (actual !== originalCameraDialogOpen) {
          throw new Error(`expected camera dialog open=${originalCameraDialogOpen}, got ${actual}`);
        }
      });
    }
  }

  const restorationVerified = restorationErrors.length === 0 && originalCamera !== null;
  const proof = {
    schema: "fullmag.viewport-camera-browser-qa.v1",
    state: operationError || restorationErrors.length ? "failed" : "passed",
    precondition: {
      view_source: originalCamera?.viewSource ?? null,
      required_view_source: "current",
      initial_camera: originalCamera,
      initial_camera_dialog_open: originalCameraDialogOpen,
      initial_dialog_values: originalDialogValues,
    },
    projection_transitions: commands.filter(({ title }) => title === "Toggle projection"),
    commands,
    poses,
    fov: { checks: fovChecks, changed_pixels_at_fixed_pose: fovChangedPixels, fit_changed_position: fovFitChangedPosition },
    captures,
    pointer_gestures: pointerGestures,
    view_cube: pointerGestures?.view_cube ?? { state: "NOT VERIFIED" },
    restoration: {
      state: restorationVerified ? "verified" : "failed-or-not-attempted",
      camera_attributes: !originalCamera ? "not-available" : mutationStarted
        ? "restored-through-visible-dialog-and-verified" : "unchanged-no-camera-mutation",
      same_canvas_element_and_context: originalCanvasHandle ? "asserted" : "not-available",
      camera_dialog_open: originalCameraDialogOpen,
      errors: restorationErrors,
    },
    errors: operationError ? [operationError?.message ?? String(operationError)] : [],
    limitations: [
      "The pointer check covers one ViewCube face and one continuous orbit drag; the remaining axial poses use the visible camera dialog.",
      "Fit is considered observed only when the public camera attributes change after the visible command; no change is reported without being treated as a camera movement.",
      "PNG captures are Playwright screenshots of the canvas element, decoded in memory; no image files are written.",
    ],
  };
  snapshots.clear();

  if (operationError || restorationErrors.length) {
    const restorationDetails = restorationErrors.length
      ? ` Restoration errors: ${restorationErrors.join("; ")}.`
      : "";
    const error = new Error(
      `Viewport camera QA failed: ${operationError?.message ?? "camera restoration failed"}.${restorationDetails}`,
      operationError ? { cause: operationError } : undefined,
    );
    error.partialProof = proof;
    error.restorationErrors = [...restorationErrors];
    throw error;
  }

  return proof;
}

const SURFACE_PASS_LABELS = ["Surface on/off", "Wireframe on/off", "Points on/off"];

async function openSurfaceMenu(page, timeout) {
  await page.getByRole("tab", { name: "View", exact: true }).click({ timeout });
  await page.locator('[data-action-id="view-surface"]').click({ timeout });
  await page.getByRole("menuitemradio", { name: "Shaded surface", exact: true }).waitFor({ state: "visible", timeout });
}

async function readSurfacePasses(page, timeout) {
  await openSurfaceMenu(page, timeout);
  try {
    const mode = (await page.locator('[role="menuitemradio"][aria-checked="true"]').innerText()).trim();
    const passes = {};
    for (const name of SURFACE_PASS_LABELS) {
      passes[name] = await page.getByRole("menuitemcheckbox", { name, exact: true }).getAttribute("aria-checked") === "true";
    }
    return { mode, passes };
  } finally {
    await page.keyboard.press("Escape");
  }
}

async function setSurfaceRenderMode(page, mode, timeout) {
  await openSurfaceMenu(page, timeout);
  await page.getByRole("menuitemradio", { name: mode, exact: true }).click({ timeout });
  await openSurfaceMenu(page, timeout);
  try {
    await page.getByRole("menuitemradio", { name: mode, exact: true, checked: true }).waitFor({ state: "visible", timeout });
  } finally {
    await page.keyboard.press("Escape");
  }
}

async function restoreSurfacePasses(page, original, timeout) {
  await setSurfaceRenderMode(page, original.mode, timeout);
  await openSurfaceMenu(page, timeout);
  try {
    for (const [name, checked] of Object.entries(original.passes)) {
      const control = page.getByRole("menuitemcheckbox", { name, exact: true });
      if ((await control.getAttribute("aria-checked") === "true") !== checked) {
        await control.click({ timeout });
      }
      await page.getByRole("menuitemcheckbox", { name, exact: true, checked }).waitFor({ state: "visible", timeout });
    }
  } finally {
    await page.keyboard.press("Escape");
  }
}

async function captureCanvas(page, {
  assertCanvas,
  cameraDialog,
  canvas,
  name,
  pngDecoder,
  preserveDialogOpen,
  timeout,
  snapshots,
  embedPng,
}) {
  let captureError = null;
  let result = null;
  try {
    await setCameraDialogOpen(page, cameraDialog, false, timeout);
    const webgl = await assertCanvas(`before ${name} camera screenshot`);
    await page.waitForTimeout(80);
    const png = Buffer.from(await canvas.screenshot({ type: "png", timeout }));
    if (!png.length) throw new Error(`Canvas screenshot for ${name} was empty`);
    const decoded = pngDecoder.sync.read(png);
    const { data, height, width } = decoded;
    const expectedBytes = width * height * 4;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      !data ||
      data.length !== expectedBytes
    ) {
      throw new Error(`Decoded canvas screenshot for ${name} has invalid RGBA dimensions`);
    }
    let nonEmptyPixels = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      if (data[offset] || data[offset + 1] || data[offset + 2] || data[offset + 3]) {
        nonEmptyPixels += 1;
      }
    }
    if (nonEmptyPixels === 0) {
      throw new Error(`Decoded canvas screenshot for ${name} contains only zero-valued pixels`);
    }

    const camera = await readCamera(page.locator(VIEWPORT_SELECTOR));
    const liveDepthRange = await page.evaluate(() => {
      const diagnostics = window.__FULLMAG_READ_VIEWPORT_3D_CAMERA_CONTROLS__?.();
      return { near: diagnostics?.cameraNear, far: diagnostics?.cameraFar };
    });
    if (!Number.isFinite(liveDepthRange.near) || !Number.isFinite(liveDepthRange.far) ||
        liveDepthRange.near <= 0 || liveDepthRange.far <= liveDepthRange.near) {
      throw new Error(`Invalid live camera depth range at ${name}: ${JSON.stringify(liveDepthRange)}`);
    }
    const pngSha256 = sha256(png);
    const pixelSha256 = sha256(data);
    const snapshot = { pngSha256, pixelSha256, width, height,
      pixels: name.startsWith("fov-") ? Buffer.from(data) : null };
    snapshots.set(name, snapshot);
    result = {
      name,
      source: "Playwright canvas element screenshot",
      width,
      height,
      png_bytes: png.length,
      png_sha256: pngSha256,
      decoded_pixel_sha256: pixelSha256,
      non_empty_rgba_pixels: nonEmptyPixels,
      red_dominant_pixels: countRedDominantPixels(data, width, height),
      camera,
      webgl,
      live_depth_range: liveDepthRange,
      png_base64_state: embedPng
        ? png.length <= MAX_EMBEDDED_PNG_BYTES
          ? "included"
          : "artifact-too-large"
        : "not-requested",
    };
    if (embedPng && png.length <= MAX_EMBEDDED_PNG_BYTES) {
      result.png_base64 = png.toString("base64");
    }
  } catch (error) {
    captureError = error;
  } finally {
    try {
      await setCameraDialogOpen(page, cameraDialog, preserveDialogOpen, timeout);
    } catch (error) {
      if (!captureError) captureError = error;
      else captureError = new Error(
        `${captureError?.message ?? String(captureError)}; camera dialog restore failed: ${error?.message ?? String(error)}`,
        { cause: captureError },
      );
    }
  }

  if (captureError) throw captureError;
  return result;
}

async function setCameraDialogOpen(page, dialog, shouldOpen, timeout) {
  const isOpen = await dialog.isVisible().catch(() => false);
  if (isOpen === shouldOpen) return;
  if (shouldOpen) {
    await executeVisibleCommand(page, page.getByRole("dialog", {
      exact: true,
      name: COMMAND_PALETTE_NAME,
    }), "Open 3D Camera Controls", timeout);
    await dialog.waitFor({ state: "visible", timeout });
    return;
  }
  await dialog.getByRole("button", {
    exact: true,
    name: "Close camera parameters",
  }).click({ timeout });
  await dialog.waitFor({ state: "hidden", timeout });
}

async function executeVisibleCommand(page, palette, title, timeout) {
  if (!await palette.isVisible().catch(() => false)) {
    const searchButton = page.getByRole("button", { name: /Command search/i });
    await searchButton.waitFor({ state: "visible", timeout });
    await searchButton.click({ timeout });
    await palette.waitFor({ state: "visible", timeout });
  }
  const input = palette.getByPlaceholder("Search commands", { exact: true });
  await input.fill(title, { timeout });
  const result = palette.getByText(title, { exact: true });
  await result.waitFor({ state: "visible", timeout });
  if (await result.count() !== 1) {
    throw new Error(`Expected one visible command result for ${title}`);
  }
  await result.click({ timeout });
  await palette.waitFor({ state: "hidden", timeout });
}

async function exercisePointerGestures(page, { viewport, canvas, assertCanvas, timeout }) {
  const rect = await canvas.boundingBox();
  if (!rect || rect.width < 320 || rect.height < 240) {
    throw new Error("Pointer camera QA requires a visible canvas of at least 320x240 CSS pixels");
  }
  const before = await readCamera(viewport);
  const radius = distance(before.position, before.target);
  // This is the real screen anchor defined by orientation/hudLayout.ts.
  // Success additionally requires the observed +X camera pose, not just a click.
  const margin = rect.width < 640 || rect.height < 420 ? 72 : 104;
  const hit = { x: rect.x + rect.width - margin, y: rect.y + margin };
  await page.mouse.click(hit.x, hit.y);
  const snapped = await waitForCamera(page, viewport, {
    position: before.target.map((value, index) => value + (index === 0 ? radius : 0)),
    target: before.target,
  }, timeout);
  await assertCanvas("after ViewCube +X face click");

  const samples = [];
  await page.mouse.move(rect.x + rect.width * 0.25, rect.y + rect.height * 0.45);
  await page.mouse.down();
  try {
    for (const fraction of [0.32, 0.39, 0.46, 0.53, 0.60]) {
      await page.mouse.move(rect.x + rect.width * fraction, rect.y + rect.height * 0.45, { steps: 4 });
      await page.waitForTimeout(32);
      const sample = await page.evaluate(() => {
        const read = window.__FULLMAG_READ_VIEWPORT_3D_CAMERA_CONTROLS__;
        if (typeof read !== "function") return null;
        const value = read();
        return { position: value.cameraPosition, target: value.controlTarget,
          enabled: value.controlsEnabled, connected: value.controlsConnectedToCanvas };
      });
      if (!sample?.enabled || !sample.connected) {
        throw new Error("Orbit pointer QA requires enabled controls connected to the visible canvas");
      }
      assertCameraFinite({ ...snapped, position: sample.position, target: sample.target }, "during pointer orbit");
      if (!sameVector(sample.target, snapped.target, sceneCoordinateEpsilon(radius))) {
        throw new Error("Orbit pointer gesture unexpectedly moved its target");
      }
      if (Math.abs(distance(sample.position, sample.target) - radius) > scalarRelativeEpsilon(radius) * 100) {
        throw new Error("Orbit pointer gesture unexpectedly changed its distance");
      }
      samples.push(sample);
    }
  } finally {
    await page.mouse.up();
  }
  if (new Set(samples.map((sample) => JSON.stringify(sample.position))).size < 2) {
    throw new Error("Continuous pointer drag produced no distinct live camera positions");
  }
  const deadline = Date.now() + timeout;
  let after = snapped;
  let stableSince = null;
  let previous = null;
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    after = await readCamera(viewport);
    if (sameCamera(after, snapped)) {
      stableSince = null;
    } else if (previous && sameCamera(after, previous)) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= 500) break;
    } else {
      stableSince = null;
    }
    previous = after;
  }
  if (stableSince === null || Date.now() - stableSince < 500) {
    throw new Error("Pointer orbit did not commit a stable changed pose to the camera owner");
  }
  assertCameraFinite(after, "committed pointer orbit");
  if (after.projection !== snapped.projection || !sameVector(after.up, snapped.up, UP_TOLERANCE) ||
      !sameVector(after.target, snapped.target, sceneCoordinateEpsilon(radius)) ||
      Math.abs(distance(after.position, after.target) - radius) > scalarRelativeEpsilon(radius) * 100) {
    throw new Error("Committed pointer orbit changed its projection, up, target, or distance");
  }
  await assertCanvas("after continuous pointer orbit");

  // Exercise translation and dolly independently of rotation: nanometre scenes
  // can rotate while fixed world-unit change thresholds suppress pan/zoom.
  const center = { x: rect.x + rect.width * 0.5, y: rect.y + rect.height * 0.6 };
  await page.mouse.move(center.x, center.y);
  const beforeZoom = await readCamera(viewport);
  await page.mouse.wheel(0, 240);
  const afterZoom = await waitForCommittedGesture(page, viewport, beforeZoom, timeout,
    (camera) => distance(camera.position, camera.target) >
      distance(beforeZoom.position, beforeZoom.target) * 1.01, "wheel zoom out");
  if (!sameVector(afterZoom.target, beforeZoom.target, sceneCoordinateEpsilon(radius))) {
    throw new Error("Wheel zoom unexpectedly moved the orbit target");
  }
  await assertCanvas("after wheel zoom out");

  const beforePan = afterZoom;
  await page.mouse.down({ button: "right" });
  try {
    await page.mouse.move(center.x + 60, center.y + 30, { steps: 12 });
  } finally {
    await page.mouse.up({ button: "right" });
  }
  const afterPan = await waitForCommittedGesture(page, viewport, beforePan, timeout,
    (camera) => distance(camera.target, beforePan.target) > radius * 0.001,
    "right-button pan");
  const translationError = Math.hypot(...afterPan.position.map((value, index) =>
    (value - beforePan.position[index]) - (afterPan.target[index] - beforePan.target[index])));
  if (translationError > scalarRelativeEpsilon(radius) * 100) {
    throw new Error("Pan failed to translate the camera and orbit target together");
  }
  await assertCanvas("after right-button pan");
  return { state: "passed", view_cube: { state: "passed", face: "+X", hit_css: hit,
    before, after: snapped }, orbit: { state: "passed", input: "Playwright mouse drag",
    live_samples: samples, committed_camera: after },
    zoom: { state: "passed", input: "Playwright mouse wheel", before: beforeZoom, after: afterZoom },
    pan: { state: "passed", input: "Playwright right-button drag", before: beforePan, after: afterPan } };
}

async function waitForCommittedGesture(page, viewport, before, timeout, changed, label) {
  const deadline = Date.now() + timeout;
  let previous = before;
  let stableSince = null;
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    const camera = await readCamera(viewport);
    assertCameraFinite(camera, label);
    if (changed(camera) && sameCamera(camera, previous)) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= 500) return camera;
    } else {
      stableSince = null;
    }
    previous = camera;
  }
  throw new Error(`${label} did not produce a stable changed camera pose`);
}

async function readDialogValues(dialog) {
  const [position, target, fov, orthoScale, projection] = await Promise.all([
    readVector(dialog, "Position (m)"),
    readVector(dialog, "Target (m)"),
    getScalarInput(dialog, "FOV").inputValue(),
    getScalarInput(dialog, "Ortho scale").inputValue(),
    getProjectionInput(dialog).inputValue(),
  ]);
  return {
    position,
    target,
    fov,
    orthoScale,
    projection,
  };
}

async function readVector(dialog, legend) {
  const fieldset = dialog.locator("fieldset").filter({ hasText: legend });
  const inputs = fieldset.locator('input[type="number"]');
  const [fieldsetCount, inputCount] = await Promise.all([fieldset.count(), inputs.count()]);
  if (fieldsetCount !== 1 || inputCount !== 3) {
    throw new Error(`Camera dialog does not expose exactly three ${legend} inputs`);
  }
  const values = await Promise.all([0, 1, 2].map((index) => inputs.nth(index).inputValue()));
  const parsed = values.map(Number);
  if (parsed.some((value) => !Number.isFinite(value))) {
    throw new Error(`Camera dialog ${legend} inputs are not finite numbers`);
  }
  return { text: values, values: parsed };
}

async function fillVector(dialog, legend, values) {
  const fieldset = dialog.locator("fieldset").filter({ hasText: legend });
  const inputs = fieldset.locator('input[type="number"]');
  if (await fieldset.count() !== 1 || await inputs.count() !== 3) {
    throw new Error(`Camera dialog does not expose exactly three ${legend} inputs`);
  }
  for (let index = 0; index < 3; index += 1) {
    await inputs.nth(index).fill(formatInputNumber(values[index]));
  }
}

function getScalarInput(dialog, label) {
  return dialog
    .locator(".fm-viewport-camera-dialog__form label")
    .filter({ hasText: new RegExp(`^${escapeRegExp(label)}`) })
    .locator('input[type="number"]');
}

function getProjectionInput(dialog) {
  return dialog
    .locator(".fm-viewport-camera-dialog__form label")
    .filter({ hasText: /^Projection/ })
    .locator("select");
}

async function restoreCamera(page, dialog, initialCamera, initialDialogValues, timeout) {
  await fillVector(dialog, "Position (m)", initialCamera.position);
  await fillVector(dialog, "Target (m)", initialCamera.target);
  await getScalarInput(dialog, "FOV").fill(initialDialogValues.fov);
  await getScalarInput(dialog, "Ortho scale").fill(initialDialogValues.orthoScale);
  await getProjectionInput(dialog).selectOption(initialCamera.projection);
  await dialog.getByRole("button", { exact: true, name: "Apply" }).click({ timeout });

  const viewport = dialog.page().locator(VIEWPORT_SELECTOR);
  await waitForCamera(page, viewport, initialCamera, timeout);
  const restoredValues = await readDialogValues(dialog);
  if (!sameNumericText(restoredValues.fov, initialDialogValues.fov)) {
    throw new Error(`FOV did not restore to its initial dialog value (${initialDialogValues.fov})`);
  }
  if (!sameNumericText(restoredValues.orthoScale, initialDialogValues.orthoScale)) {
    throw new Error(`Ortho scale did not restore to its initial dialog value (${initialDialogValues.orthoScale})`);
  }
}

async function readCamera(viewport) {
  return viewport.evaluate((node) => {
    const parseVector = (raw) => {
      if (typeof raw !== "string" || !raw.trim()) return null;
      const values = raw.trim().split(/\s+/).map(Number);
      return values.length === 3 && values.every(Number.isFinite) ? values : null;
    };
    return {
      viewSource: node.getAttribute("data-view-source"),
      position: parseVector(node.getAttribute("data-camera-position")),
      projection: node.getAttribute("data-camera-projection"),
      target: parseVector(node.getAttribute("data-camera-target")),
      up: parseVector(node.getAttribute("data-camera-up")),
    };
  });
}

function validateCameraPrecondition(camera) {
  if (camera.viewSource !== "current") {
    throw new Error(`Viewport camera QA requires data-view-source="current", received ${camera.viewSource ?? "missing"}`);
  }
  assertCameraFinite(camera, "initial viewport");
  if (!sameVector(camera.up, WORLD_UP, UP_TOLERANCE)) {
    throw new Error(`Viewport camera QA requires initial world-up [0,0,1], received ${formatVector(camera.up)}`);
  }
  const coordinateEpsilon = sceneCoordinateEpsilon(distance(camera.position, camera.target));
  if (!Number.isFinite(distance(camera.position, camera.target)) || distance(camera.position, camera.target) <= 0) {
    throw new Error("Initial camera position must differ from its target");
  }
  if (!Number.isFinite(coordinateEpsilon)) {
    throw new Error("Initial camera radius cannot produce a finite coordinate tolerance");
  }
}

function validateDialogValues(camera, values) {
  if (values.projection !== camera.projection) {
    throw new Error(`Camera dialog projection ${values.projection} does not match viewport ${camera.projection}`);
  }
  const coordinateEpsilon = sceneCoordinateEpsilon(distance(camera.position, camera.target));
  if (!sameVector(values.position.values, camera.position, coordinateEpsilon)) {
    throw new Error("Camera dialog position does not match the public viewport camera attributes");
  }
  if (!sameVector(values.target.values, camera.target, coordinateEpsilon)) {
    throw new Error("Camera dialog target does not match the public viewport camera attributes");
  }
  if (!Number.isFinite(Number(values.fov))) {
    throw new Error("Camera dialog FOV is not finite");
  }
  if (values.orthoScale.trim() !== "" && !Number.isFinite(Number(values.orthoScale))) {
    throw new Error("Camera dialog orthographic scale is not finite");
  }
}

function assertCameraFinite(camera, label) {
  if (
    !Array.isArray(camera.position) ||
    !Array.isArray(camera.target) ||
    !Array.isArray(camera.up) ||
    [...camera.position, ...camera.target, ...camera.up].some((value) => !Number.isFinite(value)) ||
    !["perspective", "orthographic"].includes(camera.projection)
  ) {
    throw new Error(`${label} camera attributes are incomplete or non-finite: ${formatCamera(camera)}`);
  }
}

async function waitForCamera(page, viewport, expected, timeout) {
  const deadline = Date.now() + timeout;
  let last = null;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      last = await readCamera(viewport);
      if (cameraMatches(last, expected)) return last;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await page.waitForTimeout(50);
  }
  const detail = lastError?.message ?? formatCamera(last);
  throw new Error(`Timed out waiting for camera attributes ${formatCamera(expected)}; last observed ${detail}`);
}

function cameraMatches(actual, expected) {
  if (!actual || !expected) return false;
  if (expected.projection && actual.projection !== expected.projection) return false;
  if (expected.position || expected.target) {
    const position = expected.position ?? actual.position;
    const target = expected.target ?? actual.target;
    const coordinateEpsilon = sceneCoordinateEpsilon(distance(position, target));
    if (expected.position && !sameVector(actual.position, expected.position, coordinateEpsilon)) return false;
    if (expected.target && !sameVector(actual.target, expected.target, coordinateEpsilon)) return false;
  }
  if (expected.up && !sameVector(actual.up, expected.up, UP_TOLERANCE)) return false;
  return true;
}

function sameCamera(left, right) {
  if (!left || !right) return false;
  const radius = distance(left.position, left.target);
  const coordinateEpsilon = sceneCoordinateEpsilon(radius);
  if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(coordinateEpsilon)) return false;
  return Boolean(left && right) &&
    left.projection === right.projection &&
    sameVector(left.position, right.position, coordinateEpsilon) &&
    sameVector(left.target, right.target, coordinateEpsilon) &&
    sameVector(left.up, right.up, UP_TOLERANCE);
}

function sameVector(left, right, tolerance) {
  return Array.isArray(left) && Array.isArray(right) && left.length === 3 && right.length === 3 &&
    left.every((value, index) => Number.isFinite(value) && Number.isFinite(right[index]) &&
      Math.abs(value - right[index]) <= tolerance);
}

function sameNumericText(left, right) {
  if (left.trim() === "" || right.trim() === "") return left.trim() === right.trim();
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) &&
    Math.abs(leftNumber - rightNumber) <= scalarRelativeEpsilon(rightNumber);
}

function sceneCoordinateEpsilon(sceneRadius) {
  return Math.max(sceneRadius * SCENE_RELATIVE_TOLERANCE, SI_ABSOLUTE_FLOOR);
}

function scalarRelativeEpsilon(reference) {
  return Math.max(Math.abs(reference) * SCALAR_RELATIVE_TOLERANCE, SI_ABSOLUTE_FLOOR);
}

function distance(left, right) {
  return Math.hypot(...left.map((value, index) => value - right[index]));
}

function normalize(vector) {
  const magnitude = Math.hypot(...vector);
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    throw new Error(`Cannot normalize camera pose direction ${formatVector(vector)}`);
  }
  return vector.map((value) => value / magnitude);
}

function formatInputNumber(value) {
  if (!Number.isFinite(value)) throw new Error("Cannot enter a non-finite camera coordinate");
  return Object.is(value, -0) ? "0" : String(value);
}

function formatVector(vector) {
  return Array.isArray(vector) ? `[${vector.join(", ")}]` : String(vector);
}

function formatCamera(camera) {
  if (!camera) return "unavailable";
  return JSON.stringify({
    position: camera.position,
    target: camera.target,
    up: camera.up,
    projection: camera.projection,
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function boundedTimeout(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 15_000;
  return Math.min(Math.max(numeric, 1_000), MAX_ACTION_TIMEOUT_MS);
}

// Scoped to the fixed red-ring fixture, never a generic material assumption.
export function countRedDominantPixels(data, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width <= 0 || height <= 0 || data?.length !== width * height * 4) {
    throw new Error("Ring pixel check requires valid decoded RGBA dimensions");
  }
  let count = 0;
  // The fixture targets the ring at the center. Exclude the red orientation
  // sphere/axes at the bottom left and the ViewCube at the top right.
  for (let y = Math.ceil(height * 0.15); y < height * 0.8; y += 1) {
    for (let x = Math.ceil(width * 0.25); x < width * 0.75; x += 1) {
      const offset = (y * width + x) * 4;
      if (data[offset + 3] > 0 && data[offset] > 32 &&
          data[offset] > data[offset + 1] * 1.3 && data[offset] > data[offset + 2] * 1.3) count += 1;
    }
  }
  return count;
}

export function assertRingSurfacePixels(capture) {
  if (!Number.isFinite(capture.red_dominant_pixels) ||
      capture.red_dominant_pixels < Math.max(128, capture.width * capture.height * 0.002)) {
    throw new Error(`Ring geometry is absent at ${capture.name}: ${capture.red_dominant_pixels} red surface pixels`);
  }
}
