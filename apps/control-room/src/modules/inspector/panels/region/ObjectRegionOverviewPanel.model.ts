import type { MeshInspectorLane } from "../fdmMeshInspectorModel";

export interface ObjectRegionOverviewLaneView {
  inlineDiagnostics: boolean;
  realization: MeshInspectorLane;
}

export function resolveObjectRegionOverviewLaneView(
  meshLane: MeshInspectorLane = "unknown",
): ObjectRegionOverviewLaneView {
  if (meshLane === "fem") {
    return { inlineDiagnostics: true, realization: "fem" };
  }
  if (meshLane === "fdm") {
    return { inlineDiagnostics: false, realization: "fdm" };
  }
  return { inlineDiagnostics: false, realization: "unknown" };
}
