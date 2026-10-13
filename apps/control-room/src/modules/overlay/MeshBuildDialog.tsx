"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { resumeMeshBuildObservation } from "@/kernel/authoring/geometryLifecycleCommandContributions";
import { initialMeshBuildDialogState, meshBuildDialogReducer } from "./mesh-build/meshBuildDialogState";
import {
  FDM_MESH_COMMAND_NOT_APPLICABLE_REASON,
  UNKNOWN_MESH_COMMAND_LANE_REASON,
  resolveMeshCommandLane,
  type MeshCommandLane,
} from "@/kernel/authoring/geometryLifecycleCommandContributions";
import {
  useSceneResource,
  useDomainMetaResource,
  useFdmRegionMembershipResource,
  useObjectMeshPolicyResource,
  useUniverseMeshPolicyResource,
  useMeshSharedDomainPolicyResource,
  useMeshBuildCurrent,
  useMeshBuildLatestSuccessful,
  useModelRegionDiagnosticsResource,
  useMeshSharedDomainQualityResource,
  useMeshSharedDomainManifestResource,
  useMeshSummaryResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { resolveActiveLaneOperation } from "@/kernel/resources/useActiveLaneCapabilities";
import { resolveSessionAuthoringDiscretization } from "@/kernel/resources/sessionDiscretization";
import type { JsonObject } from "@/kernel/api/apiTypes";
import type { KernelApi } from "@/kernel/types";
import { diffMeshPolicies } from "@/shared/domain/mesh/meshPolicyDiff";
import { buildMeshSnapshotRows } from "@/shared/domain/mesh/meshBuildSnapshots";
import { authoredObjectBounds } from "@/shared/domain/mesh/domainPresentation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import { Button } from "@/shared/ui/Button";
import { MeshBuildConfirmDialogContent } from "./mesh-build/MeshBuildConfirmDialog";
import { FdmGridBuildConfirmContent } from "./mesh-build/FdmGridBuildConfirmContent";
import { buildRegionMeshBuildReasonRows } from "./mesh-build/meshBuildRegionReasons";
import { openMeshBuildDiagnostics } from "./meshBuildDiagnosticsNavigation";
import {
  meshBuildDialogRuntimeStatusEquals,
  selectMeshBuildDialogRuntimeStatus,
} from "./MeshBuildDialogRuntimeStatus";

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

type MeshBuildDialogSnapshot = {
  requestId: string;
  sceneRevision: number;
  meshRevision: number;
  policyKey: string;
  policy: JsonObject | null;
  requestedPolicy: JsonObject | null;
  stats: {
    build: JsonObject | null;
    manifest: JsonObject | null;
    quality: JsonObject | null;
  };
};

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
  fdmGridRefreshReason?: string,
): string | null {
  if (lane === "fdm") {
    return (
      fdmGridRefreshReason ??
      "FDM grid and membership masks are rebuilt by an atomic execution-plan replan. Use Mesh → Build Grid."
    );
  }
  if (lane === "unknown") return UNKNOWN_MESH_COMMAND_LANE_REASON;
  return null;
}

export function MeshBuildDialog({ kernel }: { kernel: KernelApi }) {
  const [state, dispatch] = useReducer(meshBuildDialogReducer, initialMeshBuildDialogState);
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const [snapshotBefore, captureSnapshot] = useReducer(
    (_previous: MeshBuildDialogSnapshot | null, next: MeshBuildDialogSnapshot | null) => next,
    null,
  );

  const runtimeStatus = useSessionStatusSelector(
    selectMeshBuildDialogRuntimeStatus,
    { enabled: state.open, isEqual: meshBuildDialogRuntimeStatusEquals },
  );
  const lane = resolveMeshBuildDialogLane(
    resolveSessionAuthoringDiscretization(runtimeStatus),
  );
  const buildOperation = resolveActiveLaneOperation(
    runtimeStatus?.capabilities.active_lane ?? null,
    "shared_mesh_build",
  );
  const explicitFemLane = shouldLoadMeshBuildDialogFemResources(
    state.open,
    lane,
  );
  const unavailableMessage = meshBuildDialogUnavailableMessage(
    lane,
    runtimeStatus?.capabilities.active_lane?.operations.grid_build.reason,
  );
  const activeBuild = useMeshBuildCurrent({
    enabled: explicitFemLane,
  });
  const latestBuild = useMeshBuildLatestSuccessful({
    enabled: explicitFemLane,
  });
  const summary = useMeshSummaryResource({
    enabled: explicitFemLane,
  });
  const manifest = useMeshSharedDomainManifestResource({
    enabled: explicitFemLane,
  });
  const sharedQuality = useMeshSharedDomainQualityResource({
    enabled: explicitFemLane && state.open,
  });
  const regionDiagnostics = useModelRegionDiagnosticsResource({
    enabled: explicitFemLane && state.open,
  });

  const inputRecord = asRecord(state.request?.input);
  const target = asRecord(inputRecord?.mesh_target);
  const objectId = typeof target?.object_id === "string" ? target.object_id : null;
  const scene = useSceneResource({ enabled: state.open });
  const fdmDomain = useDomainMetaResource({ enabled: state.open && lane === "fdm" });
  const fdmMembership = useFdmRegionMembershipResource({ enabled: state.open && lane === "fdm" });
  const objectPolicy = useObjectMeshPolicyResource(objectId, { enabled: explicitFemLane && Boolean(objectId) });
  const universePolicy = useUniverseMeshPolicyResource({ enabled: explicitFemLane && !objectId });
  const sharedPolicy = useMeshSharedDomainPolicyResource({ enabled: explicitFemLane && !objectId });
  const requestedPolicy = useMemo(
    () =>
      objectId
        ? { override: objectPolicy.data?.config ?? null }
        : {
            shared_domain: sharedPolicy.data?.config ?? null,
            universe: universePolicy.data?.config ?? null,
          },
    [objectId, objectPolicy.data?.config, sharedPolicy.data?.config, universePolicy.data?.config],
  );
  const requestedPolicyKey = JSON.stringify(requestedPolicy);
  const sceneRevision = typeof scene.data?.revision === "number"
    ? scene.data.revision
    : typeof scene.data?.scene_revision === "number"
      ? scene.data.scene_revision
      : null;
  const policyLoaded = objectId ? objectPolicy.status === "ready"
    : universePolicy.status === "ready" && sharedPolicy.status === "ready";
  const computedSnapshot = useMemo(() => {
    if (lane === "fdm") {
      if (!state.request?.requestId || sceneRevision == null || !runtimeStatus) {
        return null;
      }
      return {
        requestId: state.request.requestId,
        sceneRevision,
        meshRevision: runtimeStatus.resources.mesh_revision,
        policyKey: requestedPolicyKey,
        policy: null,
        requestedPolicy: null,
        stats: {
          build: null,
          manifest: null,
          quality: null,
        },
      };
    }

    const isReadyOrNotBuilt = (resource: { status: string; error?: unknown }) => {
      if (resource.status === "ready") return true;
      if (resource.status === "error") {
        const err = resource.error as { code?: string } | null;
        const code = typeof err?.code === "string" ? err.code.toLowerCase() : "";
        if (
          code === "no_mesh_yet" ||
          code === "mesh_not_built" ||
          code === "mesh_not_found"
        ) {
          return true;
        }
      }
      return false;
    };

    if (
      !state.request?.requestId ||
      !policyLoaded ||
      sceneRevision == null ||
      !runtimeStatus ||
      !isReadyOrNotBuilt(summary) ||
      !isReadyOrNotBuilt(latestBuild) ||
      !isReadyOrNotBuilt(manifest) ||
      !isReadyOrNotBuilt(sharedQuality)
    ) {
      return null;
    }
    const previousSnapshot = asRecord(asRecord(latestBuild.data?.last_success)?.canonical_policy_snapshot);
    const previousPolicy = objectId
      ? previousSnapshot && { override: asRecord(previousSnapshot.objects)?.[objectId] ?? null }
      : previousSnapshot && { shared_domain: previousSnapshot.shared_domain, universe: previousSnapshot.universe };
    return {
      requestId: state.request.requestId,
      sceneRevision,
      meshRevision: runtimeStatus.resources.mesh_revision,
      policyKey: requestedPolicyKey,
      policy: asRecord(previousPolicy),
      requestedPolicy: asRecord(structuredClone(requestedPolicy)),
      stats: {
        build: latestBuild.status === "ready" ? asRecord(structuredClone(latestBuild.data)) : null,
        manifest: manifest.status === "ready" ? asRecord(structuredClone(manifest.data)) : null,
        quality: sharedQuality.status === "ready" ? asRecord(structuredClone(sharedQuality.data)) : null,
      },
    };
  }, [
    lane,
    state.request,
    policyLoaded,
    sceneRevision,
    runtimeStatus,
    summary,
    latestBuild,
    manifest,
    sharedQuality,
    objectId,
    requestedPolicy,
    requestedPolicyKey,
  ]);
  const stableSnapshotBefore = snapshotBefore ?? computedSnapshot;
  const snapshotCurrent = stableSnapshotBefore !== null
    && stableSnapshotBefore.sceneRevision === sceneRevision
    && stableSnapshotBefore.meshRevision === runtimeStatus?.resources.mesh_revision
    && stableSnapshotBefore.policyKey === requestedPolicyKey;
  const currentSnapshot = state.open ? stableSnapshotBefore : null;

  const diffRows = diffMeshPolicies({
    current: currentSnapshot?.policy,
    draft: currentSnapshot?.requestedPolicy,
    scope: objectId ? "object" : "shared-domain",
  });

  const tuple3 = (values: readonly number[] | null | undefined): [number, number, number] | null => {
    if (!values || values.length < 3) return null;
    const t = [values[0], values[1], values[2]];
    return t.every((v) => typeof v === "number" && Number.isFinite(v))
      ? (t as [number, number, number])
      : null;
  };

  const geometryBounds = useMemo(() => {
    const bounds = fdmDomain.data?.bounds;
    const min = tuple3(bounds?.min);
    const max = tuple3(bounds?.max);
    if (min && max) return { min, max };
    const objects = scene.data?.objects;
    if (!objects || objects.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let found = false;
    for (const obj of objects) {
      const b = authoredObjectBounds(obj);
      if (b) {
        found = true;
        minX = Math.min(minX, b.min[0]);
        minY = Math.min(minY, b.min[1]);
        minZ = Math.min(minZ, b.min[2]);
        maxX = Math.max(maxX, b.max[0]);
        maxY = Math.max(maxY, b.max[1]);
        maxZ = Math.max(maxZ, b.max[2]);
      }
    }
    return found
      ? {
          min: [minX, minY, minZ] as [number, number, number],
          max: [maxX, maxY, maxZ] as [number, number, number],
        }
      : null;
  }, [fdmDomain.data?.bounds, scene.data?.objects]);

  const gridSpacing = tuple3(fdmDomain.data?.grid?.spacing);
  const gridShape = tuple3(fdmDomain.data?.grid?.shape);
  const gridTotalCells = gridShape ? gridShape[0] * gridShape[1] * gridShape[2] : null;
  const gridMemoryMB = gridTotalCells != null ? (gridTotalCells * 4) / (1024 * 1024) : null;

  const targetLabel =
    targetLabelForPendingCommand(state.request?.commandId, state.request?.input) ??
    targetLabelForBuild(activeBuild.data?.active_build);
  const currentSummary = explicitFemLane
    ? [
        { label: "Mesh", value: text(currentSnapshot?.stats.manifest?.mesh_name, "not built") },
        { label: "Mesh revision", value: String(currentSnapshot?.meshRevision ?? "loading") },
        { label: "Scene revision", value: String(currentSnapshot?.sceneRevision ?? "loading") },
        { label: "Previous authored configuration", value: currentSnapshot?.policy ? "available" : "unavailable for this build" },
      ]
    : [{ label: "Mesh lane", value: lane === "fdm" ? "FDM structured grid" : "unresolved" }];
  const regionReasonRows = buildRegionMeshBuildReasonRows(regionDiagnostics.data);
  const newSummary = explicitFemLane
    ? [
        { label: "Requested target", value: targetLabel },
        {
          label: "Command",
          value: state.request?.commandId ?? "none",
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
          value: "New mesh revision; magnetization reinitialized from the authored model",
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
      const previous = stateRef.current;
      if (previous.request?.requestId && previous.phase === "pre-build") {
        kernel.bus.emit("mesh:build-confirm-resolved", { requestId: previous.request.requestId, confirmed: false });
      }
      captureSnapshot(null);
      dispatch({ type: "request", request });
    });
    const offRestore = kernel.bus.on("mesh:build-observation-requested", (event) => { captureSnapshot(null); dispatch({ type: "restore", event }); });
    const offSubmitted = kernel.bus.on("mesh:build-submitted", (event) => dispatch({ type: "accepted", event }));
    const offObserved = kernel.bus.on("mesh:build-observed", (event) => dispatch({ type: "observed", event }));
    const offRendered = kernel.bus.on("mesh:topology-rendered", (event) => dispatch({ type: "rendered", revision: event.meshRevision }));
    return () => { offRequested(); offRestore(); offSubmitted(); offObserved(); offRendered(); };
  }, [kernel.bus]);

  useEffect(() => {
    if (state.phase === "pre-build" && snapshotBefore === null && computedSnapshot !== null) {
      captureSnapshot(computedSnapshot);
    }
  }, [computedSnapshot, snapshotBefore, state.phase]);

  function closeDialog(): void {
    if (state.phase === "pre-build" && state.request?.requestId) {
      kernel.bus.emit("mesh:build-confirm-resolved", { requestId: state.request.requestId, confirmed: false });
    }
    dispatch({ open: false, type: "open" });
  }

  function confirmBuild(): void {
    if (!state.request?.requestId || !stableSnapshotBefore || !snapshotCurrent || !buildOperation.enabled || state.phase !== "pre-build") return;
    dispatch({ type: "submitting" });
    kernel.bus.emit("mesh:build-confirm-resolved", { requestId: state.request.requestId, confirmed: true, precondition: { scene_revision: stableSnapshotBefore.sceneRevision, mesh_revision: stableSnapshotBefore.meshRevision } });
  }

  return (
    <Dialog
      open={state.open}
      onOpenChange={(open) => { if (!open) closeDialog(); }}
    >
      <DialogContent
        aria-describedby="fm-mesh-build-dialog-description"
        className="fm-mesh-build-confirm-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {lane === "fdm" && (state.request?.commandId === "grid.build-fdm" || state.acceptedCommandId === "grid.build-fdm")
              ? state.phase === "post-build"
                ? "FDM Grid Build Complete"
                : state.phase === "error"
                  ? "FDM Grid Build Failed"
                  : "FDM Grid Build Confirmation"
              : !explicitFemLane
              ? lane === "fdm"
                ? "FDM Grid & Mask Refresh"
                : "FEM Mesh Controls Unavailable"
              : state.phase === "post-build"
              ? "Mesh Build Complete"
              : state.phase === "error"
                ? "Mesh Build Failed"
                : "Mesh Build Confirmation"}
          </DialogTitle>
          <DialogDescription id="fm-mesh-build-dialog-description">
            {lane === "fdm" && (state.request?.commandId === "grid.build-fdm" || state.acceptedCommandId === "grid.build-fdm")
              ? "Confirm the structured grid resolution and source scene geometry before execution."
              : explicitFemLane
              ? "Confirm the mesh target and parameter changes. Mesh Jobs tracks the long build log and pipeline."
              : unavailableMessage}
          </DialogDescription>
        </DialogHeader>
        <div className="fm-dialog__body">
          {explicitFemLane ? (
            <MeshBuildConfirmDialogContent
              commandId={state.acceptedCommandId ?? state.request?.commandId ?? null}
              commandStatus={state.lastCommandStatus}
              currentSummary={currentSummary}
              diffRows={diffRows}
              errorMessage={state.errorMessage}
              mode={state.phase}
              ready={snapshotCurrent && buildOperation.enabled}
              stale={stableSnapshotBefore !== null && !snapshotCurrent}
              onRefresh={() => {
                captureSnapshot(null);
                if (state.request) dispatch({ type: "request", request: state.request });
              }}
              onResumeObservation={() => {
                dispatch({ type: "submitting" });
                void resumeMeshBuildObservation(createCommandContext(state.request?.source ?? "inspector", kernel));
              }}
              rendered={state.lastCommandStatus === "rendered"}
              newSummary={newSummary}
              postBuildRows={snapshotRows}
              targetLabel={targetLabel}
              onApplyBuild={() => {
                void confirmBuild();
              }}
              onCancel={closeDialog}
              onOpenMeshJobs={() => openMeshBuildDiagnostics(kernel)}
            />
          ) : lane === "fdm" && (state.request?.commandId === "grid.build-fdm" || state.acceptedCommandId === "grid.build-fdm") ? (
            <FdmGridBuildConfirmContent
              commandId={state.acceptedCommandId ?? state.request?.commandId ?? "grid.build-fdm"}
              commandStatus={state.lastCommandStatus}
              errorMessage={state.errorMessage}
              geometryBounds={geometryBounds}
              gridMemoryMB={gridMemoryMB}
              gridShape={gridShape}
              gridSpacing={gridSpacing}
              membershipRevision={fdmMembership.data?.region_membership_revision ?? null}
              mode={state.phase}
              objectsCount={scene.data?.objects?.length ?? 0}
              onApplyBuild={() => {
                void confirmBuild();
              }}
              onCancel={closeDialog}
              onOpenMeshOverview={() => {
                closeDialog();
                openMeshBuildDiagnostics(kernel);
              }}
              ready={snapshotCurrent && buildOperation.enabled}
              rendered={state.lastCommandStatus === "rendered"}
              sceneRevision={sceneRevision}
              stale={stableSnapshotBefore !== null && !snapshotCurrent}
              totalCells={gridTotalCells}
            />
          ) : (
            <section
               aria-label={
                lane === "fdm"
                  ? "FDM grid and mask refresh unavailable"
                  : "FEM mesh controls unavailable"
               }
               className="fm-mesh-build-confirm__section fm-mesh-build-confirm__banner"
               data-command-unavailable-reason={
                 lane === "fdm"
                   ? FDM_MESH_COMMAND_NOT_APPLICABLE_REASON
                   : UNKNOWN_MESH_COMMAND_LANE_REASON
               }
             >
              <h3 className="fm-mesh-build-confirm__section-title">
                {lane === "fdm"
                  ? "Structured-grid lifecycle"
                  : "Structured-grid lane"}
              </h3>
              <p className="fm-mesh-build-confirm__empty">
                {unavailableMessage}
              </p>
              {lane === "fdm" ? (
                <p className="fm-mesh-build-confirm__empty">
                  Grid dimensions and membership masks are materialized by the
                  resolved execution plan; this dialog never substitutes FEM
                  mesh policy controls for them.
                </p>
              ) : null}
              <div className="fm-mesh-build-confirm__actions">
                <Button
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={closeDialog}
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
  commandId: string | undefined,
  input: unknown,
): string | null {
  if (commandId === "mesh.build-shared-domain") return "Shared-domain mesh";
  if (commandId === "grid.build-fdm") return "FDM structured grid & masks";
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
