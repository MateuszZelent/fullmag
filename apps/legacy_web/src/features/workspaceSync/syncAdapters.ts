import type { SelectionTarget } from "../../../features/interaction/model/selection";
import type {
  CrossSurfaceSelectionState,
  SelectionIdentity,
  SelectionSourceSurface,
} from "./contracts";
import { EMPTY_CROSS_SURFACE_SELECTION, reduceCrossSurfaceSelection } from "./contracts";

export interface ControlRoomSelectionSnapshot {
  selectedObjectId: string | null;
  selectedEntityId: string | null;
  selectedSidebarNodeId: string | null;
  sourceSurface?: SelectionSourceSurface;
}

export function selectionIdentityFromInteractionTarget(
  target: SelectionTarget | null | undefined,
): SelectionIdentity {
  if (!target) {
    return { kind: "none", id: null };
  }
  switch (target.kind) {
    case "object":
    case "object_geometry":
    case "object_material":
    case "physics_stack":
    case "magnetic_parameters":
    case "regions":
      return { kind: "scene_object", id: target.objectId };
    case "mesh_domain":
      if (target.scope === "object" && target.objectId) {
        return { kind: "scene_object", id: target.objectId };
      }
      return { kind: "mesh_part", id: target.scope };
    case "builder_primitive":
    case "builder_primitive_params":
    case "builder_primitive_transform":
      return { kind: "primitive", id: target.primitiveId };
    default:
      return { kind: "none", id: null };
  }
}

export function selectionFromControlRoomState(
  snapshot: ControlRoomSelectionSnapshot,
): CrossSurfaceSelectionState {
  if (snapshot.selectedEntityId) {
    return reduceCrossSurfaceSelection(EMPTY_CROSS_SURFACE_SELECTION, {
      primary: { kind: "mesh_part", id: snapshot.selectedEntityId },
      sourceSurface: snapshot.sourceSurface ?? "viewport3d",
      mappedSceneObjectId: snapshot.selectedObjectId,
      multi: snapshot.selectedObjectId
        ? [{ kind: "scene_object", id: snapshot.selectedObjectId }]
        : [],
    });
  }
  if (snapshot.selectedObjectId) {
    return reduceCrossSurfaceSelection(EMPTY_CROSS_SURFACE_SELECTION, {
      primary: { kind: "scene_object", id: snapshot.selectedObjectId },
      sourceSurface: snapshot.sourceSurface ?? "geometry",
      mappedSceneObjectId: snapshot.selectedObjectId,
    });
  }
  if (snapshot.selectedSidebarNodeId?.startsWith("builder-prim-")) {
    const primitiveId = snapshot.selectedSidebarNodeId.slice("builder-prim-".length).split("/")[0] ?? null;
    return reduceCrossSurfaceSelection(EMPTY_CROSS_SURFACE_SELECTION, {
      primary: { kind: "primitive", id: primitiveId },
      sourceSurface: snapshot.sourceSurface ?? "geometry",
      mappedSceneObjectId: null,
    });
  }
  return EMPTY_CROSS_SURFACE_SELECTION;
}
