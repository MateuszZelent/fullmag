export const CHART_PERFORMANCE_PROOF_VERSION = 2;

const STRING_PATHS = [
  "schema",
  "recordedAt",
  "build.commit",
  "build.diffFingerprint",
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
  "build.dirty",
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

  if (
    value.transport.cacheMeasurement !== "NOT_MEASURED" ||
    value.transport.cacheHits !== null ||
    value.transport.cacheMisses !== null
  ) {
    throw invalid(
      "transport.cacheMeasurement",
      '"NOT_MEASURED" with null cacheHits/cacheMisses',
    );
  }

  const phase = readPath(value, "scenario.phase");
  if (phase !== "cold" && phase !== "warm") {
    throw invalid("scenario.phase", '"cold" or "warm"');
  }

  if (value.scenario.sessionAbort) {
    const sourceRevision = value.cancellation.sourceRevision;
    const latestRevision = value.cancellation.latestRevision;
    if (
      typeof sourceRevision !== "number" ||
      !Number.isFinite(sourceRevision) ||
      typeof latestRevision !== "number" ||
      !Number.isFinite(latestRevision) ||
      latestRevision <= sourceRevision
    ) {
      throw invalid(
        "cancellation.latestRevision",
        "a finite revision newer than cancellation.sourceRevision",
      );
    }
    if (value.cancellation.staleRevisionVisible !== false) {
      throw invalid("cancellation.staleRevisionVisible", "false");
    }
    if (value.cancellation.staleValuesAdopted !== false) {
      throw invalid("cancellation.staleValuesAdopted", "false");
    }
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
