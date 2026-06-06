"use client";

import { useEffect, useReducer } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import {
  useMeshBuildCurrent,
  useMeshBuildLatestSuccessful,
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
import { MeshBuildConfirmDialogContent } from "./mesh-build/MeshBuildConfirmDialog";

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

type MeshDiagnosticNavigation = {
  readonly bus: {
    emit: (
      event: "footer:tab-requested",
      payload: { reason?: string; tab: "engine" | "logs" | "mesh" | "telemetry" },
    ) => void;
  };
  readonly layout: Pick<KernelApi["layout"], "setFocusedSlot" | "setPanelVisible">;
};

export function openMeshBuildDiagnostics(kernel: MeshDiagnosticNavigation) {
  kernel.layout.setPanelVisible("bottom", true);
  kernel.layout.setFocusedSlot("panel-bottom");
  kernel.bus.emit("footer:tab-requested", {
    reason: "mesh-build",
    tab: "mesh",
  });
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
  const resourceData = useStudyRuntimeCommandResourceData();
  const commandContext = createCommandContext(state.source, kernel, {
    input: state.input,
    resourceData,
    sourceDetail: state.sourceDetail,
  });
  const runtimeStatus = useSessionStatusSelector(
    selectMeshBuildDialogRuntimeStatus,
    { enabled: state.open, isEqual: meshBuildDialogRuntimeStatusEquals },
  );
  const activeBuild = useMeshBuildCurrent({
    enabled: shouldLoadRuntimeMeshBuild(state.open, runtimeStatus),
  });
  const latestBuild = useMeshBuildLatestSuccessful({
    enabled: shouldLoadRuntimeMeshBuild(state.open, runtimeStatus),
  });
  const summary = useMeshSummaryResource({
    enabled: shouldLoadRuntimeMeshSummary(state.open, runtimeStatus),
  });
  const manifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadRuntimeMeshManifest(state.open, runtimeStatus),
  });
  const sharedQuality = useMeshSharedDomainQualityResource({
    enabled: state.open,
  });
  const activeRecord = asRecord(activeBuild.data?.active_build);
  const pipelinePhases = normalizeMeshPipelineStatus(activeBuild.data?.mesh_pipeline_status);
  const buildStatus = resolveMeshBuildStatusLabel(activeRecord, pipelinePhases);
  const diffRows = diffMeshPolicies({
    current: asRecord(summary.data?.effective_airbox_target),
    draft: asRecord(activeBuild.data?.effective_airbox_target),
    realized: asRecord(latestBuild.data?.effective_airbox_target),
    scope: "airbox",
  }).filter((row) => row.state !== "unchanged");
  const targetLabel =
    targetLabelForPendingCommand(state.commandId, state.input) ??
    targetLabelForBuild(activeBuild.data?.active_build);
  const currentSummary = [
    { label: "Mesh", value: manifest.data?.mesh_name ?? "not built" },
    {
      label: "Revision",
      value: String(summary.data?.revision ?? activeBuild.data?.revision ?? "unknown"),
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
  ];
  const newSummary = [
    { label: "Requested target", value: targetLabel },
    {
      label: "Command",
      value: state.commandId ?? "none",
    },
    {
      label: "Policy changes",
      value: diffRows.length === 0 ? "No pending policy diff" : String(diffRows.length),
    },
    {
      label: "Expected result",
      value: "New mesh revision, manifest, quality and viewport render",
    },
  ];
  const snapshotRows = buildMeshSnapshotRows({
    current: {
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
  }, [kernel.bus]);

  async function confirmBuild(): Promise<void> {
    if (!state.commandId) return;
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
            {state.phase === "post-build"
              ? "Mesh Build Complete"
              : state.phase === "error"
                ? "Mesh Build Failed"
                : "Mesh Build Confirmation"}
          </DialogTitle>
          <DialogDescription id="fm-mesh-build-dialog-description">
            Confirm the mesh target and parameter changes. Mesh Jobs tracks the long build log and pipeline.
          </DialogDescription>
        </DialogHeader>
        <div className="fm-dialog__body">
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
