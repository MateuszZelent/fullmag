import type { CommandId } from "@/kernel/commands/commandTypes";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";
import type {
  DomainMetaResource,
  FdmMultilayerLayoutResource,
  HysteresisExecutionTreeResource,
  ResourceRevision,
} from "@/kernel/api/apiTypes";
import type { DomainPresentation } from "@/shared/domain/mesh/domainPresentation";
import type {
  PostprocessingDefinitionKind,
  PostprocessingFreshness,
  PostprocessingOwnerKind,
  PostprocessingOwnerReadiness,
} from "@/shared/domain/analysis/postprocessingTypes";
import type {
  CrossSectionFrameExtent,
  CrossSectionPlot,
} from "@/kernel/workspace/crossSectionWorkspace";

export type ExplorerTabId =
  | "model"
  | "resources"
  | "results"
  | "jobs"
  | "diagnostics";

export type ExplorerNodeKind =
  | "session.root"
  | "universe.root"
  | "objects.root"
  | "definitions.root"
  | "model.planar.monitors"
  | "model.planar.monitor"
  | "model.planar.monitor.draft"
  | "object.root"
  | "object.geometry"
  | "object.antenna"
  | "object.material"
  | "object.physics"
  | "object.physics.scope"
  | "object.regions"
  | "object.region"
  | "object.region.geometry"
  | "object.region.shape"
  | "object.region.mesh"
  | "object.region.magnetic-parameters"
  | "object.region.material"
  | "object.region.texture"
  | "object.region.visualization"
  | "object.region.visualization.debug"
  | "object.region.regions"
  | "object.region.diagnostics"
  | "object.region-magnetic-texture"
  | "object.magnetic-parameters"
  | "object.magnetic-texture"
  | "object.magnetic-texture.asset"
  | "object.magnetic-texture.load"
  | "object.magnetic-texture.transform"
  | "object.mesh"
  | "object.extension.topological-charge"
  | "object.visualization"
  | "object.visualization.debug"
  | "object.mode_visualization"
  | "airbox.root"
  | "airbox.mesh"
  | "airbox.mesh.parameters"
  | "airbox.mesh.quality-gates"
  | "airbox.mesh.statistics"
  | "airbox.mesh.topology"
  | "airbox.mesh.build"
  | "airbox.visualization"
  | "airbox.visualization.debug"
  | "airbox.multilayer.target"
  | "boundary-faces.root"
  | "mesh.root"
  | "mesh.grid"
  | "mesh.grid.descriptor"
  | "mesh.grid.common"
  | "mesh.grid.layers"
  | "mesh.grid.layer"
  | "mesh.grid.layer.native-grid"
  | "mesh.grid.layer.mask"
  | "mesh.grid.layer.transfer"
  | "mesh.grid.layer.provenance"
  | "mesh.grid.magnetic-support"
  | "mesh.grid.active-unassigned"
  | "mesh.grid.mask"
  | "mesh.grid.provenance"
  | "mesh.grid.region"
  | "mesh.grid.universe-outside-support"
  | "fdm.cell"
  | "mesh.shared-domain"
  | "mesh.builds"
  | "mesh.quality"
  | "mesh.size-fields"
  | "mesh.regions"
  | "mesh.unassigned"
  | "mesh.unassigned.part"
  | "visualizations-2d.root"
  | "visualizations-2d.draft"
  | "visualizations-2d.parameter"
  | "visualizations-2d.plot"
  | "physics.couplings"
  | "physics.coupling"
  | "physics.module"
  | "physics.structured-current-closure"
  | "physics.structured-current-source-cut"
  | "physics.scope.global"
  | "physics.scope.cross-object"
  | "physics.scope.unresolved"
  | "study.root"
  | "study.execution"
  | "study.recovery"
  | "study.stages"
  | "study.stage.action"
  | "study.stage.add_field_drive"
  | "study.stage.autosave"
  | "study.stage.fft_response"
  | "study.stage.eigenmodes"
  | "study.stage.eigenmodes.setup"
  | "study.stage.eigenmodes.calculation_mode"
  | "study.stage.eigenmodes.equilibrium"
  | "study.stage.eigenmodes.operator"
  | "study.stage.eigenmodes.boundary"
  | "study.stage.eigenmodes.periodic_pairs"
  | "study.stage.eigenmodes.k_path"
  | "study.stage.eigenmodes.solver"
  | "study.stage.eigenmodes.outputs"
  | "study.stage.eigenmodes.diagnostics"
  | "study.stage.frequency_response"
  | "study.stage.frequency_response.setup"
  | "study.stage.frequency_response.calculation_mode"
  | "study.stage.frequency_response.equilibrium"
  | "study.stage.frequency_response.operator"
  | "study.stage.frequency_response.boundary"
  | "study.stage.frequency_response.periodic_pairs"
  | "study.stage.frequency_response.k_grid"
  | "study.stage.frequency_response.excitation"
  | "study.stage.frequency_response.sweep"
  | "study.stage.frequency_response.solver"
  | "study.stage.frequency_response.outputs"
  | "study.stage.frequency_response.diagnostics"
  | "study.stage.hysteresis"
  | "study.stage.relax"
  | "study.stage.run"
  | "study.stage.table_autosave"
  | "study.stage.change_device"
  | "study.stage.save_state"
  | "results.root"
  | "results.dynamics.root"
  | "results.resonance.root"
  | "results.resonance.modal.stage"
  | "results.resonance.driven.stage"
  | "results.resonance.modal.spectrum"
  | "results.resonance.modal.modes"
  | "results.resonance.modal.mode"
  | "results.resonance.modal.coupling"
  | "results.resonance.modal.provenance"
  | "results.resonance.driven.spectrum"
  | "results.resonance.driven.peaks"
  | "results.resonance.driven.frequency_points"
  | "results.resonance.driven.fields"
  | "results.resonance.driven.field"
  | "results.resonance.driven.provenance"
  | "results.dispersion.root"
  | "results.dispersion.modal.stage"
  | "results.dispersion.driven.stage"
  | "results.dispersion.k_sampling"
  | "results.dispersion.modal.relation"
  | "results.dispersion.modal.branches"
  | "results.dispersion.modal.modes_at_k"
  | "results.dispersion.modal.mode_at_k"
  | "results.dispersion.modal.provenance"
  | "results.dispersion.driven.response_map"
  | "results.dispersion.driven.field_at_k"
  | "results.dispersion.driven.provenance"
  | "results.hysteresis.root"
  | "results.analysis_views.root"
  | "results.analysis_views.definition"
  | "results.derived_values.root"
  | "results.derived_values.definition"
  | "results.tables.root"
  | "results.tables.definition"
  | "results.exports.root"
  | "results.exports.definition"
  | "results.frequency_domain.root"
  | "results.frequency_domain.run"
  | "results.frequency_domain.calculation_modes"
  | "results.frequency_domain.fmr"
  | "results.frequency_domain.fmr_modal_spectrum"
  | "results.frequency_domain.fmr_response_sweep"
  | "results.frequency_domain.fmr_peaks"
  | "results.frequency_domain.fmr_peak"
  | "results.frequency_domain.dispersion"
  | "results.frequency_domain.response_map"
  | "results.eigen.root"
  | "results.eigen.study"
  | "results.eigen.spectrum"
  | "results.eigen.modes"
  | "results.eigen.modes.visualization"
  | "results.eigen.mode"
  | "results.eigen.dispersion"
  | "results.eigen.k_path"
  | "results.eigen.branches"
  | "results.eigen.branch"
  | "results.eigen.diagnostics"
  | "results.eigen.provenance"
  | "results.frequency_response.root"
  | "results.frequency_response.study"
  | "results.frequency_response.sweep"
  | "results.frequency_response.progress"
  | "results.frequency_response.cancel_requested"
  | "results.frequency_response.frequency_points"
  | "results.frequency_response.frequency_point"
  | "results.frequency_response.observables"
  | "results.frequency_response.observable"
  | "results.frequency_response.diagnostics"
  | "results.frequency_response.provenance"
  | "results.frequency_domain.comparison"
  | "results.frequency_domain.exports"
  | "results.field_quantity"
  | "results.quick_chart"
  | "resources.root"
  | "resources.runtime"
  | "jobs.root"
  | "jobs.run"
  | "jobs.stage"
  | "jobs.command"
  | "diagnostics.root"
  | "diagnostics.problem"
  | "diagnostics.health"
  | "diagnostics.capability"
  | "diagnostics.solver"
  | "diagnostics.mesh"
  | "diagnostics.frequency-domain"
  | "diagnostics.performance"
  | "diagnostics.resource";

type FrequencyDomainCalculationMode =
  | "fmr_modal"
  | "fmr_response"
  | "free_modes"
  | "dispersion_modal"
  | "response_map";

export type ExplorerNodeStatus =
  | "ready"
  | "primitive-only"
  | "mesh-stale"
  | "mesh-building"
  | "mesh-ready"
  | "mesh-failed"
  | "validation-blocked"
  | "stale"
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "skipped"
  | "cancelled"
  | "failed"
  | "degraded"
  | "warning"
  | "unavailable"
  | "unsupported";

export type ExplorerResourceState = "idle" | "loading" | "ready" | "stale" | "error";

export type ExplorerExecutionState =
  | "not_started"
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

export type ExplorerAvailability = "available" | "partial" | "unavailable" | "unsupported";

export interface ExplorerNodeStateFacets {
  availability: ExplorerAvailability;
  executionState: ExplorerExecutionState;
  resourceState: ExplorerResourceState;
}

export type {
  RuntimeExecutionDetail,
  RuntimeExplorerDetail,
  RuntimeExplorerFact,
} from "@/kernel/resources/runtimeExplorerTypes";

export type ExplorerIconToken =
  | "activity"
  | "box"
  | "braces"
  | "circle"
  | "database"
  | "file"
  | "folder"
  | "gauge"
  | "layers"
  | "magnet"
  | "mesh"
  | "play"
  | "settings"
  | "shield"
  | "sparkles"
  | "triangle"
  | "wave";

export interface ExplorerNode {
  id: string;
  kind: ExplorerNodeKind;
  label: string;
  parentId: string | null;
  activeAnalysisField?: boolean;
  analysisFieldRepresentation?: "complex-vector-xyz";
  normalization?: string;
  badge?: string;
  children?: ExplorerNode[];
  contextCommands?: CommandId[];
  contextCommandInputs?: Partial<Record<CommandId, unknown>>;
  analysisRunId?: string;
  analysisStageId?: string;
  artifactRevision?: number | string;
  postprocessingCatalogRevision?: ResourceRevision | null;
  postprocessingContractGap?: string | null;
  postprocessingDefinitionKind?: PostprocessingDefinitionKind;
  postprocessingFreshness?: PostprocessingFreshness;
  postprocessingArtifactKind?: string | null;
  postprocessingOwnerId?: string | null;
  postprocessingOwnerKind?: PostprocessingOwnerKind | null;
  postprocessingOwnerReadiness?: PostprocessingOwnerReadiness;
  postprocessingResourceRevision?: ResourceRevision | null;
  postprocessingSchemaRevision?: number | null;
  equilibriumId?: string;
  kContextKind?: "finite_open" | "fixed_k" | "gamma" | "k_grid" | "k_path";
  kPathCoordinateRadPerM?: number;
  studyProduct?: "driven_response" | "modal_eigen" | string;
  artifactPath?: string;
  branchId?: string;
  calculationMode?: FrequencyDomainCalculationMode;
  chartId?: string;
  crossSectionDraftId?: "draft";
  crossSectionPlotId?: string;
  fieldId?: string;
  extensionId?: string;
  fieldOrientation?: string;
  fieldRevision?: number | string;
  cellOrdinal?: string;
  cellIJK?: readonly [number, number, number];
  cellMaskState?: "inactive" | "active-unassigned" | "region";
  numericRegionId?: number | null;
  gridFingerprint?: string | null;
  layerId?: string;
  transferKind?: string;
  nativeGrid?: readonly [number, number, number];
  nativeCellSize?: readonly [number, number, number];
  nativeOrigin?: readonly [number, number, number];
  activeMaskPresent?: boolean;
  activeCellCount?: number;
  inactiveCellCount?: number;
  membershipRevision?: string | null;
  fmrPeakIndex?: number;
  frequencyHz?: number;
  frequencyIndex?: number;
  analysisFieldSource?: "eigen-mode" | "frequency-response";
  analysisFieldView?: string;
  icon?: ExplorerIconToken;
  hysteresisExecutionNodeId?: string;
  hysteresisExecutionNodeKind?: string;
  hysteresisPointId?: number;
  hysteresisSelectionRef?: string;
  hysteresisSnapshotId?: string;
  measurementAxis?: string;
  meshIdentity?: string;
  meshPartId?: string;
  monitorId?: string;
  visualizationTargetId?: string;
  modeIndex?: number;
  objectId?: string;
  observableId?: string;
  couplingId?: string;
  currentTransportId?: string;
  physicsModuleId?: string;
  physicsModuleKind?: string;
  physicsModuleFamily?: string;
  physicsScopeKind?: string;
  physicsScopeObjectIds?: readonly string[];
  physicsActivation?: string;
  physicsDependencyIds?: readonly string[];
  regionId?: string;
  resourceRef?: string;
  runtimeDescriptorId?: string;
  runtimeResourceKey?: string;
  displayUnits?: Record<string, string>;
  range?: { fromSI: number; toSI: number } | null;
  /** Grouping rows stay focusable/expandable but do not create a Selection. */
  selectable?: boolean;
  selectedSeriesIds?: readonly string[];
  tableId?: string;
  xAxisId?: string;
  /**
   * Compatibility owner: Quick Chart Explorer descriptor parser.
   * Removal gate: remove yAxisIds after one released Control Room version writes
   * only selectedSeriesIds and migration tests prove no persisted or Explorer
   * descriptor still depends on yAxisIds.
   */
  yAxisIds?: readonly string[];
  sampleIndex?: number;
  wavevectorKf?: readonly [number, number, number];
  stageId?: string;
  stageIndex?: number;
  availability?: ExplorerAvailability;
  executionState?: ExplorerExecutionState;
  resourceState?: ExplorerResourceState;
  status?: ExplorerNodeStatus;
  structuredCurrentClosureId?: string;
  structuredCurrentSourceCutId?: string;
}

export interface ModelTreeObjectSnapshot {
  id: string;
  label: string;
  geometryKind?: string | null;
  magnetization?: string | null;
  magnetizationKind?: string | null;
  magnetizationLabel?: string | null;
  material?: string | null;
  materialLabel?: string | null;
  materialPropertyKeys?: readonly string[];
  meshStatus?: ExplorerNodeStatus;
  physicsInteractions?: readonly ModelTreePhysicsInteractionSnapshot[];
  region?: string | null;
  regionId?: string | null;
  regions?: readonly ModelTreeObjectRegionSnapshot[];
  materialFields?: readonly ModelTreeMaterialFieldSnapshot[];
  objectRole?: "antenna" | "magnet" | "auxiliary";
  regionMagnetization?: string | null;
  regionMagnetizationKind?: string | null;
  regionMagnetizationLabel?: string | null;
  textureLoadEnabled?: boolean;
  textureTransformAvailable?: boolean;
  extensions?: readonly ModelTreeObjectExtensionSnapshot[];
}

export interface ModelTreeObjectExtensionSnapshot {
  id: "topological_charge";
  label: string;
  status?: ExplorerNodeStatus;
}

export interface ModelTreeObjectRegionSnapshot {
  enabled: boolean;
  id: string;
  label: string;
  materialFieldCount: number;
  materialOverrideCount: number;
  meshPolicyActive: boolean;
  meshLifecycleStatus?:
    | "configured"
    | "draft"
    | "pending"
    | "current"
    | "stale"
    | "failed"
    | "unsupported";
  priority?: number | null;
  realizationPolicy?: string | null;
  realizationStatus?: string | null;
  shapeKind?: string | null;
  source: string;
  textureOverrideActive: boolean;
}

export interface ModelTreeMaterialFieldSnapshot {
  id: string;
  label: string;
  ownerObjectId: string;
  parameter: string;
  realizationStatus?: string | null;
  regionId?: string | null;
  unit?: string | null;
}

export interface ModelTreeMaterialSnapshot {
  id: string;
  label: string;
  propertyKeys: readonly string[];
}

export interface ModelTreePhysicsInteractionSnapshot {
  enabledCount: number;
  id: string;
  label: string;
  objectCount: number;
}

export interface ModelTreeCouplingSnapshot {
  enabled: boolean;
  id: string;
  kind: string;
  label: string;
  realizationStatus?: string | null;
  sourceLabel: string;
  targetLabel: string;
}

export interface ModelTreeFieldDriveSnapshot {
  enabled: boolean;
  id: string;
  label: string;
  targetKind: string;
  waveformKind: string;
}

export interface ModelTreeSnapshot {
  /** DomainMeta remains available when a derived presentation is loading or degraded. */
  domainMeta?: DomainMetaResource | null;
  domainDiscretization?: "fdm" | "fem" | null;
  domainPresentationStatus?: "idle" | "loading" | "ready" | "stale" | "error";
  domainPresentation?: DomainPresentation | null;
  fdmMultilayerLayout?: FdmMultilayerLayoutResource | null;
  fdmMultilayerLayoutStatus?: ResourceStatus;
  couplings?: readonly ModelTreeCouplingSnapshot[];
  fieldDrives?: readonly ModelTreeFieldDriveSnapshot[];
  crossSections?: ModelTreeCrossSectionSnapshot | null;
  materials?: readonly ModelTreeMaterialSnapshot[];
  mesh?: ModelTreeMeshSnapshot | null;
  airbox?: {
    /** A committed universe mesh policy requests an Airbox realization. */
    authoredPolicy: boolean;
    /** The current mesh manifest contains an owner-resolved Airbox carrier. */
    realizedCarrier: boolean;
    /** Runtime planning published an effective Airbox target. */
    resolvedTarget?: boolean;
  } | null;
  universe?: {
    id: string;
    label: string;
    size?: readonly [number, number, number] | null;
  } | null;
  objects?: readonly ModelTreeObjectSnapshot[];
  physicsInteractions?: readonly ModelTreePhysicsInteractionSnapshot[];
  /** Canonical physics_graph.v1 resource when the API has resolved it. */
  physicsGraph?: unknown | null;
  /** Resource lifecycle for the canonical physics graph. */
  physicsGraphStatus?: ResourceStatus;
  study?: ModelTreeStudySnapshot | null;
}

export interface ModelTreeCrossSectionSnapshot {
  activePlotId: string | null;
  draft: {
    colorScale: CrossSectionPlot["renderOptions"]["colorScale"];
    filterExpression: string;
    frameExtent: CrossSectionFrameExtent;
    id: "draft";
    includeWireframe: boolean;
    metric: CrossSectionPlot["metric"];
    name: string;
    plane: CrossSectionPlot["plane"];
    positionPercent: number;
    rotationDegrees: number;
    shrinkFactor: number;
  } | null;
  plots: readonly {
    colorScale: CrossSectionPlot["renderOptions"]["colorScale"];
    filterExpression: string;
    frameExtent: CrossSectionFrameExtent;
    id: string;
    metric: CrossSectionPlot["metric"];
    name: string;
    plane: CrossSectionPlot["plane"];
    positionPercent: number;
    rotationDegrees: number;
    shrinkFactor: number;
    wireframeVisible: boolean;
  }[];
}

interface ModelTreeStudySnapshot {
  demagRealization?: string | null;
  externalField?: readonly [number, number, number] | null;
  requestedBackend?: string | null;
  requestedDevice?: string | null;
  requestedMode?: string | null;
  requestedPrecision?: string | null;
  stages: readonly ModelTreeStudyStageSnapshot[];
}

export interface ModelTreeStudyStageSnapshot {
  artifactName?: string | null;
  boundaryCondition?: string | null;
  calculationMode?: string | null;
  device?: string | null;
  energyTolerance?: string | number | null;
  index: number;
  kind: string;
  kSamplingKind?: string | null;
  maxSteps?: string | number | null;
  stageId?: string | null;
  hysteresisCurrentFieldMt?: string | number | null;
  hysteresisCurrentPointIndex?: number | null;
  hysteresisCurrentSettleStepIndex?: number | null;
  hysteresisCurrentSettleStepKind?: string | null;
  hysteresisCurrentSettleStepMethod?: string | null;
  hysteresisBranchMode?: string | null;
  hysteresisFieldMaxMt?: string | number | null;
  hysteresisFieldMinMt?: string | number | null;
  hysteresisFieldStepMt?: string | number | null;
  hysteresisInitialProtocol?: string | null;
  hysteresisSaturationMode?: string | null;
  hysteresisExecutionTree?: HysteresisExecutionTreeResource | null;
  hysteresisSettleSteps?: readonly ModelTreeHysteresisSettleStepSnapshot[];
  stateTransition?: string | null;
  stateTransitionKind?: string | null;
  stateTransitionReason?: string | null;
  stateTransferOperatorKind?: string | null;
  stateTransitionUiPresentation?: string | null;
  status?: ExplorerNodeStatus | null;
  torqueTolerance?: string | number | null;
  untilSeconds?: string | number | null;
}

export interface ModelTreeHysteresisSettleStepSnapshot {
  alpha?: string | number | null;
  energyTolerance?: string | number | null;
  index: number;
  kind: string;
  maxSteps?: string | number | null;
  method?: string | null;
  nonConvergencePolicy?: string | null;
  torqueTolerance?: string | number | null;
}

export interface ModelTreeMeshSnapshot {
  activeBuildStatus?: string | null;
  buildRevision?: number | string | null;
  domainMeshMode?: string | null;
  generationId?: string | null;
  latestBuildSourceSceneRevision?: number | string | null;
  latestBuildStatus?: string | null;
  lastError?: string | null;
  manifestSourceSceneRevision?: number | string | null;
  meshName?: string | null;
  meshRevision?: number | string | null;
  objectSegmentCount?: number | null;
  outerBoundaryPartCount?: number | null;
  partCount?: number | null;
  qualityStatus?: string | null;
  realizedSizeFieldCount?: number | null;
  regionCount?: number | null;
  sourceSceneRevision?: number | string | null;
  visualizationPartFallbacks?: readonly {
    id: string;
    label: string;
    visualizationTargetId: string;
  }[];
}
