import type { FieldVectorQuery } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

export function resolveViewport3DFieldQuery(
  selection: Selection,
): FieldVectorQuery {
  if (selection.kind === "mesh-part" && selection.nodeId) {
    return {
      component: "full",
      scope_id: selection.nodeId,
      scope_kind: "part",
    };
  }

  if (selection.objectId) {
    return {
      component: "full",
      scope_id: selection.objectId,
      scope_kind: "object",
    };
  }

  return {
    component: "full",
    scope_kind: "full",
  };
}
