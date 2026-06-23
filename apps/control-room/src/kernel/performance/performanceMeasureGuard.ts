"use client";

type PerformanceMeasureFn = (
  measureName: string,
  startOrMeasureOptions?: string | PerformanceMeasureOptions,
  endMark?: string,
) => PerformanceMeasure;

interface PerformanceMeasureTarget {
  measure: PerformanceMeasureFn;
}

const FULLMAG_MEASURE_GUARD = Symbol.for("fullmag.performance.measure.guard");

type GuardedPerformanceMeasureFn = PerformanceMeasureFn & {
  [FULLMAG_MEASURE_GUARD]?: true;
};

export function installPerformanceMeasureGuard(
  target: PerformanceMeasureTarget | null = defaultPerformanceTarget(),
): boolean {
  if (process.env.NODE_ENV === "production" || !target) {
    return false;
  }

  const current = target.measure as GuardedPerformanceMeasureFn;
  if (typeof current !== "function" || current[FULLMAG_MEASURE_GUARD]) {
    return false;
  }

  const nativeMeasure = current.bind(target) as PerformanceMeasureFn;
  const guardedMeasure: GuardedPerformanceMeasureFn = (
    measureName,
    startOrMeasureOptions,
    endMark,
  ) => {
    const safeStartOrMeasureOptions = hasMeasureDetail(startOrMeasureOptions)
      ? measureOptionsWithoutDetail(startOrMeasureOptions)
      : startOrMeasureOptions;
    try {
      return nativeMeasure(measureName, safeStartOrMeasureOptions, endMark);
    } catch (error) {
      if (
        !isDetailCloneFailure(error) ||
        safeStartOrMeasureOptions === startOrMeasureOptions
      ) {
        throw error;
      }

      return nativeMeasure(measureName, safeStartOrMeasureOptions, endMark);
    }
  };

  Object.defineProperty(guardedMeasure, FULLMAG_MEASURE_GUARD, {
    value: true,
  });

  try {
    target.measure = guardedMeasure;
  } catch {
    // Some browser Performance objects expose methods through readonly slots.
  }

  if (target.measure === guardedMeasure) {
    return true;
  }

  try {
    Object.defineProperty(target, "measure", {
      configurable: true,
      value: guardedMeasure,
    });
  } catch {
    return false;
  }

  return target.measure === guardedMeasure;
}

function defaultPerformanceTarget(): PerformanceMeasureTarget | null {
  if (
    typeof window === "undefined" ||
    !window.performance ||
    typeof window.performance.measure !== "function"
  ) {
    return null;
  }

  return window.performance;
}

function hasMeasureDetail(
  value: string | PerformanceMeasureOptions | undefined,
): value is PerformanceMeasureOptions & { detail: unknown } {
  return typeof value === "object" && value !== null && "detail" in value;
}

function measureOptionsWithoutDetail(
  options: PerformanceMeasureOptions,
): PerformanceMeasureOptions {
  const next = { ...options };
  delete next.detail;
  return next;
}

function isDetailCloneFailure(error: unknown): boolean {
  const isDomException =
    typeof DOMException !== "undefined" && error instanceof DOMException;
  if (!(error instanceof Error) && !isDomException) {
    return false;
  }

  return (error as Error | DOMException).name === "DataCloneError";
}
