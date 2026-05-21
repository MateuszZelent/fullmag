"use client";

import { useSyncExternalStore } from "react";

import {
  useCurrentRunResource,
  useSolverStatusResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  formatRuntimeStateLabel,
  resolveEffectiveRuntimeState,
} from "@/kernel/runtime/runtimeStateDisplay";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";

import {
  buildStatusBarEngineModel,
  formatRuntimeBundleVersionLabel,
} from "./statusBarModel";

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function subscribeToMounted(): () => void {
  return () => {};
}

function clientMountedSnapshot(): boolean {
  return true;
}

function serverMountedSnapshot(): boolean {
  return false;
}

export default function StatusBarModule() {
  const mounted = useSyncExternalStore(
    subscribeToMounted,
    clientMountedSnapshot,
    serverMountedSnapshot,
  );

  const sessionResourceStatus = useSessionStatusSelector(
    (status) => status.status,
    { enabled: mounted },
  );
  const solverState = useSessionStatusSelector(
    (status) => status.data?.solver.state ?? null,
    { enabled: mounted },
  );
  const sessionStatusName = useSessionStatusSelector(
    (status) => status.data?.session.name ?? null,
    { enabled: mounted },
  );
  const runtimeBundleVersion = useSessionStatusSelector(
    (status) => status.data?.runtime_bundle_version ?? null,
    { enabled: mounted },
  );
  const currentRun = useCurrentRunResource({ enabled: mounted });
  const solverStatus = useSolverStatusResource({ enabled: mounted });
  const runtimeState = resolveEffectiveRuntimeState({
    detailedRuntimeState: mounted ? solverStatus.data?.runtime_state : null,
    sessionSolverState: mounted ? solverState : null,
  });
  const engine = buildStatusBarEngineModel(
    mounted ? currentRun.data : null,
    mounted ? runtimeState : null,
  );
  const sessionState = mounted
    ? formatRuntimeStateLabel(runtimeState, sessionResourceStatus)
    : "loading";
  const sessionName = mounted
    ? readString(sessionStatusName, "session unavailable")
    : "—";
  const runtimeVersion = mounted
    ? formatRuntimeBundleVersionLabel(
        readString(runtimeBundleVersion, "runtime unavailable"),
      )
    : "—";
  const dotStatus = mounted ? sessionResourceStatus : "loading";

  return (
    <div className="fm-status-bar" role="status" aria-label="Session status">
      <span
        className="fm-status-bar__dot"
        data-status={dotStatus}
        aria-hidden="true"
      />
      <span className="fm-status-bar__item">{sessionState}</span>
      <span className="fm-status-bar__sep" aria-hidden="true" />
      <span className="fm-status-bar__item">{sessionName}</span>
      <span className="fm-status-bar__sep" aria-hidden="true" />
      <span className="fm-status-bar__item">{runtimeVersion}</span>
      <span className="fm-status-bar__spacer" aria-hidden="true" />
      <span
        className="fm-status-bar__engine"
        data-state={engine.state}
        title={engine.title}
      >
        <span className="fm-status-bar__engine-label">{engine.label}</span>
        <span className="fm-status-bar__engine-sep" aria-hidden="true">
          {" | "}
        </span>
        <span className="fm-status-bar__engine-detail">{engine.detail}</span>
      </span>
    </div>
  );
}
