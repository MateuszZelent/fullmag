import type { MeshSharedDomainManifestResource } from "@/kernel/api/apiTypes";
import {
  resolveSessionTopologyDiscretization,
  type SessionDiscretizationStatus,
} from "./sessionDiscretization";

/**
 * Checks that a published FEM manifest belongs to the current live topology
 * identity. This identifies inspectable topology only; it does not resolve
 * solver execution or enable runtime capabilities.
 */
export function matchesAirboxTopologyIdentity(
  status: SessionDiscretizationStatus | null | undefined,
  manifest: MeshSharedDomainManifestResource | null | undefined,
): boolean {
  if (!manifest || resolveSessionTopologyDiscretization(status) !== "fem") {
    return false;
  }
  const generationId = status?.domain?.generation_id;
  const cellCount = status?.domain?.cell_count;
  const domainGenerationId = status?.resources?.domain_generation_id;
  const meshRevision = status?.resources?.mesh_revision;
  const topologyRevision = status?.resources?.topology_revision;
  return (
    typeof generationId === "string" && generationId.length > 0 &&
    generationId === domainGenerationId &&
    generationId === manifest.generation_id &&
    typeof cellCount === "number" && Number.isSafeInteger(cellCount) && cellCount > 0 &&
    typeof meshRevision === "number" && Number.isSafeInteger(meshRevision) && meshRevision > 0 &&
    typeof topologyRevision === "number" && Number.isSafeInteger(topologyRevision) && topologyRevision > 0 &&
    String(manifest.revision) === String(meshRevision)
  );
}
