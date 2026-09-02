import {
  AirboxMeshBuildLanePanel,
  AirboxMeshOverviewLanePanel,
  AirboxMeshParametersLanePanel,
  AirboxMeshQualityGatesLanePanel,
  AirboxMeshStatisticsLanePanel,
  AirboxMeshTopologyLanePanel,
  AirboxOverviewLanePanel,
} from "./panels/airbox/AirboxInspectorLanePanel";
import { FdmMultilayerAirboxTargetPanel } from "./panels/airbox/FdmMultilayerAirboxTargetPanel";
import { AirboxVisualizationDebugInspectorPanel } from "./panels/airbox/AirboxVisualizationDebugInspectorPanel";
import { AntennaObjectPanel } from "./panels/AntennaObjectPanel";
import { QuickChartInspectorPanel } from "./panels/QuickChartInspectorPanel";
import { BoundaryFacesOverviewPanel } from "./panels/boundary-faces/BoundaryFacesOverviewPanel";
import { CouplingInspectorPanel } from "./panels/CouplingInspectorPanel";
import {
  EigenBranchesInspectorPanel,
  EigenDiagnosticsInspectorPanel,
  EigenKPathInspectorPanel,
  EigenModesInspectorPanel,
  EigenModesVisualizationInspectorPanel,
  EigenOverviewInspectorPanel,
  EigenProvenanceInspectorPanel,
  EigenSpectrumInspectorPanel,
  EigenStudyInspectorPanel,
  FrequencyDomainCalculationModesInspectorPanel,
  FrequencyDomainDispersionInspectorPanel,
  FrequencyDomainExportsInspectorPanel,
  FrequencyDomainOverviewInspectorPanel,
  FrequencyDomainResponseMapInspectorPanel,
  FrequencyDomainRunInspectorPanel,
  FrequencyResponseCancelRequestedInspectorPanel,
  FrequencyResponseDiagnosticsInspectorPanel,
  FrequencyResponseObservablesInspectorPanel,
  FrequencyResponseOverviewInspectorPanel,
  FrequencyResponseObservableInspectorPanel,
  FrequencyResponseFrequencyPointsInspectorPanel,
  FrequencyResponsePointInspectorPanel,
  FrequencyResponseProvenanceInspectorPanel,
  FrequencyResponseProgressInspectorPanel,
  FrequencyResponseStudyInspectorPanel,
  FrequencyResponseSweepInspectorPanel,
  FmrComparisonInspectorPanel,
  FmrOverviewInspectorPanel,
  FmrPeakInspectorPanel,
  FmrPeaksInspectorPanel,
} from "./panels/frequency-domain/FrequencyDomainResultInspectors";
import { EigenBranchInspectorPanel } from "./panels/frequency-domain/EigenBranchInspectorPanel";
import { EigenDispersionInspectorPanel } from "./panels/frequency-domain/EigenDispersionInspectorPanel";
import { EigenModeInspectorPanel } from "./panels/frequency-domain/EigenModeInspectorPanel";
import { FmrModalSpectrumInspectorPanel } from "./panels/frequency-domain/FmrModalSpectrumInspectorPanel";
import { FmrResponseSweepInspectorPanel } from "./panels/frequency-domain/FmrResponseSweepInspectorPanel";
import { FieldQuantityInspectorPanel } from "./panels/FieldQuantityInspectorPanel";
import { AnalysisResultInspectorPanel } from "./panels/analysis-results/AnalysisResultInspectorPanel";
import { FrozenSpinsInspectorPanel } from "./panels/constraint/FrozenSpinsInspectorPanel";
import { MeshPartVisualizationPanel } from "./panels/MeshPartVisualizationPanel";
import { ModeVisualizationOverviewPanel } from "./panels/mode-visualization/ModeVisualizationOverviewPanel";
import { ObjectGeneralPanel } from "./panels/ObjectGeneralPanel";
import { ObjectMeshPolicyPanel } from "./panels/ObjectMeshPolicyPanel";
import { TopologicalChargeExtensionPanel } from "./extensions/topological-charge/TopologicalChargeExtensionPanel";
import {
  ObjectRegionDiagnosticsPanel,
  ObjectRegionMeshPanel,
  ObjectRegionNestedRegionsPanel,
  ObjectRegionOverviewPanel,
  ObjectRegionVisualizationPanel,
} from "./panels/ObjectRegionsPanel";
import { ObjectVisualizationPanel } from "./panels/ObjectVisualizationPanel";
import { PhysicsInteractionPanel } from "./panels/PhysicsInteractionPanel";
import { PhysicsGraphModuleInspectorPanel } from "./panels/PhysicsGraphModuleInspectorPanel";
import { PlanarMonitorDraftInspectorPanel } from "./panels/PlanarMonitorDraftInspectorPanel";
import { PlanarMonitorInspectorPanel } from "./panels/PlanarMonitorInspectorPanel";
import {
  CurrentTransportInspectorPanel,
  SpinTransportInspectorPanel,
  StructuredCurrentClosureInspectorPanel,
  StructuredCurrentSourceCutInspectorPanel,
} from "./panels/TransportAuthoringInspector";
import { OerstedFieldInspectorPanel, SpinTorqueInspectorPanel } from "./panels/SpinAuthoringInspector";
import { SpinInterfaceInspectorPanel } from "./panels/SpinInterfaceInspector";
import { PlaceholderPanel } from "./panels/PlaceholderPanel";
import {
  DispersionBranchesResultInspector,
  DispersionDrivenStageResultInspector,
  DispersionKSamplingResultInspector,
  DispersionModalStageResultInspector,
  DispersionModalProvenanceResultInspector,
  DispersionModesAtKResultInspector,
  DispersionModeAtKResultInspector,
  DispersionOverviewResultInspector,
  DispersionRelationResultInspector,
  DispersionDrivenProvenanceResultInspector,
  DispersionResponseMapResultInspector,
  DispersionResponseFieldAtKResultInspector,
  DynamicsResultInspector,
  HysteresisResultInspector,
  LegacyTimeDomainResultInspector,
  ResonanceDrivenPeaksResultInspector,
  ResonanceDrivenSpectrumResultInspector,
  ResonanceDrivenStageResultInspector,
  ResonanceFrequencyPointsResultInspector,
  ResonanceModalCouplingResultInspector,
  ResonanceModalSpectrumResultInspector,
  ResonanceModalModeResultInspector,
  ResonanceModalProvenanceResultInspector,
  ResonanceModalStageResultInspector,
  ResonanceModeShapesResultInspector,
  ResonanceOverviewResultInspector,
  ResonanceResponseFieldsResultInspector,
  ResonanceResponseFieldResultInspector,
  ResonanceDrivenProvenanceResultInspector,
} from "./panels/physics-first/PhysicsFirstResultInspectors";
import {
  AnalysisViewDefinitionInspector,
  AnalysisViewsOverviewInspector,
  DerivedValueDefinitionInspector,
  DerivedValuesOverviewInspector,
  ExportDefinitionInspector,
  ExportsOverviewInspector,
  TableDefinitionInspector,
  TablesOverviewInspector,
} from "./panels/physics-first/PostprocessingResultInspectors";
import { ResultsOverviewInspectorPanel } from "./panels/physics-first/ResultsOverviewInspectorPanel";
import {
  CrossObjectPhysicsScopeInspectorPanel,
  DefinitionsRootInspectorPanel,
  GlobalPhysicsScopeInspectorPanel,
  MeshUnassignedInspectorPanel,
  MeshUnassignedPartInspectorPanel,
  ObjectPhysicsScopeInspectorPanel,
  ObjectsRootInspectorPanel,
  PhysicsCouplingsInspectorPanel,
  PlanarMonitorsInspectorPanel,
  SessionRootInspectorPanel,
  UniverseRootInspectorPanel,
  UnresolvedPhysicsScopeInspectorPanel,
  Visualizations2DDraftInspectorPanel,
  Visualizations2DOverviewInspectorPanel,
  Visualizations2DParameterInspectorPanel,
  Visualizations2DPlotInspectorPanel,
} from "./panels/ModelTreeOverviewInspectorPanels";
import { RegionsListPanel } from "./panels/RegionsListPanel";
import {
  RuntimeCapabilityDiagnosticInspectorPanel,
  RuntimeCommandJobInspectorPanel,
  RuntimeFrequencyDiagnosticInspectorPanel,
  RuntimeHealthDiagnosticInspectorPanel,
  RuntimeMeshDiagnosticInspectorPanel,
  RuntimePerformanceDiagnosticInspectorPanel,
  RuntimeProblemDiagnosticInspectorPanel,
  RuntimeResourceDiagnosticInspectorPanel,
  RuntimeResourceInspectorPanel,
  RuntimeRunJobInspectorPanel,
  RuntimeSolverDiagnosticInspectorPanel,
  RuntimeStageJobInspectorPanel,
} from "./panels/RuntimeExplorerInspectorPanels";
import {
  DiagnosticsOverviewInspectorPanel,
  JobsOverviewInspectorPanel,
  ResourcesOverviewInspectorPanel,
} from "./panels/RuntimeExplorerOverviewInspectorPanels";
import {
  AirboxVisualizationInspectorPanel,
  AnalysisChartInspectorPanel,
  AnalysisChartPointInspectorPanel,
  BuilderPrimitiveInspectorPanel,
  CrossSectionDraftInspectorPanel,
  CrossSectionInspectorPanelRoute,
  CrossSectionPlotInspectorPanel,
  FdmCellInspectorPanel,
  FdmGridActiveUnassignedInspectorPanel,
  FdmGridCommonInspectorPanel,
  FdmGridDescriptorInspectorPanel,
  FdmGridInspectorPanelRoute,
  FdmGridLayerInspectorPanel,
  FdmGridLayerMaskInspectorPanel,
  FdmGridLayerProvenanceInspectorPanel,
  FdmGridLayerTransferInspectorPanel,
  FdmGridLayersInspectorPanel,
  FdmGridMagneticSupportInspectorPanel,
  FdmGridMaskInspectorPanel,
  FdmGridNativeGridInspectorPanel,
  FdmGridProvenanceInspectorPanel,
  FdmGridRegionInspectorPanel,
  FdmGridUniverseOutsideSupportInspectorPanel,
  FieldDriveInspectorPanel,
  FieldDrivesInspectorPanel,
  GeometryObjectInspectorPanel,
  LiveChartInspectorPanel,
  LiveChartPointInspectorPanel,
  MeshBuildsInspectorPanel,
  MeshPartAirboxInspectorPanel,
  MeshQualityInspectorPanel,
  MeshRegionsInspectorPanel,
  MeshRootInspectorPanel,
  MeshSharedDomainInspectorPanel,
  MeshSizeFieldsInspectorPanel,
  ObjectMagneticParametersInspectorPanel,
  ObjectMagneticTextureAssetInspectorPanel,
  ObjectMagneticTextureInspectorPanel,
  ObjectMagneticTextureLoadInspectorPanel,
  ObjectMagneticTextureTransformInspectorPanel,
  ObjectMaterialInspectorPanel,
  ObjectRegionGeometryInspectorPanel,
  ObjectRegionMagneticParametersInspectorPanel,
  ObjectRegionMagneticTextureInspectorPanel,
  ObjectRegionMaterialInspectorPanel,
  ObjectRegionShapeInspectorPanel,
  ObjectRegionTextureInspectorPanel,
  StudyExecutionInspectorPanel,
  StudyRecoveryInspectorPanel,
  StudyRootInspectorPanel,
  StudyStageActionInspectorPanel,
  StudyStageAddFieldDriveInspectorPanel,
  StudyStageAutosaveInspectorPanel,
  StudyStageChangeDeviceInspectorPanel,
  StudyStageFftResponseInspectorPanel,
  StudyStageHysteresisInspectorPanel,
  StudyStageRelaxInspectorPanel,
  StudyStageRunInspectorPanel,
  StudyStageSaveStateInspectorPanel,
  StudyStageTableAutosaveInspectorPanel,
  StudyStagesInspectorPanel,
} from "./panels/DedicatedExplorerInspectorPanels";
import { FieldRow } from "./primitives/FieldRow";
import { InspectorGroup } from "./primitives/InspectorGroup";
import { VisualizationDebugPanel } from "./panels/visualization-debug/VisualizationDebugPanel";
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
} from "./panels/StudyStageInspectorRouter";
import { resolveFrequencyDomainNodeDetail } from "./panels/frequencyDomainNodeDetails";
import type {
  InspectorPanelContribution,
  InspectorPanelProps,
} from "./inspectorTypes";

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
  "results.dynamics.root",
  "results.time_domain.spectral_feature",
  "results.time_domain.dsf_point",
  "results.resonance.root",
  "results.resonance.modal.stage",
  "results.resonance.driven.stage",
  "results.resonance.modal.spectrum",
  "results.resonance.modal.modes",
  "results.resonance.modal.mode",
  "results.resonance.modal.coupling",
  "results.resonance.driven.spectrum",
  "results.resonance.driven.peaks",
  "results.resonance.driven.frequency_points",
  "results.resonance.driven.fields",
  "results.resonance.driven.field",
  "results.dispersion.root",
  "results.dispersion.modal.stage",
  "results.dispersion.driven.stage",
  "results.dispersion.k_sampling",
  "results.dispersion.modal.relation",
  "results.dispersion.modal.branches",
  "results.dispersion.modal.modes_at_k",
  "results.dispersion.modal.mode_at_k",
  "results.dispersion.driven.response_map",
  "results.dispersion.driven.field_at_k",
  "results.hysteresis.root",
  "results.analysis_views.root",
  "results.analysis_views.definition",
  "results.derived_values.root",
  "results.derived_values.definition",
  "results.tables.root",
  "results.tables.definition",
  "results.exports.root",
  "results.exports.definition",
  "results.resonance.modal.provenance",
  "results.resonance.driven.provenance",
  "results.dispersion.modal.provenance",
  "results.dispersion.driven.provenance",
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
  "results.dynamics.root": DynamicsResultInspector,
  "results.time_domain.spectral_feature": LegacyTimeDomainResultInspector,
  "results.time_domain.dsf_point": LegacyTimeDomainResultInspector,
  "results.resonance.root": ResonanceOverviewResultInspector,
  "results.resonance.modal.stage": ResonanceModalStageResultInspector,
  "results.resonance.driven.stage": ResonanceDrivenStageResultInspector,
  "results.resonance.modal.spectrum": ResonanceModalSpectrumResultInspector,
  "results.resonance.modal.modes": ResonanceModeShapesResultInspector,
  "results.resonance.modal.mode": ResonanceModalModeResultInspector,
  "results.resonance.modal.coupling": ResonanceModalCouplingResultInspector,
  "results.resonance.modal.provenance": ResonanceModalProvenanceResultInspector,
  "results.resonance.driven.spectrum": ResonanceDrivenSpectrumResultInspector,
  "results.resonance.driven.peaks": ResonanceDrivenPeaksResultInspector,
  "results.resonance.driven.frequency_points":
    ResonanceFrequencyPointsResultInspector,
  "results.resonance.driven.fields": ResonanceResponseFieldsResultInspector,
  "results.resonance.driven.field": ResonanceResponseFieldResultInspector,
  "results.resonance.driven.provenance": ResonanceDrivenProvenanceResultInspector,
  "results.dispersion.root": DispersionOverviewResultInspector,
  "results.dispersion.modal.stage": DispersionModalStageResultInspector,
  "results.dispersion.driven.stage": DispersionDrivenStageResultInspector,
  "results.dispersion.k_sampling": DispersionKSamplingResultInspector,
  "results.dispersion.modal.relation": DispersionRelationResultInspector,
  "results.dispersion.modal.branches": DispersionBranchesResultInspector,
  "results.dispersion.modal.modes_at_k": DispersionModesAtKResultInspector,
  "results.dispersion.modal.mode_at_k": DispersionModeAtKResultInspector,
  "results.dispersion.modal.provenance": DispersionModalProvenanceResultInspector,
  "results.dispersion.driven.response_map": DispersionResponseMapResultInspector,
  "results.dispersion.driven.field_at_k": DispersionResponseFieldAtKResultInspector,
  "results.dispersion.driven.provenance": DispersionDrivenProvenanceResultInspector,
  "results.hysteresis.root": HysteresisResultInspector,
  "results.analysis_views.root": AnalysisViewsOverviewInspector,
  "results.analysis_views.definition": AnalysisViewDefinitionInspector,
  "results.derived_values.root": DerivedValuesOverviewInspector,
  "results.derived_values.definition": DerivedValueDefinitionInspector,
  "results.tables.root": TablesOverviewInspector,
  "results.tables.definition": TableDefinitionInspector,
  "results.exports.root": ExportsOverviewInspector,
  "results.exports.definition": ExportDefinitionInspector,
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

interface VisualizationDebugInspectorOwner {
  actionSummary: string;
  capabilityDescription: string;
  id: string;
  targetLabel: string;
  title: string;
}

const OBJECT_VISUALIZATION_DEBUG_OWNER: VisualizationDebugInspectorOwner = {
  actionSummary: "Inspect object render adoption and export bounded evidence",
  capabilityDescription:
    "Object-scoped FEM viewport snapshots, field carriers, and exact transport metadata",
  id: "object.visualization.debug",
  targetLabel: "Magnetic object target",
  title: "Object Visualization Debug",
};

const OBJECT_REGION_VISUALIZATION_DEBUG_OWNER: VisualizationDebugInspectorOwner = {
  actionSummary: "Inspect region overlay adoption and export bounded evidence",
  capabilityDescription:
    "Region overlay snapshots with part-scoped carriers and exact transport metadata",
  id: "object.region.visualization.debug",
  targetLabel: "Object region target",
  title: "Region Visualization Debug",
};

function visualizationDebugTargetId(selection: InspectorPanelProps["selection"]): string {
  const ref = selection.ref;
  return ref && "visualizationTargetId" in ref
    ? String(ref.visualizationTargetId)
    : "unresolved";
}

function VisualizationDebugOwnerPanel({
  owner,
  selection,
}: InspectorPanelProps & { owner: VisualizationDebugInspectorOwner }) {
  return (
    <div className="fm-inspector-panel" data-inspector-owner={owner.id}>
      <InspectorGroup title={owner.title}>
        <FieldRow label="Owner" value={owner.id} />
        <FieldRow
          label="Target"
          value={`${owner.targetLabel} (${visualizationDebugTargetId(selection)})`}
        />
        <FieldRow label="Capabilities" value={owner.capabilityDescription} />
        <FieldRow label="Actions" value={owner.actionSummary} />
      </InspectorGroup>
      <VisualizationDebugPanel selection={selection} />
    </div>
  );
}

function ObjectVisualizationDebugOwner({ selection }: InspectorPanelProps) {
  return (
    <VisualizationDebugOwnerPanel
      owner={OBJECT_VISUALIZATION_DEBUG_OWNER}
      selection={selection}
    />
  );
}

function ObjectRegionVisualizationDebugOwner({ selection }: InspectorPanelProps) {
  return (
    <VisualizationDebugOwnerPanel
      owner={OBJECT_REGION_VISUALIZATION_DEBUG_OWNER}
      selection={selection}
    />
  );
}

const INSPECTOR_ROUTE_CONTRIBUTIONS: InspectorPanelContribution[] = [
  {
    id: "planar-monitor-draft",
    title: "Planar Monitor Draft",
    selectionKinds: ["model.planar.monitor.draft"],
    component: PlanarMonitorDraftInspectorPanel,
  },
  {
    id: "planar-monitor",
    title: "Planar Monitor",
    selectionKinds: ["model.planar.monitor"],
    component: PlanarMonitorInspectorPanel,
  },
  {
    id: "chart",
    title: "Charts",
    selectionKinds: ["analysis.chart"],
    component: AnalysisChartInspectorPanel,
  },
  {
    id: "chart-point",
    title: "Chart Point",
    selectionKinds: ["analysis.chart-point"],
    component: AnalysisChartPointInspectorPanel,
  },
  {
    id: "live-chart",
    title: "Live Chart",
    selectionKinds: ["live.chart"],
    component: LiveChartInspectorPanel,
  },
  {
    id: "live-chart-point",
    title: "Live Chart Point",
    selectionKinds: ["live.chart-point"],
    component: LiveChartPointInspectorPanel,
  },
  {
    id: "quick-chart",
    title: "Quick Chart",
    selectionKinds: ["results.quick_chart"],
    component: QuickChartInspectorPanel,
  },
  {
    id: "session-root",
    title: "Session Model",
    selectionKinds: ["session.root"],
    component: SessionRootInspectorPanel,
  },
  {
    id: "universe-root",
    title: "Universe",
    selectionKinds: ["universe.root"],
    component: UniverseRootInspectorPanel,
  },
  {
    id: "objects-root",
    title: "Objects",
    selectionKinds: ["objects.root"],
    component: ObjectsRootInspectorPanel,
  },
  {
    id: "definitions-root",
    title: "Definitions",
    selectionKinds: ["definitions.root"],
    component: DefinitionsRootInspectorPanel,
  },
  {
    id: "planar-monitors",
    title: "Planar Monitors",
    selectionKinds: ["model.planar.monitors"],
    component: PlanarMonitorsInspectorPanel,
  },
  {
    id: "physics-couplings",
    title: "Couplings",
    selectionKinds: ["physics.couplings"],
    component: PhysicsCouplingsInspectorPanel,
  },
  {
    id: "physics-scope-global",
    title: "Global Physics",
    selectionKinds: ["physics.scope.global"],
    component: GlobalPhysicsScopeInspectorPanel,
  },
  {
    id: "object-physics-scope",
    title: "Object Physics Scope",
    selectionKinds: ["object.physics.scope"],
    component: ObjectPhysicsScopeInspectorPanel,
  },
  {
    id: "physics-scope-cross-object",
    title: "Cross-object Interfaces",
    selectionKinds: ["physics.scope.cross-object"],
    component: CrossObjectPhysicsScopeInspectorPanel,
  },
  {
    id: "physics-scope-unresolved",
    title: "Unresolved Physics",
    selectionKinds: ["physics.scope.unresolved"],
    component: UnresolvedPhysicsScopeInspectorPanel,
  },
  {
    id: "mesh-unassigned",
    title: "Unassigned Mesh Parts",
    selectionKinds: ["mesh.unassigned"],
    component: MeshUnassignedInspectorPanel,
  },
  {
    id: "mesh-unassigned-part",
    title: "Unassigned Mesh Part",
    selectionKinds: ["mesh.unassigned.part"],
    component: MeshUnassignedPartInspectorPanel,
  },
  {
    id: "visualizations-2d-root",
    title: "Visualizations 2D",
    selectionKinds: ["visualizations-2d.root"],
    component: Visualizations2DOverviewInspectorPanel,
  },
  {
    id: "visualizations-2d-draft",
    title: "2D Visualization Draft",
    selectionKinds: ["visualizations-2d.draft"],
    component: Visualizations2DDraftInspectorPanel,
  },
  {
    id: "visualizations-2d-parameter",
    title: "2D Visualization Parameter",
    selectionKinds: ["visualizations-2d.parameter"],
    component: Visualizations2DParameterInspectorPanel,
  },
  {
    id: "visualizations-2d-plot",
    title: "2D Visualization Plot",
    selectionKinds: ["visualizations-2d.plot"],
    component: Visualizations2DPlotInspectorPanel,
  },
  {
    id: "resources-overview",
    title: "Resources",
    selectionKinds: ["resources.root"],
    component: ResourcesOverviewInspectorPanel,
  },
  {
    id: "results-overview",
    title: "Results",
    selectionKinds: ["results.root"],
    component: ResultsOverviewInspectorPanel,
  },
  {
    id: "jobs-overview",
    title: "Jobs",
    selectionKinds: ["jobs.root"],
    component: JobsOverviewInspectorPanel,
  },
  {
    id: "diagnostics-overview",
    title: "Diagnostics",
    selectionKinds: ["diagnostics.root"],
    component: DiagnosticsOverviewInspectorPanel,
  },
  {
    id: "runtime-resource-diagnostic",
    title: "Resource Diagnostic",
    selectionKinds: ["diagnostics.resource"],
    component: RuntimeResourceDiagnosticInspectorPanel,
  },
  {
    id: "runtime-resource",
    title: "Runtime Resource",
    selectionKinds: ["resources.runtime"],
    component: RuntimeResourceInspectorPanel,
  },
  {
    id: "runtime-run-job",
    title: "Runtime Run",
    selectionKinds: ["jobs.run"],
    component: RuntimeRunJobInspectorPanel,
  },
  {
    id: "runtime-stage-job",
    title: "Runtime Stage",
    selectionKinds: ["jobs.stage"],
    component: RuntimeStageJobInspectorPanel,
  },
  {
    id: "runtime-command-job",
    title: "Runtime Command",
    selectionKinds: ["jobs.command"],
    component: RuntimeCommandJobInspectorPanel,
  },
  {
    id: "runtime-problem-diagnostic",
    title: "Problem Diagnostic",
    selectionKinds: ["diagnostics.problem"],
    component: RuntimeProblemDiagnosticInspectorPanel,
  },
  {
    id: "runtime-health-diagnostic",
    title: "Health Diagnostic",
    selectionKinds: ["diagnostics.health"],
    component: RuntimeHealthDiagnosticInspectorPanel,
  },
  {
    id: "runtime-capability-diagnostic",
    title: "Capability Diagnostic",
    selectionKinds: ["diagnostics.capability"],
    component: RuntimeCapabilityDiagnosticInspectorPanel,
  },
  {
    id: "runtime-solver-diagnostic",
    title: "Solver Diagnostic",
    selectionKinds: ["diagnostics.solver"],
    component: RuntimeSolverDiagnosticInspectorPanel,
  },
  {
    id: "runtime-mesh-diagnostic",
    title: "Mesh Diagnostic",
    selectionKinds: ["diagnostics.mesh"],
    component: RuntimeMeshDiagnosticInspectorPanel,
  },
  {
    id: "runtime-frequency-diagnostic",
    title: "Frequency-domain Diagnostic",
    selectionKinds: ["diagnostics.frequency-domain"],
    component: RuntimeFrequencyDiagnosticInspectorPanel,
  },
  {
    id: "runtime-performance-diagnostic",
    title: "Performance Diagnostic",
    selectionKinds: ["diagnostics.performance"],
    component: RuntimePerformanceDiagnosticInspectorPanel,
  },
  {
    id: "object-general",
    title: "Object General",
    selectionKinds: ["object.root"],
    component: ObjectGeneralPanel,
  },
  {
    id: "object-frozen-spins",
    title: "Frozen Spins",
    selectionKinds: ["object.frozen-spins"],
    component: FrozenSpinsInspectorPanel,
  },
  {
    id: "geometry-object",
    title: "Geometry",
    selectionKinds: ["object.geometry"],
    component: GeometryObjectInspectorPanel,
  },
  {
    id: "builder-primitive",
    title: "Builder Primitive",
    selectionKinds: ["builder.primitive"],
    component: BuilderPrimitiveInspectorPanel,
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
    component: AirboxOverviewLanePanel,
  },
  {
    id: "fdm-multilayer-airbox-target",
    title: "Multilayer Airbox target",
    selectionKinds: ["airbox.multilayer.target"],
    component: FdmMultilayerAirboxTargetPanel,
  },
  {
    id: "boundary-faces-overview",
    title: "Boundary Faces",
    selectionKinds: ["boundary-faces.root"],
    component: BoundaryFacesOverviewPanel,
  },
  {
    id: "airbox-visualization",
    title: "Airbox Visualization",
    selectionKinds: ["airbox.visualization"],
    component: AirboxVisualizationInspectorPanel,
  },
  {
    id: "mesh-part-airbox-visualization",
    title: "Airbox Mesh Part Visualization",
    selectionKinds: ["mesh-part-airbox"],
    component: MeshPartAirboxInspectorPanel,
  },
  {
    id: "object-visualization",
    title: "Visualization",
    selectionKinds: ["object.visualization"],
    component: ObjectVisualizationPanel,
  },
  {
    id: "mesh-part-visualization",
    title: "Mesh-part Visualization",
    selectionKinds: ["mesh-part"],
    component: MeshPartVisualizationPanel,
  },
  {
    id: "airbox-visualization-debug",
    title: "Airbox Visualization Debug",
    selectionKinds: ["airbox.visualization.debug"],
    component: AirboxVisualizationDebugInspectorPanel,
  },
  {
    id: "object-visualization-debug",
    title: "Object Visualization Debug",
    selectionKinds: ["object.visualization.debug"],
    component: ObjectVisualizationDebugOwner,
  },
  {
    id: "object-region-visualization-debug",
    title: "Region Visualization Debug",
    selectionKinds: ["object.region.visualization.debug"],
    component: ObjectRegionVisualizationDebugOwner,
  },
  {
    id: "object-mode-visualization-overview",
    title: "Mode Visualization Overview",
    selectionKinds: ["object.mode_visualization"],
    component: ModeVisualizationOverviewPanel,
  },
  {
    id: "physics-interaction",
    title: "Physics Interaction",
    selectionKinds: ["object.physics"],
    component: PhysicsInteractionPanel,
  },
  {
    id: "physics-graph-module",
    title: "Physics Module",
    selectionKinds: ["physics.module"],
    component: PhysicsGraphModuleInspectorPanel,
  },
  {
    id: "physics-coupling",
    title: "Coupling",
    selectionKinds: ["physics.coupling"],
    component: CouplingInspectorPanel,
  },
  {
    id: "physics-current-transport",
    title: "Charge transport",
    selectionKinds: ["physics.current-transport"],
    component: CurrentTransportInspectorPanel,
  },
  {
    id: "physics-structured-current-closure",
    title: "Structured Current Closure",
    selectionKinds: ["physics.structured-current-closure"],
    component: StructuredCurrentClosureInspectorPanel,
  },
  {
    id: "physics-structured-current-source-cut",
    title: "Structured Current Source Cut",
    selectionKinds: ["physics.structured-current-source-cut"],
    component: StructuredCurrentSourceCutInspectorPanel,
  },
  {
    id: "physics-spin-transport",
    title: "Spin transport",
    selectionKinds: ["physics.spin-transport"],
    component: SpinTransportInspectorPanel,
  },
  {
    id: "physics-spin-interface",
    title: "HM/FM interface",
    selectionKinds: ["physics.spin-interface"],
    component: SpinInterfaceInspectorPanel,
  },
  {
    id: "physics-spin-torque",
    title: "Transport torque",
    selectionKinds: ["physics.spin-torque"],
    component: SpinTorqueInspectorPanel,
  },
  {
    id: "physics-oersted-field",
    title: "Oersted Field",
    selectionKinds: ["physics.oersted-field"],
    component: OerstedFieldInspectorPanel,
  },
  {
    id: "physics-field-drive",
    title: "Field Drive",
    selectionKinds: ["physics.field-drives"],
    component: FieldDrivesInspectorPanel,
  },
  {
    id: "physics-field-drive-item",
    title: "Field Drive Item",
    selectionKinds: ["physics.field-drive"],
    component: FieldDriveInspectorPanel,
  },
  {
    id: "object-material",
    title: "Magnetic Parameters",
    selectionKinds: ["object.magnetic-parameters"],
    component: ObjectMagneticParametersInspectorPanel,
  },
  {
    id: "object-material-assignment",
    title: "Material Assignment",
    selectionKinds: ["object.material"],
    component: ObjectMaterialInspectorPanel,
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
    selectionKinds: ["object.region.geometry"],
    component: ObjectRegionGeometryInspectorPanel,
  },
  {
    id: "object-region-shape",
    title: "Region Shape",
    selectionKinds: ["object.region.shape"],
    component: ObjectRegionShapeInspectorPanel,
  },
  {
    id: "object-region-magnetic-parameters",
    title: "Region Magnetic Parameters",
    selectionKinds: ["object.region.magnetic-parameters"],
    component: ObjectRegionMagneticParametersInspectorPanel,
  },
  {
    id: "object-region-material",
    title: "Region Material",
    selectionKinds: ["object.region.material"],
    component: ObjectRegionMaterialInspectorPanel,
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
    selectionKinds: ["object.region.texture"],
    component: ObjectRegionTextureInspectorPanel,
  },
  {
    id: "object-region-magnetic-texture",
    title: "Region Magnetic Texture",
    selectionKinds: ["object.region-magnetic-texture"],
    component: ObjectRegionMagneticTextureInspectorPanel,
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
    selectionKinds: ["object.magnetic-texture"],
    component: ObjectMagneticTextureInspectorPanel,
  },
  {
    id: "object-magnetic-texture-asset",
    title: "Magnetic Texture Asset",
    selectionKinds: ["object.magnetic-texture.asset"],
    component: ObjectMagneticTextureAssetInspectorPanel,
  },
  {
    id: "object-magnetic-texture-load",
    title: "Magnetic Texture Load",
    selectionKinds: ["object.magnetic-texture.load"],
    component: ObjectMagneticTextureLoadInspectorPanel,
  },
  {
    id: "object-magnetic-texture-transform",
    title: "Magnetic Texture Transform",
    selectionKinds: ["object.magnetic-texture.transform"],
    component: ObjectMagneticTextureTransformInspectorPanel,
  },
  {
    id: "airbox-mesh-overview",
    title: "Airbox Mesh Overview",
    selectionKinds: ["airbox.mesh"],
    component: AirboxMeshOverviewLanePanel,
  },
  {
    id: "airbox-mesh-parameters",
    title: "Airbox Mesh Parameters",
    selectionKinds: ["airbox.mesh.parameters"],
    component: AirboxMeshParametersLanePanel,
  },
  {
    id: "airbox-mesh-quality-gates",
    title: "Airbox Mesh Quality Gates",
    selectionKinds: ["airbox.mesh.quality-gates"],
    component: AirboxMeshQualityGatesLanePanel,
  },
  {
    id: "airbox-mesh-statistics",
    title: "Airbox Mesh Statistics",
    selectionKinds: ["airbox.mesh.statistics"],
    component: AirboxMeshStatisticsLanePanel,
  },
  {
    id: "airbox-mesh-topology",
    title: "Airbox Mesh Topology",
    selectionKinds: ["airbox.mesh.topology"],
    component: AirboxMeshTopologyLanePanel,
  },
  {
    id: "airbox-mesh-build",
    title: "Airbox Mesh Build",
    selectionKinds: ["airbox.mesh.build"],
    component: AirboxMeshBuildLanePanel,
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
    title: "Mesh",
    selectionKinds: ["mesh.root"],
    component: MeshRootInspectorPanel,
  },
  {
    id: "mesh-shared-domain",
    title: "Shared Domain Mesh",
    selectionKinds: ["mesh.shared-domain"],
    component: MeshSharedDomainInspectorPanel,
  },
  {
    id: "mesh-builds",
    title: "Mesh Builds",
    selectionKinds: ["mesh.builds"],
    component: MeshBuildsInspectorPanel,
  },
  {
    id: "mesh-quality",
    title: "Mesh Quality",
    selectionKinds: ["mesh.quality"],
    component: MeshQualityInspectorPanel,
  },
  {
    id: "mesh-size-fields",
    title: "Mesh Size Fields",
    selectionKinds: ["mesh.size-fields"],
    component: MeshSizeFieldsInspectorPanel,
  },
  {
    id: "mesh-regions",
    title: "Mesh Regions",
    selectionKinds: ["mesh.regions"],
    component: MeshRegionsInspectorPanel,
  },
  {
    id: "fdm-grid",
    title: "FDM Mesh",
    selectionKinds: ["mesh.grid"],
    component: FdmGridInspectorPanelRoute,
  },
  {
    id: "fdm-grid-descriptor",
    title: "FDM Grid Descriptor",
    selectionKinds: ["mesh.grid.descriptor"],
    component: FdmGridDescriptorInspectorPanel,
  },
  {
    id: "fdm-grid-common",
    title: "FDM Grid Common",
    selectionKinds: ["mesh.grid.common"],
    component: FdmGridCommonInspectorPanel,
  },
  {
    id: "fdm-grid-layers",
    title: "FDM Grid Layers",
    selectionKinds: ["mesh.grid.layers"],
    component: FdmGridLayersInspectorPanel,
  },
  {
    id: "fdm-grid-layer",
    title: "FDM Grid Layer",
    selectionKinds: ["mesh.grid.layer"],
    component: FdmGridLayerInspectorPanel,
  },
  {
    id: "fdm-grid-native-grid",
    title: "FDM Native Grid",
    selectionKinds: ["mesh.grid.layer.native-grid"],
    component: FdmGridNativeGridInspectorPanel,
  },
  {
    id: "fdm-grid-layer-mask",
    title: "FDM Grid Layer Mask",
    selectionKinds: ["mesh.grid.layer.mask"],
    component: FdmGridLayerMaskInspectorPanel,
  },
  {
    id: "fdm-grid-layer-transfer",
    title: "FDM Grid Layer Transfer",
    selectionKinds: ["mesh.grid.layer.transfer"],
    component: FdmGridLayerTransferInspectorPanel,
  },
  {
    id: "fdm-grid-layer-provenance",
    title: "FDM Grid Layer Provenance",
    selectionKinds: ["mesh.grid.layer.provenance"],
    component: FdmGridLayerProvenanceInspectorPanel,
  },
  {
    id: "fdm-grid-magnetic-support",
    title: "FDM Magnetic Support",
    selectionKinds: ["mesh.grid.magnetic-support"],
    component: FdmGridMagneticSupportInspectorPanel,
  },
  {
    id: "fdm-grid-active-unassigned",
    title: "FDM Active Unassigned Cells",
    selectionKinds: ["mesh.grid.active-unassigned"],
    component: FdmGridActiveUnassignedInspectorPanel,
  },
  {
    id: "fdm-grid-mask",
    title: "FDM Grid Mask",
    selectionKinds: ["mesh.grid.mask"],
    component: FdmGridMaskInspectorPanel,
  },
  {
    id: "fdm-grid-provenance",
    title: "FDM Grid Provenance",
    selectionKinds: ["mesh.grid.provenance"],
    component: FdmGridProvenanceInspectorPanel,
  },
  {
    id: "fdm-grid-region",
    title: "FDM Grid Region",
    selectionKinds: ["mesh.grid.region"],
    component: FdmGridRegionInspectorPanel,
  },
  {
    id: "fdm-grid-universe-outside-support",
    title: "FDM Universe Outside Support",
    selectionKinds: ["mesh.grid.universe-outside-support"],
    component: FdmGridUniverseOutsideSupportInspectorPanel,
  },
  {
    id: "fdm-cell",
    title: "FDM Cell",
    selectionKinds: ["fdm.cell"],
    component: FdmCellInspectorPanel,
  },
  {
    id: "cross-section",
    title: "Cross-Section",
    selectionKinds: ["mesh.cross-section"],
    component: CrossSectionInspectorPanelRoute,
  },
  {
    id: "cross-section-draft",
    title: "Cross-Section Draft",
    selectionKinds: ["mesh.cross-section.draft"],
    component: CrossSectionDraftInspectorPanel,
  },
  {
    id: "cross-section-plot",
    title: "Cross-Section Plot",
    selectionKinds: ["mesh.cross-section.plot"],
    component: CrossSectionPlotInspectorPanel,
  },
  {
    id: "study-root",
    title: "Study",
    selectionKinds: ["study.root"],
    component: StudyRootInspectorPanel,
  },
  {
    id: "study-stages",
    title: "Study Stages",
    selectionKinds: ["study.stages"],
    component: StudyStagesInspectorPanel,
  },
  {
    id: "study-execution",
    title: "Study Execution",
    selectionKinds: ["study.execution"],
    component: StudyExecutionInspectorPanel,
  },
  {
    id: "study-recovery",
    title: "Study Recovery",
    selectionKinds: ["study.recovery"],
    component: StudyRecoveryInspectorPanel,
  },
  {
    id: "study-stage",
    title: "Study Stage",
    selectionKinds: ["study.stage.action"],
    component: StudyStageActionInspectorPanel,
  },
  {
    id: "study-stage-add-field-drive",
    title: "Study Stage Add Field Drive",
    selectionKinds: ["study.stage.add_field_drive"],
    component: StudyStageAddFieldDriveInspectorPanel,
  },
  {
    id: "study-stage-autosave",
    title: "Study Stage Autosave",
    selectionKinds: ["study.stage.autosave"],
    component: StudyStageAutosaveInspectorPanel,
  },
  {
    id: "study-stage-fft-response",
    title: "Study Stage FFT Response",
    selectionKinds: ["study.stage.fft_response"],
    component: StudyStageFftResponseInspectorPanel,
  },
  {
    id: "study-stage-hysteresis",
    title: "Study Stage Hysteresis",
    selectionKinds: ["study.stage.hysteresis"],
    component: StudyStageHysteresisInspectorPanel,
  },
  {
    id: "study-stage-relax",
    title: "Study Stage Relax",
    selectionKinds: ["study.stage.relax"],
    component: StudyStageRelaxInspectorPanel,
  },
  {
    id: "study-stage-run",
    title: "Study Stage Run",
    selectionKinds: ["study.stage.run"],
    component: StudyStageRunInspectorPanel,
  },
  {
    id: "study-stage-table-autosave",
    title: "Study Stage Table Autosave",
    selectionKinds: ["study.stage.table_autosave"],
    component: StudyStageTableAutosaveInspectorPanel,
  },
  {
    id: "study-stage-change-device",
    title: "Study Stage Change Device",
    selectionKinds: ["study.stage.change_device"],
    component: StudyStageChangeDeviceInspectorPanel,
  },
  {
    id: "study-stage-save-state",
    title: "Study Stage Save State",
    selectionKinds: ["study.stage.save_state"],
    component: StudyStageSaveStateInspectorPanel,
  },
  ...frequencyDomainPanels,
  {
    id: "analysis-result",
    title: "Analysis result",
    selectionKinds: ["analysis.result"],
    component: AnalysisResultInspectorPanel,
  },
  {
    id: "field-quantity",
    title: "Field Quantity",
    selectionKinds: ["results.field_quantity"],
    component: FieldQuantityInspectorPanel,
  },
];

function createInspectorRoute(
  contribution: InspectorPanelContribution,
): InspectorRoute {
  return {
    id: contribution.id as InspectorRouteId,
    title: contribution.title,
    selectionKinds: contribution.selectionKinds,
    component: contribution.component,
    contribution,
  };
}

const INSPECTOR_ROUTES_BY_KIND = new Map<string, InspectorRoute>();

for (const contribution of INSPECTOR_ROUTE_CONTRIBUTIONS) {
  const route = createInspectorRoute(contribution);
  for (const kind of route.selectionKinds) {
    if (INSPECTOR_ROUTES_BY_KIND.has(kind)) {
      throw new Error(`Duplicate inspector route for ${kind}`);
    }
    INSPECTOR_ROUTES_BY_KIND.set(kind, route);
  }
}

const UNKNOWN_INSPECTOR_ROUTE = createInspectorRoute({
  id: "placeholder",
  title: "Selection",
  selectionKinds: ["*"],
  component: PlaceholderPanel,
});

export function resolveInspectorRoute(kind: string): InspectorRoute | null {
  return INSPECTOR_ROUTES_BY_KIND.get(kind) ?? null;
}

export function resolveUnknownInspectorRoute(): InspectorRoute {
  return UNKNOWN_INSPECTOR_ROUTE;
}
