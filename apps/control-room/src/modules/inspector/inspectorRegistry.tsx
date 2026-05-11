import type { Selection } from "@/kernel/selection/selectionTypes";

import { GeometryObjectPanel } from "./panels/GeometryObjectPanel";
import { ObjectVisualizationPanel } from "./panels/ObjectVisualizationPanel";
import { PlaceholderPanel } from "./panels/PlaceholderPanel";
import type { InspectorPanelContribution } from "./inspectorTypes";

const PANELS: InspectorPanelContribution[] = [
  {
    id: "geometry-object",
    title: "Geometry Object",
    selectionKinds: ["object.root", "object.geometry", "builder.primitive"],
    component: GeometryObjectPanel,
  },
  {
    id: "object-visualization",
    title: "Visualization",
    selectionKinds: [
      "airbox.visualization",
      "mesh-part-airbox",
      "object.visualization",
      "mesh-part",
    ],
    component: ObjectVisualizationPanel,
  },
  {
    id: "placeholder",
    title: "Selection",
    selectionKinds: ["*"],
    component: PlaceholderPanel,
  },
];

export function allInspectorPanels(): InspectorPanelContribution[] {
  return [...PANELS];
}

export function resolveInspectorPanel(
  selection: Pick<Selection, "kind">,
): InspectorPanelContribution | null {
  if (!selection.kind) return null;

  return (
    PANELS.find((panel) => panel.selectionKinds.includes(selection.kind!)) ??
    PANELS.find((panel) => panel.selectionKinds.includes("*")) ??
    null
  );
}
