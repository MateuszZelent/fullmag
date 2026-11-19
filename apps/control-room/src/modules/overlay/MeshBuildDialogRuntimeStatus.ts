import {
  projectFlatActiveLaneDiscretization,
  type SessionDiscretizationCapabilitiesProjection,
} from "@/kernel/resources/sessionDiscretization";
import type { LiveStatusResource } from "@/kernel/api/apiTypes";

export type MeshBuildDialogRuntimeStatus = {
  capabilities: Pick<LiveStatusResource["capabilities"], "explicit_topology"> &
    SessionDiscretizationCapabilitiesProjection & {
      active_lane?: LiveStatusResource["capabilities"]["active_lane"] | null;
    };
  domain: Pick<LiveStatusResource["domain"], "discretization">;
  resources: Pick<
    LiveStatusResource["resources"],
    "mesh_build_revision" | "mesh_revision" | "scene_revision"
  >;
};

export function selectMeshBuildDialogRuntimeStatus(status: {
  data: LiveStatusResource | null;
}): MeshBuildDialogRuntimeStatus | null {
  if (!status.data) return null;
  const sourceCapabilities = status.data.capabilities;
  const flatLane = projectFlatActiveLaneDiscretization(sourceCapabilities);
  const capabilities: MeshBuildDialogRuntimeStatus["capabilities"] = {
    explicit_topology: sourceCapabilities?.explicit_topology ?? false,
  };
  if (
    Object.prototype.hasOwnProperty.call(sourceCapabilities ?? {}, "active_lane")
  ) {
    capabilities.active_lane = sourceCapabilities?.active_lane ?? null;
  }
  if (flatLane) capabilities.active_lane_discretization = flatLane.value;
  return {
    capabilities,
    domain: {
      discretization: status.data.domain.discretization,
    },
    resources: {
      mesh_build_revision: status.data.resources.mesh_build_revision,
      mesh_revision: status.data.resources.mesh_revision,
      scene_revision: status.data.resources.scene_revision,
    },
  };
}

export function meshBuildDialogRuntimeStatusEquals(
  previous: MeshBuildDialogRuntimeStatus | null,
  next: MeshBuildDialogRuntimeStatus | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  const previousActiveLane = previous.capabilities.active_lane;
  const nextActiveLane = next.capabilities.active_lane;
  return (
    previous.capabilities.explicit_topology ===
      next.capabilities.explicit_topology &&
    Object.prototype.hasOwnProperty.call(
      previous.capabilities,
      "active_lane",
    ) === Object.prototype.hasOwnProperty.call(next.capabilities, "active_lane") &&
    Object.prototype.hasOwnProperty.call(previousActiveLane ?? {}, "authored") ===
      Object.prototype.hasOwnProperty.call(nextActiveLane ?? {}, "authored") &&
    previousActiveLane?.authored?.backend === nextActiveLane?.authored?.backend &&
    previousActiveLane?.authored?.discretization === nextActiveLane?.authored?.discretization &&
    previousActiveLane?.resolved?.discretization ===
      nextActiveLane?.resolved?.discretization &&
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
    previousActiveLane?.operations?.grid_build?.reason ===
      nextActiveLane?.operations?.grid_build?.reason &&
    previousActiveLane?.operations?.grid_build?.state ===
      nextActiveLane?.operations?.grid_build?.state &&
    previousActiveLane?.operations?.shared_mesh_build?.state ===
      nextActiveLane?.operations?.shared_mesh_build?.state &&
    previous.domain.discretization === next.domain.discretization &&
    previous.resources.mesh_build_revision ===
      next.resources.mesh_build_revision &&
    previous.resources.mesh_revision === next.resources.mesh_revision &&
    previous.resources.scene_revision === next.resources.scene_revision
  );
}
