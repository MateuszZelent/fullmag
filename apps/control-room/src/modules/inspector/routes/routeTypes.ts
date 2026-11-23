import type { InspectorPanelContribution } from "../inspectorTypes";

export type InspectorRouteId = string & {
  readonly __brand: "InspectorRouteId";
};

export interface InspectorRoute {
  id: InspectorRouteId;
  title: string;
  selectionKinds: readonly string[];
  component: InspectorPanelContribution["component"];
  contribution: InspectorPanelContribution;
}

export function defineInspectorRoute(
  contribution: InspectorPanelContribution,
): InspectorRoute {
  return {
    component: contribution.component,
    contribution,
    id: contribution.id as InspectorRouteId,
    selectionKinds: contribution.selectionKinds,
    title: contribution.title,
  };
}
