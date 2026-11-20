import { resolveSessionAuthoringDiscretization, type SessionDiscretizationCapabilitiesProjection } from "@/kernel/resources/sessionDiscretization";
import type { LiveStatusResource } from "@/kernel/api/apiTypes";

export type ExplorerModelRuntimeStatus = {
  capabilities: Pick<LiveStatusResource["capabilities"], "explicit_topology"> &
    SessionDiscretizationCapabilitiesProjection;
  domain: Pick<LiveStatusResource["domain"], "discretization"> &
    Partial<Pick<LiveStatusResource["domain"], "cell_count" | "generation_id">>;
  resources: Pick<
    LiveStatusResource["resources"],
    "mesh_build_revision" | "mesh_revision" | "stages_revision"
  > &
    Partial<
      Pick<
        LiveStatusResource["resources"],
        "domain_generation_id" | "topology_revision"
      >
    >;
};

export function explorerModelRuntimeStatusEquals(
  previous: ExplorerModelRuntimeStatus | null,
  next: ExplorerModelRuntimeStatus | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  return (
    previous.capabilities.explicit_topology ===
      next.capabilities.explicit_topology &&
    Object.prototype.hasOwnProperty.call(
      previous.capabilities,
      "active_lane",
    ) === Object.prototype.hasOwnProperty.call(next.capabilities, "active_lane") &&
    Object.prototype.hasOwnProperty.call(previous.capabilities.active_lane ?? {}, "authored") ===
      Object.prototype.hasOwnProperty.call(next.capabilities.active_lane ?? {}, "authored") &&
    previous.capabilities.active_lane?.authored?.backend === next.capabilities.active_lane?.authored?.backend &&
    previous.capabilities.active_lane?.authored?.discretization === next.capabilities.active_lane?.authored?.discretization &&
    previous.capabilities.active_lane?.resolved?.discretization ===
      next.capabilities.active_lane?.resolved?.discretization &&
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
    previous.domain.discretization === next.domain.discretization &&
    previous.domain.cell_count === next.domain.cell_count &&
    previous.domain.generation_id === next.domain.generation_id &&
    previous.resources.domain_generation_id ===
      next.resources.domain_generation_id &&
    previous.resources.mesh_build_revision ===
      next.resources.mesh_build_revision &&
    previous.resources.mesh_revision === next.resources.mesh_revision &&
    previous.resources.stages_revision === next.resources.stages_revision &&
    previous.resources.topology_revision === next.resources.topology_revision
  );
}

export function resolveExplorerModelDiscretization({
  activeLaneDiscretization,
  domainDiscretization,
}: {
  activeLaneDiscretization: string | null | undefined;
  domainDiscretization: string | null | undefined;
}): "fdm" | "fem" | null {
  return resolveSessionAuthoringDiscretization({
    ...(activeLaneDiscretization !== undefined
      ? { capabilities: { active_lane_discretization: activeLaneDiscretization } }
      : {}),
    domain: { discretization: domainDiscretization },
  });
}
