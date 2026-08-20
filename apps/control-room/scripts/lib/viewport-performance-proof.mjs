import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const VIEWPORT_PERFORMANCE_REASON_LIMIT = 64;

const NUMERIC_COUNTER_KEYS = Object.freeze([
  "cacheEvictions", "cacheHits", "cacheMisses", "fieldDecodes", "fieldSwaps",
  "geometriesCreated", "geometriesDisposed", "gpuUploadBytes", "gpuUploads",
  "materialsCreated", "materialsDisposed", "topologyBuilds", "topologyUploads",
  "typedArrayCopiedBytes", "viewportFrames", "workerJobs",
]);

export function createViewportPerformanceProbeCounters() {
  return { publishes: 0, scans: 0, viewportFrames: 0 };
}

export async function installViewportPerformanceProbe(page) {
  await page.addInitScript(() => {
    window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__ = {
      publishes: 0,
      scans: 0,
      viewportFrames: 0,
    };
  });
}

export async function captureViewportPerformanceSnapshot(page, label) {
  const counters = await page.evaluate(() =>
    window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__ ?? {
      publishes: 0,
      scans: 0,
      viewportFrames: 0,
    },
  );
  return serializeViewportPerformanceSnapshot(counters, label);
}

export function serializeViewportPerformanceSnapshot(counters, label) {
  const rawReasons = Object.entries(counters?.viewportFrameReasons ?? {})
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  const retainedReasons = rawReasons.slice(0, VIEWPORT_PERFORMANCE_REASON_LIMIT);
  const droppedReasons = rawReasons.slice(VIEWPORT_PERFORMANCE_REASON_LIMIT);
  const droppedFrameReasons = droppedReasons.reduce(
    (total, [, count]) => total + count,
    Number(counters?.viewportFrameReasonsDropped ?? 0),
  );

  return {
    counters: {
      ...Object.fromEntries(
        NUMERIC_COUNTER_KEYS.map((key) => [key, finiteCounter(counters?.[key])]),
      ),
      viewportFrameReasons: Object.fromEntries(retainedReasons),
      viewportFrameReasonsDropped: droppedFrameReasons,
      viewportFrameReasonsOverflowed:
        Boolean(counters?.viewportFrameReasonsOverflowed) || droppedReasons.length > 0,
    },
    label,
    schemaVersion: 1,
  };
}

export function assertViewportPerformanceTrace(trace) {
  if (!Array.isArray(trace) || trace.length < 2) {
    throw new Error("Viewport performance proof requires at least two raw snapshots.");
  }
  const labels = new Set();
  for (const snapshot of trace) {
    assertViewportPerformanceSnapshot(snapshot);
    if (labels.has(snapshot.label)) {
      throw new Error(`Viewport performance trace contains duplicate label: ${snapshot.label}.`);
    }
    labels.add(snapshot.label);
  }
}

export function assertQuantitySwitchPerformanceDelta({
  after,
  before,
  fieldGetsAfter,
  fieldGetsBefore,
  maxFieldDecodes,
  maxFieldGets,
  maxFieldSwaps,
  plan,
}) {
  const delta = viewportPerformanceDelta(before, after);
  const fieldGets = nonNegativeDelta(fieldGetsBefore, fieldGetsAfter, "field GETs");
  assertAtMost(delta.topologyBuilds, 0, "quantity switch topology builds");
  assertAtMost(fieldGets, maxFieldGets, `${plan} quantity switch field GETs`);
  assertAtMost(delta.fieldDecodes, maxFieldDecodes, `${plan} quantity switch field decodes`);
  assertAtMost(delta.fieldSwaps, maxFieldSwaps, `${plan} quantity switch field swaps`);
  return { ...delta, fieldGets };
}

export function assertOrbitPerformanceDelta({
  acknowledgementsAfter,
  acknowledgementsBefore,
  after,
  before,
  fieldGetsAfter,
  fieldGetsBefore,
}) {
  const delta = viewportPerformanceDelta(before, after);
  const fieldGets = nonNegativeDelta(fieldGetsBefore, fieldGetsAfter, "field GETs");
  const acknowledgements = nonNegativeDelta(
    acknowledgementsBefore,
    acknowledgementsAfter,
    "visualization acknowledgements",
  );
  assertAtMost(fieldGets, 0, "orbit field GETs");
  assertAtMost(delta.fieldDecodes, 0, "orbit field decodes");
  assertAtMost(delta.topologyBuilds, 0, "orbit topology builds");
  assertAtMost(acknowledgements, 0, "orbit visualization acknowledgements");
  return { ...delta, acknowledgements, fieldGets };
}

export function assertNoSettledR3FFrames(before, after, settledWindowMs) {
  const delta = viewportPerformanceDelta(before, after).viewportFrames;
  if (delta !== 0) {
    throw new Error(
      `Viewport rendered ${delta} R3F frame(s) during the ${settledWindowMs}ms settled window.`,
    );
  }
}

export async function writeViewportOrbitPerformanceArtifact({
  artifactDirectory,
  delta,
  rawPerformanceTrace,
}) {
  const artifact = {
    delta,
    gate: { id: "camera-orbit-locality", passed: true },
    rawPerformanceTrace,
    schemaVersion: "fullmag.viewport-orbit-performance-proof.v1",
  };
  validateViewportOrbitPerformanceArtifact(artifact);
  const outputPath = join(
    artifactDirectory,
    "viewport-3d-camera-orbit-performance-proof.json",
  );
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`);
  await rename(temporaryPath, outputPath);
  await assertViewportOrbitPerformanceArtifactFile(outputPath);
  return outputPath;
}

export async function assertViewportOrbitPerformanceArtifactFile(path) {
  const artifact = JSON.parse(await readFile(path, "utf8"));
  validateViewportOrbitPerformanceArtifact(artifact);
  return artifact;
}

export function validateViewportOrbitPerformanceArtifact(artifact) {
  if (
    !artifact ||
    artifact.schemaVersion !== "fullmag.viewport-orbit-performance-proof.v1" ||
    artifact.gate?.id !== "camera-orbit-locality" ||
    artifact.gate?.passed !== true
  ) {
    throw new Error("Viewport orbit proof requires a passing gate artifact.");
  }
  assertViewportPerformanceTrace(artifact.rawPerformanceTrace);
  if (artifact.rawPerformanceTrace.length !== 2) {
    throw new Error("Viewport orbit proof requires exactly one before/after raw trace.");
  }
  const [before, after] = artifact.rawPerformanceTrace;
  if (
    before.label !== "camera-orbit-before" ||
    after.label !== "camera-orbit-after"
  ) {
    throw new Error("Viewport orbit proof requires labeled before/after raw snapshots.");
  }
  const expectedDelta = assertOrbitPerformanceDelta({
    acknowledgementsAfter: artifact.delta?.acknowledgements,
    acknowledgementsBefore: 0,
    after,
    before,
    fieldGetsAfter: artifact.delta?.fieldGets,
    fieldGetsBefore: 0,
  });
  for (const [key, value] of Object.entries(expectedDelta)) {
    if (artifact.delta?.[key] !== value) {
      throw new Error(`Viewport orbit proof delta mismatch for ${key}.`);
    }
  }
}

export function viewportPerformanceDelta(before, after) {
  assertViewportPerformanceSnapshot(before);
  assertViewportPerformanceSnapshot(after);
  return Object.fromEntries(
    NUMERIC_COUNTER_KEYS.map((key) => [
      key,
      nonNegativeDelta(before.counters[key], after.counters[key], key),
    ]),
  );
}

function assertViewportPerformanceSnapshot(snapshot) {
  if (
    !snapshot ||
    snapshot.schemaVersion !== 1 ||
    typeof snapshot.label !== "string" ||
    snapshot.label.length === 0 ||
    !snapshot.counters ||
    typeof snapshot.counters !== "object"
  ) {
    throw new Error("Viewport performance proof requires serialized raw snapshots.");
  }
  for (const key of NUMERIC_COUNTER_KEYS) {
    if (!Number.isFinite(snapshot.counters[key]) || snapshot.counters[key] < 0) {
      throw new Error(`Viewport performance snapshot has invalid ${key}.`);
    }
  }
}

function assertAtMost(actual, maximum, label) {
  if (!Number.isFinite(maximum) || maximum < 0 || actual > maximum) {
    throw new Error(`${label} exceeded budget: actual=${actual} maximum=${maximum}.`);
  }
}

function finiteCounter(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function nonNegativeDelta(before, after, label) {
  const delta = after - before;
  if (!Number.isFinite(delta) || delta < 0) {
    throw new Error(`Viewport performance counter regressed for ${label}.`);
  }
  return delta;
}
