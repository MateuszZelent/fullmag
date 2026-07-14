import type { LiveStatusResource } from "@/kernel/api/apiTypes";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";

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

export function useAirboxInspectorRuntimeStatus() {
  return useSessionStatusSelector(selectAirboxInspectorRuntimeStatus, {
    isEqual: airboxInspectorRuntimeStatusEquals,
  });
}
