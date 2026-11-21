"use client";

import {
  Profiler,
  useMemo,
  type ProfilerOnRenderCallback,
  type ReactNode,
} from "react";
import { shouldEnableReactRenderProfiler, recordReactRenderMeasure } from "./reactRenderProfiler.model";

declare global {
  interface Window {
    __FULLMAG_REACT_PROFILER__?: boolean;
  }
}

export type ReactRenderProfilerId =
  | "ExplorerModule"
  | "FooterModule"
  | "InspectorModule"
  | "RibbonModule"
  | "Viewport3DModule"
  | "WorkspaceDockLayout";

interface ReactRenderProfilerProps {
  children: ReactNode;
  id: ReactRenderProfilerId;
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
