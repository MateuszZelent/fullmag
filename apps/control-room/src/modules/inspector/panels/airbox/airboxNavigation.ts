import type { SelectionController } from "@/kernel/selection/SelectionController";
import type { Selection } from "@/kernel/selection/selectionTypes";

export const AIRBOX_INSPECTOR_ROUTES = {
  meshBuild: {
    kind: "airbox.mesh.build",
    label: "Mesh Build",
    nodeId: "model:airbox:mesh:build",
  },
  meshParameters: {
    kind: "airbox.mesh.parameters",
    label: "Mesh Parameters",
    nodeId: "model:airbox:mesh:parameters",
  },
  visualization: {
    kind: "airbox.visualization",
    label: "Visualization",
    nodeId: "model:airbox:visualization",
  },
} as const;

export type AirboxInspectorRoute = keyof typeof AIRBOX_INSPECTOR_ROUTES;

export function airboxRouteSelection(
  route: AirboxInspectorRoute,
): Partial<Omit<Selection, "moduleSource">> {
  const target = AIRBOX_INSPECTOR_ROUTES[route];
  return {
    kind: target.kind,
    label: target.label,
    nodeId: target.nodeId,
    objectId: null,
    ref: {
      kind: target.kind,
      nodeId: target.nodeId,
      type: "airbox",
      visualizationTargetId: "airbox",
    },
  };
}

/** Uses kernel selection so the Inspector's dirty-draft guard remains in force. */
export function navigateToAirboxRoute(
  selection: Pick<SelectionController, "set">,
  route: AirboxInspectorRoute,
): void {
  selection.set(airboxRouteSelection(route), "inspector");
}

/** Routes FDM users to the existing Study grid authoring surface. */
export function navigateToStudyRoot(
  selection: Pick<SelectionController, "set">,
): void {
  const nodeId = "model:study";
  selection.set({
    kind: "study.root",
    label: "Study",
    nodeId,
    objectId: null,
    ref: { kind: "study.root", nodeId, type: "study" },
  }, "inspector");
}
