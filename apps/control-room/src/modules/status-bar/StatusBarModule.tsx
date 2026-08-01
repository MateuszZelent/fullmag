"use client";

import { useSyncExternalStore } from "react";
import { useKernel } from "@/kernel/KernelContext";

import {
  useCurrentRunResource,
  useSolverStatusResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  useMeshBuildCurrent,
  useMeshSharedDomainManifestResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  formatRuntimeStateLabel,
  resolveEffectiveRuntimeState,
} from "@/kernel/runtime/runtimeStateDisplay";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";

import {
  buildStatusBarEngineModel,
  buildStatusBarMeshModel,
  formatRuntimeBundleVersionLabel,
} from "./statusBarModel";

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

export default function StatusBarModule() {
  const kernel = useKernel();
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
    (status) => status.data?.resources.mesh_revision ?? 0,
    { enabled: mounted },
  );
  const meshBuildRevision = useSessionStatusSelector(
    (status) => status.data?.resources.mesh_build_revision ?? 0,
    { enabled: mounted },
  );
  const sceneRevision = useSessionStatusSelector(
    (status) => status.data?.resources.scene_revision ?? null,
    { enabled: mounted },
  );
  const currentRun = useCurrentRunResource({ enabled: mounted });
  const solverStatus = useSolverStatusResource({ enabled: mounted });
  const meshManifest = useMeshSharedDomainManifestResource({ enabled: mounted });
  const meshBuildCurrent = useMeshBuildCurrent({ enabled: mounted });
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
  const activeBuild = readRecord(meshBuildCurrent.data?.active_build);
  const mesh = buildStatusBarMeshModel({
    activeBuildStatus:
      typeof activeBuild?.status === "string" ? activeBuild.status : null,
    manifestSourceSceneRevision: mounted
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
  const dotStatus = mounted ? sessionResourceStatus : "loading";

  const handleItemClick = (tab: "telemetry" | "mesh" | "diagnostics") => {
    kernel.bus.emit("footer:tab-requested", { tab });
  };
  const handleItemKeyDown = (event: React.KeyboardEvent, tab: "telemetry" | "mesh" | "diagnostics") => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleItemClick(tab);
    }
  };

  return (
    <div className="fm-status-bar" role="status" aria-label="Session status">
      <span
        className="fm-status-bar__dot"
        data-status={dotStatus}
        aria-hidden="true"
      />
      <span
        className="fm-status-bar__item fm-status-bar__item--clickable"
        role="button"
        tabIndex={0}
        onClick={() => handleItemClick("telemetry")}
        onKeyDown={(e) => handleItemKeyDown(e, "telemetry")}
      >
        {sessionState}
      </span>
      <span className="fm-status-bar__sep" aria-hidden="true" />
      <span
        className="fm-status-bar__item fm-status-bar__item--clickable"
        role="button"
        tabIndex={0}
        onClick={() => handleItemClick("telemetry")}
        onKeyDown={(e) => handleItemKeyDown(e, "telemetry")}
      >
        {sessionName}
      </span>
      <span className="fm-status-bar__sep" aria-hidden="true" />
      <span className="fm-status-bar__item">{runtimeVersion}</span>
      <span className="fm-status-bar__sep" aria-hidden="true" />
      <span
        className="fm-status-bar__item fm-status-bar__item--clickable"
        data-state={mesh.state}
        title={mesh.title}
        role="button"
        tabIndex={0}
        onClick={() => handleItemClick("mesh")}
        onKeyDown={(e) => handleItemKeyDown(e, "mesh")}
      >
        {mesh.label}
      </span>
      <span className="fm-status-bar__spacer" aria-hidden="true" />
      <span
        className="fm-status-bar__engine fm-status-bar__engine--clickable"
        data-state={engine.state}
        title={engine.title}
        role="button"
        tabIndex={0}
        onClick={() => handleItemClick("diagnostics")}
        onKeyDown={(e) => handleItemKeyDown(e, "diagnostics")}
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
