export const CHART_PERFORMANCE_PROOF_VERSION = 1;

const STRING_PATHS = [
  "schema",
  "recordedAt",
  "build.commit",
  "build.mode",
  "browser.name",
  "browser.version",
  "dataset.fixture",
  "dataset.checksum",
  "dataset.size",
  "scenario.id",
];

const NUMBER_PATHS = [
  "dataset.rows",
  "dataset.series",
  "scenario.iteration",
  "timing.samples",
  "timing.p50Ms",
  "timing.p95Ms",
  "timing.longTasks",
  "transport.requests",
  "transport.payloadBytes",
  "transport.cacheHits",
  "transport.cacheMisses",
  "transport.cancelledRequests",
  "chart.modelBuilds",
  "chart.plannedPoints",
  "chart.renderedPoints",
  "chart.setOptionCalls",
  "chart.redraws",
  "chart.activeInstances",
  "chart.createdInstances",
  "chart.disposedInstances",
  "lifecycle.listeners",
  "lifecycle.observers",
  "lifecycle.workers",
  "memory.baselineHeapBytes",
  "memory.peakHeapBytes",
  "memory.retainedHeapBytes",
  "viewport3d.dirtyFrames",
  "viewport3d.fieldRequests",
  "viewport3d.topologyRequests",
  "viewport3d.unchangedBufferUploads",
  "viewport3d.drawingBufferWidth",
  "viewport3d.drawingBufferHeight",
  "viewport3d.webglBufferDelta",
];

const BOOLEAN_PATHS = [
  "scenario.sessionAbort",
  "viewport3d.mounted",
  "viewport3d.contextLost",
  "cancellation.requested",
  "cancellation.completed",
  "cancellation.adoptedAfterAbort",
];

export function assertChartPerformanceProof(value) {
  if (!isRecord(value)) {
    throw new TypeError("ChartPerformanceProof must be an object.");
  }
  if (value.schema !== "fullmag.chart-performance-proof") {
    throw invalid("schema", "fullmag.chart-performance-proof");
  }
  if (value.version !== CHART_PERFORMANCE_PROOF_VERSION) {
    throw invalid("version", CHART_PERFORMANCE_PROOF_VERSION);
  }

  for (const path of STRING_PATHS) {
    const field = readPath(value, path);
    if (typeof field !== "string" || field.length === 0) {
      throw invalid(path, "a non-empty string");
    }
  }
  if (!Number.isFinite(Date.parse(value.recordedAt))) {
    throw invalid("recordedAt", "an ISO timestamp");
  }

  for (const path of NUMBER_PATHS) {
    const field = readPath(value, path);
    if (typeof field !== "number" || !Number.isFinite(field) || field < 0) {
      throw invalid(path, "a measured finite non-negative number");
    }
  }

  for (const path of BOOLEAN_PATHS) {
    if (typeof readPath(value, path) !== "boolean") {
      throw invalid(path, "a boolean");
    }
  }

  const phase = readPath(value, "scenario.phase");
  if (phase !== "cold" && phase !== "warm") {
    throw invalid("scenario.phase", '"cold" or "warm"');
  }

  return value;
}

function readPath(value, path) {
  return path.split(".").reduce(
    (current, key) => (isRecord(current) ? current[key] : undefined),
    value,
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(path, expectation) {
  return new TypeError(
    `Invalid ChartPerformanceProof field ${path}; expected ${expectation}.`,
  );
}
