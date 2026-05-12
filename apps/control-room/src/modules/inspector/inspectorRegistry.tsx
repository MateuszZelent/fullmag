import type { Selection } from "@/kernel/selection/selectionTypes";

import { GeometryObjectPanel } from "./panels/GeometryObjectPanel";
import { ObjectMagneticTexturePanel } from "./panels/ObjectMagneticTexturePanel";
import { ObjectMaterialPanel } from "./panels/ObjectMaterialPanel";
import { ObjectMeshPolicyPanel } from "./panels/ObjectMeshPolicyPanel";
import { ObjectRegionsPanel } from "./panels/ObjectRegionsPanel";
import { ObjectVisualizationPanel } from "./panels/ObjectVisualizationPanel";
import { PhysicsInteractionPanel } from "./panels/PhysicsInteractionPanel";
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
    id: "physics-interaction",
    title: "Physics Interaction",
    selectionKinds: ["object.physics"],
    component: PhysicsInteractionPanel,
  },
  {
    id: "object-material",
    title: "Magnetic Parameters",
    selectionKinds: ["object.magnetic-parameters", "object.material"],
    component: ObjectMaterialPanel,
  },
  {
    id: "object-regions",
    title: "Object Regions",
    selectionKinds: ["object.regions"],
    component: ObjectRegionsPanel,
  },
  {
    id: "object-magnetic-texture",
    title: "Magnetic Texture",
    selectionKinds: ["object.magnetic-texture"],
    component: ObjectMagneticTexturePanel,
  },
  {
    id: "airbox-mesh-policy",
    title: "Airbox Mesh Policy",
    selectionKinds: ["airbox.mesh"],
    component: PlaceholderPanel,
  },
  {
    id: "object-mesh-policy",
    title: "Object Mesh Policy",
    selectionKinds: ["object.mesh"],
    component: ObjectMeshPolicyPanel,
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
