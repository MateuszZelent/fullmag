"use client";

import {
  Profiler,
  useMemo,
  type ProfilerOnRenderCallback,
  type ReactNode,
} from "react";

declare global {
  interface Window {
    __FULLMAG_REACT_PROFILER__?: boolean;
  }
}

export const REACT_RENDER_PROFILE_MEASURE_PREFIX = "fullmag.react.render.";

export type ReactRenderProfilerId =
  | "ExplorerModule"
  | "RibbonModule"
  | "Viewport3DModule"
  | "WorkspaceDockLayout";

interface ReactRenderProfilerProps {
  children: ReactNode;
  id: ReactRenderProfilerId;
}

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

  try {
    performanceTarget.measure(
      `${REACT_RENDER_PROFILE_MEASURE_PREFIX}${id}.${phase}`,
      {
        duration: actualDuration,
        start: startTime,
      },
    );
  } catch {
    // User Timing support varies across embedded browser environments.
  }
}

export function WorkspaceRenderProfiler({
  children,
  id,
}: ReactRenderProfilerProps) {
  const onRender = useMemo(() => createOnRender(id), [id]);

  if (!shouldEnableReactRenderProfiler()) {
    return <>{children}</>;
  }

  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}

function createOnRender(id: ReactRenderProfilerId): ProfilerOnRenderCallback {
  return (_profilerId, phase, actualDuration, _baseDuration, startTime) => {
    recordReactRenderMeasure({
      actualDuration,
      id,
      phase,
      startTime,
    });
  };
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
    return window.localStorage.getItem("fullmag:react-profiler");
  } catch {
    return null;
  }
}

function defaultPerformanceTarget(): ReactRenderMeasureTarget | null {
  return typeof performance === "undefined" ? null : performance;
}
