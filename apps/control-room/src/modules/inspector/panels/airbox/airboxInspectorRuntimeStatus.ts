import type { LiveStatusResource } from "@/kernel/api/apiTypes";
import {
  describeSessionAuthoringDiscretization,
  projectFlatActiveLaneDiscretization,
  resolveSessionDiscretization,
  resolveSessionTopologyDiscretization,
  type SessionAuthoringMethodDescription,
  type SessionDiscretizationCapabilitiesProjection,
} from "@/kernel/resources/sessionDiscretization";
import { shouldLoadRuntimeMeshManifest } from "@/kernel/resources/studyRuntimeResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { isExplicitFdmStudy } from "../StudyGlobalAuthoringModel";

export { matchesAirboxTopologyIdentity } from "@/kernel/resources/meshTopologyIdentity";

export type AirboxInspectorRuntimeStatus = {
  authoring: SessionAuthoringMethodDescription;
  executionState?: string;
  capabilities: Pick<LiveStatusResource["capabilities"], "explicit_topology"> &
    SessionDiscretizationCapabilitiesProjection;
  domain: Pick<
    LiveStatusResource["domain"],
    "cell_count" | "discretization" | "generation_id"
  >;
  resources: Pick<
    LiveStatusResource["resources"],
    | "domain_generation_id"
    | "mesh_build_revision"
    | "mesh_revision"
    | "topology_revision"
  >;
};

export function selectAirboxInspectorRuntimeStatus(status: {
  data: LiveStatusResource | null;
}): AirboxInspectorRuntimeStatus | null {
  if (!status.data) return null;
  const sourceCapabilities = status.data.capabilities;
  const flatLane = projectFlatActiveLaneDiscretization(sourceCapabilities);
  const hasActiveLane = Object.prototype.hasOwnProperty.call(
    sourceCapabilities ?? {},
    "active_lane",
  );
  return {
    authoring: describeSessionAuthoringDiscretization(status.data),
    executionState: status.data.lifecycle?.solver ?? "unknown",
    capabilities: {
      explicit_topology: status.data.capabilities?.explicit_topology ?? false,
      ...(hasActiveLane
        ? { active_lane: sourceCapabilities?.active_lane ?? null }
        : {}),
      ...(flatLane ? { active_lane_discretization: flatLane.value } : {}),
    },
    domain: {
      cell_count: status.data.domain?.cell_count,
      discretization: status.data.domain?.discretization ?? "",
      generation_id: status.data.domain?.generation_id,
    },
    resources: {
      domain_generation_id: status.data.resources.domain_generation_id,
      mesh_build_revision: status.data.resources.mesh_build_revision,
      mesh_revision: status.data.resources.mesh_revision,
      topology_revision: status.data.resources.topology_revision,
    },
  };
}

export function airboxInspectorRuntimeStatusEquals(
  previous: AirboxInspectorRuntimeStatus | null,
  next: AirboxInspectorRuntimeStatus | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  const previousLane = previous.capabilities.active_lane;
  const nextLane = next.capabilities.active_lane;
  const previousHasAuthored = Boolean(
    previousLane && Object.prototype.hasOwnProperty.call(previousLane, "authored"),
  );
  const nextHasAuthored = Boolean(
    nextLane && Object.prototype.hasOwnProperty.call(nextLane, "authored"),
  );
  return (
    previous.executionState === next.executionState &&
    previous.authoring.method === next.authoring.method &&
    previous.authoring.state === next.authoring.state &&
    previous.authoring.reason === next.authoring.reason &&
    Object.prototype.hasOwnProperty.call(
      previous.capabilities,
      "active_lane",
    ) === Object.prototype.hasOwnProperty.call(next.capabilities, "active_lane") &&
    previous.capabilities.active_lane?.resolved?.discretization ===
      next.capabilities.active_lane?.resolved?.discretization &&
    previousHasAuthored === nextHasAuthored &&
    previousLane?.authored?.backend === nextLane?.authored?.backend &&
    previousLane?.authored?.discretization === nextLane?.authored?.discretization &&
    Object.prototype.hasOwnProperty.call(
      previous.capabilities,
      "active_lane_discretization",
    ) ===
      Object.prototype.hasOwnProperty.call(
        next.capabilities,
        "active_lane_discretization",
      ) &&
    previous.capabilities.active_lane_discretization ===
      next.capabilities.active_lane_discretization &&
    previous.capabilities.explicit_topology ===
      next.capabilities.explicit_topology &&
    previous.domain.cell_count === next.domain.cell_count &&
    previous.domain.discretization === next.domain.discretization &&
    previous.domain.generation_id === next.domain.generation_id &&
    previous.resources.domain_generation_id ===
      next.resources.domain_generation_id &&
    previous.resources.mesh_build_revision ===
      next.resources.mesh_build_revision &&
    previous.resources.mesh_revision === next.resources.mesh_revision &&
    previous.resources.topology_revision === next.resources.topology_revision
  );
}

/**
 * A published FEM topology can be inspected while runtime resolution is
 * pending only when the thin status snapshot carries a complete matching
 * generation/cell/revision identity. This projection never resolves solver
 * capabilities or enables build/solve commands.
 */
export function hasPublishedFemTopologyInspectionLane(
  status: AirboxInspectorRuntimeStatus | null | undefined,
): boolean {
  return (
    status?.authoring.method === "fem" &&
    resolveSessionDiscretization(status) === null &&
    resolveSessionTopologyDiscretization(status) === "fem"
  );
}

export function shouldLoadAirboxMeshManifest(
  enabled: boolean,
  status: AirboxInspectorRuntimeStatus | null | undefined,
): boolean {
  return (
    shouldLoadRuntimeMeshManifest(enabled, status) ||
    (enabled && hasPublishedFemTopologyInspectionLane(status))
  );
}

/**
 * Airbox mesh controls are lane-specific. Missing or unresolved session mode
 * remains unresolved instead of inferring a solver lane from DomainMeta.
 */
export function isExplicitFdmAirboxRuntime(
  status: AirboxInspectorRuntimeStatus | null | undefined,
): boolean {
  const discretization = resolveSessionDiscretization(status);
  return isExplicitFdmStudy({
    sessionDiscretization: discretization,
  });
}

export function isExplicitFemAirboxRuntime(
  status: AirboxInspectorRuntimeStatus | null | undefined,
): boolean {
  return resolveSessionDiscretization(status) === "fem";
}

export type AirboxInspectorLane = "conflict" | "fdm" | "fem" | "unresolved";

export function resolveAirboxInspectorLane(
  selection: Selection,
  status: AirboxInspectorRuntimeStatus | null | undefined,
): AirboxInspectorLane {
  const selectionLane =
    selection.ref?.type === "airbox"
      ? selection.kind === "airbox.multilayer.target" ||
        selection.kind === "mesh.grid.universe-outside-support"
        ? "fdm"
        : null
      : null;
  const runtimeLane = resolveSessionDiscretization(status);
  if (runtimeLane === null) return "unresolved";

  if (selectionLane && runtimeLane && selectionLane !== runtimeLane) {
    return "conflict";
  }
  return runtimeLane;
}

export function resolveAirboxInspectorAuthoringLane(
  selection: Selection,
  status: AirboxInspectorRuntimeStatus | null | undefined,
): "conflict" | "fdm" | "fem" | "unresolved" {
  const authoredLane = status?.authoring.method ?? null;
  if (authoredLane === null) return "unresolved";

  const selectionLane =
    selection.ref?.type === "airbox" &&
    (selection.kind === "airbox.multilayer.target" ||
      selection.kind === "mesh.grid.universe-outside-support")
      ? "fdm"
      : null;
  return selectionLane && selectionLane !== authoredLane
    ? "conflict"
    : authoredLane;
}

export function useAirboxInspectorRuntimeStatus() {
  return useSessionStatusSelector(selectAirboxInspectorRuntimeStatus, {
    isEqual: airboxInspectorRuntimeStatusEquals,
  });
}
