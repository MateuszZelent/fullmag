import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const configuredUrl = process.env.CONTROL_ROOM_URL;
const artifactDirectory = path.resolve(
  process.env.CONTROL_ROOM_AUDIT_ARTIFACTS_DIR ??
    ".artifacts/airbox-vector-cold-toggle",
);
const trials = Math.max(1, Number(process.env.CONTROL_ROOM_AUDIT_TRIALS ?? 20));
const lanes = ["fdm-single-grid", "fdm-multilayer", "fem"];

if (!configuredUrl) {
  throw new Error(
    "CONTROL_ROOM_URL is required; this qualification never starts or stops an external dev server.",
  );
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    return await import("@playwright/test");
  }
}

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  throw new Error("Playwright/Chromium is required for Airbox qualification.");
}

await mkdir(artifactDirectory, { recursive: true });
const browser = await playwright.chromium.launch({
  args: ["--js-flags=--expose-gc"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const responseSamples = [];
page.on("response", async (response) => {
  if (!response.url().includes("/data/fields/")) return;
  const headers = response.headers();
  const contentLength = Number(headers["content-length"] ?? 0);
  responseSamples.push({
    bytes: Number.isFinite(contentLength) ? contentLength : 0,
    status: response.status(),
    url: response.url(),
  });
});

const metrics = [];
try {
  await page.goto(configuredUrl, { waitUntil: "domcontentloaded" });
  const canvas = page.locator(".fm-viewport-3d canvas");
  await canvas.waitFor({ state: "visible", timeout: 20_000 });
  await assertWebgl(canvas);

  for (const lane of lanes) {
    for (let trial = 0; trial < trials; trial += 1) {
      if (trial > 0 && trial % 5 === 0) {
        await page.reload({ waitUntil: "domcontentloaded" });
        await canvas.waitFor({ state: "visible", timeout: 20_000 });
      }
      const warm = trial > 0;
      const before = responseSamples.length;
      const start = await page.evaluate(() => performance.now());
      await page.evaluate((selectedLane) => {
        const hook = window.__FULLMAG_CONTROL_ROOM_AUDIT__;
        hook?.setActiveViewportModule("viewport-3d");
        hook?.setGlobalQuantity(
          selectedLane === "fem" ? "m" : "H_demag",
        );
      }, lane);
      await page.waitForTimeout(100);
      const sample = await page.evaluate(({ startTime, warmRun }) => {
        const canvas = document.querySelector(".fm-viewport-3d canvas");
        const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
        const runtime = window.__FULLMAG_CONTROL_ROOM_AUDIT__?.readViewportAuditRuntime?.() ?? null;
        const longTasks = performance
          .getEntriesByType("longtask")
          .filter((entry) => entry.startTime >= startTime)
          .map((entry) => entry.duration);
        return {
          decodeMs: runtime?.diagnostics?.decodeMs ?? null,
          dirtyFrames: runtime?.diagnostics?.dirtyFrames ?? null,
          drawCalls: runtime?.gpu?.drawCalls ?? null,
          firstGlyphMs: performance.now() - startTime,
          gpuUploadMs: runtime?.diagnostics?.gpuUploadMs ?? null,
          heapBytes: performance.memory?.usedJSHeapSize ?? null,
          longTasksMs: longTasks,
          pointCount: runtime?.diagnostics?.pointCount ?? null,
          requestMs: performance.now() - startTime,
          webgl: gl
            ? {
                drawingBufferHeight: gl.drawingBufferHeight,
                drawingBufferWidth: gl.drawingBufferWidth,
                contextLost: gl.isContextLost(),
              }
            : null,
          warm: warmRun,
          workerMs: runtime?.diagnostics?.workerMs ?? null,
        };
      }, { startTime: start, warmRun: warm });
      metrics.push({
        ...sample,
        bytes: responseSamples.slice(before).reduce((sum, item) => sum + item.bytes, 0),
        lane,
        trial,
      });
      if (sample.webgl?.contextLost || sample.webgl?.drawingBufferWidth === 0 || sample.webgl?.drawingBufferHeight === 0) {
        throw new Error(`WebGL qualification failed for ${lane} trial ${trial}.`);
      }
    }
  }
} finally {
  await browser.close();
}

const report = {
  generatedAt: new Date().toISOString(),
  lanes,
  trials,
  metrics: metrics.map((sample) => ({
    ...sample,
    longTaskCount: sample.longTasksMs.length,
    longTaskTotalMs: sample.longTasksMs.reduce((sum, value) => sum + value, 0),
  })),
  summary: Object.fromEntries(
    lanes.map((lane) => [
      lane,
      summarize(metrics.filter((sample) => sample.lane === lane)),
    ]),
  ),
};
const outputPath = path.join(artifactDirectory, "airbox-vector-cold-toggle.json");
await writeFile(outputPath, JSON.stringify(report, null, 2));
console.log(`Airbox vector qualification report: ${outputPath}`);

function summarize(samples) {
  const numeric = (field) =>
    samples
      .map((sample) => sample[field])
      .filter((value) => typeof value === "number" && Number.isFinite(value));
  return {
    cold: summarizeSamples(samples.filter((sample) => !sample.warm), numeric),
    warm: summarizeSamples(samples.filter((sample) => sample.warm), numeric),
  };
}

function summarizeSamples(samples, numeric) {
  const values = numeric("firstGlyphMs").filter((value, index) => samples[index]);
  return values.length === 0
    ? { count: 0, p50: null, p95: null }
    : { count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

async function assertWebgl(canvas) {
  const status = await canvas.evaluate((element) => {
    const gl = element.getContext("webgl2") ?? element.getContext("webgl");
    return gl
      ? {
          contextLost: gl.isContextLost(),
          drawingBufferHeight: gl.drawingBufferHeight,
          drawingBufferWidth: gl.drawingBufferWidth,
        }
      : null;
  });
  if (!status || status.contextLost || status.drawingBufferWidth <= 0 || status.drawingBufferHeight <= 0) {
    throw new Error(`Initial WebGL qualification failed: ${JSON.stringify(status)}`);
  }
}
