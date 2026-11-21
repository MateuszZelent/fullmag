export const REACT_RENDER_PROFILE_MEASURE_PREFIX = "fullmag.react.render.";

const REACT_RENDER_PROFILE_STORAGE_KEY = "fullmag:react-profiler";

const MIN_REACT_RENDER_MEASURE_INTERVAL_MS = 1_000;

const lastReactRenderMeasureAtByName = new Map<string, number>();

interface ReactRenderProfilerOptions {
  explicitFlag?: unknown;
  locationSearch?: string;
  storageValue?: string | null;
}

interface ReactRenderMeasureTarget {
  measure(name: string, options: PerformanceMeasureOptions): PerformanceMeasure;
}

interface RecordReactRenderMeasureOptions {
  actualDuration: number;
  id: string;
  performanceTarget?: ReactRenderMeasureTarget | null;
  phase: string;
  startTime: number;
}

export function shouldEnableReactRenderProfiler({
  explicitFlag = defaultReactProfilerFlag(),
  locationSearch = defaultLocationSearch(),
  storageValue = defaultStorageValue(),
}: ReactRenderProfilerOptions = {}): boolean {
  if (explicitFlag === true) return true;
  if (storageValue === "1") return true;

  if (!locationSearch) return false;
  try {
    return new URLSearchParams(locationSearch).get("fullmagReactProfiler") === "1";
  } catch {
    return false;
  }
}

export function recordReactRenderMeasure({
  actualDuration,
  id,
  performanceTarget = defaultPerformanceTarget(),
  phase,
  startTime,
}: RecordReactRenderMeasureOptions): void {
  if (!performanceTarget) return;
  if (!Number.isFinite(actualDuration) || actualDuration < 0) return;
  if (!Number.isFinite(startTime) || startTime < 0) return;
  const measureName = `${REACT_RENDER_PROFILE_MEASURE_PREFIX}${id}.${phase}`;
  if (!shouldRecordReactRenderMeasure(measureName, startTime)) return;

  try {
    performanceTarget.measure(
      measureName,
      {
        duration: actualDuration,
        start: startTime,
      },
    );
  } catch {
    // User Timing support varies across embedded browser environments.
  }
}

function shouldRecordReactRenderMeasure(name: string, startTime: number): boolean {
  const last = lastReactRenderMeasureAtByName.get(name);
  if (
    last !== undefined &&
    startTime - last < MIN_REACT_RENDER_MEASURE_INTERVAL_MS
  ) {
    return false;
  }

  lastReactRenderMeasureAtByName.set(name, startTime);
  return true;
}

function defaultReactProfilerFlag(): unknown {
  return typeof window === "undefined" ? undefined : window.__FULLMAG_REACT_PROFILER__;
}

function defaultLocationSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

function defaultStorageValue(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(REACT_RENDER_PROFILE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function defaultPerformanceTarget(): ReactRenderMeasureTarget | null {
  return typeof performance === "undefined" ? null : performance;
}
