"use client";

import { useEffect, useReducer, useState } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import {
  FDM_MESH_COMMAND_NOT_APPLICABLE_REASON,
  UNKNOWN_MESH_COMMAND_LANE_REASON,
  resolveMeshCommandLane,
  type MeshCommandLane,
} from "@/kernel/authoring/geometryLifecycleCommandContributions";
import {
  useMeshBuildCurrent,
  useMeshBuildLatestSuccessful,
  useModelRegionDiagnosticsResource,
  useMeshSharedDomainQualityResource,
  useMeshSharedDomainManifestResource,
  useMeshSummaryResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  shouldLoadRuntimeMeshBuild,
  shouldLoadRuntimeMeshManifest,
  shouldLoadRuntimeMeshSummary,
  useStudyRuntimeCommandResourceData,
} from "@/kernel/resources/studyRuntimeResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import type { JsonObject, LiveStatusResource } from "@/kernel/api/apiTypes";
import type { KernelApi } from "@/kernel/types";
import { diffMeshPolicies } from "@/shared/domain/mesh/meshPolicyDiff";
import { buildMeshSnapshotRows } from "@/shared/domain/mesh/meshBuildSnapshots";
import {
  normalizeMeshPipelineStatus,
  resolveMeshBuildStatusLabel,
} from "@/shared/domain/mesh/buildPipeline";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import { Button } from "@/shared/ui/Button";
import { MeshBuildConfirmDialogContent } from "./mesh-build/MeshBuildConfirmDialog";
import { buildRegionMeshBuildReasonRows } from "./mesh-build/meshBuildRegionReasons";
import { openMeshBuildDiagnostics } from "./meshBuildDiagnosticsNavigation";

function asRecord(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function text(value: unknown, fallback = "unknown"): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

interface MeshBuildDialogState {
  acceptedCommandId: string | null;
  commandId: "mesh.build-selected" | "mesh.build-shared-domain" | null;
  errorMessage: string | null;
  input: unknown;
  lastCommandId: string | null;
  lastCommandStatus: string;
  open: boolean;
  phase: "pre-build" | "submitting" | "post-build" | "error";
  source: "inspector" | "palette" | "ribbon" | "test";
  sourceDetail: string | undefined;
}

type MeshBuildDialogAction =
  | {
      commandId: "mesh.build-selected" | "mesh.build-shared-domain";
      input: unknown;
      source: "inspector" | "palette" | "ribbon" | "test";
      sourceDetail: string | undefined;
      type: "request";
    }
  | {
      commandId: string | null;
      status: string;
      type: "accepted";
    }
  | {
      message: string;
      type: "error";
    }
  | {
      type: "rendered";
    }
  | {
      type: "submitting";
    }
  | {
      open: boolean;
      type: "open";
    };

function meshBuildDialogReducer(
  state: MeshBuildDialogState,
  action: MeshBuildDialogAction,
): MeshBuildDialogState {
  if (action.type === "open") {
    return { ...state, open: action.open };
  }
  if (action.type === "request") {
    return {
      acceptedCommandId: null,
      commandId: action.commandId,
      errorMessage: null,
      input: action.input,
      lastCommandId: action.commandId,
      lastCommandStatus: "pending-confirmation",
      open: true,
      phase: "pre-build",
      source: action.source,
      sourceDetail: action.sourceDetail,
    };
  }
  if (action.type === "submitting") {
    return {
      ...state,
      errorMessage: null,
      lastCommandStatus: "submitting",
      open: true,
      phase: "submitting",
    };
  }
  if (action.type === "accepted") {
    return {
      ...state,
      acceptedCommandId: action.commandId,
      lastCommandId: action.commandId,
      lastCommandStatus: action.status,
      open: true,
      phase: "submitting",
    };
  }
  if (action.type === "rendered") {
    if (!state.open || state.phase === "pre-build") return state;
    return {
      ...state,
      lastCommandStatus: "rendered",
      phase: "post-build",
    };
  }
  return {
    ...state,
    errorMessage: action.message,
    lastCommandStatus: "failed",
    open: true,
    phase: "error",
  };
}

type MeshBuildDialogRuntimeStatus = {
  capabilities: Pick<LiveStatusResource["capabilities"], "explicit_topology">;
  domain: Pick<LiveStatusResource["domain"], "discretization">;
  resources: Pick<
    LiveStatusResource["resources"],
    "mesh_build_revision" | "mesh_revision"
  >;
};

function selectMeshBuildDialogRuntimeStatus(status: {
  data: LiveStatusResource | null;
}): MeshBuildDialogRuntimeStatus | null {
  if (!status.data) return null;
  return {
    capabilities: {
      explicit_topology: status.data.capabilities.explicit_topology,
    },
    domain: {
      discretization: status.data.domain.discretization,
    },
    resources: {
      mesh_build_revision: status.data.resources.mesh_build_revision,
      mesh_revision: status.data.resources.mesh_revision,
    },
  };
}

function meshBuildDialogRuntimeStatusEquals(
  previous: MeshBuildDialogRuntimeStatus | null,
  next: MeshBuildDialogRuntimeStatus | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  return (
    previous.capabilities.explicit_topology ===
      next.capabilities.explicit_topology &&
    previous.domain.discretization === next.domain.discretization &&
    previous.resources.mesh_build_revision ===
      next.resources.mesh_build_revision &&
    previous.resources.mesh_revision === next.resources.mesh_revision
  );
}

export function resolveMeshBuildDialogLane(
  discretization: unknown,
): MeshCommandLane {
  return resolveMeshCommandLane(discretization);
}

export function shouldLoadMeshBuildDialogFemResources(
  open: boolean,
  lane: MeshCommandLane,
): boolean {
  return open && lane === "fem";
}

export function meshBuildDialogUnavailableMessage(
  lane: MeshCommandLane,
): string | null {
  if (lane === "fdm") return FDM_MESH_COMMAND_NOT_APPLICABLE_REASON;
  if (lane === "unknown") return UNKNOWN_MESH_COMMAND_LANE_REASON;
  return null;
}

export function MeshBuildDialog({ kernel }: { kernel: KernelApi }) {
  const [state, dispatch] = useReducer(meshBuildDialogReducer, {
    acceptedCommandId: null,
    commandId: null,
    errorMessage: null,
    input: undefined,
    lastCommandId: null,
    lastCommandStatus: "pending",
    open: false,
    phase: "pre-build",
    source: "ribbon",
    sourceDetail: undefined,
  });
  const [snapshotBefore, setSnapshotBefore] = useState<{
    policy: JsonObject | null;
    stats: {
      build: JsonObject | null;
      manifest: JsonObject | null;
      quality: JsonObject | null;
    };
  } | null>(null);

  const runtimeStatus = useSessionStatusSelector(
    selectMeshBuildDialogRuntimeStatus,
    { enabled: state.open, isEqual: meshBuildDialogRuntimeStatusEquals },
  );
  const lane = resolveMeshBuildDialogLane(runtimeStatus?.domain.discretization);
  const explicitFemLane = shouldLoadMeshBuildDialogFemResources(
    state.open,
    lane,
  );
  const resourceData = useStudyRuntimeCommandResourceData({
    enabled: explicitFemLane,
  });
  const commandContext = createCommandContext(state.source, kernel, {
    input: state.input,
    resourceData,
    sourceDetail: state.sourceDetail,
  });
  const unavailableMessage = meshBuildDialogUnavailableMessage(lane);
  const activeBuild = useMeshBuildCurrent({
    enabled:
      explicitFemLane &&
      (shouldLoadRuntimeMeshBuild(state.open, runtimeStatus) ||
        state.phase === "submitting"),
  });
  const latestBuild = useMeshBuildLatestSuccessful({
    enabled:
      explicitFemLane &&
      (shouldLoadRuntimeMeshBuild(state.open, runtimeStatus) ||
        state.phase === "submitting"),
  });
  const summary = useMeshSummaryResource({
    enabled:
      explicitFemLane && shouldLoadRuntimeMeshSummary(state.open, runtimeStatus),
  });
  const manifest = useMeshSharedDomainManifestResource({
    enabled:
      explicitFemLane && shouldLoadRuntimeMeshManifest(state.open, runtimeStatus),
  });
  const sharedQuality = useMeshSharedDomainQualityResource({
    enabled: explicitFemLane && state.open,
  });
  const regionDiagnostics = useModelRegionDiagnosticsResource({
    enabled: explicitFemLane && state.open,
  });

  const currentSnapshot = state.open ? snapshotBefore : null;

  const activeRecord = asRecord(activeBuild.data?.active_build);
  const pipelinePhases = normalizeMeshPipelineStatus(activeBuild.data?.mesh_pipeline_status);
  const buildStatus = resolveMeshBuildStatusLabel(activeRecord, pipelinePhases);

  const diffRows = diffMeshPolicies({
    current: currentSnapshot?.policy ?? asRecord(summary.data?.effective_airbox_target),
    draft: state.phase === "post-build"
      ? asRecord(latestBuild.data?.effective_airbox_target)
      : asRecord(activeBuild.data?.effective_airbox_target),
    realized: asRecord(latestBuild.data?.effective_airbox_target),
    scope: "airbox",
  });

  const targetLabel =
    targetLabelForPendingCommand(state.commandId, state.input) ??
    targetLabelForBuild(activeBuild.data?.active_build);
  const currentSummary = explicitFemLane
    ? [
        { label: "Mesh", value: manifest.data?.mesh_name ?? "not built" },
        {
          label: "Revision",
          value: String(
            summary.data?.revision ?? activeBuild.data?.revision ?? "unknown",
          ),
        },
        { label: "Build resource", value: activeBuild.status },
        { label: "Active build", value: buildStatus },
        {
          label: "Last error",
          value:
            activeBuild.data?.last_build_error ??
            latestBuild.data?.last_build_error ??
            "none",
        },
      ]
    : [
        { label: "Mesh lane", value: lane === "fdm" ? "FDM structured grid" : "unresolved" },
        { label: "Availability", value: unavailableMessage ?? "not applicable" },
      ];
  const regionReasonRows = buildRegionMeshBuildReasonRows(regionDiagnostics.data);
  const newSummary = explicitFemLane
    ? [
        { label: "Requested target", value: targetLabel },
        {
          label: "Command",
          value: state.commandId ?? "none",
        },
        {
          label: "Policy changes",
          value:
            diffRows.filter((r) => r.state !== "unchanged").length === 0
              ? "No pending policy diff"
              : String(diffRows.filter((r) => r.state !== "unchanged").length),
        },
        {
          label: "Expected result",
          value: "New mesh revision, manifest, quality and viewport render",
        },
        ...regionReasonRows,
      ]
    : [];
  const snapshotRows = buildMeshSnapshotRows({
    current: currentSnapshot?.stats ?? {
      build: asRecord(latestBuild.data),
      manifest: null,
      quality: null,
    },
    next: {
      build: asRecord(activeBuild.data),
      manifest: asRecord(manifest.data),
      quality: asRecord(sharedQuality.data),
    },
  });

  useEffect(() => {
    const offRequested = kernel.bus.on("mesh:build-confirm-requested", (request) => {
      setSnapshotBefore({
        policy: asRecord(summary.data?.effective_airbox_target),
        stats: {
          build: asRecord(latestBuild.data),
          manifest: asRecord(manifest.data),
          quality: asRecord(sharedQuality.data),
        },
      });
      dispatch({
        commandId: request.commandId,
        input: request.input,
        source: request.source,
        sourceDetail: request.sourceDetail,
        type: "request",
      });
    });
    const offSubmitted = kernel.bus.on("mesh:build-submitted", ({ commandId }) => {
      dispatch({ commandId, status: "accepted", type: "accepted" });
    });
    const offRendered = kernel.bus.on("mesh:topology-rendered", () => {
      dispatch({ type: "rendered" });
    });
    return () => {
      offRequested();
      offSubmitted();
      offRendered();
    };
  }, [
    kernel.bus,
    summary.data,
    latestBuild.data,
    manifest.data,
    sharedQuality.data,
  ]);

  // Polling fallback while in "submitting" phase to ensure we query status every 1000ms.
  const { refetch: refetchActive } = activeBuild;
  const { refetch: refetchLatest } = latestBuild;
  useEffect(() => {
    if (!state.open || state.phase !== "submitting") return;

    const intervalId = setInterval(() => {
      void refetchActive();
      void refetchLatest();
    }, 1000);

    return () => {
      clearInterval(intervalId);
    };
  }, [state.open, state.phase, refetchActive, refetchLatest]);

  // Query-based success/failure transition detection (decoupled from the 3D viewport).
  useEffect(() => {
    if (!state.open || state.phase !== "submitting") return;

    const activeRecord = asRecord(activeBuild.data?.active_build);
    const pipelinePhases = normalizeMeshPipelineStatus(activeBuild.data?.mesh_pipeline_status);
    const isReady = pipelinePhases.some(
      (p) =>
        p.id === "ready" &&
        (p.status === "active" || p.status === "done" || p.status === "completed")
    );

    const hasFailedPhase = pipelinePhases.some(
      (p) => p.status === "warning" || p.status === "failed"
    );
    const lastError = activeBuild.data?.last_build_error;

    if (lastError || hasFailedPhase) {
      dispatch({
        message: lastError ?? "Mesh build failed during background execution.",
        type: "error",
      });
      return;
    }

    const prevRev = snapshotBefore?.stats?.build?.revision;
    const previousRevision = typeof prevRev === "number" ? prevRev : 0;
    const currentRevision = latestBuild.data?.revision ?? 0;

    const isSuccess =
      (activeBuild.data && !activeRecord && isReady) ||
      (latestBuild.data && currentRevision > previousRevision);

    if (isSuccess) {
      dispatch({ type: "rendered" });
    }
  }, [
    state.open,
    state.phase,
    activeBuild.data,
    latestBuild.data,
    snapshotBefore,
  ]);

  async function confirmBuild(): Promise<void> {
    if (!state.commandId) return;
    if (!explicitFemLane) {
      dispatch({
        message: unavailableMessage ?? UNKNOWN_MESH_COMMAND_LANE_REASON,
        type: "error",
      });
      return;
    }
    dispatch({ type: "submitting" });
    const result = await kernel.commands.execute(
      state.commandId,
      commandContext,
      state.input,
    );
    if (result.status === "failed") {
      dispatch({
        message: result.message ?? "Mesh build command failed.",
        type: "error",
      });
      return;
    }
    openMeshBuildDiagnostics(kernel);
  }

  return (
    <Dialog
      open={state.open}
      onOpenChange={(open) => dispatch({ open, type: "open" })}
    >
      <DialogContent
        aria-describedby="fm-mesh-build-dialog-description"
        className="fm-mesh-build-confirm-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {!explicitFemLane
              ? "FEM Mesh Controls Unavailable"
              : state.phase === "post-build"
              ? "Mesh Build Complete"
              : state.phase === "error"
                ? "Mesh Build Failed"
                : "Mesh Build Confirmation"}
          </DialogTitle>
          <DialogDescription id="fm-mesh-build-dialog-description">
            {explicitFemLane
              ? "Confirm the mesh target and parameter changes. Mesh Jobs tracks the long build log and pipeline."
              : unavailableMessage}
          </DialogDescription>
        </DialogHeader>
        <div className="fm-dialog__body">
          {explicitFemLane ? (
            <MeshBuildConfirmDialogContent
              commandId={state.acceptedCommandId ?? state.lastCommandId}
              commandStatus={state.lastCommandStatus}
              currentSummary={currentSummary}
              diffRows={diffRows}
              errorMessage={state.errorMessage}
              mode={state.phase}
              newSummary={newSummary}
              postBuildRows={snapshotRows}
              targetLabel={targetLabel}
              onApplyBuild={() => {
                void confirmBuild();
              }}
              onCancel={() => dispatch({ open: false, type: "open" })}
              onOpenMeshJobs={() => openMeshBuildDiagnostics(kernel)}
            />
          ) : (
            <section
              aria-label="FEM mesh controls unavailable"
              className="fm-mesh-build-confirm__section fm-mesh-build-confirm__banner"
            >
              <h3 className="fm-mesh-build-confirm__section-title">
                Structured-grid lane
              </h3>
              <p className="fm-mesh-build-confirm__empty">
                {unavailableMessage}
              </p>
              <div className="fm-mesh-build-confirm__actions">
                <Button
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => dispatch({ open: false, type: "open" })}
                >
                  Close
                </Button>
              </div>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function targetLabelForPendingCommand(
  commandId: MeshBuildDialogState["commandId"],
  input: unknown,
): string | null {
  if (commandId === "mesh.build-shared-domain") return "Shared-domain mesh";
  if (commandId === "mesh.build-selected") {
    const inputRecord = asRecord(input);
    const target = asRecord(inputRecord?.mesh_target) ?? asRecord(inputRecord?.target);
    const objectId = text(target?.object_id ?? inputRecord?.object_id, "selected object");
    return `Object mesh ${objectId}`;
  }
  return null;
}

function targetLabelForBuild(value: unknown): string {
  const record = asRecord(value);
  const target = asRecord(record?.mesh_target) ?? asRecord(record?.target);
  const kind = text(target?.kind ?? record?.target_kind, "mesh");
  if (kind === "object_mesh") {
    return `Object mesh ${text(target?.object_id ?? record?.object_id, "unknown")}`;
  }
  if (kind === "study_domain" || kind === "shared_domain") {
    return "Shared-domain mesh";
  }
  return kind;
}
