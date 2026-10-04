import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { chromium } from "playwright";

const url = new URL(process.env.CONTROL_ROOM_URL ?? "http://localhost:3197/workspace");
const storageRoot = process.env.FULLMAG_PROJECT_STORAGE_ROOT;
const output = process.env.FULLMAG_START_COMPUTE_REPORT_DIR;
assert.ok(storageRoot && isAbsolute(storageRoot) && output && isAbsolute(output),
  "Absolute managed storage and compute report paths are required.");
const reportRoot = resolve(output);
const descendant = relative(resolve(storageRoot), reportRoot);
assert.ok(descendant && descendant !== ".." && !descendant.startsWith(`..${sep}`) && !isAbsolute(descendant),
  "Compute reports must stay below project storage.");

const checks = [];
const errors = [];
const evidence = {};
const sourcePaths = [
  "modules/start/StartScreen.tsx", "modules/start/model/types.ts", "modules/start/model/useComputeProbe.ts",
  "modules/start/model/computeTelemetry.ts", "modules/start/model/continueModel.ts", "modules/start/model/templates.ts",
  "modules/start/model/diagnostics.ts", "modules/start/ui/StartStatusBar.tsx", "modules/start/rail/StartRail.tsx",
  "modules/start/rail/ComputeEnvironmentWidget.tsx", "modules/start/sections/SettingsSection.tsx",
  "modules/start/sections/ComputeEnvironmentSettings.tsx", "design/styles/components/index.css",
  "design/styles/start-compute.css", "design/styles/start-screen.css",
];
const source = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  files: await Promise.all(sourcePaths.map(async (path) => ({
    path, sha256: createHash("sha256").update(await readFile(new URL(`../src/${path}`, import.meta.url))).digest("hex"),
  }))),
};
const check = (name, assertion) => { assertion(); checks.push(name); };
const cpu = {
  status: "available", sample_time_unix_ms: 1, logical_cpus: 24, model_name: "Fixture CPU",
  utilization_cpu_percent: 25, process_cpu_percent: 5, memory_used_mb: 16384,
  memory_total_mb: 65536, process_rss_mb: 100, process_threads: 24,
};
const gpu = {
  status: "available", sample_time_unix_ms: 1,
  devices: [0, 1].map((index) => ({
    index, name: `Fixture GPU ${index}`, memory_total_mb: 24576, memory_used_mb: 6144,
    utilization_gpu_percent: 12, utilization_memory_percent: 20, temperature_c: 45,
  })),
};
const engine = (backend, device, status, precision = "fp64") => ({
  backend, device, status, precision, mode: "strict", public: true, stability: "production",
  runtime_family: "fixture", runtime_version: "1", worker: "fixture",
  ...(status === "available" ? {} : { status_reason: "Fixture runtime is unavailable." }),
});
const capabilities = { profile_version: "fixture", engines: [
  engine("fdm", "cpu", "available"), engine("fdm", "cpu", "available", "fp32"),
  engine("fdm", "gpu", "missing_library"), engine("fem", "cpu", "available"),
  engine("fem", "gpu", "missing_driver"),
  { ...engine("fem", "gpu", "available"), public: false },
] };

await mkdir(reportRoot, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
let failure;
try {
  const liveContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const health = await liveContext.request.get(new URL("/v2/platform/health", url).href);
  const pin = health.headers()["x-fullmag-api-instance"];
  if (pin) url.searchParams.set("fullmag_api_instance", pin);
  const livePage = await liveContext.newPage();
  livePage.on("pageerror", (error) => errors.push(error.message));
  await livePage.goto(url.href, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const liveWidget = livePage.locator("[data-compute-environment]");
  await liveWidget.waitFor({ state: "visible", timeout: 60_000 });
  await liveWidget.locator(".fm-start-env__cpu").waitFor({ state: "visible" });
  evidence.live = await liveWidget.innerText();
  check("runtime inventory is available without opening a session", () => {
    assert.match(evidence.live, /CPU/);
    assert.doesNotMatch(evidence.live, /40×|CPU fallback/);
  });
  await livePage.getByRole("button", { name: "Configure compute", exact: true }).click();
  await livePage.locator("[data-compute-settings]").waitFor({ state: "visible" });
  evidence.liveSettings = await livePage.locator("[data-compute-settings]").innerText();
  for (const theme of ["dark", "light"]) {
    await livePage.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
    await livePage.screenshot({ path: resolve(reportRoot, `compute-live-${theme}.png`), fullPage: true });
  }
  await liveContext.close();

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let mode = "gpu";
  let sample = 2;
  let requests = 0;
  const held = [];
  await context.route(/\/v2\/(sessions\/current\/diagnostics\/(cpu|gpu)|platform\/capabilities)(\?|$)/,
    async (route) => {
      requests++;
      if (mode === "hold") await new Promise((resolveHeld) => held.push(resolveHeld));
      const path = new URL(route.request().url()).pathname;
      if (mode === "error") {
        await route.fulfill({ status: 503, headers: { "x-api-contract-version": "1.0.0",
          ...(pin ? { "x-fullmag-api-instance": pin } : {}) },
        contentType: "application/json", body: JSON.stringify({ error: "fixture_failure", message: "Fixture unavailable." }) });
        return;
      }
      const body = path.endsWith("capabilities") ? capabilities : path.endsWith("cpu")
        ? mode === "unavailable" ? { ...cpu, status: "unavailable", memory_total_mb: 0,
          memory_used_mb: 0, utilization_cpu_percent: 0 } : { ...cpu, sample_time_unix_ms: sample }
        : mode === "cpu" ? { ...gpu, sample_time_unix_ms: sample, devices: [] }
          : mode === "unavailable" ? { ...gpu, status: "unavailable", devices: [], reason: "Fixture unavailable." }
            : { ...gpu, sample_time_unix_ms: sample };
      await route.fulfill({ status: 200, contentType: "application/json", headers: {
        "x-api-contract-version": "1.0.0", ...(pin ? { "x-fullmag-api-instance": pin } : {}),
      }, body: JSON.stringify(body) });
    });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(30_000);
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const widget = page.locator("[data-compute-environment]");
  await widget.getByText(/GPU 1: Fixture GPU 1/).waitFor();
  check("every detected GPU is visible in the rail", () => {});
  await page.getByRole("button", { name: "Configure compute", exact: true }).click();
  const settings = page.locator("[data-compute-settings]");
  await settings.getByText("Fixture CPU", { exact: true }).waitFor();
  await settings.getByText("Fixture GPU 1", { exact: true }).waitFor();
  evidence.multipleGpu = await settings.innerText();
  const meters = await settings.getByRole("meter").evaluateAll((nodes) => nodes.map((node) => ({
    value: Number(node.getAttribute("aria-valuenow")), label: node.getAttribute("aria-label"),
  })));
  check("memory meters carry bounded, named readings", () => {
    assert.ok(meters.length >= 2);
    assert.ok(meters.every((meter) => meter.label && meter.value >= 0 && meter.value <= 100));
  });
  check("registered lanes do not equate GPU detection with solver readiness", () => {
    assert.match(evidence.multipleGpu, /FDM/);
    assert.match(evidence.multipleGpu, /FEM/);
    assert.match(evidence.multipleGpu, /fp32/);
    assert.match(evidence.multipleGpu, /Fixture runtime is unavailable/);
  });
  await page.evaluate(() => { window.__computeSettingsRoot = document.querySelector("[data-compute-settings]"); });
  const refresh = settings.getByRole("button", { name: /^Refresh(?:ing)? compute environment$/ });
  mode = "hold";
  await refresh.click();
  await page.waitForFunction(() => document.querySelector('[data-compute-settings] button[aria-label^="Refresh"]')?.disabled);
  assert.equal(await settings.getByText("Fixture GPU 1", { exact: true }).isVisible(), true);
  check("refresh retains the inventory and stable panel", () => {});
  mode = "error";
  for (const release of held.splice(0)) release();
  await settings.getByText(/Could not refresh the host readings/).waitFor();
  await refresh.waitFor({ state: "visible" });
  assert.equal(await refresh.isEnabled(), true);
  assert.equal(await settings.getByText("Fixture GPU 1", { exact: true }).isVisible(), true);
  assert.equal(await page.evaluate(() => window.__computeSettingsRoot === document.querySelector("[data-compute-settings]")), true);
  check("failed refresh retains readings and offers recovery", () => {});
  mode = "cpu";
  sample++;
  await refresh.click();
  await widget.getByText("No GPU detected", { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector("[data-compute-environment]")?.textContent.includes("Fixture GPU"));
  check("confirmed CPU inventory replaces previous GPU data", () => {});
  mode = "unavailable";
  sample++;
  await refresh.click();
  await widget.getByText("GPU telemetry unavailable", { exact: true }).waitFor();
  evidence.unavailable = await settings.innerText();
  check("unavailable telemetry is not a missing GPU or a zero measurement", () => {
    assert.doesNotMatch(evidence.unavailable, /No GPU detected|0(?:\.0)?\s*(?:%|GiB|GB)/);
  });
  mode = "gpu";
  sample++;
  await refresh.click();
  await widget.getByText(/GPU 1: Fixture GPU 1/).waitFor();
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
    for (const width of [1440, 860, 600]) {
      await page.setViewportSize({ width, height: 1000 });
      const bounds = await widget.evaluate((node) => ({
        scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
        width: node.getBoundingClientRect().width,
      }));
      assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1, `Widget overflows at ${width}px (${theme})`);
      assert.ok(bounds.width > 0);
      await page.screenshot({ path: resolve(reportRoot, `compute-fixture-${theme}-${width}.png`), fullPage: true });
    }
  }
  check("both themes fit desktop and narrow layouts", () => {});
  await page.setViewportSize({ width: 1440, height: 1000 });
  const beforePoll = requests;
  await page.waitForTimeout(6000);
  assert.ok(requests > beforePoll, "Visible inventory must update");
  await page.goto("about:blank");
  const afterUnmount = requests;
  await page.waitForTimeout(6000);
  assert.equal(requests, afterUnmount, "Sampling must stop when the screen unmounts");
  check("sampling is live and stops after unmount", () => {});
  assert.deepEqual(errors, [], "Unexpected browser errors");
  await context.close();
} catch (error) {
  failure = error;
} finally {
  await browser.close();
  await writeFile(resolve(reportRoot, "compute-environment.json"), JSON.stringify({
    schema: "fullmag.start-compute.browser.v1", url: url.href, capturedAt: new Date().toISOString(),
    status: failure ? "failed" : "passed", source, checks, errors, evidence,
    ...(failure ? { failure: String(failure.stack ?? failure) } : {}),
  }, null, 2));
}
if (failure) throw failure;
console.log(`Compute environment: ${checks.length} browser checks passed. Report: ${reportRoot}`);
