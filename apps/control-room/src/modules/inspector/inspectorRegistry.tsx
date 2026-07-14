import type { Selection } from "@/kernel/selection/selectionTypes";

import { AirboxOverviewPanel } from "./panels/airbox/AirboxOverviewPanel";
import { AirboxMeshBuildPanel } from "./panels/airbox/AirboxMeshBuildPanel";
import { AirboxMeshOverviewPanel } from "./panels/airbox/AirboxMeshOverviewPanel";
import { AirboxMeshParametersPanel } from "./panels/airbox/AirboxMeshParametersPanel";
import { AirboxMeshQualityGatesPanel } from "./panels/airbox/AirboxMeshQualityGatesPanel";
import { AirboxMeshStatisticsPanel } from "./panels/airbox/AirboxMeshStatisticsPanel";
import { AirboxMeshTopologyPanel } from "./panels/airbox/AirboxMeshTopologyPanel";
import { AntennaObjectPanel } from "./panels/AntennaObjectPanel";
import { ChartInspectorPanel } from "./panels/ChartInspectorPanel";
import { CouplingInspectorPanel } from "./panels/CouplingInspectorPanel";
import { CrossSectionInspectorPanel } from "./panels/CrossSectionInspectorPanel";
import {
  EigenBranchInspectorPanel,
  EigenBranchesInspectorPanel,
  EigenDiagnosticsInspectorPanel,
  EigenDispersionInspectorPanel,
  FrequencyDomainApiResourcesDiagnosticInspectorPanel,
  FrequencyDomainArtifactsDiagnosticInspectorPanel,
  FrequencyDomainCapabilitiesDiagnosticInspectorPanel,
  FrequencyDomainDiagnosticsOverviewInspectorPanel,
  FrequencyDomainEquilibriumDiagnosticInspectorPanel,
  FrequencyDomainResourceFamilyInspectorPanel,
  FrequencyDomainManifestResourceInspectorPanel,
  FrequencyDomainCalculationModesResourceInspectorPanel,
  FrequencyDomainFmrResourceInspectorPanel,
  FrequencyDomainDispersionResourceInspectorPanel,
  FrequencyDomainResponseMapResourceInspectorPanel,
  EigenSpectrumResourceInspectorPanel,
  EigenBranchesResourceInspectorPanel,
  EigenDispersionResourceInspectorPanel,
  EigenDiagnosticsResourceInspectorPanel,
  EigenModeMetadataResourceInspectorPanel,
  EigenModeFieldResourceInspectorPanel,
  FrequencyResponseSweepResourceInspectorPanel,
  FrequencyResponseProgressResourceInspectorPanel,
  FrequencyResponseCancelRequestedResourceInspectorPanel,
  FrequencyResponseFrequencyPointResourceInspectorPanel,
  FrequencyResponseFieldResourceInspectorPanel,
  FrequencyResponseObservablesResourceInspectorPanel,
  FrequencyResponseDiagnosticsResourceInspectorPanel,
  FrequencyDomainOperatorDiagnosticInspectorPanel,
  FrequencyDomainPeriodicFloquetDiagnosticInspectorPanel,
  FrequencyDomainPeriodicPairsResourceInspectorPanel,
  FrequencyDomainSolverDiagnosticInspectorPanel,
  FrequencyDomainVisualizationDiagnosticInspectorPanel,
  EigenKPathInspectorPanel,
  EigenModeInspectorPanel,
  EigenModesInspectorPanel,
  EigenModesVisualizationInspectorPanel,
  EigenOverviewInspectorPanel,
  EigenProvenanceInspectorPanel,
  EigenSampleJobInspectorPanel,
  EigenSpectrumInspectorPanel,
  EigenStudyInspectorPanel,
  FrequencyDomainArtifactExportJobInspectorPanel,
  FrequencyDomainCalculationModesInspectorPanel,
  FrequencyDomainDispersionInspectorPanel,
  FrequencyDomainExportsInspectorPanel,
  FrequencyDomainJobsOverviewInspectorPanel,
  FrequencyDomainOverviewInspectorPanel,
  FrequencyDomainResponseMapInspectorPanel,
  FrequencyDomainRunInspectorPanel,
  FrequencyDomainStageRunJobInspectorPanel,
  FrequencyResponseCancelRequestedInspectorPanel,
  FrequencyResponseDiagnosticsInspectorPanel,
  FrequencyResponseFrequencyJobInspectorPanel,
  FrequencyResponseObservablesInspectorPanel,
  FrequencyResponseOverviewInspectorPanel,
  FrequencyResponseObservableInspectorPanel,
  FrequencyResponseFrequencyPointsInspectorPanel,
  FrequencyResponsePointInspectorPanel,
  FrequencyResponseProvenanceInspectorPanel,
  FrequencyResponseProgressJobInspectorPanel,
  FrequencyResponseProgressInspectorPanel,
  FrequencyResponseStudyInspectorPanel,
  FrequencyResponseSweepInspectorPanel,
  FmrComparisonInspectorPanel,
  FmrModalSpectrumInspectorPanel,
  FmrOverviewInspectorPanel,
  FmrPeakInspectorPanel,
  FmrPeaksInspectorPanel,
  FmrResponseSweepInspectorPanel,
} from "./panels/frequency-domain/FrequencyDomainResultInspectors";
import { GeometryObjectPanel } from "./panels/GeometryObjectPanel";
import { MeshDetailsPanel } from "./panels/MeshDetailsPanel";
import { ModeVisualizationInspectorPanel } from "./panels/ModeVisualizationInspectorPanel";
import { ObjectGeneralPanel } from "./panels/ObjectGeneralPanel";
import { ObjectMagneticTexturePanel } from "./panels/ObjectMagneticTexturePanel";
import { ObjectMaterialPanel } from "./panels/ObjectMaterialPanel";
import { ObjectMeshPolicyPanel } from "./panels/ObjectMeshPolicyPanel";
import { TopologicalChargeExtensionPanel } from "./extensions/topological-charge/TopologicalChargeExtensionPanel";
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
import {
  EigenmodesBoundaryStageInspectorPanel,
  EigenmodesCalculationModeStageInspectorPanel,
  EigenmodesDiagnosticsStageInspectorPanel,
  EigenmodesEquilibriumStageInspectorPanel,
  EigenmodesKPathStageInspectorPanel,
  EigenmodesOperatorStageInspectorPanel,
  EigenmodesOutputsStageInspectorPanel,
  EigenmodesPeriodicPairsStageInspectorPanel,
  EigenmodesSetupStageInspectorPanel,
  EigenmodesSolverStageInspectorPanel,
  EigenmodesStageOverviewInspectorPanel,
  FrequencyResponseBoundaryStageInspectorPanel,
  FrequencyResponseCalculationModeStageInspectorPanel,
  FrequencyResponseDiagnosticsStageInspectorPanel,
  FrequencyResponseEquilibriumStageInspectorPanel,
  FrequencyResponseExcitationStageInspectorPanel,
  FrequencyResponseKGridStageInspectorPanel,
  FrequencyResponseOperatorStageInspectorPanel,
  FrequencyResponseOutputsStageInspectorPanel,
  FrequencyResponsePeriodicPairsStageInspectorPanel,
  FrequencyResponseSetupStageInspectorPanel,
  FrequencyResponseSolverStageInspectorPanel,
  FrequencyResponseStageOverviewInspectorPanel,
  FrequencyResponseSweepStageInspectorPanel,
  StudyStageInspectorRouter,
} from "./panels/StudyStageInspectorRouter";
import { resolveFrequencyDomainNodeDetail } from "./panels/frequencyDomainNodeDetails";
import type { InspectorPanelContribution } from "./inspectorTypes";
export {
  PBC_INSPECTOR_CONTEXT_IDS,
  resolvePbcInspectorContext,
} from "./panels/pbcInspectorModel";
export type {
  PbcInspectorContext,
  PbcInspectorContextModel,
} from "./panels/pbcInspectorModel";

const FREQUENCY_DOMAIN_STAGE_SELECTION_KINDS = [
  "study.stage.eigenmodes",
  "study.stage.eigenmodes.setup",
  "study.stage.eigenmodes.calculation_mode",
  "study.stage.eigenmodes.equilibrium",
  "study.stage.eigenmodes.operator",
  "study.stage.eigenmodes.solver",
  "study.stage.eigenmodes.outputs",
  "study.stage.eigenmodes.diagnostics",
  "study.stage.frequency_response",
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
  "results.frequency_domain.fmr_peak",
  "results.frequency_domain.dispersion",
  "results.frequency_domain.response_map",
  "results.eigen.root",
  "results.eigen.study",
  "results.eigen.spectrum",
  "results.eigen.modes",
  "results.eigen.modes.visualization",
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
  "resources.analysis.frequency_response.observables",
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

type FrequencyDomainInspectorKind =
  (typeof FREQUENCY_DOMAIN_INSPECTOR_SELECTION_KINDS)[number];

const FREQUENCY_DOMAIN_NAMED_PANELS: Partial<
  Record<FrequencyDomainInspectorKind, InspectorPanelContribution["component"]>
> = {
  "study.stage.eigenmodes": EigenmodesStageOverviewInspectorPanel,
  "study.stage.eigenmodes.setup": EigenmodesSetupStageInspectorPanel,
  "study.stage.eigenmodes.calculation_mode":
    EigenmodesCalculationModeStageInspectorPanel,
  "study.stage.eigenmodes.equilibrium":
    EigenmodesEquilibriumStageInspectorPanel,
  "study.stage.eigenmodes.operator": EigenmodesOperatorStageInspectorPanel,
  "study.stage.eigenmodes.boundary": EigenmodesBoundaryStageInspectorPanel,
  "study.stage.eigenmodes.periodic_pairs":
    EigenmodesPeriodicPairsStageInspectorPanel,
  "study.stage.eigenmodes.k_path": EigenmodesKPathStageInspectorPanel,
  "study.stage.eigenmodes.solver": EigenmodesSolverStageInspectorPanel,
  "study.stage.eigenmodes.outputs": EigenmodesOutputsStageInspectorPanel,
  "study.stage.eigenmodes.diagnostics":
    EigenmodesDiagnosticsStageInspectorPanel,
  "study.stage.frequency_response":
    FrequencyResponseStageOverviewInspectorPanel,
  "study.stage.frequency_response.setup":
    FrequencyResponseSetupStageInspectorPanel,
  "study.stage.frequency_response.calculation_mode":
    FrequencyResponseCalculationModeStageInspectorPanel,
  "study.stage.frequency_response.equilibrium":
    FrequencyResponseEquilibriumStageInspectorPanel,
  "study.stage.frequency_response.operator":
    FrequencyResponseOperatorStageInspectorPanel,
  "study.stage.frequency_response.boundary":
    FrequencyResponseBoundaryStageInspectorPanel,
  "study.stage.frequency_response.periodic_pairs":
    FrequencyResponsePeriodicPairsStageInspectorPanel,
  "study.stage.frequency_response.k_grid":
    FrequencyResponseKGridStageInspectorPanel,
  "study.stage.frequency_response.excitation":
    FrequencyResponseExcitationStageInspectorPanel,
  "study.stage.frequency_response.sweep":
    FrequencyResponseSweepStageInspectorPanel,
  "study.stage.frequency_response.solver":
    FrequencyResponseSolverStageInspectorPanel,
  "study.stage.frequency_response.outputs":
    FrequencyResponseOutputsStageInspectorPanel,
  "study.stage.frequency_response.diagnostics":
    FrequencyResponseDiagnosticsStageInspectorPanel,
  "results.frequency_domain.run": FrequencyDomainRunInspectorPanel,
  "results.frequency_domain.root": FrequencyDomainOverviewInspectorPanel,
  "results.frequency_domain.calculation_modes":
    FrequencyDomainCalculationModesInspectorPanel,
  "results.frequency_domain.dispersion": FrequencyDomainDispersionInspectorPanel,
  "results.frequency_domain.fmr": FmrOverviewInspectorPanel,
  "results.frequency_domain.response_map": FrequencyDomainResponseMapInspectorPanel,
  "results.eigen.branch": EigenBranchInspectorPanel,
  "results.eigen.branches": EigenBranchesInspectorPanel,
  "results.eigen.root": EigenOverviewInspectorPanel,
  "results.eigen.study": EigenStudyInspectorPanel,
  "results.eigen.mode": EigenModeInspectorPanel,
  "results.eigen.modes": EigenModesInspectorPanel,
  "results.eigen.modes.visualization": EigenModesVisualizationInspectorPanel,
  "results.eigen.provenance": EigenProvenanceInspectorPanel,
  "results.eigen.spectrum": EigenSpectrumInspectorPanel,
  "results.eigen.dispersion": EigenDispersionInspectorPanel,
  "results.eigen.k_path": EigenKPathInspectorPanel,
  "results.eigen.diagnostics": EigenDiagnosticsInspectorPanel,
  "results.frequency_domain.fmr_modal_spectrum":
    FmrModalSpectrumInspectorPanel,
  "results.frequency_domain.fmr_peaks": FmrPeaksInspectorPanel,
  "results.frequency_domain.fmr_peak": FmrPeakInspectorPanel,
  "results.frequency_domain.fmr_response_sweep": FmrResponseSweepInspectorPanel,
  "results.frequency_domain.comparison": FmrComparisonInspectorPanel,
  "results.frequency_domain.exports": FrequencyDomainExportsInspectorPanel,
  "results.frequency_response.frequency_points":
    FrequencyResponseFrequencyPointsInspectorPanel,
  "results.frequency_response.root": FrequencyResponseOverviewInspectorPanel,
  "results.frequency_response.study": FrequencyResponseStudyInspectorPanel,
  "results.frequency_response.frequency_point":
    FrequencyResponsePointInspectorPanel,
  "results.frequency_response.observable":
    FrequencyResponseObservableInspectorPanel,
  "results.frequency_response.observables":
    FrequencyResponseObservablesInspectorPanel,
  "results.frequency_response.progress": FrequencyResponseProgressInspectorPanel,
  "results.frequency_response.cancel_requested":
    FrequencyResponseCancelRequestedInspectorPanel,
  "results.frequency_response.provenance":
    FrequencyResponseProvenanceInspectorPanel,
  "results.frequency_response.sweep": FrequencyResponseSweepInspectorPanel,
  "results.frequency_response.diagnostics":
    FrequencyResponseDiagnosticsInspectorPanel,
  "jobs.frequency_domain.root": FrequencyDomainJobsOverviewInspectorPanel,
  "jobs.frequency_domain.stage_run": FrequencyDomainStageRunJobInspectorPanel,
  "jobs.frequency_domain.eigen_sample": EigenSampleJobInspectorPanel,
  "jobs.frequency_domain.response_frequency":
    FrequencyResponseFrequencyJobInspectorPanel,
  "jobs.frequency_domain.response_progress":
    FrequencyResponseProgressJobInspectorPanel,
  "jobs.frequency_domain.artifact_export":
    FrequencyDomainArtifactExportJobInspectorPanel,
  "diagnostics.frequency_domain.root":
    FrequencyDomainDiagnosticsOverviewInspectorPanel,
  "diagnostics.frequency_domain.capabilities":
    FrequencyDomainCapabilitiesDiagnosticInspectorPanel,
  "diagnostics.frequency_domain.equilibrium":
    FrequencyDomainEquilibriumDiagnosticInspectorPanel,
  "diagnostics.frequency_domain.operator":
    FrequencyDomainOperatorDiagnosticInspectorPanel,
  "diagnostics.frequency_domain.solver":
    FrequencyDomainSolverDiagnosticInspectorPanel,
  "diagnostics.frequency_domain.artifacts":
    FrequencyDomainArtifactsDiagnosticInspectorPanel,
  "diagnostics.frequency_domain.api_resources":
    FrequencyDomainApiResourcesDiagnosticInspectorPanel,
  "diagnostics.frequency_domain.visualization":
    FrequencyDomainVisualizationDiagnosticInspectorPanel,
  "diagnostics.frequency_domain.periodic_floquet":
    FrequencyDomainPeriodicFloquetDiagnosticInspectorPanel,
  "resources.analysis.frequency_domain": FrequencyDomainResourceFamilyInspectorPanel,
  "resources.analysis.frequency_domain.manifest":
    FrequencyDomainManifestResourceInspectorPanel,
  "resources.analysis.frequency_domain.calculation_modes":
    FrequencyDomainCalculationModesResourceInspectorPanel,
  "resources.analysis.frequency_domain.fmr":
    FrequencyDomainFmrResourceInspectorPanel,
  "resources.analysis.frequency_domain.dispersion":
    FrequencyDomainDispersionResourceInspectorPanel,
  "resources.analysis.frequency_domain.response_map":
    FrequencyDomainResponseMapResourceInspectorPanel,
  "resources.mesh.periodic_pairs":
    FrequencyDomainPeriodicPairsResourceInspectorPanel,
  "resources.analysis.eigen.spectrum": EigenSpectrumResourceInspectorPanel,
  "resources.analysis.eigen.branches": EigenBranchesResourceInspectorPanel,
  "resources.analysis.eigen.dispersion": EigenDispersionResourceInspectorPanel,
  "resources.analysis.eigen.diagnostics": EigenDiagnosticsResourceInspectorPanel,
  "resources.analysis.eigen.mode_metadata": EigenModeMetadataResourceInspectorPanel,
  "resources.analysis.eigen.mode_field": EigenModeFieldResourceInspectorPanel,
  "resources.analysis.frequency_response.sweep":
    FrequencyResponseSweepResourceInspectorPanel,
  "resources.analysis.frequency_response.progress":
    FrequencyResponseProgressResourceInspectorPanel,
  "resources.analysis.frequency_response.cancel_requested":
    FrequencyResponseCancelRequestedResourceInspectorPanel,
  "resources.analysis.frequency_response.frequency_point":
    FrequencyResponseFrequencyPointResourceInspectorPanel,
  "resources.analysis.frequency_response.field":
    FrequencyResponseFieldResourceInspectorPanel,
  "resources.analysis.frequency_response.observables":
    FrequencyResponseObservablesResourceInspectorPanel,
  "resources.analysis.frequency_response.diagnostics":
    FrequencyResponseDiagnosticsResourceInspectorPanel,
};

const FREQUENCY_DOMAIN_DEDICATED_PANELS = Object.fromEntries(
  FREQUENCY_DOMAIN_INSPECTOR_SELECTION_KINDS.map((kind) => [
    kind,
    requireFrequencyDomainNamedPanel(kind),
  ]),
) as Partial<
  Record<FrequencyDomainInspectorKind, InspectorPanelContribution["component"]>
>;

function requireFrequencyDomainNamedPanel(
  kind: FrequencyDomainInspectorKind,
): InspectorPanelContribution["component"] {
  const component = FREQUENCY_DOMAIN_NAMED_PANELS[kind];
  if (!component) {
    throw new Error(`Missing dedicated frequency-domain inspector for ${kind}`);
  }
  return component;
}

function frequencyDomainPanelId(kind: FrequencyDomainInspectorKind): string {
  return `frequency-domain-${kind.replace(/[.:]/g, "-")}`;
}

function frequencyDomainPanelTitle(kind: FrequencyDomainInspectorKind): string {
  return resolveFrequencyDomainNodeDetail({
    kind,
    label: null,
    moduleSource: "inspector",
    nodeId: null,
    objectId: null,
    ref: { kind, nodeId: `detail:${kind}`, type: "frequency-domain" },
  }).title;
}

const frequencyDomainPanels: InspectorPanelContribution[] =
  FREQUENCY_DOMAIN_INSPECTOR_SELECTION_KINDS.map((kind) => ({
    id: frequencyDomainPanelId(kind),
    title: frequencyDomainPanelTitle(kind),
    selectionKinds: [kind],
    component: FREQUENCY_DOMAIN_DEDICATED_PANELS[kind] ?? requireFrequencyDomainNamedPanel(kind),
  }));

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
    id: "airbox-overview",
    title: "Airbox Overview",
    selectionKinds: ["airbox.root"],
    component: AirboxOverviewPanel,
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
    id: "airbox-visualization-debug",
    title: "Airbox Visualization Debug",
    selectionKinds: ["airbox.visualization.debug"],
    component: PlaceholderPanel,
  },
  {
    id: "object-mode-visualization",
    title: "Mode Visualization",
    selectionKinds: [
      "object.mode_visualization",
      "object.mode_visualization.group",
      "object.mode_visualization.field",
      "object.mode_visualization.view",
    ],
    component: ModeVisualizationInspectorPanel,
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
    id: "airbox-mesh-overview",
    title: "Airbox Mesh Overview",
    selectionKinds: ["airbox.mesh"],
    component: AirboxMeshOverviewPanel,
  },
  {
    id: "airbox-mesh-parameters",
    title: "Airbox Mesh Parameters",
    selectionKinds: ["airbox.mesh.parameters"],
    component: AirboxMeshParametersPanel,
  },
  {
    id: "airbox-mesh-quality-gates",
    title: "Airbox Mesh Quality Gates",
    selectionKinds: ["airbox.mesh.quality-gates"],
    component: AirboxMeshQualityGatesPanel,
  },
  {
    id: "airbox-mesh-statistics",
    title: "Airbox Mesh Statistics",
    selectionKinds: ["airbox.mesh.statistics"],
    component: AirboxMeshStatisticsPanel,
  },
  {
    id: "airbox-mesh-topology",
    title: "Airbox Mesh Topology",
    selectionKinds: ["airbox.mesh.topology"],
    component: AirboxMeshTopologyPanel,
  },
  {
    id: "airbox-mesh-build",
    title: "Airbox Mesh Build",
    selectionKinds: ["airbox.mesh.build"],
    component: AirboxMeshBuildPanel,
  },
  {
    id: "object-mesh-policy",
    title: "Object Mesh Policy",
    selectionKinds: ["object.mesh"],
    component: ObjectMeshPolicyPanel,
  },
  {
    id: "object-extension-topological-charge",
    title: "Topological Charge",
    selectionKinds: ["object.extension.topological-charge"],
    component: TopologicalChargeExtensionPanel,
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
      "study.stage.hysteresis",
      "study.stage.relax",
      "study.stage.run",
      "study.stage.change_device",
      "study.stage.save_state",
    ],
    component: StudyStageInspectorRouter,
  },
  ...frequencyDomainPanels,
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
