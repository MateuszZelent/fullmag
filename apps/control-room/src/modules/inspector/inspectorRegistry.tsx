import type { Selection } from "@/kernel/selection/selectionTypes";

import { AirboxMeshPolicyPanel } from "./panels/AirboxMeshPolicyPanel";
import { AntennaObjectPanel } from "./panels/AntennaObjectPanel";
import { ChartInspectorPanel } from "./panels/ChartInspectorPanel";
import { CouplingInspectorPanel } from "./panels/CouplingInspectorPanel";
import { CrossSectionInspectorPanel } from "./panels/CrossSectionInspectorPanel";
import { FrequencyDomainInspectorPanel } from "./panels/FrequencyDomainInspectorPanel";
import { GeometryObjectPanel } from "./panels/GeometryObjectPanel";
import { MeshDetailsPanel } from "./panels/MeshDetailsPanel";
import { ObjectGeneralPanel } from "./panels/ObjectGeneralPanel";
import { ObjectMagneticTexturePanel } from "./panels/ObjectMagneticTexturePanel";
import { ObjectMaterialPanel } from "./panels/ObjectMaterialPanel";
import { ObjectMeshPolicyPanel } from "./panels/ObjectMeshPolicyPanel";
import {
  ObjectRegionDiagnosticsPanel,
  ObjectRegionGeometryPanel,
  ObjectRegionMagneticParametersPanel,
  ObjectRegionMeshPanel,
  ObjectRegionNestedRegionsPanel,
  ObjectRegionOverviewPanel,
  ObjectRegionTexturePanel,
  ObjectRegionVisualizationPanel,
} from "./panels/ObjectRegionsPanel";
import { ObjectVisualizationPanel } from "./panels/ObjectVisualizationPanel";
import { PhysicsInteractionPanel } from "./panels/PhysicsInteractionPanel";
import { PlaceholderPanel } from "./panels/PlaceholderPanel";
import { RegionsListPanel } from "./panels/RegionsListPanel";
import { StudyInspectorPanel } from "./panels/StudyInspectorPanel";
import { StudyStageInspectorRouter } from "./panels/StudyStageInspectorRouter";
import type { InspectorPanelContribution } from "./inspectorTypes";

const FREQUENCY_DOMAIN_STAGE_SELECTION_KINDS = [
  "study.stage.eigenmodes.setup",
  "study.stage.eigenmodes.calculation_mode",
  "study.stage.eigenmodes.equilibrium",
  "study.stage.eigenmodes.operator",
  "study.stage.eigenmodes.solver",
  "study.stage.eigenmodes.outputs",
  "study.stage.eigenmodes.diagnostics",
  "study.stage.frequency_response.setup",
  "study.stage.frequency_response.calculation_mode",
  "study.stage.frequency_response.equilibrium",
  "study.stage.frequency_response.operator",
  "study.stage.frequency_response.excitation",
  "study.stage.frequency_response.sweep",
  "study.stage.frequency_response.solver",
  "study.stage.frequency_response.outputs",
  "study.stage.frequency_response.diagnostics",
] as const;

const FREQUENCY_DOMAIN_STAGE_DETAIL_SELECTION_KINDS = [
  "study.stage.eigenmodes.boundary",
  "study.stage.eigenmodes.periodic_pairs",
  "study.stage.eigenmodes.k_path",
  "study.stage.frequency_response.boundary",
  "study.stage.frequency_response.periodic_pairs",
  "study.stage.frequency_response.k_grid",
] as const;

export const FREQUENCY_DOMAIN_INSPECTOR_SELECTION_KINDS = [
  ...FREQUENCY_DOMAIN_STAGE_SELECTION_KINDS,
  ...FREQUENCY_DOMAIN_STAGE_DETAIL_SELECTION_KINDS,
  "results.frequency_domain.root",
  "results.frequency_domain.run",
  "results.frequency_domain.calculation_modes",
  "results.frequency_domain.fmr",
  "results.frequency_domain.fmr_modal_spectrum",
  "results.frequency_domain.fmr_response_sweep",
  "results.frequency_domain.fmr_peaks",
  "results.frequency_domain.dispersion",
  "results.frequency_domain.response_map",
  "results.eigen.root",
  "results.eigen.study",
  "results.eigen.spectrum",
  "results.eigen.modes",
  "results.eigen.mode",
  "results.eigen.dispersion",
  "results.eigen.k_path",
  "results.eigen.branches",
  "results.eigen.branch",
  "results.eigen.diagnostics",
  "results.eigen.provenance",
  "results.frequency_response.root",
  "results.frequency_response.study",
  "results.frequency_response.sweep",
  "results.frequency_response.progress",
  "results.frequency_response.cancel_requested",
  "results.frequency_response.frequency_points",
  "results.frequency_response.frequency_point",
  "results.frequency_response.observables",
  "results.frequency_response.observable",
  "results.frequency_response.diagnostics",
  "results.frequency_response.provenance",
  "results.frequency_domain.comparison",
  "results.frequency_domain.exports",
  "resources.analysis.frequency_domain",
  "resources.analysis.frequency_domain.manifest",
  "resources.analysis.frequency_domain.calculation_modes",
  "resources.analysis.frequency_domain.fmr",
  "resources.analysis.frequency_domain.dispersion",
  "resources.analysis.frequency_domain.response_map",
  "resources.mesh.periodic_pairs",
  "resources.analysis.eigen.spectrum",
  "resources.analysis.eigen.branches",
  "resources.analysis.eigen.dispersion",
  "resources.analysis.eigen.diagnostics",
  "resources.analysis.eigen.mode_metadata",
  "resources.analysis.eigen.mode_field",
  "resources.analysis.frequency_response.sweep",
  "resources.analysis.frequency_response.progress",
  "resources.analysis.frequency_response.cancel_requested",
  "resources.analysis.frequency_response.frequency_point",
  "resources.analysis.frequency_response.field",
  "resources.analysis.frequency_response.diagnostics",
  "jobs.frequency_domain.root",
  "jobs.frequency_domain.stage_run",
  "jobs.frequency_domain.eigen_sample",
  "jobs.frequency_domain.response_frequency",
  "jobs.frequency_domain.response_progress",
  "jobs.frequency_domain.artifact_export",
  "diagnostics.frequency_domain.root",
  "diagnostics.frequency_domain.capabilities",
  "diagnostics.frequency_domain.equilibrium",
  "diagnostics.frequency_domain.operator",
  "diagnostics.frequency_domain.solver",
  "diagnostics.frequency_domain.artifacts",
  "diagnostics.frequency_domain.api_resources",
  "diagnostics.frequency_domain.visualization",
  "diagnostics.frequency_domain.periodic_floquet",
] as const;

const PANELS: InspectorPanelContribution[] = [
  {
    id: "chart",
    title: "Charts",
    selectionKinds: ["analysis.chart", "analysis.chart-point"],
    component: ChartInspectorPanel,
  },
  {
    id: "object-general",
    title: "Object General",
    selectionKinds: ["object.root"],
    component: ObjectGeneralPanel,
  },
  {
    id: "geometry-object",
    title: "Geometry",
    selectionKinds: ["object.geometry", "builder.primitive"],
    component: GeometryObjectPanel,
  },
  {
    id: "antenna-object",
    title: "Antenna",
    selectionKinds: ["object.antenna"],
    component: AntennaObjectPanel,
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
    id: "physics-coupling",
    title: "Coupling",
    selectionKinds: ["physics.coupling"],
    component: CouplingInspectorPanel,
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
    component: RegionsListPanel,
  },
  {
    id: "object-region",
    title: "Object Region",
    selectionKinds: ["object.region"],
    component: ObjectRegionOverviewPanel,
  },
  {
    id: "object-region-geometry",
    title: "Region Geometry",
    selectionKinds: ["object.region.geometry", "object.region.shape"],
    component: ObjectRegionGeometryPanel,
  },
  {
    id: "object-region-magnetic-parameters",
    title: "Region Magnetic Parameters",
    selectionKinds: [
      "object.region.magnetic-parameters",
      "object.region.material",
    ],
    component: ObjectRegionMagneticParametersPanel,
  },
  {
    id: "object-region-mesh",
    title: "Region Mesh",
    selectionKinds: ["object.region.mesh"],
    component: ObjectRegionMeshPanel,
  },
  {
    id: "object-region-texture",
    title: "Region Texture",
    selectionKinds: ["object.region.texture", "object.region-magnetic-texture"],
    component: ObjectRegionTexturePanel,
  },
  {
    id: "object-region-visualization",
    title: "Region Visualization",
    selectionKinds: ["object.region.visualization"],
    component: ObjectRegionVisualizationPanel,
  },
  {
    id: "object-region-regions",
    title: "Nested Regions",
    selectionKinds: ["object.region.regions"],
    component: ObjectRegionNestedRegionsPanel,
  },
  {
    id: "object-region-diagnostics",
    title: "Region Diagnostics",
    selectionKinds: ["object.region.diagnostics"],
    component: ObjectRegionDiagnosticsPanel,
  },
  {
    id: "object-magnetic-texture",
    title: "Magnetic Texture",
    selectionKinds: [
      "object.magnetic-texture",
      "object.magnetic-texture.asset",
      "object.magnetic-texture.load",
      "object.magnetic-texture.transform",
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
    selectionKinds: ["study.root", "study.stages", "study.execution", "study.recovery"],
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
    id: "frequency-domain",
    title: "Frequency Domain",
    selectionKinds: [...FREQUENCY_DOMAIN_INSPECTOR_SELECTION_KINDS],
    component: FrequencyDomainInspectorPanel,
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
