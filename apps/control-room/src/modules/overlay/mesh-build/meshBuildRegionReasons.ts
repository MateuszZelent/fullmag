import type { RegionDiagnosticsResource } from "@/kernel/api/apiTypes";
import type { MeshBuildSummaryRow } from "./MeshBuildConfirmDialog";

export function buildRegionMeshBuildReasonRows(
  resource: RegionDiagnosticsResource | null | undefined,
): MeshBuildSummaryRow[] {
  const meshPolicyDiagnostics =
    resource?.diagnostics.filter(
      (diagnostic) =>
        diagnostic.capability_gate === "regions.mesh_policy" &&
        (diagnostic.severity === "warning" || diagnostic.severity === "error"),
    ) ?? [];
  if (meshPolicyDiagnostics.length === 0) return [];

  const regionCount = new Set(
    meshPolicyDiagnostics.map((diagnostic) => diagnostic.region_id),
  ).size;
  return [
    {
      label: "Rebuild reasons",
      value:
        regionCount === 1
          ? "region mesh policy changed"
          : `${regionCount} region mesh policies changed`,
    },
  ];
}
