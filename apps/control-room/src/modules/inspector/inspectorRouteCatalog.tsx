import {
  AirboxMeshBuildLanePanel,
  AirboxMeshOverviewLanePanel,
  AirboxMeshParametersLanePanel,
  AirboxMeshQualityGatesLanePanel,
  AirboxMeshStatisticsLanePanel,
  AirboxMeshTopologyLanePanel,
  AirboxOverviewLanePanel,
} from "./panels/airbox/AirboxInspectorLanePanel";
import { AirboxVisualizationPanel } from "./panels/airbox/AirboxVisualizationPanel";
import { FdmMultilayerAirboxTargetPanel } from "./panels/airbox/FdmMultilayerAirboxTargetPanel";
import { AntennaObjectPanel } from "./panels/AntennaObjectPanel";
import { ChartInspectorPanel } from "./panels/ChartInspectorPanel";
import { LiveChartInspectorPanel } from "./panels/LiveChartInspectorPanel";
import { QuickChartInspectorPanel } from "./panels/QuickChartInspectorPanel";
import { BoundaryFacesOverviewPanel } from "./panels/boundary-faces/BoundaryFacesOverviewPanel";
import { CouplingInspectorPanel } from "./panels/CouplingInspectorPanel";
import { RegionalFieldDrivePanel } from "./panels/RegionalFieldDrivePanel";
import { CrossSectionInspectorPanel } from "./panels/CrossSectionInspectorPanel";
import {
  EigenBranchesInspectorPanel,
  EigenDiagnosticsInspectorPanel,
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
  FmrOverviewInspectorPanel,
  FmrPeakInspectorPanel,
  FmrPeaksInspectorPanel,
} from "./panels/frequency-domain/FrequencyDomainResultInspectors";
import { EigenBranchInspectorPanel } from "./panels/frequency-domain/EigenBranchInspectorPanel";
import { EigenDispersionInspectorPanel } from "./panels/frequency-domain/EigenDispersionInspectorPanel";
import { EigenModeInspectorPanel } from "./panels/frequency-domain/EigenModeInspectorPanel";
import { FmrModalSpectrumInspectorPanel } from "./panels/frequency-domain/FmrModalSpectrumInspectorPanel";
import { FmrResponseSweepInspectorPanel } from "./panels/frequency-domain/FmrResponseSweepInspectorPanel";
import { GeometryObjectPanel } from "./panels/GeometryObjectPanel";
import { FieldQuantityInspectorPanel } from "./panels/FieldQuantityInspectorPanel";
import { MeshDetailsPanel } from "./panels/MeshDetailsPanel";
import { MeshPartVisualizationPanel } from "./panels/MeshPartVisualizationPanel";
import { FdmGridInspectorPanel } from "./panels/fdm-grid/FdmGridInspectorPanel";
import { ModeVisualizationOverviewPanel } from "./panels/mode-visualization/ModeVisualizationOverviewPanel";
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
  AnalysisViewDefinitionInspector,
  AnalysisViewsOverviewInspector,
  DerivedValueDefinitionInspector,
  DerivedValuesOverviewInspector,
  DispersionBranchesResultInspector,
  DispersionDrivenStageResultInspector,
  DispersionKSamplingResultInspector,
  DispersionModalStageResultInspector,
  DispersionModesAtKResultInspector,
  DispersionModeAtKResultInspector,
  DispersionOverviewResultInspector,
  DispersionRelationResultInspector,
  DispersionResponseMapResultInspector,
  DispersionResponseFieldAtKResultInspector,
  DynamicsResultInspector,
  ExportDefinitionInspector,
  ExportsOverviewInspector,
  HysteresisResultInspector,
  ResonanceDrivenPeaksResultInspector,
  ResonanceDrivenSpectrumResultInspector,
  ResonanceDrivenStageResultInspector,
  ResonanceFrequencyPointsResultInspector,
  ResonanceModalCouplingResultInspector,
  ResonanceModalSpectrumResultInspector,
  ResonanceModalModeResultInspector,
  ResonanceModalStageResultInspector,
  ResonanceModeShapesResultInspector,
  ResonanceOverviewResultInspector,
  ResonanceResponseFieldsResultInspector,
  ResonanceResponseFieldResultInspector,
  TableDefinitionInspector,
  TablesOverviewInspector,
} from "./panels/physics-first/PhysicsFirstResultInspectors";
import { RegionsListPanel } from "./panels/RegionsListPanel";
import { StudyInspectorPanel } from "./panels/StudyInspectorPanel";
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
  StudyStageInspectorRouter,
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
  "results.frequency_domain.provenance",
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
  "results.dynamics.root": DynamicsResultInspector,
  "results.resonance.root": ResonanceOverviewResultInspector,
  "results.resonance.modal.stage": ResonanceModalStageResultInspector,
  "results.resonance.driven.stage": ResonanceDrivenStageResultInspector,
  "results.resonance.modal.spectrum": ResonanceModalSpectrumResultInspector,
  "results.resonance.modal.modes": ResonanceModeShapesResultInspector,
  "results.resonance.modal.mode": ResonanceModalModeResultInspector,
  "results.resonance.modal.coupling": ResonanceModalCouplingResultInspector,
  "results.resonance.driven.spectrum": ResonanceDrivenSpectrumResultInspector,
  "results.resonance.driven.peaks": ResonanceDrivenPeaksResultInspector,
  "results.resonance.driven.frequency_points":
    ResonanceFrequencyPointsResultInspector,
  "results.resonance.driven.fields": ResonanceResponseFieldsResultInspector,
  "results.resonance.driven.field": ResonanceResponseFieldResultInspector,
  "results.dispersion.root": DispersionOverviewResultInspector,
  "results.dispersion.modal.stage": DispersionModalStageResultInspector,
  "results.dispersion.driven.stage": DispersionDrivenStageResultInspector,
  "results.dispersion.k_sampling": DispersionKSamplingResultInspector,
  "results.dispersion.modal.relation": DispersionRelationResultInspector,
  "results.dispersion.modal.branches": DispersionBranchesResultInspector,
  "results.dispersion.modal.modes_at_k": DispersionModesAtKResultInspector,
  "results.dispersion.modal.mode_at_k": DispersionModeAtKResultInspector,
  "results.dispersion.driven.response_map": DispersionResponseMapResultInspector,
  "results.dispersion.driven.field_at_k": DispersionResponseFieldAtKResultInspector,
  "results.hysteresis.root": HysteresisResultInspector,
  "results.analysis_views.root": AnalysisViewsOverviewInspector,
  "results.analysis_views.definition": AnalysisViewDefinitionInspector,
  "results.derived_values.root": DerivedValuesOverviewInspector,
  "results.derived_values.definition": DerivedValueDefinitionInspector,
  "results.tables.root": TablesOverviewInspector,
  "results.tables.definition": TableDefinitionInspector,
  "results.exports.root": ExportsOverviewInspector,
  "results.exports.definition": ExportDefinitionInspector,
  "results.frequency_domain.provenance": EigenProvenanceInspectorPanel,
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

interface VisualizationDebugInspectorOwner {
  actionSummary: string;
  capabilityDescription: string;
  id: string;
  targetLabel: string;
  title: string;
}

const AIRBOX_VISUALIZATION_DEBUG_OWNER: VisualizationDebugInspectorOwner = {
  actionSummary: "Inspect Airbox render adoption and export bounded evidence",
  capabilityDescription:
    "Airbox FEM viewport snapshots, field carriers, and exact transport metadata",
  id: "airbox.visualization.debug",
  targetLabel: "Airbox target",
  title: "Airbox Visualization Debug",
};

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

function AirboxVisualizationDebugOwner({ selection }: InspectorPanelProps) {
  return (
    <VisualizationDebugOwnerPanel
      owner={AIRBOX_VISUALIZATION_DEBUG_OWNER}
      selection={selection}
    />
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
    selectionKinds: ["analysis.chart", "analysis.chart-point"],
    component: ChartInspectorPanel,
  },
  {
    id: "live-chart",
    title: "Live Chart",
    selectionKinds: ["live.chart", "live.chart-point"],
    component: LiveChartInspectorPanel,
  },
  {
    id: "quick-chart",
    title: "Quick Chart",
    selectionKinds: ["results.quick_chart"],
    component: QuickChartInspectorPanel,
  },
  {
    id: "resources-overview",
    title: "Resources",
    selectionKinds: ["resources.root", "resources.field"],
    component: FieldQuantityInspectorPanel,
  },
  {
    id: "results-overview",
    title: "Results",
    selectionKinds: ["results.root"],
    component: FieldQuantityInspectorPanel,
  },
  {
    id: "jobs-overview",
    title: "Jobs",
    selectionKinds: ["jobs.root", "jobs.command"],
    component: StudyInspectorPanel,
  },
  {
    id: "diagnostics-overview",
    title: "Diagnostics",
    selectionKinds: ["diagnostics.root", "diagnostics.resource"],
    component: VisualizationDebugPanel,
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
    selectionKinds: ["airbox.visualization", "mesh-part-airbox"],
    component: AirboxVisualizationPanel,
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
    component: AirboxVisualizationDebugOwner,
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
    title: "Current Transport",
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
    title: "Spin Transport",
    selectionKinds: ["physics.spin-transport"],
    component: SpinTransportInspectorPanel,
  },
  {
    id: "physics-spin-interface",
    title: "Spin Interface",
    selectionKinds: ["physics.spin-interface"],
    component: SpinInterfaceInspectorPanel,
  },
  {
    id: "physics-spin-torque",
    title: "Spin Torque",
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
    selectionKinds: ["physics.field-drives", "physics.field-drive"],
    component: RegionalFieldDrivePanel,
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
    id: "fdm-grid",
    title: "FDM Mesh",
    selectionKinds: [
      "mesh.grid",
      "mesh.grid.descriptor",
      "mesh.grid.common",
      "mesh.grid.layers",
      "mesh.grid.layer",
      "mesh.grid.layer.native-grid",
      "mesh.grid.layer.mask",
      "mesh.grid.layer.transfer",
      "mesh.grid.layer.provenance",
      "mesh.grid.magnetic-support",
      "mesh.grid.active-unassigned",
      "mesh.grid.mask",
      "mesh.grid.provenance",
      "mesh.grid.region",
      "mesh.grid.universe-outside-support",
      "fdm.cell",
    ],
    component: FdmGridInspectorPanel,
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
      "study.stage.add_field_drive",
      "study.stage.autosave",
      "study.stage.fft_response",
      "study.stage.hysteresis",
      "study.stage.relax",
      "study.stage.run",
      "study.stage.table_autosave",
      "study.stage.change_device",
      "study.stage.save_state",
    ],
    component: StudyStageInspectorRouter,
  },
  ...frequencyDomainPanels,
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
