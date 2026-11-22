"use client";

import { Info, Radio, RefreshCw } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";

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
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/Popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/Tooltip";

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
    // Retained data while the status resource refetches, not a failure.
    case "stale":
      return "refreshing";
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

  const freshnessLabel = formatStatusFreshnessLabel(statusFreshness);

  /* Everything the bar shows, in full, for the details popover. Fields the
     bar drops at narrow widths (container queries) stay reachable here. */
  const details: Array<{ label: string; value: string; state?: string; title?: string }> = [
    { label: "State", value: sessionState, state: statusFreshness },
    { label: "Session", value: sessionName },
    { label: "Runtime", value: runtimeVersion },
    { label: "Mesh", value: mesh.label, state: mesh.state, title: mesh.title },
    { label: "Realtime", value: realtimeLabel, state: realtimeConnection.status },
    { label: "Status data", value: freshnessLabel, state: statusFreshness },
    { label: "Engine", value: `${engine.label} — ${engine.detail}`, state: engine.state, title: engine.title },
    { label: "Method", value: method.label, state: method.state, title: method.title },
  ];

  return (
    <TooltipProvider delayDuration={300}>
      <div className="fm-status-bar" role="group" aria-label="Session status">
        <span
          className="fm-status-bar__dot"
          data-status={statusFreshness}
          aria-hidden="true"
        />
        <StatusTip content={`Session state: ${sessionState}`}>
          <button
            type="button"
            className="fm-status-bar__button fm-status-bar__item fm-status-bar__item--clickable fm-status-bar__item--state"
            onClick={() => handleItemClick("telemetry")}
          >
            {sessionState}
          </button>
        </StatusTip>
        <span className="fm-status-bar__sep" data-priority="low" aria-hidden="true" />
        <StatusTip content={sessionName}>
          <button
            type="button"
            className="fm-status-bar__button fm-status-bar__item fm-status-bar__item--clickable"
            data-priority="low"
            onClick={() => handleItemClick("telemetry")}
          >
            {sessionName}
          </button>
        </StatusTip>
        <span className="fm-status-bar__sep" data-priority="lowest" aria-hidden="true" />
        <StatusTip content={`Runtime ${runtimeVersion}`}>
          <span className="fm-status-bar__item" data-priority="lowest">
            {runtimeVersion}
          </span>
        </StatusTip>
        <span className="fm-status-bar__sep" data-priority="low" aria-hidden="true" />
        <StatusTip content={mesh.title}>
          <button
            type="button"
            className="fm-status-bar__button fm-status-bar__item fm-status-bar__item--clickable"
            data-priority="low"
            data-state={mesh.state}
            aria-label={mesh.label}
            onClick={() => handleItemClick("operations")}
          >
            {mesh.label}
          </button>
        </StatusTip>
        <SimulationPreparationStatusEntry />
        <span className="fm-status-bar__spacer" aria-hidden="true" />
        <StatusTip content={`WebSocket connection: ${realtimeLabel}. Session status data freshness is shown separately.`}>
          <span role="group"
            className="fm-status-bar__axis fm-status-bar__axis--connection"
            data-state={realtimeConnection.status}
            aria-label={`Realtime connection ${realtimeLabel}`}
          >
            <Radio aria-hidden="true" className="fm-status-bar__axis-icon" size={12} />
            <span className="fm-status-bar__axis-text">Realtime {realtimeLabel}</span>
          </span>
        </StatusTip>
        <StatusTip content={`Session status resource fetch state: ${freshnessLabel}. WebSocket connection is shown separately.`}>
          <span role="group"
            className="fm-status-bar__axis fm-status-bar__axis--freshness"
            data-state={statusFreshness}
            aria-label={`Session status data ${freshnessLabel}`}
          >
            <RefreshCw aria-hidden="true" className="fm-status-bar__axis-icon" size={12} />
            <span className="fm-status-bar__axis-text">Status {freshnessLabel}</span>
          </span>
        </StatusTip>
        <StatusTip content={engine.title}>
          <button
            type="button"
            className="fm-status-bar__button fm-status-bar__engine fm-status-bar__engine--clickable"
            data-state={engine.state}
            data-tone={engine.tone}
            onClick={() => handleItemClick("diagnostics")}
          >
            <span className="fm-status-bar__engine-label">{engine.label}</span>
            <span className="fm-status-bar__engine-detail">{engine.detail}</span>
          </button>
        </StatusTip>
        {engine.awaitingCompute ? (
          <StatusTip content={compute.title}>
            <Button
              aria-disabled={compute.disabledReason !== null || compute.pending}
              className="fm-status-bar__compute-cta"
              onClick={compute.run}
              size="sm"
              type="button"
              variant="primary"
            >
              {compute.pending ? "Submitting…" : "Compute"}
            </Button>
          </StatusTip>
        ) : null}
        <StatusTip content={method.title}>
          <span role="group"
            className="fm-status-bar__engine"
            data-state={method.state}
            data-method={method.method ?? "unresolved"}
            aria-label="Simulation method"
          >
            <span className="fm-status-bar__engine-label">{method.label}</span>
          </span>
        </StatusTip>
        <Popover>
          <StatusTip content="Session status details">
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Session status details"
                className="fm-status-bar__button fm-status-bar__details-trigger"
              >
                <Info aria-hidden="true" size={13} />
              </button>
            </PopoverTrigger>
          </StatusTip>
          <PopoverContent
            align="end"
            aria-label="Session status details"
            className="fm-status-bar__details"
            side="top"
            sideOffset={8}
          >
            <dl className="fm-status-bar__details-list">
              {details.map(({ label, state, title, value }) => (
                <div className="fm-status-bar__details-row" data-state={state} key={label}>
                  <dt>{label}</dt>
                  <dd>
                    {value}
                    {title ? <small className="fm-status-bar__details-note">{title}</small> : null}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="fm-status-bar__details-actions">
              <Button size="sm" type="button" variant="ghost" onClick={() => handleItemClick("telemetry")}>
                Telemetry
              </Button>
              <Button size="sm" type="button" variant="ghost" onClick={() => handleItemClick("operations")}>
                Operations
              </Button>
              <Button size="sm" type="button" variant="ghost" onClick={() => handleItemClick("diagnostics")}>
                Diagnostics
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </TooltipProvider>
  );
}

function StatusTip({ children, content }: { children: ReactNode; content: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top">{content}</TooltipContent>
    </Tooltip>
  );
}
