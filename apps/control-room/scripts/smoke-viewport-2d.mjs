import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { assertPlanarEvidenceReady } from "./lib/planar-field-evidence.mjs";

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
    const open2d = page.getByRole("button", { name: "2D", exact: true });
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
    const open3d = page.getByRole("button", { name: "3D", exact: true });
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
  await installPlanarWorkerAudit(page, apiBase);

  try {
    await page.goto(workspaceUrl, {
      timeout: timeoutMs,
      waitUntil: "domcontentloaded",
    });
    const initialWebGL = await assertHealthyWebGL(page, "initial default 3D");
    const workerBaseline = await readPlanarWorkerSnapshot(page);
    const open2d = page.getByRole("button", { name: "2D", exact: true });
    await open2d.waitFor({ state: "visible", timeout: timeoutMs });
    const initialOpenStarted = performance.now();
    await open2d.click();
    const initialCanvas = await assertFieldMapCanvas(page);
    await waitForDefaultControls(page, "xy", 0.5, "plane_sample");
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

    const defaultCases = [];
    for (const [plane, positionFraction] of [
      ["xy", 0.25],
      ["xy", 0.75],
      ["xz", 0.5],
      ["yz", 0.5],
    ]) {
      await selectDefaultPlaneInUi(page, plane);
      await setDefaultSliceViaApi(plane, positionFraction, "plane_sample");
      await waitForDefaultControls(page, plane, positionFraction, "plane_sample");
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
    await page.getByLabel("Sampling", { exact: true }).selectOption("slab_average");
    await page.getByLabel("Thickness", { exact: true }).fill(String(thicknessM));
    await page.getByLabel("Thickness", { exact: true }).press("Tab");
    await setDefaultSliceViaApi("xy", 0.5, "slab_average", thicknessM);
    await waitForDefaultControls(page, "xy", 0.5, "slab_average");
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
    const monitorState = await page.getByLabel("Source", { exact: true }).inputValue();
    if (monitorState !== created.monitor.id) {
      throw new Error(`Authored monitor was not selected in Source control: ${monitorState}`);
    }

    await page.getByLabel("Source", { exact: true }).selectOption("default");
    await setDefaultSliceViaApi("xy", 0.5, "plane_sample");
    await waitForDefaultControls(page, "xy", 0.5, "plane_sample");
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
    const open3d = page.getByRole("button", { name: "3D", exact: true });
    for (let index = 0; index < switchCount; index += 1) {
      await open3d.click();
      await assertHealthyWebGL(page, `Default lifecycle cycle ${index + 1}`);
      await open2d.click();
      await assertFieldMapCanvas(page);
      await setDefaultSliceViaApi("xy", 0.5, "plane_sample");
      await waitForDefaultControls(page, "xy", 0.5, "plane_sample");
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

function expectedDefaultFrame(domain, plane, positionFraction) {
  const min = domain.bounds.min;
  const max = domain.bounds.max;
  const lengths = max.map((value, index) => value - min[index]);
  const center = min.map((value, index) => (value + max[index]) * 0.5);
  const origin = [...center];
  if (plane === "xy") {
    origin[2] = min[2] + positionFraction * lengths[2];
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
    origin[1] = min[1] + positionFraction * lengths[1];
    return {
      boundsUvM: [-0.5 * lengths[0], 0.5 * lengths[0], -0.5 * lengths[2], 0.5 * lengths[2]],
      normal: [0, -1, 0],
      origin,
      uAxis: [1, 0, 0],
      vAxis: [0, 0, 1],
      resolvedCoordinateM: origin[1],
    };
  }
  origin[0] = min[0] + positionFraction * lengths[0];
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
  const frame = expectedDefaultFrame(domain, expected.plane, expected.positionFraction);
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
  const frame = expectedDefaultFrame(domain, expected.plane, expected.positionFraction);
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

async function waitForDefaultControls(page, plane, positionFraction, operatorKind) {
  await page.waitForFunction(
    (expected) => {
      const source = document.querySelector('[aria-label="Source"]');
      const position = document.querySelector('[aria-label="Position"]');
      const sampling = document.querySelector('[aria-label="Sampling"]');
      const plane = document.querySelector(
        `[data-slot="segmented-control-item"][data-value="${expected.plane}"]`,
      );
      return source instanceof HTMLSelectElement &&
        source.value === "default" &&
        position instanceof HTMLInputElement &&
        Math.abs(Number(position.value) - expected.positionFraction) < 1e-9 &&
        sampling instanceof HTMLSelectElement &&
        sampling.value === expected.operatorKind &&
        plane?.getAttribute("data-state") === "checked";
    },
    { plane, positionFraction, operatorKind },
    { timeout: timeoutMs },
  );
}

async function selectDefaultPlaneInUi(page, plane) {
  const button = page.locator(
    `[data-slot="segmented-control-item"][data-value="${plane}"]`,
  );
  await button.waitFor({ state: "visible", timeout: timeoutMs });
  await button.click();
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
    { id: "raster", layers: { raster: true } },
    { id: "contours", layers: { contours: true, raster: true } },
    { id: "mesh", layers: { mesh: true, raster: true } },
    { id: "boundaries", layers: { boundaries: true, raster: true } },
    { id: "bounds", layers: { bounds: true, raster: true } },
    { id: "points", layers: { points: true, raster: true } },
    { id: "vectors", layers: { raster: true, vectors: true } },
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
        return evidence.status === "ready" &&
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
