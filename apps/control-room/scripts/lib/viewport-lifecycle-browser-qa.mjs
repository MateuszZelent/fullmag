import { ensureViewportSettingsSection, getViewportSettingsRegion, readViewportInspectorState, restoreViewportInspectorState, selectViewportInspectorContext } from "./viewport-export-browser-qa.mjs";
const VIEWPORT_SELECTOR = ".fm-viewport-3d";
const CANVAS_SELECTOR = `${VIEWPORT_SELECTOR} canvas`;
const MAIN_SLOT_SELECTOR = '[data-slot-id="viewport-main"]';
const APPEARANCE_STORAGE_KEY =
  "fullmag.control-room.viewport-3d.appearance-preferences";
const RESOURCE_COUNT_KEYS = Object.freeze([
  "geometries",
  "materials",
  "renderTargets",
  "textures",
  "workers",
]);
const MODULE_TITLES = Object.freeze({
  "analysis-plots": "Analysis",
  "field-map": "2D View",
  "live-charts": "Live Charts",
  "viewport-3d": "3D Viewport",
});
const APPEARANCE_CHOICES = Object.freeze([
  "Subtle gradient",
  "Solid",
]);
const MAX_STEP_TIMEOUT_MS = 30_000;

/**
 * Exercises active 3D/2D viewport lifecycle in an existing Playwright page.
 * This helper only uses visible controls and public DOM/debug diagnostics. It
 * does not create sessions, mutate model data, reload the page, or reset debug
 * counters.
 */
export async function runViewportLifecycleBrowserQa(page, options = {}) {
  const cycles = positiveInteger(options.cycles, 20, "cycles");
  if (cycles > 20) throw new RangeError("cycles cannot exceed the requested 20-cycle QA scope");
  const timeout = boundedTimeout(options.timeout);
  const cleanupTimeout = Math.min(timeout, 5_000);
  const settleMs = boundedWait(options.settleMs, 250, "settleMs");
  const idleSampleCount = positiveInteger(options.idleSampleCount, 3, "idleSampleCount");
  const idleSampleMs = boundedWait(options.idleSampleMs, 350, "idleSampleMs");
  const getSessionIdentity = options.getSessionIdentity;
  const expectedSession = options.expectedSession;
  const assertCanvas = options.assertCanvas;

  const mainSlot = page.locator(MAIN_SLOT_SELECTOR);
  const settingsDialog = getViewportSettingsRegion(page);
  const originalViewport = page.viewportSize();
  if (!originalViewport) {
    throw new Error("Viewport lifecycle QA requires a fixed browser viewport");
  }

  await mainSlot.waitFor({ state: "attached", timeout });
  const originalModuleId = await mainSlot.getAttribute("data-active-module-id");
  if (!originalModuleId) {
    throw new Error("Viewport-main did not expose its active module id");
  }

  const originalInspectorState = await readViewportInspectorState(page);
  const [originalDialogOpen, originalStorage, sessionBefore] = await Promise.all([
    settingsDialog.isVisible().catch(() => false), readAppearanceStorage(page),
    typeof getSessionIdentity === "function" ? getSessionIdentity() : null,
  ]);
  if (typeof getSessionIdentity === "function" && !sessionBefore) {
    throw new Error("The provided session identity reader returned no identity before the QA");
  }
  assertSession(expectedSession, sessionBefore, "before viewport lifecycle QA");

  const matchingRequests = [];
  let requestPhase = null;
  const requestListener = (request) => {
    if (!requestPhase) return;
    const kind = classifyResourceRequest(request.url());
    if (!kind || matchingRequests.length >= 200) return;
    let pathname = request.url();
    try {
      pathname = new URL(request.url()).pathname;
    } catch {
      // Keep a bounded raw URL only when the request URL is not parseable.
    }
    matchingRequests.push({
      kind,
      method: request.method(),
      phase: requestPhase,
      pathname: String(pathname).slice(0, 512),
    });
  };
  page.on("request", requestListener);

  let originalBackground = null;
  let appearanceProbe = {
    state: "not-verified",
    reason: "A visible 3D background control was not observed.",
    matching_requests: [],
  };
  let operationError = null;
  let restorationError = null;
  let result = null;

  try {
    await closeSettingsIfOpen(page, settingsDialog, timeout);
    if (originalModuleId !== "viewport-3d") {
      await activateViewportTab(page, "viewport-3d", timeout);
    }

    appearanceProbe = await inspectAppearanceRequests(page, {
      matchingRequests,
      onOriginalBackground(value) {
        originalBackground = value;
      },
      setRequestPhase(value) {
        requestPhase = value;
      },
      settingsDialog,
      timeout,
    });
    if (appearanceProbe.state === "requests-observed") {
      throw new Error("Changing viewport appearance fetched field or topology resources: " +
        JSON.stringify(appearanceProbe.matching_requests));
    }

    await closeSettingsIfOpen(page, settingsDialog, timeout);
    const baselineCanvas = await checkCanvas(page, "initial active 3D viewport", assertCanvas, timeout);
    // Match the post-return settle used for every cycle before sampling the baseline.
    await assertCanvasStableWithinMount(page, timeout, settleMs);
    const baselineSignals = await readPublicSignals(page);
    const inactiveSamples = [];
    const returnCanvasProofs = [];
    const activeSamples = [];

    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      requestPhase = `cycle-${cycle}:to-2d`;
      await activateViewportTab(page, "field-map", timeout);
      await assertActiveFieldMap(page, timeout);
      await page.waitForTimeout(settleMs);
      const inactiveSignals = await readPublicSignals(page);
      inactiveSamples.push(inactiveSignals);
      assertInactiveResourceCounts(inactiveSignals, cycle);

      requestPhase = `cycle-${cycle}:to-3d`;
      await activateViewportTab(page, "viewport-3d", timeout);
      const canvasProof = await checkCanvas(
        page,
        `3D viewport return ${cycle}`,
        assertCanvas,
        timeout,
      );
      await assertCanvasStableWithinMount(page, timeout, settleMs);
      returnCanvasProofs.push(canvasProof);
      activeSamples.push(await readPublicSignals(page));
    }
    requestPhase = null;

    const postChurnSignals = await readPublicSignals(page);
    const resourceAssessment = assessResourceCounts(
      baselineSignals,
      postChurnSignals,
      inactiveSamples,
    );
    if (resourceAssessment.state === "growth-observed") {
      const error = new Error(`Viewport resource counts grew after ${cycles} 3D/2D cycles: ${JSON.stringify(resourceAssessment.growth)}`);
      error.partialProof = { resource_assessment: resourceAssessment, active_samples: activeSamples.map(summarizeSignals), inactive_samples: inactiveSamples.map(summarizeSignals) };
      throw error;
    }

    const idle = await sampleIdleFrames(page, idleSampleCount, idleSampleMs);
    if (idle.state === "continuous-frames-observed") {
      throw new Error(
        `The settled 3D viewport continued rendering in every idle sample: ` +
          JSON.stringify(idle.sample_deltas),
      );
    }
    resourceAssessment.idle = idle.final_signals?.resource_counts ?? null;

    result = {
      schema: "fullmag.viewport-lifecycle-browser-qa.v1",
      state: "passed",
      cycles,
      transitions: cycles * 2,
      viewport_switch_requests: summarizeRequests(
        matchingRequests.filter((request) => request.phase.startsWith("cycle-")),
      ),
      appearance_request_check: {
        ...appearanceProbe,
        matching_requests: appearanceProbe.matching_requests,
      },
      canvas: {
        initial: baselineCanvas,
        returns_checked: returnCanvasProofs.length,
        same_dom_node_checked_within_each_active_mount: true,
        cross_mount_node_identity: "not-asserted",
      },
      diagnostics: {
        resources: resourceAssessment,
        idle_frames: idle,
        baseline: summarizeSignals(baselineSignals),
        post_churn: summarizeSignals(postChurnSignals),
        idle: summarizeSignals(idle.final_signals),
      },
      session_identity: sessionBefore
        ? { state: "verified-before-and-after" }
        : {
            state: "not-verified",
            reason: "No session identity reader was provided by the caller.",
          },
      preferences: {
        effects_toggled: false,
        storage_snapshot: originalStorage.available ? "captured" : "not-verified",
        restoration: "pending",
      },
      restoration: {
        original_module_id: originalModuleId,
        original_settings_dialog_open: originalDialogOpen,
        viewport_unchanged: true,
        state: "pending",
      },
    };
  } catch (error) {
    operationError = error;
  } finally {
    requestPhase = null;
    page.off("request", requestListener);
    const cleanupErrors = [];
    const cleanup = async (action) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(error?.message ?? String(error));
      }
    };

    if (originalBackground !== null) {
      await cleanup(async () => {
        const activeModuleId = await mainSlot.getAttribute("data-active-module-id");
        if (activeModuleId !== "viewport-3d") {
        await activateViewportTab(page, "viewport-3d", cleanupTimeout);
        }
        await openSettings(page, settingsDialog, cleanupTimeout);
        const current = await readBackgroundChoice(page);
        if (current !== originalBackground) {
          await chooseBackground(page, originalBackground, cleanupTimeout);
        }
      });
    }

    await cleanup(async () => {
      if (await settingsDialog.isVisible().catch(() => false)) {
        await closeSettingsIfOpen(page, settingsDialog, cleanupTimeout);
      }
      const currentModuleId = await mainSlot.getAttribute("data-active-module-id");
      if (currentModuleId !== originalModuleId) {
        await activateViewportTab(page, originalModuleId, cleanupTimeout);
      }
    });

    await cleanup(() => restoreViewportInspectorState(page, originalInspectorState, cleanupTimeout));

    await cleanup(async () => {
      const restoredStorage = await readAppearanceStorage(page);
      if (
        originalStorage.available &&
        restoredStorage.available &&
        restoredStorage.value !== originalStorage.value
      ) {
        await restoreAppearanceStorage(page, originalStorage);
      }
      const verifiedStorage = await readAppearanceStorage(page);
      if (
        originalStorage.available &&
        (!verifiedStorage.available || verifiedStorage.value !== originalStorage.value)
      ) {
        throw new Error("Viewport appearance preference storage did not return to its original value");
      }
    });

    await cleanup(async () => {
      const restoredModuleId = await mainSlot.getAttribute("data-active-module-id");
      if (restoredModuleId !== originalModuleId) {
        throw new Error(
          `Active viewport tab was not restored (${originalModuleId} -> ${restoredModuleId})`,
        );
      }
      if (page.viewportSize()?.width !== originalViewport.width ||
          page.viewportSize()?.height !== originalViewport.height) {
        throw new Error("Viewport lifecycle QA changed the browser viewport size");
      }
      const dialogOpen = await settingsDialog.isVisible().catch(() => false);
      if (dialogOpen !== originalDialogOpen) {
        throw new Error("The 3D View Settings inspector did not return to its original open state");
      }
    });

    if (typeof getSessionIdentity === "function") {
      await cleanup(async () => {
        const sessionAfter = await getSessionIdentity();
        assertSession(sessionBefore, sessionAfter, "after viewport lifecycle QA");
        if (!sameSessionIdentity(sessionBefore, sessionAfter)) {
          throw new Error("Active session identity changed during viewport lifecycle QA");
        }
        if (result) result.session_identity = { state: "unchanged" };
      });
    }

    if (cleanupErrors.length > 0) restorationError = new Error(cleanupErrors.join("; "));
  }

  if (operationError && restorationError) {
    throw new Error(
      `Viewport lifecycle QA failed: ${operationError?.message ?? operationError}; ` +
        `restoration failed: ${restorationError.message}`,
    );
  }
  if (operationError) throw operationError;
  if (restorationError) throw restorationError;
  result.preferences.restoration = originalStorage.available
    ? "verified"
    : "not-verified: browser storage unavailable";
  result.restoration.state = "verified";
  result.final_active_module_id = originalModuleId;
  result.viewport_switch_requests = summarizeRequests(
    matchingRequests.filter((request) => request.phase.startsWith("cycle-")),
  );
  return result;
}

async function inspectAppearanceRequests(page, {
  matchingRequests,
  onOriginalBackground,
  setRequestPhase,
  settingsDialog,
  timeout,
}) {
  const settingsButton = page.getByRole("button", { name: /view settings/i }).first();
  if (await settingsButton.count() === 0) {
    return {
      state: "not-verified",
      source: "window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__.resourceCounts",
      reason: "The visible View settings control was not available.",
      matching_requests: [],
    };
  }

  await openSettings(page, settingsDialog, timeout);
  const background = page.getByRole("combobox", { exact: true, name: "Background" }).first();
  if (await background.count() === 0) {
    await closeSettingsIfOpen(page, settingsDialog, timeout);
    return {
      state: "not-verified",
      reason: "The 3D settings inspector did not expose a Background control.",
      matching_requests: [],
    };
  }

  const original = normalizeText(await background.innerText());
  const alternate = APPEARANCE_CHOICES.find((choice) => choice !== original);
  if (!alternate) {
    await closeSettingsIfOpen(page, settingsDialog, timeout);
    return {
      state: "not-verified",
      reason: `Unrecognized Background value: ${original || "empty"}.`,
      matching_requests: [],
    };
  }
  onOriginalBackground(original);

  const requestStart = matchingRequests.length;
  setRequestPhase("appearance-change");
  try {
    await chooseBackground(page, alternate, timeout);
    await page.waitForTimeout(120);
    await chooseBackground(page, original, timeout);
    await page.waitForTimeout(120);
    setRequestPhase(null);
    const observed = matchingRequests.slice(requestStart);
    return {
      state: observed.length === 0 ? "observed-no-field-or-topology-requests" : "requests-observed",
      original_background: original,
      temporary_background: alternate,
      matching_requests: observed,
    };
  } finally {
    setRequestPhase(null);
    await closeSettingsIfOpen(page, settingsDialog, timeout);
  }
}

async function chooseBackground(page, value, timeout) {
  const background = page.getByRole("combobox", { exact: true, name: "Background" }).first();
  await background.scrollIntoViewIfNeeded();
  await background.click({ timeout });
  await page.getByRole("option", { exact: true, name: value }).click({ timeout });
  await page.waitForFunction(
    (expected) => {
      const element = document.getElementById("fm-view-background");
      return (element?.textContent ?? "").replace(/\s+/g, " ").trim() === expected;
    },
    value,
    { timeout },
  );
}

async function readBackgroundChoice(page) {
  const control = page.getByRole("combobox", { exact: true, name: "Background" }).first();
  return normalizeText(await control.innerText());
}

async function openSettings(page, dialog, timeout) {
  await ensureViewportSettingsSection(page, "Appearance", timeout);
  await dialog.waitFor({ state: "visible", timeout });
}

async function closeSettingsIfOpen(page, dialog, timeout) {
  if (!await dialog.isVisible().catch(() => false)) return;
  await selectViewportInspectorContext(page, "selection", timeout);
  await dialog.waitFor({ state: "hidden", timeout });
}

async function activateViewportTab(page, moduleId, timeout) {
  if (!/^[a-zA-Z0-9_-]+$/.test(moduleId)) {
    throw new Error(`Unsupported viewport-main module id: ${moduleId}`);
  }
  const tabs = page.locator(`${MAIN_SLOT_SELECTOR} [role="tab"]`);
  const index = await tabs.evaluateAll((elements, wantedId) =>
    elements.findIndex((element) => element.getAttribute("data-value") === wantedId),
  moduleId);
  if (index < 0) {
    const title = MODULE_TITLES[moduleId];
    if (!title) throw new Error(`The ${moduleId} viewport tab was not found`);
    const named = page.getByRole("tab", { exact: true, name: title }).first();
    await named.waitFor({ state: "visible", timeout });
    await named.click({ timeout });
  } else {
    const tab = tabs.nth(index);
    await tab.waitFor({ state: "visible", timeout });
    await tab.click({ timeout });
  }
  await page.locator(
    `${MAIN_SLOT_SELECTOR}[data-active-module-id="${moduleId}"]`,
  ).waitFor({ state: "attached", timeout });
}

async function assertActiveFieldMap(page, timeout) {
  await page.locator(".fm-field-map").first().waitFor({ state: "visible", timeout });
  await page.waitForFunction(
    (selectors) => {
      const active = document.querySelector(selectors.mainSlot)
        ?.getAttribute("data-active-module-id");
      return active === "field-map" &&
        !document.querySelector(selectors.viewport) &&
        !document.querySelector(selectors.canvas);
    },
    { mainSlot: MAIN_SLOT_SELECTOR, viewport: VIEWPORT_SELECTOR, canvas: CANVAS_SELECTOR },
    { timeout },
  );
}

async function checkCanvas(page, label, assertCanvas, timeout) {
  if (typeof assertCanvas === "function") await assertCanvas(label);
  const canvas = page.locator(CANVAS_SELECTOR);
  await canvas.first().waitFor({ state: "visible", timeout });
  const proof = await canvas.first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const context = element.getContext("webgl2") ?? element.getContext("webgl");
    return {
      canvas_height: element.height,
      canvas_width: element.width,
      context_type: context?.constructor?.name ?? null,
      context_lost: context?.isContextLost?.() ?? null,
      drawing_buffer_height: context?.drawingBufferHeight ?? 0,
      drawing_buffer_width: context?.drawingBufferWidth ?? 0,
      rect_height: rect.height,
      rect_width: rect.width,
    };
  });
  if (await canvas.count() !== 1 || proof.rect_width <= 0 || proof.rect_height <= 0 ||
      proof.canvas_width <= 0 || proof.canvas_height <= 0 || !proof.context_type ||
      proof.context_lost !== false || proof.drawing_buffer_width <= 0 ||
      proof.drawing_buffer_height <= 0) {
    throw new Error(`${label}: unhealthy or ambiguous WebGL canvas: ${JSON.stringify(proof)}`);
  }
  return proof;
}

async function assertCanvasStableWithinMount(page, timeout, settleMs) {
  const canvas = page.locator(CANVAS_SELECTOR);
  if (await canvas.count() !== 1) {
    throw new Error("Expected one 3D canvas after returning to the active viewport");
  }
  const elementHandle = await canvas.first().elementHandle();
  if (!elementHandle) throw new Error("Could not retain the active 3D canvas element");
  await page.waitForTimeout(Math.max(80, Math.min(settleMs, 300)));
  const stable = await elementHandle.evaluate(
    (node, selector) => node === document.querySelector(selector) && document.contains(node),
    CANVAS_SELECTOR,
  );
  if (!stable || await canvas.count() !== 1) {
    throw new Error("The 3D canvas was replaced while its mount remained active");
  }
  await canvas.first().waitFor({ state: "visible", timeout });
}

async function readPublicSignals(page) {
  return page.evaluate(({ mainSlotSelector, canvasSelector, viewportSelector, resourceKeys }) => {
    const counters = window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__;
    const resourceCounts = counters?.resourceCounts;
    const completeResourceCounts = resourceKeys.every((key) =>
      Number.isFinite(resourceCounts?.[key]),
    );
    const frameReasons = counters?.viewportFrameReasons;
    const completeFrameReasons = frameReasons && typeof frameReasons === "object" &&
      Object.values(frameReasons).every((value) => Number.isFinite(value));
    return {
      active_module_id:
        document.querySelector(mainSlotSelector)?.getAttribute("data-active-module-id") ?? null,
      canvas_count: document.querySelectorAll(canvasSelector).length,
      viewport_root_count: document.querySelectorAll(viewportSelector).length,
      debug_available: Boolean(counters),
      resource_counts: completeResourceCounts
        ? Object.fromEntries(resourceKeys.map((key) => [key, resourceCounts[key]]))
        : null,
      resource_counts_available: completeResourceCounts,
      viewport_frame_reasons: completeFrameReasons ? { ...frameReasons } : null,
      viewport_frame_reasons_available: Boolean(completeFrameReasons),
      viewport_frames: Number.isFinite(counters?.viewportFrames)
        ? counters.viewportFrames
        : null,
      viewport_frames_available: Number.isFinite(counters?.viewportFrames),
    };
  }, {
    mainSlotSelector: MAIN_SLOT_SELECTOR,
    canvasSelector: CANVAS_SELECTOR,
    viewportSelector: VIEWPORT_SELECTOR,
    resourceKeys: RESOURCE_COUNT_KEYS,
  });
}

function assertInactiveResourceCounts(signals, cycle) {
  if (!signals.resource_counts_available) return;
  const allocated = Object.entries(signals.resource_counts).filter(([, count]) => count > 0);
  if (allocated.length > 0) {
    throw new Error(
      `2D viewport retained 3D resource counts in cycle ${cycle}: ` +
        allocated.map(([name, count]) => `${name}=${count}`).join(", "),
    );
  }
}

function assessResourceCounts(baseline, postChurn, inactiveSamples) {
  if (!baseline.resource_counts_available || !postChurn.resource_counts_available) {
    return {
      state: "not-verified",
      reason: "The public debug counter did not expose complete resourceCounts.",
      baseline: baseline.resource_counts,
      post_churn: postChurn.resource_counts,
      idle: null,
      inactive_samples_available: inactiveSamples.filter((sample) => sample.resource_counts_available).length,
    };
  }
  const growth = Object.fromEntries(RESOURCE_COUNT_KEYS
    .map((key) => [key, postChurn.resource_counts[key] - baseline.resource_counts[key]])
    .filter(([, delta]) => delta > 0));
  return {
    state: Object.keys(growth).length === 0 ? "no-growth-observed" : "growth-observed",
    source: "window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__.resourceCounts",
    baseline: baseline.resource_counts,
    post_churn: postChurn.resource_counts,
    growth,
    idle: null,
    inactive_samples_available: inactiveSamples.filter((sample) => sample.resource_counts_available).length,
  };
}

async function sampleIdleFrames(page, sampleCount, sampleMs) {
  await page.waitForTimeout(450);
  let previous = await readPublicSignals(page);
  if (!previous.viewport_frames_available) {
    return {
      state: "not-verified",
      reason: "The public debug counter did not expose viewportFrames.",
      sample_deltas: [],
      final_signals: previous,
    };
  }

  const deltas = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    await page.waitForTimeout(sampleMs);
    const current = await readPublicSignals(page);
    if (!current.viewport_frames_available) {
      return {
        state: "not-verified",
        reason: "viewportFrames disappeared while sampling the settled viewport.",
        sample_deltas: deltas,
        final_signals: current,
      };
    }
    deltas.push(current.viewport_frames - previous.viewport_frames);
    previous = current;
  }

  const state = deltas.every((delta) => delta === 0)
    ? "verified-quiet"
    : deltas.every((delta) => delta > 0)
      ? "continuous-frames-observed"
      : "not-verified-transient-frames";
  return {
    state,
    source: "window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__.viewportFrames",
    sample_interval_ms: sampleMs,
    sample_deltas: deltas,
    final_signals: previous,
  };
}

function summarizeSignals(signals) {
  if (!signals) return { state: "not-verified" };
  return {
    active_module_id: signals.active_module_id,
    canvas_count: signals.canvas_count,
    viewport_root_count: signals.viewport_root_count,
    debug_available: signals.debug_available,
    resource_counts: signals.resource_counts,
    resource_counts_available: signals.resource_counts_available,
    viewport_frames: signals.viewport_frames,
    viewport_frames_available: signals.viewport_frames_available,
    viewport_frame_reasons: signals.viewport_frame_reasons,
    viewport_frame_reasons_available: signals.viewport_frame_reasons_available,
  };
}

function classifyResourceRequest(requestUrl) {
  let pathname;
  try {
    pathname = new URL(requestUrl).pathname;
  } catch {
    return null;
  }
  if (pathname.includes("/v2/sessions/current/data/fields/")) return "field";
  if (
    pathname.endsWith("/v2/sessions/current/data/domain/topology") ||
    pathname.endsWith("/v2/sessions/current/meshing/meshes/shared-domain/topology")
  ) {
    return "topology";
  }
  return null;
}

function summarizeRequests(requests) {
  const counts = { field: 0, topology: 0 };
  for (const request of requests) counts[request.kind] += 1;
  return {
    state: requests.length === 0 ? "no-matching-requests" : "matching-requests-observed",
    count: requests.length,
    field_count: counts.field,
    topology_count: counts.topology,
    samples: requests.slice(0, 24),
  };
}

async function readAppearanceStorage(page) {
  return page.evaluate((key) => {
    try {
      return { available: true, value: window.localStorage.getItem(key) };
    } catch {
      return { available: false, value: null };
    }
  }, APPEARANCE_STORAGE_KEY);
}

async function restoreAppearanceStorage(page, snapshot) {
  await page.evaluate(({ key, value }) => {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch {
      throw new Error("Browser appearance preference storage is unavailable");
    }
  }, { key: APPEARANCE_STORAGE_KEY, value: snapshot.value });
}

function assertSession(expected, actual, label) {
  if (expected && !actual) {
    throw new Error(`Session identity was unavailable ${label}`);
  }
  if (expected && actual && !sameSessionIdentity(expected, actual)) {
    throw new Error(`Active session identity changed ${label}`);
  }
}

function sameSessionIdentity(left, right) {
  return ["session_id", "session_epoch", "request_scope_epoch"]
    .every((key) => left?.[key] === right?.[key]);
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function positiveInteger(value, fallback, name) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return candidate;
}

function boundedTimeout(value) {
  const candidate = value === undefined ? 15_000 : Number(value);
  if (!Number.isFinite(candidate) || candidate <= 0) {
    throw new TypeError("timeout must be a positive number of milliseconds");
  }
  return Math.min(Math.floor(candidate), MAX_STEP_TIMEOUT_MS);
}

function boundedWait(value, fallback, name) {
  return Math.min(positiveInteger(value, fallback, name), MAX_STEP_TIMEOUT_MS);
}
