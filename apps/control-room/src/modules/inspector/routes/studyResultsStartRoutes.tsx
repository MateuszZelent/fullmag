import type { InspectorPanelProps } from "../inspectorTypes";
import {
  AirboxVisualizationInspectorPanel,
  AnalysisChartInspectorPanel,
  AnalysisChartPointInspectorPanel,
  LiveChartInspectorPanel,
  LiveChartPointInspectorPanel,
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
} from "../panels/DedicatedExplorerInspectorPanels";
import { FieldQuantityInspectorPanel } from "../panels/FieldQuantityInspectorPanel";
import { MaterializedDatasetInspectorPanel } from "../panels/MaterializedDatasetInspectorPanel";
import { MeshPartVisualizationPanel } from "../panels/MeshPartVisualizationPanel";
import { PlanarMonitorsInspectorPanel } from "../panels/ModelTreeOverviewInspectorPanels";
import { ObjectRegionVisualizationPanel } from "../panels/ObjectRegionsPanel";
import { ObjectVisualizationPanel } from "../panels/ObjectVisualizationEntryPanel";
import {
  ObservationFrameInspectorPanel,
  ObservationFramesOverviewPanel,
} from "../panels/ObservationFrameInspectorPanel";
import { PlanarMonitorDraftInspectorPanel } from "../panels/PlanarMonitorDraftInspectorPanel";
import { PlanarMonitorInspectorPanel } from "../panels/PlanarMonitorInspectorPanel";
import { QuickChartInspectorPanel } from "../panels/QuickChartInspectorPanel";
import {
  RuntimeCapabilityDiagnosticInspectorPanel,
  RuntimeCommandJobInspectorPanel,
  RuntimeFrequencyDiagnosticInspectorPanel,
  RuntimeHealthDiagnosticInspectorPanel,
  RuntimeMeshDiagnosticInspectorPanel,
  RuntimePerformanceDiagnosticInspectorPanel,
  RuntimeProblemDiagnosticInspectorPanel,
  RuntimeResourceInspectorPanel,
  RuntimeRunJobInspectorPanel,
  RuntimeSolverDiagnosticInspectorPanel,
  RuntimeStageJobInspectorPanel,
} from "../panels/RuntimeExplorerInspectorPanels";
import {
  DiagnosticsOverviewInspectorPanel,
  JobsOverviewInspectorPanel,
  ResourcesOverviewInspectorPanel,
} from "../panels/RuntimeExplorerOverviewInspectorPanels";
import {
  EigenmodesStageOverviewInspectorPanel,
  FrequencyResponseStageOverviewInspectorPanel,
  StudyStageInspectorRouter,
} from "../panels/StudyStageInspectorRouter";
import { AirboxVisualizationDebugInspectorPanel } from "../panels/airbox/AirboxVisualizationDebugInspectorPanel";
import { AnalysisResultInspectorPanel } from "../panels/analysis-results/AnalysisResultInspectorPanel";
import { PinnedVisualizationsInspectorPanel } from "../panels/analysis-results/PinnedVisualizationsInspectorPanel";
import { EigenFieldSweepInspectorPanel } from "../panels/frequency-domain/FrequencyDomainFieldSweepPanel";
import { FmrComparisonInspectorPanel } from "../panels/frequency-domain/FrequencyDomainResultInspectors";
import { resolveFrequencyDomainNodeDetail } from "../panels/frequencyDomainNodeDetails";
import { ModeVisualizationOverviewPanel } from "../panels/mode-visualization/ModeVisualizationOverviewPanel";
import {
  DispersionBranchesResultInspector,
  DispersionDrivenStageResultInspector,
  DispersionKSamplingResultInspector,
  DispersionModalStageResultInspector,
  DispersionModeAtKResultInspector,
  DispersionModesAtKResultInspector,
  DispersionOverviewResultInspector,
  DispersionRelationResultInspector,
  DispersionResponseFieldAtKResultInspector,
  DispersionResponseMapResultInspector,
  DynamicsResultInspector,
  HysteresisResultInspector,
  ResonanceDrivenPeaksResultInspector,
  ResonanceDrivenSpectrumResultInspector,
  ResonanceDrivenStageResultInspector,
  ResonanceModalCouplingResultInspector,
  ResonanceModalModeResultInspector,
  ResonanceModalSpectrumResultInspector,
  ResonanceModalStageResultInspector,
  ResonanceModeShapesResultInspector,
  ResonanceOverviewResultInspector,
  ResonanceResponseFieldResultInspector,
  ResonanceResponseFieldsResultInspector,
} from "../panels/physics-first/PhysicsFirstResultInspectors";
import {
  AnalysisViewDefinitionInspector,
  AnalysisViewsOverviewInspector,
  DerivedValueDefinitionInspector,
  DerivedValuesOverviewInspector,
  ExportDefinitionInspector,
  ExportsOverviewInspector,
  TableDefinitionInspector,
  TablesOverviewInspector,
} from "../panels/physics-first/PostprocessingResultInspectors";
import { ResultsOverviewInspectorPanel } from "../panels/physics-first/ResultsOverviewInspectorPanel";
import { VisualizationDebugPanel } from "../panels/visualization-debug/VisualizationDebugPanel";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorGroup } from "../primitives/InspectorGroup";

import { defineInspectorRoute, type InspectorRoute } from "./routeTypes";

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
  targetLabel: "Object target",
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

const MESH_PART_VISUALIZATION_DEBUG_OWNER: VisualizationDebugInspectorOwner = {
  actionSummary: "Inspect mesh-part carrier adoption and export bounded evidence",
  capabilityDescription:
    "Part-scoped mesh viewport snapshots, field carriers, and exact transport metadata",
  id: "mesh.part.visualization.debug",
  targetLabel: "Mesh part target",
  title: "Mesh Part Visualization Debug",
};

function visualizationDebugTargetId(
  selection: InspectorPanelProps["selection"],
): string {
  const ref = selection.ref;
  return ref && "visualizationTargetId" in ref
    ? String(ref.visualizationTargetId)
    : selection.nodeId ?? "mesh-part";
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

function MeshPartVisualizationDebugOwner({ selection }: InspectorPanelProps) {
  return (
    <VisualizationDebugOwnerPanel
      owner={MESH_PART_VISUALIZATION_DEBUG_OWNER}
      selection={selection}
    />
  );
}

function ResonanceDrivenFitsResultInspector(props: InspectorPanelProps) {
  return <ResonanceDrivenPeaksResultInspector {...props} />;
}

function ResonanceKittelFitResultInspector(props: InspectorPanelProps) {
  return <ResonanceOverviewResultInspector {...props} />;
}

function StudyStageMaskFieldDriveInspectorPanel(props: InspectorPanelProps) {
  return <StudyStageInspectorRouter {...props} />;
}

function HysteresisPointResultInspector(props: InspectorPanelProps) {
  return <HysteresisResultInspector {...props} />;
}

function HysteresisDatasetResultInspector(props: InspectorPanelProps) {
  return <AnalysisResultInspectorPanel {...props} />;
}

function frequencyDomainRouteId(kind: string): string {
  return `frequency-domain-${kind.replace(/[.:]/g, "-")}`;
}

function frequencyDomainRouteTitle(kind: string): string {
  return resolveFrequencyDomainNodeDetail({
    kind,
    label: null,
    moduleSource: "inspector",
    nodeId: null,
    objectId: null,
    ref: { kind, nodeId: `detail:${kind}`, type: "frequency-domain" },
  }).title;
}

export const CANONICAL_FREQUENCY_DOMAIN_SELECTION_KINDS = [
  "study.stage.eigenmodes",
  "study.stage.frequency_response",
  "results.frequency_domain.comparison",
  "results.dynamics.root",
  "results.resonance.root",
  "results.resonance.modal.stage",
  "results.resonance.driven.stage",
  "results.resonance.modal.spectrum",
  "results.resonance.modal.modes",
  "results.resonance.modal.mode",
  "results.resonance.modal.coupling",
  "results.resonance.modal.field_sweep",
  "results.resonance.driven.spectrum",
  "results.resonance.driven.peaks",
  "results.resonance.driven.fits",
  "results.resonance.driven.fields",
  "results.resonance.driven.field",
  "results.resonance.kittel_fit",
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
] as const;

type CanonicalFrequencyDomainKind =
  (typeof CANONICAL_FREQUENCY_DOMAIN_SELECTION_KINDS)[number];

const CANONICAL_FREQUENCY_DOMAIN_PANELS: Record<
  CanonicalFrequencyDomainKind,
  InspectorRoute["component"]
> = {
  "results.analysis_views.definition": AnalysisViewDefinitionInspector,
  "results.analysis_views.root": AnalysisViewsOverviewInspector,
  "results.derived_values.definition": DerivedValueDefinitionInspector,
  "results.derived_values.root": DerivedValuesOverviewInspector,
  "results.dispersion.driven.field_at_k": DispersionResponseFieldAtKResultInspector,
  "results.dispersion.driven.response_map": DispersionResponseMapResultInspector,
  "results.dispersion.driven.stage": DispersionDrivenStageResultInspector,
  "results.dispersion.k_sampling": DispersionKSamplingResultInspector,
  "results.dispersion.modal.branches": DispersionBranchesResultInspector,
  "results.dispersion.modal.mode_at_k": DispersionModeAtKResultInspector,
  "results.dispersion.modal.modes_at_k": DispersionModesAtKResultInspector,
  "results.dispersion.modal.relation": DispersionRelationResultInspector,
  "results.dispersion.modal.stage": DispersionModalStageResultInspector,
  "results.dispersion.root": DispersionOverviewResultInspector,
  "results.dynamics.root": DynamicsResultInspector,
  "results.exports.definition": ExportDefinitionInspector,
  "results.exports.root": ExportsOverviewInspector,
  "results.frequency_domain.comparison": FmrComparisonInspectorPanel,
  "results.hysteresis.root": HysteresisResultInspector,
  "results.resonance.driven.field": ResonanceResponseFieldResultInspector,
  "results.resonance.driven.fields": ResonanceResponseFieldsResultInspector,
  "results.resonance.driven.fits": ResonanceDrivenFitsResultInspector,
  "results.resonance.driven.peaks": ResonanceDrivenPeaksResultInspector,
  "results.resonance.driven.spectrum": ResonanceDrivenSpectrumResultInspector,
  "results.resonance.driven.stage": ResonanceDrivenStageResultInspector,
  "results.resonance.kittel_fit": ResonanceKittelFitResultInspector,
  "results.resonance.modal.coupling": ResonanceModalCouplingResultInspector,
  "results.resonance.modal.field_sweep": EigenFieldSweepInspectorPanel,
  "results.resonance.modal.mode": ResonanceModalModeResultInspector,
  "results.resonance.modal.modes": ResonanceModeShapesResultInspector,
  "results.resonance.modal.spectrum": ResonanceModalSpectrumResultInspector,
  "results.resonance.modal.stage": ResonanceModalStageResultInspector,
  "results.resonance.root": ResonanceOverviewResultInspector,
  "results.tables.definition": TableDefinitionInspector,
  "results.tables.root": TablesOverviewInspector,
  "study.stage.eigenmodes": EigenmodesStageOverviewInspectorPanel,
  "study.stage.frequency_response": FrequencyResponseStageOverviewInspectorPanel,
};

const CANONICAL_FREQUENCY_DOMAIN_ROUTES: readonly InspectorRoute[] =
  CANONICAL_FREQUENCY_DOMAIN_SELECTION_KINDS.map((kind) =>
    defineInspectorRoute({
      component: CANONICAL_FREQUENCY_DOMAIN_PANELS[kind],
      id: frequencyDomainRouteId(kind),
      selectionKinds: [kind],
      title: frequencyDomainRouteTitle(kind),
    }),
  );

/**
 * Canonical Wave 6 (Volume V) domain route registry: Study, Stages, Physics-First
 * Results, Visualization, Planar Monitors, Charts, Runtime & Datasets (93 routes).
 */
export const STUDY_RESULTS_START_ROUTES: readonly InspectorRoute[] = [
  defineInspectorRoute({
    component: PlanarMonitorsInspectorPanel,
    id: "planar-monitors",
    selectionKinds: ["model.planar.monitors"],
    title: "Planar Monitors",
  }),
  defineInspectorRoute({
    component: PlanarMonitorDraftInspectorPanel,
    id: "planar-monitor-draft",
    selectionKinds: ["model.planar.monitor.draft"],
    title: "Planar Monitor Draft",
  }),
  defineInspectorRoute({
    component: PlanarMonitorInspectorPanel,
    id: "planar-monitor",
    selectionKinds: ["model.planar.monitor"],
    title: "Planar Monitor",
  }),
  defineInspectorRoute({
    component: AnalysisChartInspectorPanel,
    id: "chart",
    selectionKinds: ["analysis.chart"],
    title: "Charts",
  }),
  defineInspectorRoute({
    component: AnalysisChartPointInspectorPanel,
    id: "chart-point",
    selectionKinds: ["analysis.chart-point"],
    title: "Chart Point",
  }),
  defineInspectorRoute({
    component: LiveChartInspectorPanel,
    id: "live-chart",
    selectionKinds: ["live.chart"],
    title: "Live Chart",
  }),
  defineInspectorRoute({
    component: LiveChartPointInspectorPanel,
    id: "live-chart-point",
    selectionKinds: ["live.chart-point"],
    title: "Live Chart Point",
  }),
  defineInspectorRoute({
    component: QuickChartInspectorPanel,
    id: "quick-chart",
    selectionKinds: ["results.quick_chart"],
    title: "Quick Chart",
  }),
  defineInspectorRoute({
    component: ObservationFramesOverviewPanel,
    id: "observation-frames-overview",
    selectionKinds: ["results.observation_frames.root"],
    title: "State Snapshots",
  }),
  defineInspectorRoute({
    component: PinnedVisualizationsInspectorPanel,
    id: "pinned-visualizations",
    selectionKinds: ["results.pinned_visualizations.root"],
    title: "Pinned Visualizations",
  }),
  defineInspectorRoute({
    component: ObservationFrameInspectorPanel,
    id: "observation-frame",
    selectionKinds: ["results.observation_frame"],
    title: "Observation Frame",
  }),
  defineInspectorRoute({
    component: ResourcesOverviewInspectorPanel,
    id: "resources-overview",
    selectionKinds: ["resources.root"],
    title: "Resources",
  }),
  defineInspectorRoute({
    component: ResultsOverviewInspectorPanel,
    id: "results-overview",
    selectionKinds: ["results.root"],
    title: "Results",
  }),
  defineInspectorRoute({
    component: JobsOverviewInspectorPanel,
    id: "jobs-overview",
    selectionKinds: ["jobs.root"],
    title: "Jobs",
  }),
  defineInspectorRoute({
    component: DiagnosticsOverviewInspectorPanel,
    id: "diagnostics-overview",
    selectionKinds: ["diagnostics.root"],
    title: "Diagnostics",
  }),
  defineInspectorRoute({
    component: RuntimeResourceInspectorPanel,
    id: "runtime-resource",
    selectionKinds: ["resources.runtime"],
    title: "Runtime Resource",
  }),
  defineInspectorRoute({
    component: RuntimeRunJobInspectorPanel,
    id: "runtime-run-job",
    selectionKinds: ["jobs.run"],
    title: "Runtime Run",
  }),
  defineInspectorRoute({
    component: RuntimeStageJobInspectorPanel,
    id: "runtime-stage-job",
    selectionKinds: ["jobs.stage"],
    title: "Runtime Stage",
  }),
  defineInspectorRoute({
    component: RuntimeCommandJobInspectorPanel,
    id: "runtime-command-job",
    selectionKinds: ["jobs.command"],
    title: "Runtime Command",
  }),
  defineInspectorRoute({
    component: RuntimeProblemDiagnosticInspectorPanel,
    id: "runtime-problem-diagnostic",
    selectionKinds: ["diagnostics.problem"],
    title: "Problem Diagnostic",
  }),
  defineInspectorRoute({
    component: RuntimeHealthDiagnosticInspectorPanel,
    id: "runtime-health-diagnostic",
    selectionKinds: ["diagnostics.health"],
    title: "Health Diagnostic",
  }),
  defineInspectorRoute({
    component: RuntimeCapabilityDiagnosticInspectorPanel,
    id: "runtime-capability-diagnostic",
    selectionKinds: ["diagnostics.capability"],
    title: "Capability Diagnostic",
  }),
  defineInspectorRoute({
    component: RuntimeSolverDiagnosticInspectorPanel,
    id: "runtime-solver-diagnostic",
    selectionKinds: ["diagnostics.solver"],
    title: "Solver Diagnostic",
  }),
  defineInspectorRoute({
    component: RuntimeMeshDiagnosticInspectorPanel,
    id: "runtime-mesh-diagnostic",
    selectionKinds: ["diagnostics.mesh"],
    title: "Mesh Diagnostic",
  }),
  defineInspectorRoute({
    component: RuntimeFrequencyDiagnosticInspectorPanel,
    id: "runtime-frequency-diagnostic",
    selectionKinds: ["diagnostics.frequency-domain"],
    title: "Frequency-domain Diagnostic",
  }),
  defineInspectorRoute({
    component: RuntimePerformanceDiagnosticInspectorPanel,
    id: "runtime-performance-diagnostic",
    selectionKinds: ["diagnostics.performance"],
    title: "Performance Diagnostic",
  }),
  defineInspectorRoute({
    component: AirboxVisualizationInspectorPanel,
    id: "airbox-visualization",
    selectionKinds: ["airbox.visualization"],
    title: "Airbox Visualization",
  }),
  defineInspectorRoute({
    component: ObjectVisualizationPanel,
    id: "object-visualization",
    selectionKinds: ["object.visualization"],
    title: "Visualization",
  }),
  defineInspectorRoute({
    component: MeshPartVisualizationPanel,
    id: "mesh-part-visualization",
    selectionKinds: ["mesh-part"],
    title: "Mesh-part Visualization",
  }),
  defineInspectorRoute({
    component: AirboxVisualizationDebugInspectorPanel,
    id: "airbox-visualization-debug",
    selectionKinds: ["airbox.visualization.debug"],
    title: "Airbox Visualization Debug",
  }),
  defineInspectorRoute({
    component: ObjectVisualizationDebugOwner,
    id: "object-visualization-debug",
    selectionKinds: ["object.visualization.debug"],
    title: "Object Visualization Debug",
  }),
  defineInspectorRoute({
    component: ObjectRegionVisualizationDebugOwner,
    id: "object-region-visualization-debug",
    selectionKinds: ["object.region.visualization.debug"],
    title: "Region Visualization Debug",
  }),
  defineInspectorRoute({
    component: MeshPartVisualizationDebugOwner,
    id: "mesh-part-visualization-debug",
    selectionKinds: ["mesh.part.visualization.debug"],
    title: "Mesh Part Visualization Debug",
  }),
  defineInspectorRoute({
    component: ModeVisualizationOverviewPanel,
    id: "object-mode-visualization-overview",
    selectionKinds: ["object.mode_visualization"],
    title: "Mode Visualization Overview",
  }),
  defineInspectorRoute({
    component: ObjectRegionVisualizationPanel,
    id: "object-region-visualization",
    selectionKinds: ["object.region.visualization"],
    title: "Region Visualization",
  }),
  defineInspectorRoute({
    component: StudyRootInspectorPanel,
    id: "study-root",
    selectionKinds: ["study.root"],
    title: "Study",
  }),
  defineInspectorRoute({
    component: StudyStagesInspectorPanel,
    id: "study-stages",
    selectionKinds: ["study.stages"],
    title: "Study Stages",
  }),
  defineInspectorRoute({
    component: StudyExecutionInspectorPanel,
    id: "study-execution",
    selectionKinds: ["study.execution"],
    title: "Study Execution",
  }),
  defineInspectorRoute({
    component: StudyRecoveryInspectorPanel,
    id: "study-recovery",
    selectionKinds: ["study.recovery"],
    title: "Study Recovery",
  }),
  defineInspectorRoute({
    component: StudyStageActionInspectorPanel,
    id: "study-stage",
    selectionKinds: ["study.stage.action"],
    title: "Study Stage",
  }),
  defineInspectorRoute({
    component: StudyStageMaskFieldDriveInspectorPanel,
    id: "study-stage-mask-field-drive",
    selectionKinds: ["study.stage.mask_field_drive"],
    title: "Mask Field Drive Stage",
  }),
  defineInspectorRoute({
    component: StudyStageAddFieldDriveInspectorPanel,
    id: "study-stage-add-field-drive",
    selectionKinds: ["study.stage.add_field_drive"],
    title: "Study Stage Add Field Drive",
  }),
  defineInspectorRoute({
    component: StudyStageInspectorRouter,
    id: "study-stage-antenna-field-solve",
    selectionKinds: ["study.stage.antenna_field_solve"],
    title: "Antenna Field Solve",
  }),
  defineInspectorRoute({
    component: StudyStageAutosaveInspectorPanel,
    id: "study-stage-autosave",
    selectionKinds: ["study.stage.autosave"],
    title: "Study Stage Autosave",
  }),
  defineInspectorRoute({
    component: StudyStageFftResponseInspectorPanel,
    id: "study-stage-fft-response",
    selectionKinds: ["study.stage.fft_response"],
    title: "Study Stage FFT Response",
  }),
  defineInspectorRoute({
    component: StudyStageHysteresisInspectorPanel,
    id: "study-stage-hysteresis",
    selectionKinds: ["study.stage.hysteresis"],
    title: "Study Stage Hysteresis",
  }),
  defineInspectorRoute({
    component: StudyStageRelaxInspectorPanel,
    id: "study-stage-relax",
    selectionKinds: ["study.stage.relax"],
    title: "Study Stage Relax",
  }),
  defineInspectorRoute({
    component: StudyStageRunInspectorPanel,
    id: "study-stage-run",
    selectionKinds: ["study.stage.run"],
    title: "Study Stage Run",
  }),
  defineInspectorRoute({
    component: StudyStageTableAutosaveInspectorPanel,
    id: "study-stage-table-autosave",
    selectionKinds: ["study.stage.table_autosave"],
    title: "Study Stage Table Autosave",
  }),
  defineInspectorRoute({
    component: StudyStageChangeDeviceInspectorPanel,
    id: "study-stage-change-device",
    selectionKinds: ["study.stage.change_device"],
    title: "Study Stage Change Device",
  }),
  defineInspectorRoute({
    component: StudyStageSaveStateInspectorPanel,
    id: "study-stage-save-state",
    selectionKinds: ["study.stage.save_state"],
    title: "Study Stage Save State",
  }),
  ...CANONICAL_FREQUENCY_DOMAIN_ROUTES,
  defineInspectorRoute({
    component: HysteresisPointResultInspector,
    id: "results-hysteresis-point",
    selectionKinds: ["results.hysteresis.point"],
    title: "Hysteresis Point",
  }),
  defineInspectorRoute({
    component: AnalysisResultInspectorPanel,
    id: "analysis-result",
    selectionKinds: ["analysis.result"],
    title: "Analysis result",
  }),
  defineInspectorRoute({
    component: HysteresisDatasetResultInspector,
    id: "results-hysteresis-dataset",
    selectionKinds: ["results.hysteresis.dataset"],
    title: "Hysteresis Dataset",
  }),
  defineInspectorRoute({
    component: MaterializedDatasetInspectorPanel,
    id: "materialized-dataset",
    selectionKinds: ["results.materialized_dataset"],
    title: "Materialized Dataset",
  }),
  defineInspectorRoute({
    component: FieldQuantityInspectorPanel,
    id: "field-quantity",
    selectionKinds: ["results.field_quantity"],
    title: "Field Quantity",
  }),
];
