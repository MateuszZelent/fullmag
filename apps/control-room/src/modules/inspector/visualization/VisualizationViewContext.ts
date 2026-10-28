import type { Selection } from "@/kernel/selection/selectionTypes";
import type { PlanarViewScopeState } from "@/kernel/api/apiTypes";

export type VisualizationViewContext = "planar" | "three-d";

export function resolveVisualizationViewContext(
  activeViewportMainModuleId: string,
  previous: VisualizationViewContext = "three-d",
): VisualizationViewContext {
  if (activeViewportMainModuleId === "field-map") return "planar";
  if (activeViewportMainModuleId === "viewport-3d") return "three-d";
  return previous;
}

export function planarVisualizationCoverage(selection: Selection): {
  supported: boolean;
  targetKind: string;
} {
  const kind = selection.kind ?? "";
  if (kind === "scene" || kind === "universe") {
    return { supported: true, targetKind: "domain" };
  }
  if (kind.includes("airbox")) {
    return { supported: true, targetKind: "airbox" };
  }
  if (kind.includes("region")) {
    return { supported: true, targetKind: "region" };
  }
  if (kind.includes("part") || kind.includes("mesh")) {
    return { supported: true, targetKind: "mesh_part" };
  }
  if (
    kind.includes("object") ||
    kind.includes("field") ||
    kind.includes("mode") ||
    kind.includes("monitor")
  ) {
    return { supported: true, targetKind: kind.includes("monitor") ? "monitor" : "spatial" };
  }
  return { supported: false, targetKind: "unsupported" };
}

export function planarViewScopeForSelection(
  selection: Selection,
): PlanarViewScopeState {
  if (selection.ref?.type === "mesh-part") {
    return {
      kind: "mesh_part",
      scope_id: selection.ref.carrierPartId ?? selection.ref.nodeId,
    };
  }
  if (
    selection.ref?.type === "fdm-domain" &&
    selection.ref.scope === "layer" &&
    selection.ref.layerId
  ) {
    return { kind: "layer", scope_id: selection.ref.layerId };
  }
  if (
    selection.ref?.type === "airbox" ||
    selection.kind?.includes("airbox")
  ) {
    return { kind: "airbox" };
  }
  // P1-03: an object region (scene object or FDM region node) scopes the 2D
  // view to that region; region ids are scoped by their owner object.
  const ref = selection.ref;
  if (
    ref &&
    ((ref.type === "scene-object") ||
      (ref.type === "fdm-domain" && ref.scope === "region")) &&
    ref.objectId &&
    ref.regionId
  ) {
    return { kind: "region", scope_id: ref.objectId, region_id: ref.regionId };
  }
  return { kind: "monitor_target" };
}
