import type { Selection } from "@/kernel/selection/selectionTypes";

import { AirboxMeshPolicyPanel } from "./panels/AirboxMeshPolicyPanel";
import { ChartInspectorPanel } from "./panels/ChartInspectorPanel";
import { CrossSectionInspectorPanel } from "./panels/CrossSectionInspectorPanel";
import { GeometryObjectPanel } from "./panels/GeometryObjectPanel";
import { MeshDetailsPanel } from "./panels/MeshDetailsPanel";
import { ObjectMagneticTexturePanel } from "./panels/ObjectMagneticTexturePanel";
import { ObjectMaterialPanel } from "./panels/ObjectMaterialPanel";
import { ObjectMeshPolicyPanel } from "./panels/ObjectMeshPolicyPanel";
import { ObjectRegionsPanel } from "./panels/ObjectRegionsPanel";
import { ObjectVisualizationPanel } from "./panels/ObjectVisualizationPanel";
import { PhysicsInteractionPanel } from "./panels/PhysicsInteractionPanel";
import { PlaceholderPanel } from "./panels/PlaceholderPanel";
import { StudyInspectorPanel } from "./panels/StudyInspectorPanel";
import { StudyStageInspectorRouter } from "./panels/StudyStageInspectorRouter";
import type { InspectorPanelContribution } from "./inspectorTypes";

const PANELS: InspectorPanelContribution[] = [
  {
    id: "chart",
    title: "Charts",
    selectionKinds: ["analysis.chart", "analysis.chart-point"],
    component: ChartInspectorPanel,
  },
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
    selectionKinds: [
      "object.magnetic-texture",
      "object.magnetic-texture.asset",
      "object.magnetic-texture.load",
      "object.magnetic-texture.transform",
      "object.region-magnetic-texture",
    ],
    component: ObjectMagneticTexturePanel,
  },
  {
    id: "airbox-mesh-policy",
    title: "Airbox Mesh Policy",
    selectionKinds: ["airbox.mesh"],
    component: AirboxMeshPolicyPanel,
  },
  {
    id: "airbox-mesh-quality",
    title: "Airbox Mesh Quality",
    selectionKinds: ["airbox.mesh-quality"],
    component: AirboxMeshPolicyPanel,
  },
  {
    id: "object-mesh-policy",
    title: "Object Mesh Policy",
    selectionKinds: ["object.mesh"],
    component: ObjectMeshPolicyPanel,
  },
  {
    id: "mesh-details",
    title: "Mesh Details",
    selectionKinds: [
      "mesh.root",
      "mesh.shared-domain",
      "mesh.builds",
      "mesh.quality",
      "mesh.size-fields",
      "mesh.regions",
      "resources.mesh",
    ],
    component: MeshDetailsPanel,
  },
  {
    id: "cross-section",
    title: "Cross-Section",
    selectionKinds: [
      "mesh.cross-section",
      "mesh.cross-section.draft",
      "mesh.cross-section.plot",
    ],
    component: CrossSectionInspectorPanel,
  },
  {
    id: "study-root",
    title: "Study",
    selectionKinds: ["study.root"],
    component: StudyInspectorPanel,
  },
  {
    id: "study-stage",
    title: "Study Stage",
    selectionKinds: [
      "study.stage.action",
      "study.stage.eigenmodes",
      "study.stage.frequency_response",
      "study.stage.hysteresis",
      "study.stage.relax",
      "study.stage.run",
      "study.stage.save_state",
    ],
    component: StudyStageInspectorRouter,
  },
  {
    id: "placeholder",
    title: "Selection",
    selectionKinds: ["*"],
    component: PlaceholderPanel,
  },
];

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
