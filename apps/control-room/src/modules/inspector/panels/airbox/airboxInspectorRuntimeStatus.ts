import type { LiveStatusResource } from "@/kernel/api/apiTypes";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { isExplicitFdmStudy } from "../StudyGlobalAuthoringModel";

export type AirboxInspectorRuntimeStatus = {
  capabilities: Pick<LiveStatusResource["capabilities"], "explicit_topology">;
  domain: Pick<LiveStatusResource["domain"], "discretization">;
  resources: Pick<
    LiveStatusResource["resources"],
    "mesh_build_revision" | "mesh_revision"
  >;
};

export function selectAirboxInspectorRuntimeStatus(status: {
  data: LiveStatusResource | null;
}): AirboxInspectorRuntimeStatus | null {
  if (!status.data) return null;
  return {
    capabilities: {
      explicit_topology: status.data.capabilities?.explicit_topology ?? false,
    },
    domain: {
      discretization: status.data.domain?.discretization ?? "",
    },
    resources: {
      mesh_build_revision: status.data.resources.mesh_build_revision,
      mesh_revision: status.data.resources.mesh_revision,
    },
  };
}

export function airboxInspectorRuntimeStatusEquals(
  previous: AirboxInspectorRuntimeStatus | null,
  next: AirboxInspectorRuntimeStatus | null,
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

/**
 * Airbox mesh controls are FEM-only. FDM is selected only from an explicit
 * current-session lane; missing or errored status must not be interpreted as
 * FDM (or as a reason to hide FEM controls).
 */
export function isExplicitFdmAirboxRuntime(
  status: AirboxInspectorRuntimeStatus | null | undefined,
): boolean {
  return isExplicitFdmStudy({
    sessionDiscretization: status?.domain.discretization,
  });
}

export type AirboxInspectorLane = "conflict" | "fdm" | "fem";

export function resolveAirboxInspectorLane(
  selection: Selection,
  status: AirboxInspectorRuntimeStatus | null | undefined,
): AirboxInspectorLane {
  const selectionLane =
    selection.ref?.type === "airbox"
      ? selection.ref.visualizationTargetId === "fdm-universe-outside-support"
        ? "fdm"
        : "fem"
      : null;
  const discretization = status?.domain.discretization.trim().toLowerCase();
  const runtimeLane =
    discretization === "fdm" || discretization === "fem"
      ? discretization
      : null;

  if (selectionLane && runtimeLane && selectionLane !== runtimeLane) {
    return "conflict";
  }
  return selectionLane ?? runtimeLane ?? "fem";
}

export function useAirboxInspectorRuntimeStatus() {
  return useSessionStatusSelector(selectAirboxInspectorRuntimeStatus, {
    isEqual: airboxInspectorRuntimeStatusEquals,
  });
}
