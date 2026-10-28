"use client";

import { useSyncExternalStore } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
  useMeshBuildCurrent,
  useMeshSharedDomainManifestResource,
} from "@/kernel/resources/geometryLifecycleResources";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";
import {
  useCurrentRunResource,
  useSolverStatusResource,
} from "@/kernel/resources/studyRuntimeResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { useRealtimeConnection } from "@/kernel/realtime/useRealtimeConnection";

import {
  formatRuntimeStateLabel,
  resolveEffectiveRuntimeState,
  resolveRuntimeUserSolvePhase,
} from "@/kernel/runtime/runtimeStateDisplay";
import { useAwaitingComputeCommand } from "@/kernel/runtime/useAwaitingComputeCommand";
import { Button } from "@/shared/ui/Button";

import {
  buildStatusBarEngineModel,
  buildStatusBarMethodModel,
  statusBarMethodModelsEqual,
  buildStatusBarMeshModel,
  formatRuntimeBundleVersionLabel,
} from "./statusBarModel";
import { SimulationPreparationStatusEntry } from "./SimulationPreparationStatusEntry";

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
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

function formatRealtimeConnectionLabel(
  status: ReturnType<typeof useRealtimeConnection>["status"],
  disrupted: boolean,
): string {
  if (status === "connecting" && disrupted) return "reconnecting";
  return status;
}

function formatStatusFreshnessLabel(status: ResourceStatus): string {
  switch (status) {
    case "ready":
      return "ready";
    case "stale":
      return "stale";
    case "loading":
      return "loading";
    case "error":
      return "unavailable";
    case "idle":
      return "idle";
  }
}

export default function StatusBarModule() {
  const kernel = useKernel();
  const realtimeConnection = useRealtimeConnection();
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
  const meshRevision = useSessionStatusSelector(
    (status) => status.data?.resources.mesh_revision ?? null,
    { enabled: mounted },
  );
  const meshBuildRevision = useSessionStatusSelector(
    (status) => status.data?.resources.mesh_build_revision ?? null,
    { enabled: mounted },
  );
  const sceneRevision = useSessionStatusSelector(
    (status) => status.data?.resources.scene_revision ?? null,
    { enabled: mounted },
  );
  const method = useSessionStatusSelector(
    (status) => buildStatusBarMethodModel(status.data),
    {
      enabled: mounted,
      isEqual: statusBarMethodModelsEqual,
    },
  );
  const currentRun = useCurrentRunResource({ enabled: mounted });
  const solverStatus = useSolverStatusResource({ enabled: mounted });
  const femMeshActive = mounted && method.method === "fem";
  const meshManifest = useMeshSharedDomainManifestResource({ enabled: femMeshActive });
  const meshBuildCurrent = useMeshBuildCurrent({ enabled: femMeshActive });
  const runtimeState = resolveEffectiveRuntimeState({
    detailedRuntimeState: mounted ? solverStatus.data?.runtime_state : null,
    sessionSolverState: mounted ? solverState : null,
  });
  const userSolvePhase = mounted
    ? resolveRuntimeUserSolvePhase({
        detailedRuntimeState: solverStatus.data?.runtime_state,
        runStatus: currentRun.data?.status,
        runStatusReason: currentRun.data?.status_reason,
        sessionSolverState: solverState,
      })
    : null;
  const engine = buildStatusBarEngineModel(
    mounted ? currentRun.data : null,
    mounted ? runtimeState : null,
    userSolvePhase,
  );
  const compute = useAwaitingComputeCommand({
    enabled: engine.awaitingCompute,
    sourceDetail: "status-bar.awaiting-compute",
  });
  const sessionState = mounted
    ? formatRuntimeStateLabel(runtimeState, sessionResourceStatus)
    : "loading";
  const sessionName = mounted
    ? readString(sessionStatusName, "session unavailable")
    : "—";
  const activeBuild = femMeshActive
    ? readRecord(meshBuildCurrent.data?.active_build)
    : null;
  const mesh = buildStatusBarMeshModel({
    activeBuildStatus:
      typeof activeBuild?.status === "string" ? activeBuild.status : null,
    manifestSourceSceneRevision: femMeshActive
      ? meshManifest.data?.source_scene_revision
      : null,
    meshBuildRevision: mounted ? meshBuildRevision : null,
    meshRevision: mounted ? meshRevision : null,
    sceneRevision: mounted ? sceneRevision : null,
  });
  const runtimeVersion = mounted
    ? formatRuntimeBundleVersionLabel(
        readString(runtimeBundleVersion, "runtime unavailable"),
      )
    : "—";
  const statusFreshness = mounted ? sessionResourceStatus : "loading";
  const realtimeLabel = formatRealtimeConnectionLabel(
    realtimeConnection.status,
    realtimeConnection.disrupted,
  );

  const handleItemClick = (tab: "telemetry" | "operations" | "diagnostics") => {
    kernel.bus.emit("footer:tab-requested", { tab });
  };

  return (
    <div className="fm-status-bar" role="group" aria-label="Session status">
      <span
        className="fm-status-bar__dot"
        data-status={statusFreshness}
        aria-hidden="true"
      />
      <button
        type="button"
        className="fm-status-bar__button fm-status-bar__item fm-status-bar__item--clickable fm-status-bar__item--state"
        onClick={() => handleItemClick("telemetry")}
        title={sessionState}
      >
        {sessionState}
      </button>
      <span className="fm-status-bar__sep" aria-hidden="true" />
      <button
        type="button"
        className="fm-status-bar__button fm-status-bar__item fm-status-bar__item--clickable"
        onClick={() => handleItemClick("telemetry")}
        title={sessionName}
      >
        {sessionName}
      </button>
      <span className="fm-status-bar__sep" aria-hidden="true" />
      <span className="fm-status-bar__item" title={runtimeVersion}>{runtimeVersion}</span>
      <span className="fm-status-bar__sep" aria-hidden="true" />
      <button
        type="button"
        className="fm-status-bar__button fm-status-bar__item fm-status-bar__item--clickable"
        data-state={mesh.state}
        title={mesh.title}
        aria-label={mesh.label}
        onClick={() => handleItemClick("operations")}
      >
        {mesh.label}
      </button>
      <SimulationPreparationStatusEntry />
      <span className="fm-status-bar__spacer" aria-hidden="true" />
      <span
        className="fm-status-bar__axis fm-status-bar__axis--connection"
        data-state={realtimeConnection.status}
        aria-label={`Realtime connection ${realtimeLabel}`}
        title={`WebSocket connection: ${realtimeLabel}. Session status data freshness is shown separately.`}
      >
        Realtime {realtimeLabel}
      </span>
      <span
        className="fm-status-bar__axis fm-status-bar__axis--freshness"
        data-state={statusFreshness}
        aria-label={`Session status data ${formatStatusFreshnessLabel(statusFreshness)}`}
        title={`Session status resource fetch state: ${formatStatusFreshnessLabel(statusFreshness)}. WebSocket connection is shown separately.`}
      >
        Status {formatStatusFreshnessLabel(statusFreshness)}
      </span>
      <button
        type="button"
        className="fm-status-bar__button fm-status-bar__engine fm-status-bar__engine--clickable"
        data-state={engine.state}
        data-tone={engine.tone}
        title={engine.title}
        onClick={() => handleItemClick("diagnostics")}
      >
        <span className="fm-status-bar__engine-label">{engine.label}</span>
        <span className="fm-status-bar__engine-sep" aria-hidden="true">
          {" | "}
        </span>
        <span className="fm-status-bar__engine-detail">{engine.detail}</span>
      </button>
      {engine.awaitingCompute ? (
        <Button
          aria-disabled={compute.disabledReason !== null || compute.pending}
          className="fm-status-bar__compute-cta"
          onClick={compute.run}
          size="sm"
          title={compute.title}
          type="button"
          variant="primary"
        >
          {compute.pending ? "Submitting…" : "Compute"}
        </Button>
      ) : null}
      <span
        className="fm-status-bar__engine"
        data-state={method.state}
        data-method={method.method ?? "unresolved"}
        aria-label="Simulation method"
        title={method.title}
      >
        <span className="fm-status-bar__engine-label">{method.label}</span>
      </span>
    </div>
  );
}
