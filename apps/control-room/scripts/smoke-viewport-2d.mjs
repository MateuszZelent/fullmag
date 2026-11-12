import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { assertPlanarEvidenceReady } from "./lib/planar-field-evidence.mjs";
import {
  REMOVED_CANVAS_CONTROL_LABELS,
  assertCroppedPlanarMeta,
  assertFullFramePlanarMeta,
  assertLayerFlagsUnchanged,
  assertLayerMoved,
  assertLegendCardCount,
  assertMigratedLayers,
  assertNodeReadoutHeading,
  assertPlanarToolbarSnapshot,
  assertTicksWithinRange,
  countPositionCommits,
  drawnFieldLayers,
  frameIntervalWorldRange,
} from "./lib/planar-toolbar-smoke.mjs";

const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://localhost:3194/workspace";
const apiBase = (
  process.env.CONTROL_ROOM_API_BASE_URL ?? new URL(workspaceUrl).origin
).replace(/\/$/, "");
const backend = process.env.CONTROL_ROOM_PLANAR_BACKEND ?? "fdm";
const sourceKind = process.env.CONTROL_ROOM_PLANAR_SOURCE_KIND ?? "monitor";
const outputDir =
  process.env.CONTROL_ROOM_PLANAR_OUTPUT_DIR ??
  path.resolve(
    sourceKind === "default"
      ? ".fullmag/reports/viewport-2d-default-slice-smoke/browser"
      : ".fullmag/reports/viewport-2d-planar-monitor-smoke/browser",
  );
const timeoutMs = Number(
  process.env.CONTROL_ROOM_PLANAR_SMOKE_TIMEOUT_MS ?? 180_000,
);
const switchCount = Number(
  process.env.CONTROL_ROOM_PLANAR_SWITCH_COUNT ?? 100,
);
const execFileAsync = promisify(execFile);

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    throw new Error("2D viewport smoke requires Playwright or @playwright/test");
  }
  if (sourceKind === "default") {
    await runDefaultSliceSmoke(playwright);
    return;
  }
  await fs.mkdir(outputDir, { recursive: true });
  const monitors = await waitForMonitors();
  const ids = monitors.monitors.map((monitor) => monitor.id);
  const required =
    backend === "fem"
      ? ["xy-plane", "xy-slab", "object-surface"]
      : ["xy-plane", "xy-slab", "depth-mean", "oblique-plane"];
  for (const id of required) {
    if (!ids.includes(id)) throw new Error(`Missing planar monitor ${id}`);
  }

  const browser = await playwright.chromium.launch({
    args: ["--enable-precise-memory-info"],
  });
  const page = await browser.newPage({
    reducedMotion: "reduce",
    viewport: { height: 900, width: 1440 },
  });
  const errors = [];
  const observedPlanarMeta = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", async (response) => {
    const requestUrl = new URL(response.url());
    const match = requestUrl.pathname.match(
      /^\/v2\/sessions\/current\/data\/fields\/([^/]+)\/(planar-default|planar-monitors\/([^/]+))\/meta$/,
    );
    if (!match || response.status() !== 200) return;
    try {
      const sourceKind = match[2] === "planar-default" ? "default" : "monitor";
      observedPlanarMeta.push({
        sourceId: sourceKind === "default" ? "default" : decodeURIComponent(match[3]),
        sourceKind,
        payload: await response.json(),
        quantityId: decodeURIComponent(match[1]),
      });
    } catch (error) {
      errors.push(`Planar meta inspection failed: ${String(error)}`);
    }
  });
  await page.addInitScript((baseUrl) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: baseUrl,
    };
    const NativeWorker = window.Worker;
    const workerAudit = { active: 0, created: 0, terminated: 0 };
    window.__FULLMAG_PLANAR_WORKER_AUDIT__ = workerAudit;
    window.Worker = class FullmagPlanarAuditedWorker extends NativeWorker {
      constructor(...args) {
        super(...args);
        const isPlanar = String(args[0]).includes("planarRendererWorker");
        if (!isPlanar) return;
        workerAudit.active += 1;
        workerAudit.created += 1;
        let terminated = false;
        const nativeTerminate = this.terminate.bind(this);
        this.terminate = () => {
          if (!terminated) {
            terminated = true;
            workerAudit.active -= 1;
            workerAudit.terminated += 1;
          }
          nativeTerminate();
        };
      }
    };
  }, apiBase);

  try {
    const initialMonitor = monitorById(monitors, required[0]);
    await selectMonitor(initialMonitor.id, 128);
    await page.goto(workspaceUrl, {
      timeout: timeoutMs,
      waitUntil: "domcontentloaded",
    });
    const workerBaseline = await readPlanarWorkerSnapshot(page);
    const open2d = page.getByRole("tab", { name: "2D View", exact: true });
    await open2d.waitFor({ state: "visible", timeout: timeoutMs });
    const initialOpenStarted = performance.now();
    await open2d.click();
    const initialCanvas = await assertFieldMapCanvas(page);
    const initialEvidence = await assertPlanarEvidence(
      page,
      expectedPlanarEvidence(initialMonitor),
      observedPlanarMeta,
    );
    const smokeEvidence = [initialEvidence];
    const initialOpenMs = performance.now() - initialOpenStarted;
    if (initialOpenMs > 10_000) {
      throw new Error(`initial 2D open exceeded 10 s: ${initialOpenMs}`);
    }
    const open3d = page.getByRole("tab", { name: "3D Viewport", exact: true });
    await open3d.click();
    await page.keyboard.press("2");
    await assertFieldMapCanvas(page);
    smokeEvidence.push(
      await assertPlanarEvidence(
        page,
        expectedPlanarEvidence(initialMonitor),
        observedPlanarMeta,
      ),
    );
    await page.screenshot({
      fullPage: true,
      path: path.join(outputDir, "scalar-plane.png"),
    });

    const qualificationCases = await captureLayerCases(
      page,
      initialMonitor,
      observedPlanarMeta,
    );

    const performanceMetrics = { initial_open_ms: initialOpenMs };
    const smallSwitch = await timedMonitorSwitch(
      page,
      monitorById(monitors, "xy-slab"),
      128,
      path.join(outputDir, "slab-vectors.png"),
      observedPlanarMeta,
    );
    performanceMetrics.small_switch_ms = smallSwitch.duration;
    smokeEvidence.push(smallSwitch.evidence);
    const largeSwitch = await timedMonitorSwitch(
      page,
      initialMonitor,
      1024,
      undefined,
      observedPlanarMeta,
    );
    performanceMetrics.large_switch_ms = largeSwitch.duration;
    smokeEvidence.push(largeSwitch.evidence);
    if (backend === "fem") {
      const surfaceSwitch = await timedMonitorSwitch(
        page,
        monitorById(monitors, "object-surface"),
        256,
        path.join(outputDir, "surface-projection.png"),
        observedPlanarMeta,
      );
      performanceMetrics.surface_switch_ms = surfaceSwitch.duration;
      smokeEvidence.push(surfaceSwitch.evidence);
      const meshSwitch = await timedMonitorSwitch(
        page,
        monitorById(monitors, "xy-plane"),
        256,
        path.join(outputDir, "fem-mesh-overlay.png"),
        observedPlanarMeta,
      );
      smokeEvidence.push(meshSwitch.evidence);
    }
    await capturePlanarFramePreview(
      page,
      initialMonitor,
      observedPlanarMeta,
    );
    smokeEvidence.push(
      await assertPlanarEvidence(
        page,
        expectedPlanarEvidence(initialMonitor),
        observedPlanarMeta,
      ),
    );

    const memoryBefore = await usedHeap(page);
    if (memoryBefore == null) {
      throw new Error("performance.memory is unavailable; heap lifecycle gate cannot run");
    }
    for (let index = 0; index < switchCount; index += 1) {
      await open3d.click();
      await assertHealthyWebGL(page, `lifecycle cycle ${index + 1}`);
      await open2d.click();
      await assertFieldMapCanvas(page);
      const monitor = monitorById(monitors, required[index % required.length]);
      await selectMonitor(monitor.id, 128);
      await waitForCanvasPaint(page);
      smokeEvidence.push(
        await assertPlanarEvidence(
          page,
          expectedPlanarEvidence(monitor),
          observedPlanarMeta,
        ),
      );
    }
    const memoryAfter = await usedHeap(page);
    if (memoryAfter == null) {
      throw new Error("performance.memory disappeared; heap lifecycle gate cannot complete");
    }
    const memoryGrowthBytes =
      memoryAfter - memoryBefore;
    if (memoryGrowthBytes > 96 * 1024 * 1024) {
      throw new Error(
        `100-switch heap growth exceeded 96 MiB: ${memoryGrowthBytes}`,
      );
    }
    if (errors.length > 0) {
      throw new Error(`Browser errors:\n${errors.join("\n")}`);
    }
    await open3d.click();
    const finalWebGL = await assertHealthyWebGL(page, "after planar lifecycle cycles");
    const workerAfter = await readPlanarWorkerSnapshot(page);
    if (workerAfter.active !== workerBaseline.active) {
      throw new Error(
        `Planar worker count did not return to baseline: ${JSON.stringify({ workerAfter, workerBaseline })}`,
      );
    }
    if (
      workerAfter.created <= workerBaseline.created ||
      workerAfter.created - workerBaseline.created !==
        workerAfter.terminated - workerBaseline.terminated
    ) {
      throw new Error(
        `Planar workers were not created and terminated one-for-one: ${JSON.stringify({ workerAfter, workerBaseline })}`,
      );
    }
    const status = await getJson("/v2/sessions/current/status");
    const run = await getJson("/v2/sessions/current/simulation/runs/current");
    const scienceReport = await readScienceReport();
    const currentGitHead = await gitHead();
    const runtimeBundleIdentity = {
      api_contract_version: status.api_contract_version,
      requested_backend: run.requested_backend,
      requested_device: run.requested_device,
      resolved_backend: run.resolved_backend,
      resolved_device: run.resolved_device,
      resolved_runtime_family: run.resolved_runtime_family,
      runtime_bundle_version: status.runtime_bundle_version,
    };
    const scienceMatchesRuntime =
      scienceReport.pass === true &&
      scienceReport.head === currentGitHead &&
      scienceReport.backend === backend &&
      scienceReport.device === run.resolved_device &&
      scienceReport.execution?.requested_backend === run.requested_backend &&
      scienceReport.execution?.requested_device === run.requested_device &&
      scienceReport.execution?.resolved_backend === run.resolved_backend &&
      scienceReport.execution?.resolved_device === run.resolved_device &&
      scienceReport.execution?.resolved_runtime_family === run.resolved_runtime_family &&
      scienceReport.runtime_bundle_identity?.api_contract_version ===
        status.api_contract_version &&
      scienceReport.runtime_bundle_identity?.runtime_bundle_version ===
        status.runtime_bundle_version;
    const report = {
      backend,
      canvas: "2d",
      canvas_proof: initialCanvas,
      evidence: smokeEvidence,
      final_webgl: finalWebGL,
      git_head: currentGitHead,
      keyboard_shortcut: "2",
      memory_after_bytes: memoryAfter,
      memory_before_bytes: memoryBefore,
      memory_growth_bytes: memoryGrowthBytes,
      pass:
        scienceMatchesRuntime &&
        scienceReport.qualification_complete === true &&
        smokeEvidence.every((evidence) => evidence.status === "ready") &&
        qualificationCases.filter((entry) => entry.required).every((entry) => entry.passed),
      performance: performanceMetrics,
      reduced_motion: true,
      planar_frame_preview_3d: true,
      qualification_cases: qualificationCases,
      scientific_qualification: {
        complete: scienceReport.qualification_complete === true,
        matches_runtime: scienceMatchesRuntime,
        pass: scienceReport.pass === true,
        report: "../science-report.json",
        status: scienceReport.qualification_status ?? "blocked",
      },
      runtime_bundle_identity: runtimeBundleIdentity,
      schema_version: "viewport-2d-browser-smoke-v2",
      switch_count: switchCount,
      worker_after: workerAfter,
      worker_baseline: workerBaseline,
    };
    await fs.writeFile(
      path.join(outputDir, "browser-report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    if (!report.pass) {
      throw new Error(`Viewport 2D qualification is blocked: ${outputDir}`);
    }
    console.log(`Viewport 2D browser smoke passed: ${outputDir}`);
  } finally {
    await browser.close();
  }
}

async function runDefaultSliceSmoke(playwright) {
  await fs.mkdir(outputDir, { recursive: true });
  const domain = await getJson("/v2/sessions/current/data/domain/meta");
  const monitors = await waitForEmptyMonitors();
  await setDefaultSliceViaApi("xy", 0.5, "plane_sample");

  const browser = await playwright.chromium.launch({
    args: ["--enable-precise-memory-info"],
  });
  const page = await browser.newPage({
    reducedMotion: "reduce",
    viewport: { height: 900, width: 1440 },
  });
  const errors = [];
  const observedPlanarMeta = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", async (response) => {
    const requestUrl = new URL(response.url());
    const match = requestUrl.pathname.match(
      /^\/v2\/sessions\/current\/data\/fields\/([^/]+)\/(planar-default|planar-monitors\/([^/]+))\/meta$/,
    );
    if (!match || response.status() !== 200) return;
    try {
      const responseSourceKind = match[2] === "planar-default" ? "default" : "monitor";
      observedPlanarMeta.push({
        sourceId: responseSourceKind === "default" ? "default" : decodeURIComponent(match[3]),
        sourceKind: responseSourceKind,
        payload: await response.json(),
        quantityId: decodeURIComponent(match[1]),
      });
    } catch (error) {
      errors.push(`Planar meta inspection failed: ${String(error)}`);
    }
  });
  const displayPatches = [];
  page.on("request", (request) => {
    if (request.method() !== "PATCH") return;
    if (new URL(request.url()).pathname !== "/v2/sessions/current/visualization/state") return;
    try {
      displayPatches.push(request.postDataJSON());
    } catch (error) {
      errors.push(`Display PATCH inspection failed: ${String(error)}`);
    }
  });
  await installPlanarWorkerAudit(page, apiBase);

  try {
    await page.goto(workspaceUrl, {
      timeout: timeoutMs,
      waitUntil: "domcontentloaded",
    });
    const initialWebGL = await assertHealthyWebGL(page, "initial default 3D");
    const workerBaseline = await readPlanarWorkerSnapshot(page);
    const open2d = page.getByRole("tab", { name: "2D View", exact: true });
    await open2d.waitFor({ state: "visible", timeout: timeoutMs });
    const initialOpenStarted = performance.now();
    await open2d.click();
    const initialCanvas = await assertFieldMapCanvas(page);
    const initialEvidence = await assertDefaultEvidence(
      page,
      domain,
      { plane: "xy", positionFraction: 0.5, operatorKind: "plane_sample" },
      observedPlanarMeta,
    );
    const smokeEvidence = [initialEvidence];
    const initialOpenMs = performance.now() - initialOpenStarted;
    if (initialOpenMs > 10_000) {
      throw new Error(`initial Default 2D open exceeded 10 s: ${initialOpenMs}`);
    }
    await page.screenshot({
      fullPage: true,
      path: path.join(outputDir, "default-xy-q0.5.png"),
    });
    const pngEvidence = {
      default: await capturePlanarPng(
        initialEvidence,
        observedPlanarMeta,
        "default-source.png",
      ),
    };
    const toolbarCases = await runToolbarLayerScenarios(
      page,
      observedPlanarMeta,
      displayPatches,
    );

    const defaultCases = [];
    for (const [plane, positionFraction] of [
      ["xy", 0.25],
      ["xy", 0.75],
      ["xz", 0.5],
      ["yz", 0.5],
    ]) {
      await setDefaultSliceViaApi(plane, positionFraction, "plane_sample");
      const evidence = await assertDefaultEvidence(
        page,
        domain,
        { plane, positionFraction, operatorKind: "plane_sample" },
        observedPlanarMeta,
      );
      smokeEvidence.push(evidence);
      defaultCases.push({
        case_id: `default-${plane}-q${positionFraction}`,
        passed: evidence.status === "ready",
        required: true,
        status: evidence.status === "ready" ? "passed" : "blocked",
      });
      await page.screenshot({
        fullPage: true,
        path: path.join(outputDir, `default-${plane}-q${positionFraction}.png`),
      });
    }

    const thicknessM = (domain.bounds.max[2] - domain.bounds.min[2]) * 0.25;
    await setDefaultSliceViaApi("xy", 0.5, "slab_average", thicknessM);
    const slabEvidence = await assertDefaultEvidence(
      page,
      domain,
      { plane: "xy", positionFraction: 0.5, operatorKind: "slab_average" },
      observedPlanarMeta,
    );
    smokeEvidence.push(slabEvidence);
    defaultCases.push({
      case_id: "default-xy-slab-average",
      passed: slabEvidence.status === "ready",
      required: true,
      status: slabEvidence.status === "ready" ? "passed" : "blocked",
      thickness_m: thicknessM,
    });

    const created = await createAuthoredMonitor(domain, monitors);
    await selectMonitor(created.monitor.id, 128);
    await waitForCanvasPaint(page);
    const monitorEvidence = await assertPlanarEvidence(
      page,
      expectedPlanarEvidence(created.monitor),
      observedPlanarMeta,
    );
    smokeEvidence.push(monitorEvidence);
    pngEvidence.monitor = await capturePlanarPng(
      monitorEvidence,
      observedPlanarMeta,
      "authored-monitor-source.png",
    );
    await setDefaultSliceViaApi("xy", 0.5, "plane_sample");
    const returnedDefaultEvidence = await assertDefaultEvidence(
      page,
      domain,
      { plane: "xy", positionFraction: 0.5, operatorKind: "plane_sample" },
      observedPlanarMeta,
    );
    smokeEvidence.push(returnedDefaultEvidence);

    const memoryBefore = await usedHeap(page);
    if (memoryBefore == null) {
      throw new Error("performance.memory is unavailable; heap lifecycle gate cannot run");
    }
    const open3d = page.getByRole("tab", { name: "3D Viewport", exact: true });
    for (let index = 0; index < switchCount; index += 1) {
      await open3d.click();
      await assertHealthyWebGL(page, `Default lifecycle cycle ${index + 1}`);
      await open2d.click();
      await assertFieldMapCanvas(page);
      await setDefaultSliceViaApi("xy", 0.5, "plane_sample");
      smokeEvidence.push(
        await assertDefaultEvidence(
          page,
          domain,
          { plane: "xy", positionFraction: 0.5, operatorKind: "plane_sample" },
          observedPlanarMeta,
        ),
      );
    }
    const memoryAfter = await usedHeap(page);
    if (memoryAfter == null) {
      throw new Error("performance.memory disappeared; heap lifecycle gate cannot complete");
    }
    const memoryGrowthBytes = memoryAfter - memoryBefore;
    if (memoryGrowthBytes > 96 * 1024 * 1024) {
      throw new Error(`100-switch heap growth exceeded 96 MiB: ${memoryGrowthBytes}`);
    }
    if (errors.length > 0) {
      throw new Error(`Browser errors:\n${errors.join("\n")}`);
    }
    await open3d.click();
    const finalWebGL = await assertHealthyWebGL(page, "after Default planar lifecycle cycles");
    const workerAfter = await readPlanarWorkerSnapshot(page);
    if (workerAfter.active !== workerBaseline.active) {
      throw new Error(
        `Planar worker count did not return to baseline: ${JSON.stringify({ workerAfter, workerBaseline })}`,
      );
    }
    if (
      workerAfter.created <= workerBaseline.created ||
      workerAfter.created - workerBaseline.created !==
        workerAfter.terminated - workerBaseline.terminated
    ) {
      throw new Error(
        `Planar workers were not created and terminated one-for-one: ${JSON.stringify({ workerAfter, workerBaseline })}`,
      );
    }
    const status = await getJson("/v2/sessions/current/status");
    const run = await getJson("/v2/sessions/current/simulation/runs/current");
    const scienceReport = await readScienceReport();
    const currentGitHead = await gitHead();
    const runtimeBundleIdentity = {
      api_contract_version: status.api_contract_version,
      requested_backend: run.requested_backend,
      requested_device: run.requested_device,
      resolved_backend: run.resolved_backend,
      resolved_device: run.resolved_device,
      resolved_runtime_family: run.resolved_runtime_family,
      runtime_bundle_version: status.runtime_bundle_version,
    };
    const scienceMatchesRuntime =
      scienceReport.pass === true &&
      scienceReport.source_kind === "default" &&
      scienceReport.head === currentGitHead &&
      scienceReport.backend === backend &&
      scienceReport.device === run.resolved_device &&
      scienceReport.execution?.requested_backend === run.requested_backend &&
      scienceReport.execution?.requested_device === run.requested_device &&
      scienceReport.execution?.resolved_backend === run.resolved_backend &&
      scienceReport.execution?.resolved_device === run.resolved_device &&
      scienceReport.execution?.resolved_runtime_family === run.resolved_runtime_family &&
      scienceReport.runtime_bundle_identity?.api_contract_version ===
        status.api_contract_version &&
      scienceReport.runtime_bundle_identity?.runtime_bundle_version ===
        status.runtime_bundle_version;
    const qualificationCases = [
      ...defaultCases,
      ...toolbarCases,
      {
        case_id: "default-vs-monitor",
        identities_distinct: monitorEvidence.sourceKind === "monitor",
        passed: monitorEvidence.status === "ready" && monitorEvidence.sourceKind === "monitor",
        required: true,
        status: monitorEvidence.status === "ready" ? "passed" : "blocked",
      },
      {
        case_id: "default-and-monitor-png",
        passed:
          pngEvidence.default.status === "passed" &&
          pngEvidence.monitor.status === "passed",
        required: true,
        status:
          pngEvidence.default.status === "passed" &&
          pngEvidence.monitor.status === "passed"
            ? "passed"
            : "blocked",
      },
      {
        case_id: "default-3d-lifecycle",
        passed: finalWebGL.drawingBufferWidth > 0 && !finalWebGL.isContextLost,
        required: true,
        status: finalWebGL.drawingBufferWidth > 0 && !finalWebGL.isContextLost ? "passed" : "blocked",
      },
    ];
    const report = {
      backend,
      canvas: "2d",
      canvas_proof: initialCanvas,
      evidence: smokeEvidence,
      final_webgl: finalWebGL,
      git_head: currentGitHead,
      initial_webgl: initialWebGL,
      memory_after_bytes: memoryAfter,
      memory_before_bytes: memoryBefore,
      memory_growth_bytes: memoryGrowthBytes,
      pass:
        scienceMatchesRuntime &&
        scienceReport.qualification_complete === true &&
        smokeEvidence.every((evidence) => evidence.status === "ready") &&
        qualificationCases.filter((entry) => entry.required).every((entry) => entry.passed),
      performance: { initial_open_ms: initialOpenMs },
      png_exports: pngEvidence,
      qualification_cases: qualificationCases,
      reduced_motion: true,
      runtime_bundle_identity: runtimeBundleIdentity,
      schema_version: "viewport-2d-default-slice-browser-smoke-v1",
      scientific_qualification: {
        complete: scienceReport.qualification_complete === true,
        matches_runtime: scienceMatchesRuntime,
        pass: scienceReport.pass === true,
        report: "../science-report.json",
        status: scienceReport.qualification_status ?? "blocked",
      },
      source_kind: "default",
      switch_count: switchCount,
      worker_after: workerAfter,
      worker_baseline: workerBaseline,
    };
    await fs.writeFile(
      path.join(outputDir, "browser-report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    if (!report.pass) {
      throw new Error(`Default planar qualification is blocked: ${outputDir}`);
    }
    console.log(`Default planar browser smoke passed: ${outputDir}`);
  } finally {
    await browser.close();
  }
}

// --- 2D toolbar, crop, node inspector and field-layer scenarios -----------
// Plan 2026-11-12 Task 12 Step 1. Each case asserts data-planar-* evidence or
// visualization state plus the DOM, and restores the presentation it changed.

const VISUALIZATION_STATE_PATH = "/v2/sessions/current/visualization/state";

async function readPlanarState() {
  return (await getJson(VISUALIZATION_STATE_PATH)).planar;
}

async function waitForPlanarState(predicate, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readPlanarState();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: visualization state did not settle: ${JSON.stringify(last)?.slice(0, 400)}`);
}

async function readPlanarBaseEvidence(page) {
  const raw = await page
    .locator("[aria-label='Planar field evidence']")
    .first()
    .getAttribute("data-planar-evidence");
  return raw ? JSON.parse(raw) : null;
}

async function waitForPlanarBaseEvidence(page, predicate, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readPlanarBaseEvidence(page).catch(() => null);
    if (last && predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: planar evidence did not settle: ${JSON.stringify(last)?.slice(0, 400)}`);
}

async function waitForObservedMetaByToken(observedPlanarMeta, sampleToken, label) {
  const deadline = Date.now() + Math.min(timeoutMs, 10_000);
  while (Date.now() < deadline) {
    const match = [...observedPlanarMeta].reverse().find((entry) => entry.payload?.sample_token === sampleToken);
    if (match) return match.payload;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label}: no observed planar metadata has sample token ${sampleToken}`);
}

/** Screen box of the 2D plot (the tool overlay covers it exactly). */
async function planarPlotBox(page) {
  const overlay = page.locator("[data-planar-tool-overlay]").first();
  await overlay.waitFor({ state: "attached", timeout: timeoutMs });
  const box = await overlay.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) throw new Error("2D plot has no measurable box");
  return box;
}

async function dragInPlot(page, box, from, to) {
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    const t = step / 8;
    await page.mouse.move(
      box.x + box.width * (from[0] + (to[0] - from[0]) * t),
      box.y + box.height * (from[1] + (to[1] - from[1]) * t),
    );
  }
  await page.mouse.up();
}

async function selectPlanarTool(page, name) {
  const tool = page
    .getByRole("toolbar", { name: "2D view tools", exact: true })
    .getByRole("radio", { name, exact: true });
  await tool.click();
  await page.waitForFunction(
    (label) => [...document.querySelectorAll("[role='radio']")]
      .some((node) => node.getAttribute("aria-label") === label && node.getAttribute("aria-checked") === "true"),
    name,
    { timeout: timeoutMs },
  );
}

async function withPlanarPatch(page, action, label) {
  const acknowledgement = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "PATCH" && url.pathname === VISUALIZATION_STATE_PATH;
  }, { timeout: timeoutMs });
  await action();
  const response = await acknowledgement;
  if (response.status() < 200 || response.status() >= 300) {
    throw new Error(`${label}: display-state PATCH returned ${response.status()}`);
  }
}

function toolbarCase(caseId, details, passed) {
  return { case_id: caseId, passed, required: true, status: passed ? "passed" : "blocked", ...details };
}

/** Scenario 1: six tools, no Quantity/Scope/Free section above the canvas. */
async function toolbarShapeCase(page) {
  const toolbar = page.getByRole("toolbar", { name: "2D view tools", exact: true });
  await toolbar.waitFor({ state: "visible", timeout: timeoutMs });
  const snapshot = await page.evaluate((removed) => {
    const group = document.querySelector("[role='toolbar'][aria-label='2D view tools'] [role='radiogroup'][aria-label='Canvas tool']");
    const radios = group ? [...group.querySelectorAll("[role='radio']")] : [];
    const stage = document.querySelector(".fm-field-map");
    const labelled = stage ? [...stage.querySelectorAll("label, [aria-label], button, [role='combobox']")] : [];
    const names = new Set(labelled.flatMap((node) => [node.getAttribute("aria-label") ?? "", node.textContent?.trim() ?? ""]));
    return {
      tools: radios.map((node) => node.getAttribute("aria-label")),
      checked: radios.filter((node) => node.getAttribute("aria-checked") === "true").map((node) => node.getAttribute("aria-label")),
      removedHits: removed.filter((label) => names.has(label)),
    };
  }, [...REMOVED_CANVAS_CONTROL_LABELS]);
  assertPlanarToolbarSnapshot(snapshot);
  return toolbarCase("toolbar-six-tools", { snapshot }, true);
}

/** Scenario 2: box zoom raises planar.interaction.zoom; F fits back to 1. */
async function zoomBoxCase(page) {
  await selectPlanarTool(page, "Zoom to box");
  const box = await planarPlotBox(page);
  await dragInPlot(page, box, [0.3, 0.3], [0.7, 0.7]);
  const zoomed = await waitForPlanarState((planar) => (planar?.interaction?.zoom ?? 1) > 1.01, "Zoom to box");
  const toolAfter = await page
    .getByRole("radio", { name: "Navigate", exact: true })
    .getAttribute("aria-checked");
  await page.keyboard.press("f");
  const fitted = await waitForPlanarState((planar) => Math.abs((planar?.interaction?.zoom ?? 0) - 1) < 1e-9, "Fit view (F)");
  await page.screenshot({ fullPage: true, path: path.join(outputDir, "toolbar-zoom-box.png") });
  const passed = zoomed.interaction.zoom > 1 && fitted.interaction.zoom === 1 && toolAfter === "true";
  return toolbarCase("toolbar-zoom-box", {
    fitted_zoom: fitted.interaction.zoom,
    tool_returned_to_navigate: toolAfter === "true",
    zoom: zoomed.interaction.zoom,
  }, passed);
}

/**
 * Scenario 3: a committed crop is resampled as its own window: the metadata
 * bounds equal the crop, the sample token changes and the axis ticks show
 * the crop range; "Clear crop" in the status bar restores the full frame.
 */
async function cropCase(page, observedPlanarMeta) {
  const before = await waitForPlanarBaseEvidence(page, (evidence) => evidence.status === "ready", "Crop baseline");
  await selectPlanarTool(page, "Crop");
  const box = await planarPlotBox(page);
  await dragInPlot(page, box, [0.25, 0.25], [0.75, 0.75]);
  const apply = page.getByRole("button", { name: "Apply crop", exact: true });
  await apply.waitFor({ state: "visible", timeout: timeoutMs });
  await withPlanarPatch(page, () => apply.click(), "Apply crop");
  const cropped = await waitForPlanarState((planar) => planar?.crop != null, "Crop commit");
  const evidence = await waitForPlanarBaseEvidence(
    page,
    (candidate) => candidate.status === "ready" && candidate.sampleToken && candidate.sampleToken !== before.sampleToken,
    "Cropped sample",
  );
  const meta = await waitForObservedMetaByToken(observedPlanarMeta, evidence.sampleToken, "Cropped sample");
  const cropWindow = assertCroppedPlanarMeta(meta, cropped.crop, before.sampleToken);
  const ticks = await page.evaluate(() => {
    const read = (prefix) => [...document.querySelectorAll(`[role='group'][aria-label^='${prefix}'] [data-planar-axis-tick]`)]
      .map((node) => Number(node.getAttribute("data-planar-axis-tick")));
    return { horizontal: read("Horizontal"), vertical: read("Vertical") };
  });
  assertTicksWithinRange(ticks.horizontal, frameIntervalWorldRange(meta.frame, "u", cropWindow[0], cropWindow[1]), "Horizontal");
  assertTicksWithinRange(ticks.vertical, frameIntervalWorldRange(meta.frame, "v", cropWindow[2], cropWindow[3]), "Vertical");
  const statusCrop = page.locator("[data-planar-crop]");
  await statusCrop.waitFor({ state: "visible", timeout: timeoutMs });
  await page.screenshot({ fullPage: true, path: path.join(outputDir, "toolbar-crop.png") });
  await withPlanarPatch(page, () => statusCrop.getByRole("button", { name: "Clear crop", exact: true }).click(), "Clear crop");
  await waitForPlanarState((planar) => planar?.crop == null, "Clear crop");
  const cleared = await waitForPlanarBaseEvidence(
    page,
    (candidate) => candidate.status === "ready" && candidate.sampleToken !== evidence.sampleToken,
    "Uncropped sample",
  );
  const fullMeta = await waitForObservedMetaByToken(observedPlanarMeta, cleared.sampleToken, "Uncropped sample");
  assertFullFramePlanarMeta(fullMeta);
  return toolbarCase("toolbar-crop-window", {
    crop: cropped.crop,
    cropped_bounds_uv_m: meta.frame.bounds_uv_m,
    cropped_sample_token: evidence.sampleToken,
    full_bounds_uv_m: meta.frame.full_bounds_uv_m,
    restored_bounds_uv_m: fullMeta.frame.bounds_uv_m,
    ticks,
    uncropped_sample_token: before.sampleToken,
  }, (await statusCrop.count()) === 0);
}

/** Scenario 4: hovering in Inspect node names the FEM node or FDM cell. */
async function nodeInspectCase(page) {
  await selectPlanarTool(page, "Inspect node");
  const box = await planarPlotBox(page);
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  const heading = page
    .locator("[data-planar-node-readout='hover'] tbody[data-planar-node-status='ok'] .fm-planar-node-readout__heading")
    .first();
  await heading.waitFor({ state: "visible", timeout: timeoutMs });
  const text = (await heading.innerText()).trim();
  assertNodeReadoutHeading(text, backend);
  const rings = await page.locator("[data-planar-node-ring]").count();
  await page.screenshot({ fullPage: true, path: path.join(outputDir, `toolbar-inspect-${backend}.png`) });
  await selectPlanarTool(page, "Navigate");
  return toolbarCase(`toolbar-inspect-node-${backend}`, {
    entity: backend === "fem" ? "fem_node" : "fdm_cell_center",
    heading: text,
    ring_count: rings,
  }, rings > 0);
}

async function legendCardCount(page) {
  return page.locator("[role='group'][aria-label='Field layer legends'] > *").count();
}

/**
 * Scenario 5: add an object layer (and the Airbox when the domain has one),
 * hide one, reorder with Alt+Up; the legend shows one card per visible layer.
 */
async function fieldLayerListCase(page) {
  const original = await readPlanarState();
  const list = page.locator("[data-slot='planar-field-layer-list']");
  await list.waitFor({ state: "visible", timeout: timeoutMs });
  const addFor = async (pattern) => {
    await list.getByRole("button", { name: "Add field", exact: true }).click();
    const menu = list.getByRole("menu", { name: "Add field for" });
    const item = menu.getByRole("menuitem").filter({ hasText: pattern }).first();
    if (await menu.count() === 0 || await item.count() === 0) {
      await page.keyboard.press("Escape");
      return false;
    }
    await withPlanarPatch(page, () => item.click(), `Add field for ${pattern}`);
    return true;
  };
  const beforeIds = (original.field_overlays ?? []).map((layer) => layer.id);
  try {
    // Objects are the menu items that are neither "All objects" nor the Airbox.
    const objectAdded = await addFor(/^(?!All objects$)(?!.*airbox).+$/i);
    if (!objectAdded) throw new Error("The Add field menu offered no object target");
    const airboxAdded = await addFor(/airbox/i);
    const added = await readPlanarState();
    const objectLayer = added.field_overlays.find((layer) => !beforeIds.includes(layer.id) && layer.id.startsWith("object:"));
    if (!objectLayer) throw new Error("Adding an object field layer did not create an object:<id> layer");
    const objectRow = list.locator(`li[data-layer-id="${objectLayer.id}"]`);
    await withPlanarPatch(page, () => objectRow.getByRole("button", { name: /^Hide / }).click(), "Hide object layer");
    const hidden = await waitForPlanarState(
      (planar) => planar.field_overlays.find((layer) => layer.id === objectLayer.id)?.visible === false,
      "Hide object layer",
    );
    const orderBefore = hidden.field_overlays.map((layer) => layer.id);
    const lastId = orderBefore.at(-1);
    const lastRow = list.locator(`li[data-layer-id="${lastId}"]`);
    await lastRow.getByRole("button", { name: /^Edit / }).focus();
    await withPlanarPatch(page, () => page.keyboard.press("Alt+ArrowUp"), "Reorder layer");
    const reordered = await waitForPlanarState(
      (planar) => planar.field_overlays.map((layer) => layer.id).join() !== orderBefore.join(),
      "Reorder layer",
    );
    assertLayerMoved(orderBefore, reordered.field_overlays.map((layer) => layer.id), lastId, orderBefore.length - 2);
    const expectedCards = reordered.viewport_colorbar_visible === false ? 0 : drawnFieldLayers(reordered).length;
    await page.waitForFunction(
      (count) => document.querySelectorAll("[role='group'][aria-label='Field layer legends'] > *").length === count,
      expectedCards,
      { timeout: timeoutMs },
    );
    const cards = await legendCardCount(page);
    assertLegendCardCount(reordered, cards);
    await page.screenshot({ fullPage: true, path: path.join(outputDir, "toolbar-field-layers.png") });
    return toolbarCase("toolbar-field-layer-list", {
      airbox_added: airboxAdded,
      legend_cards: cards,
      order_after: reordered.field_overlays.map((layer) => layer.id),
      order_before: orderBefore,
    }, true);
  } finally {
    await patchJson(VISUALIZATION_STATE_PATH, { planar: { field_overlays: original.field_overlays ?? [] } });
  }
}

/** Scenario 6: the toolbar vector mask hides every layer's vectors, flags untouched. */
async function vectorMaskCase(page) {
  const original = await readPlanarState();
  const layers = original.field_overlays ?? [];
  if (layers.length === 0) throw new Error("Vector mask scenario needs at least one field layer");
  // Give the first layer vectors so the mask has something to hide.
  const seeded = layers.map((layer, index) => (index === 0 ? { ...layer, visible: true, vectors_visible: true } : layer));
  try {
    await patchJson(VISUALIZATION_STATE_PATH, {
      planar: { field_overlays: seeded, layers: { ...original.layers, vectors: true } },
    });
    const before = await waitForPlanarState((planar) => planar.layers.vectors === true, "Vector mask on");
    const toggle = page
      .getByRole("toolbar", { name: "2D view tools", exact: true })
      .getByRole("button", { name: "Vectors", exact: true });
    await withPlanarPatch(page, () => toggle.click(), "Vector mask off");
    const after = await waitForPlanarState((planar) => planar.layers.vectors === false, "Vector mask off");
    assertLayerFlagsUnchanged(before.field_overlays, after.field_overlays);
    const pressed = await toggle.getAttribute("aria-pressed");
    await page.waitForFunction(() => {
      const slot = document.querySelector("[data-planar-composition-slot][aria-hidden='false']");
      if (!slot) return false;
      return [...slot.querySelectorAll("canvas[data-planar-overlay-layer='vectors']")].every((node) => {
        const evidence = JSON.parse(node.getAttribute("data-planar-overlay-rendered-evidence") ?? "null");
        return evidence !== null && (evidence.glyphCount ?? 0) === 0;
      });
    }, null, { timeout: timeoutMs });
    return toolbarCase("toolbar-vector-mask", {
      layer_flags_unchanged: true,
      toggle_pressed_after: pressed,
    }, pressed === "false");
  } finally {
    await patchJson(VISUALIZATION_STATE_PATH, {
      planar: { field_overlays: layers, layers: original.layers },
    });
  }
}

/** Scenario 7: dragging the status-bar slider commits one position on release. */
async function sectionSliderCase(page, displayPatches) {
  const original = await readPlanarState();
  const slider = page
    .getByRole("group", { name: "2D view status", exact: true })
    .getByRole("slider", { name: /^(Position|Layer) along / });
  await slider.waitFor({ state: "visible", timeout: timeoutMs });
  const thumb = await slider.boundingBox();
  const track = await slider.locator("xpath=ancestor::*[contains(@class,'fm-planar-statusbar__slider')][1]").boundingBox();
  if (!thumb || !track) throw new Error("Section slider has no measurable box");
  const startCommits = countPositionCommits(displayPatches);
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  const targetX = Math.min(track.x + track.width - 2, thumb.x + thumb.width / 2 + track.width * 0.3);
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(thumb.x + thumb.width / 2 + (targetX - thumb.x - thumb.width / 2) * (step / 10), thumb.y + thumb.height / 2);
  }
  const duringDrag = countPositionCommits(displayPatches) - startCommits;
  await page.mouse.up();
  const moved = await waitForPlanarState(
    (planar) => planar.default_slice?.position_fraction !== original.default_slice?.position_fraction,
    "Section slider commit",
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const commits = countPositionCommits(displayPatches) - startCommits;
  await setDefaultSliceViaApi("xy", 0.5, "plane_sample");
  return toolbarCase("toolbar-section-slider", {
    commits_after_release: commits,
    commits_during_drag: duringDrag,
    position_fraction: moved.default_slice.position_fraction,
  }, duringDrag === 0 && commits === 1);
}

/**
 * Scenario 8 (Review Focus 1): a session saved before field layers opens with
 * the same image. Runs when CONTROL_ROOM_PLANAR_LEGACY_FIXTURE names the JSON
 * `{ "planar": <legacy planar state> }` of the session this group restored.
 */
async function legacySessionCase(page) {
  const fixturePath = process.env.CONTROL_ROOM_PLANAR_LEGACY_FIXTURE;
  if (!fixturePath) {
    return {
      case_id: "toolbar-legacy-session-image",
      passed: false,
      reason: "CONTROL_ROOM_PLANAR_LEGACY_FIXTURE is not set; no legacy session was restored",
      required: true,
      status: "not_run",
    };
  }
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  const restored = await readPlanarState();
  const expectedIds = assertMigratedLayers(fixture.planar, restored);
  const drawnIds = drawnFieldLayers(restored).map((layer) => layer.id);
  await page.waitForFunction((ids) => {
    const slot = document.querySelector("[data-planar-composition-slot][aria-hidden='false']");
    if (!slot) return false;
    const rendered = new Set([...slot.querySelectorAll("canvas[data-planar-overlay-id]")]
      .filter((node) => node.getAttribute("data-planar-overlay-rendered-current") === "true")
      .map((node) => node.getAttribute("data-planar-overlay-id")));
    return ids.every((id) => rendered.has(id)) && rendered.size === ids.length;
  }, drawnIds, { timeout: timeoutMs });
  await page.screenshot({ fullPage: true, path: path.join(outputDir, "toolbar-legacy-session.png") });
  return toolbarCase("toolbar-legacy-session-image", {
    drawn_layer_ids: drawnIds,
    migrated_layer_ids: expectedIds,
  }, true);
}

async function runToolbarLayerScenarios(page, observedPlanarMeta, displayPatches) {
  const scenarios = [
    ["toolbar-legacy-session-image", () => legacySessionCase(page)],
    ["toolbar-six-tools", () => toolbarShapeCase(page)],
    ["toolbar-zoom-box", () => zoomBoxCase(page)],
    ["toolbar-crop-window", () => cropCase(page, observedPlanarMeta)],
    [`toolbar-inspect-node-${backend}`, () => nodeInspectCase(page)],
    ["toolbar-field-layer-list", () => fieldLayerListCase(page)],
    ["toolbar-vector-mask", () => vectorMaskCase(page)],
    ["toolbar-section-slider", () => sectionSliderCase(page, displayPatches)],
  ];
  const cases = [];
  for (const [caseId, run] of scenarios) {
    try {
      cases.push(await run());
    } catch (error) {
      cases.push({
        case_id: caseId,
        error: error instanceof Error ? error.message : String(error),
        passed: false,
        required: true,
        status: "blocked",
      });
      await page.screenshot({ fullPage: true, path: path.join(outputDir, `${caseId}-failure.png`) }).catch(() => {});
    }
  }
  return cases;
}

async function installPlanarWorkerAudit(page, baseUrl) {
  await page.addInitScript((apiUrl) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: apiUrl,
    };
    const NativeWorker = window.Worker;
    const workerAudit = { active: 0, created: 0, terminated: 0 };
    window.__FULLMAG_PLANAR_WORKER_AUDIT__ = workerAudit;
    window.Worker = class FullmagPlanarAuditedWorker extends NativeWorker {
      constructor(...args) {
        super(...args);
        const isPlanar = String(args[0]).includes("planarRendererWorker");
        if (!isPlanar) return;
        workerAudit.active += 1;
        workerAudit.created += 1;
        let terminated = false;
        const nativeTerminate = this.terminate.bind(this);
        this.terminate = () => {
          if (!terminated) {
            terminated = true;
            workerAudit.active -= 1;
            workerAudit.terminated += 1;
          }
          nativeTerminate();
        };
      }
    };
  }, baseUrl);
}

/**
 * Default-slice coordinate along the normal (note 0970,
 * eq-planar-default-layer): a plane sample on a structured FDM grid snaps to
 * the cell centre `origin + (k + 1/2) h` with `k = clamp(ceil(q N) - 1)`;
 * slabs and unstructured domains keep the requested coordinate.
 */
function expectedDefaultCoordinate(domain, axis, positionFraction, operatorKind) {
  const min = domain.bounds.min[axis];
  const continuous = min + positionFraction * (domain.bounds.max[axis] - min);
  const grid = domain.grid;
  if (domain.discretization !== "fdm" || !grid || operatorKind !== "plane_sample") {
    return continuous;
  }
  const count = grid.shape[axis];
  const scaled = positionFraction * count;
  const index = Math.min(scaled <= 0 ? 0 : Math.ceil(scaled) - 1, count - 1);
  return grid.origin[axis] + (index + 0.5) * grid.spacing[axis];
}

function expectedDefaultFrame(domain, plane, positionFraction, operatorKind = "plane_sample") {
  const min = domain.bounds.min;
  const max = domain.bounds.max;
  const lengths = max.map((value, index) => value - min[index]);
  const center = min.map((value, index) => (value + max[index]) * 0.5);
  const origin = [...center];
  if (plane === "xy") {
    origin[2] = expectedDefaultCoordinate(domain, 2, positionFraction, operatorKind);
    return {
      boundsUvM: [-0.5 * lengths[0], 0.5 * lengths[0], -0.5 * lengths[1], 0.5 * lengths[1]],
      normal: [0, 0, 1],
      origin,
      uAxis: [1, 0, 0],
      vAxis: [0, 1, 0],
      resolvedCoordinateM: origin[2],
    };
  }
  if (plane === "xz") {
    origin[1] = expectedDefaultCoordinate(domain, 1, positionFraction, operatorKind);
    return {
      boundsUvM: [-0.5 * lengths[0], 0.5 * lengths[0], -0.5 * lengths[2], 0.5 * lengths[2]],
      normal: [0, -1, 0],
      origin,
      uAxis: [1, 0, 0],
      vAxis: [0, 0, 1],
      resolvedCoordinateM: origin[1],
    };
  }
  origin[0] = expectedDefaultCoordinate(domain, 0, positionFraction, operatorKind);
  return {
    boundsUvM: [-0.5 * lengths[1], 0.5 * lengths[1], -0.5 * lengths[2], 0.5 * lengths[2]],
    normal: [1, 0, 0],
    origin,
    uAxis: [0, 1, 0],
    vAxis: [0, 0, 1],
    resolvedCoordinateM: origin[0],
  };
}

function assertDefaultMetaGeometry(meta, domain, expected) {
  if (meta.source?.kind !== "default") {
    throw new Error(`Default meta source mismatch: ${JSON.stringify(meta.source)}`);
  }
  const frame = expectedDefaultFrame(domain, expected.plane, expected.positionFraction, expected.operatorKind);
  for (const [key, value] of [
    ["origin_m", frame.origin],
    ["u_axis", frame.uAxis],
    ["v_axis", frame.vAxis],
    ["normal", frame.normal],
    ["bounds_uv_m", frame.boundsUvM],
  ]) {
    if (JSON.stringify(meta.frame?.[key]) !== JSON.stringify(value)) {
      throw new Error(`Default ${key} mismatch: ${JSON.stringify({ actual: meta.frame?.[key], expected: value })}`);
    }
  }
  if (meta.operator?.kind !== expected.operatorKind) {
    throw new Error(`Default operator mismatch: ${JSON.stringify(meta.operator)}`);
  }
  return frame;
}

async function assertDefaultEvidence(page, domain, expected, observedPlanarMeta) {
  const frame = expectedDefaultFrame(domain, expected.plane, expected.positionFraction, expected.operatorKind);
  const evidence = await assertPlanarEvidence(
    page,
    expectedDefaultEvidence(expected, frame),
    observedPlanarMeta,
  );
  const matchingMeta = await waitForObservedPlanarMeta(
    observedPlanarMeta,
    evidence,
    expectedDefaultEvidence(expected, frame),
  );
  assertDefaultMetaGeometry(matchingMeta, domain, expected);
  return evidence;
}

function expectedDefaultEvidence(expected, frame) {
  return {
    component: "magnitude",
    defaultPlane: expected.plane,
    operatorKind: expected.operatorKind,
    positionFraction: expected.positionFraction,
    quantityId: "m",
    resolvedCoordinateM: frame.resolvedCoordinateM,
    sourceId: "default",
    sourceKind: "default",
  };
}

async function setDefaultSliceViaApi(
  plane,
  positionFraction,
  operatorKind,
  thicknessM,
) {
  const operator = { kind: operatorKind };
  if (operatorKind === "slab_average") operator.thickness_m = thicknessM;
  return patchJson("/v2/sessions/current/visualization/state", {
    planar: {
      default_slice: { operator, plane, position_fraction: positionFraction },
      source: { kind: "default" },
    },
  });
}

async function waitForEmptyMonitors() {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const resource = await getJson("/v2/sessions/current/model/planar-monitors");
      if (Array.isArray(resource.monitors) && resource.monitors.length === 0) return resource;
      last = resource;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Default fixture published authored planar monitors: ${JSON.stringify(last)}`);
}

async function createAuthoredMonitor(domain, collection) {
  const min = domain.bounds.min;
  const max = domain.bounds.max;
  const lengths = max.map((value, index) => value - min[index]);
  return postJson("/v2/sessions/current/model/planar-monitors", {
    expected_scene_revision: collection.scene_revision,
    monitor: {
      frame: {
        extent: {
          kind: "explicit",
          u_max_m: 0.5 * lengths[0],
          u_min_m: -0.5 * lengths[0],
          v_max_m: 0.5 * lengths[1],
          v_min_m: -0.5 * lengths[1],
        },
        normal: [0, 0, 1],
        normalization_version: "planar_frame_v1",
        origin_m: [
          0.5 * (min[0] + max[0]),
          0.5 * (min[1] + max[1]),
          min[2] + 0.5 * lengths[2],
        ],
        preset: "xy",
        u_axis: [1, 0, 0],
        v_axis: [0, 1, 0],
      },
      id: `browser-default-equivalent-${Date.now()}`,
      name: "Default equivalent authored monitor",
      operator: { kind: "plane_sample" },
      target: { kind: "domain" },
    },
  });
}

async function capturePlanarPng(evidence, observedPlanarMeta, filename) {
  const entry = [...observedPlanarMeta].reverse().find(
    (candidate) => candidate.payload?.etag === evidence.metaIdentity,
  );
  const link = entry?.payload?.links?.render_png;
  if (!link) throw new Error(`No render_png link for ${filename}`);
  const response = await fetch(new URL(link, `${apiBase}/`).toString());
  if (!response.ok) throw new Error(`PNG export failed with HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new Error(`PNG export is not a PNG payload: ${filename}`);
  }
  await fs.writeFile(path.join(outputDir, filename), bytes);
  return {
    etag: evidence.metaIdentity,
    path: filename,
    sourceId: evidence.sourceId,
    sourceKind: evidence.sourceKind,
    size: bytes.length,
    status: "passed",
  };
}

async function captureLayerCases(page, monitor, observedPlanarMeta) {
  const definitions = [
    { id: "raster", layers: { boundaries: false, mesh: false, points: false, raster: true } },
    { id: "contours", layers: { contours: true, raster: true } },
    { id: "mesh", layers: { boundaries: true, mesh: true, points: false, raster: true } },
    { id: "boundaries", layers: { boundaries: true, raster: true } },
    { id: "bounds", layers: { bounds: true, raster: true } },
    { id: "points", layers: { points: true, raster: true } },
    { id: "vectors", layers: { boundaries: false, mesh: false, raster: true, vectors: true } },
    { id: "probes", layers: { probes: true, raster: true } },
  ];
  const cases = [];
  for (const definition of definitions) {
    const visualizationState = await selectMonitor(
      monitor.id,
      128,
      definition.layers,
    );
    await waitForCanvasPaint(page);
    const evidence = await assertPlanarEvidence(
      page,
      expectedPlanarEvidence(monitor),
      observedPlanarMeta,
    );
    if (definition.id === "probes") {
      const canvas = page.locator(".fm-field-map__canvas").first();
      const box = await canvas.boundingBox();
      if (!box) throw new Error("Probe layer canvas has no measurable bounds");
      await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
      await page.getByRole("table", { name: "Pinned planar probe" }).waitFor({
        state: "visible",
        timeout: timeoutMs,
      });
    }
    await page.screenshot({
      fullPage: true,
      path: path.join(outputDir, `layer-${definition.id}.png`),
    });
    const positiveOverlay =
      definition.id === "contours"
        ? evidence.overlayCounts.contours > 0
        : definition.id === "bounds"
          ? evidence.overlayCounts.boundsSegments === 4
          : definition.id === "points"
            ? evidence.overlayCounts.pointMarkers > 0
        : ["mesh", "boundaries"].includes(definition.id)
          ? evidence.overlayCounts.meshSegments > 0
          : definition.id === "vectors"
            ? evidence.glyphCount > 0
            : true;
    const acceptedLayers = visualizationState.planar?.layers ?? null;
    const exactLayerSelection =
      acceptedLayers != null &&
      Object.entries(definition.layers).every(
        ([layer, enabled]) => acceptedLayers[layer] === enabled,
      );
    cases.push({
      accepted_layers: acceptedLayers,
      case_id: `layer-${definition.id}`,
      evidence,
      layers: definition.layers,
      passed: positiveOverlay && exactLayerSelection,
      required: true,
      screenshot: `layer-${definition.id}.png`,
      status: positiveOverlay && exactLayerSelection ? "passed" : "blocked",
    });
  }
  return cases;
}

async function capturePlanarFramePreview(page, monitor, observedPlanarMeta) {
  if (!monitor?.name) {
    throw new Error("Cannot verify 3D frame preview without a monitor name");
  }
  await assertPlanarEvidence(
    page,
    expectedPlanarEvidence(monitor),
    observedPlanarMeta,
  );
  const monitorNode = page.getByText(monitor.name, { exact: true }).first();
  await monitorNode.scrollIntoViewIfNeeded();
  await monitorNode.click();
  const showFrame = page.getByRole("button", { name: "Show frame in 3D" });
  await showFrame.waitFor({ state: "visible", timeout: timeoutMs });
  await showFrame.click();
  const canvas = page.locator(".fm-viewport-3d canvas").first();
  await canvas.waitFor({ state: "visible", timeout: timeoutMs });
  await assertHealthyWebGL(page, "planar frame preview");
  await page.screenshot({
    fullPage: true,
    path: path.join(outputDir, "planar-frame-preview-3d.png"),
  });
  await page.keyboard.press("2");
  await assertFieldMapCanvas(page);
}

async function timedMonitorSwitch(
  page,
  monitor,
  resolution,
  screenshot,
  observedPlanarMeta,
) {
  const started = performance.now();
  await selectMonitor(monitor.id, resolution);
  await waitForCanvasPaint(page);
  const evidence = await assertPlanarEvidence(
    page,
    expectedPlanarEvidence(monitor),
    observedPlanarMeta,
  );
  const duration = performance.now() - started;
  if (duration > 10_000) {
    throw new Error(
      `${monitor.id} ${resolution}x${resolution} switch exceeded 10 s: ${duration}`,
    );
  }
  if (screenshot) await page.screenshot({ fullPage: true, path: screenshot });
  return { duration, evidence };
}

async function assertFieldMapCanvas(page) {
  await page.locator(".fm-field-map__canvas").first().waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await waitForCanvasPaint(page);
  const proof = await page.locator(".fm-field-map__canvas").first().evaluate(
    (canvas) => {
      const context = canvas.getContext("2d");
      if (!context) return { height: 0, nonTransparent: false, width: 0 };
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let nonTransparent = false;
      for (let index = 3; index < data.length; index += 4) {
        if (data[index] !== 0) {
          nonTransparent = true;
          break;
        }
      }
      return {
        height: canvas.height,
        nonTransparent,
        width: canvas.width,
      };
    },
  );
  if (proof.width <= 0 || proof.height <= 0 || !proof.nonTransparent) {
    throw new Error(`2D canvas is blank: ${JSON.stringify(proof)}`);
  }
  return proof;
}

function monitorById(monitors, monitorId) {
  const monitor = monitors.monitors.find((candidate) => candidate.id === monitorId);
  if (!monitor) throw new Error(`Missing planar monitor ${monitorId}`);
  return monitor;
}

function expectedPlanarEvidence(monitor) {
  if (typeof monitor.operator?.kind !== "string") {
    throw new Error(`Planar monitor ${monitor.id} has no operator kind`);
  }
  return {
    component: "magnitude",
    operatorKind: monitor.operator.kind,
    quantityId: "m",
    sourceId: monitor.id,
    sourceKind: "monitor",
  };
}

async function assertPlanarEvidence(page, expected, observedPlanarMeta) {
  const evidence = await page.waitForFunction(
    (request) => {
      const raw = document
        .querySelector("[aria-label='Planar field evidence']")
        ?.getAttribute("data-planar-evidence");
      if (!raw) return null;
      try {
        const evidence = JSON.parse(raw);
        if (evidence.status === "error") return evidence;
        // A layer step keeps the previous frame on screen (retained, still
        // "ready"); wait for the frame of the requested section itself.
        const sectionMatches = ["defaultPlane", "positionFraction", "resolvedCoordinateM"]
          .every((key) => request[key] === undefined || evidence[key] === request[key]);
        return evidence.status === "ready" &&
          sectionMatches &&
          evidence.sourceKind === request.sourceKind &&
          evidence.sourceId === request.sourceId &&
          evidence.operatorKind === request.operatorKind &&
          evidence.quantityId === request.quantityId &&
          evidence.component === request.component
          ? evidence
          : null;
      } catch {
        return null;
      }
    },
    expected,
    { timeout: timeoutMs },
  );
  const value = await evidence.jsonValue();
  const matchingMeta = await waitForObservedPlanarMeta(observedPlanarMeta, value, expected);
  return assertPlanarEvidenceReady(value, expected, matchingMeta);
}

async function waitForObservedPlanarMeta(observedPlanarMeta, evidence, expected) {
  const deadline = Date.now() + Math.min(timeoutMs, 10_000);
  while (Date.now() < deadline) {
    const match = [...observedPlanarMeta].reverse().find(
      (entry) =>
        entry.sourceKind === expected.sourceKind &&
        entry.sourceId === expected.sourceId &&
        entry.quantityId === expected.quantityId &&
        entry.payload?.etag === evidence.metaIdentity,
    );
    if (match) return match.payload;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No browser-consumed planar meta matched ${JSON.stringify({ evidence, expected })}`);
}

async function waitForCanvasPaint(page) {
  try {
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector(".fm-field-map__canvas");
        if (!(canvas instanceof HTMLCanvasElement)) return false;
        const context = canvas.getContext("2d");
        if (!context || canvas.width <= 0 || canvas.height <= 0) return false;
        const pixels = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        ).data;
        for (let index = 3; index < pixels.length; index += 4) {
          if (pixels[index] !== 0) return true;
        }
        return false;
      },
      undefined,
      { timeout: timeoutMs },
    );
  } catch (error) {
    const diagnostic = await page.evaluate(() => {
      const canvas = document.querySelector(".fm-field-map__canvas");
      const activeModule = document
        .querySelector("[data-slot-id='viewport-main']")
        ?.getAttribute("data-active-module-id");
      if (!(canvas instanceof HTMLCanvasElement)) {
        return {
          activeModule,
          canvas: null,
          status: document.querySelector(".fm-field-map")?.textContent,
        };
      }
      const context = canvas.getContext("2d");
      const center =
        context && canvas.width > 0 && canvas.height > 0
          ? Array.from(
              context.getImageData(
                Math.floor(canvas.width / 2),
                Math.floor(canvas.height / 2),
                1,
                1,
              ).data,
            )
          : null;
      const rect = canvas.getBoundingClientRect();
      return {
        activeModule,
        canvas: {
          center,
          cssHeight: rect.height,
          cssWidth: rect.width,
          height: canvas.height,
          width: canvas.width,
        },
        status: document.querySelector(".fm-field-map")?.textContent,
      };
    });
    throw new Error(
      `2D canvas paint timed out: ${JSON.stringify(diagnostic)}`,
      { cause: error },
    );
  }
}

async function selectMonitor(monitorId, resolution, enabledLayers = null) {
  const layers = Object.fromEntries(
    ["boundaries", "bounds", "contours", "mesh", "points", "probes", "raster", "vectors"].map(
      (layer) => [layer, enabledLayers ? Boolean(enabledLayers[layer]) : true],
    ),
  );
  return patchJson("/v2/sessions/current/visualization/state", {
    planar: {
      source: { kind: "monitor", monitor_id: monitorId },
      component: "magnitude",
      layers,
      quality: "interactive",
      quantity_id: "m",
      resolution: {
        height: resolution,
        vector_budget: 256,
        width: resolution,
      },
    },
  });
}

async function waitForMonitors() {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const resource = await getJson(
        "/v2/sessions/current/model/planar-monitors",
      );
      if (resource.monitors?.length) return resource;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Planar monitors did not become ready: ${lastError}`);
}

async function getJson(resourcePath) {
  const response = await fetch(apiBase + resourcePath);
  if (!response.ok) {
    throw new Error(`${resourcePath} failed with HTTP ${response.status}`);
  }
  return response.json();
}

async function postJson(resourcePath, body) {
  const response = await fetch(apiBase + resourcePath, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      `${resourcePath} failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return response.json();
}

async function patchJson(resourcePath, body) {
  const response = await fetch(apiBase + resourcePath, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  if (!response.ok) {
    throw new Error(
      `${resourcePath} failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return response.json();
}

async function usedHeap(page) {
  return page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
}

async function readPlanarWorkerSnapshot(page) {
  return page.evaluate(() => ({
    active: window.__FULLMAG_PLANAR_WORKER_AUDIT__?.active ?? null,
    created: window.__FULLMAG_PLANAR_WORKER_AUDIT__?.created ?? null,
    terminated: window.__FULLMAG_PLANAR_WORKER_AUDIT__?.terminated ?? null,
  }));
}

async function readScienceReport() {
  const sciencePath = path.resolve(outputDir, "..", "science-report.json");
  try {
    return JSON.parse(await fs.readFile(sciencePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read planar science report ${sciencePath}: ${String(error)}`);
  }
}

async function assertHealthyWebGL(page, phase) {
  const canvas = page.locator(".fm-viewport-3d canvas").first();
  await canvas.waitFor({ state: "visible", timeout: timeoutMs });
  const health = await canvas.evaluate((element) => {
    const context = element.getContext("webgl2") ?? element.getContext("webgl");
    return {
      drawingBufferHeight: context?.drawingBufferHeight ?? 0,
      drawingBufferWidth: context?.drawingBufferWidth ?? 0,
      isContextLost: context?.isContextLost() ?? true,
    };
  });
  if (
    health.isContextLost ||
    health.drawingBufferWidth <= 0 ||
    health.drawingBufferHeight <= 0
  ) {
    throw new Error(`3D WebGL unhealthy ${phase}: ${JSON.stringify(health)}`);
  }
  return health;
}

async function gitHead() {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"]);
  return stdout.trim();
}

async function loadPlaywright() {
  for (const packageName of ["playwright", "@playwright/test"]) {
    try {
      return await import(packageName);
    } catch {}
  }
  return null;
}

await main();
