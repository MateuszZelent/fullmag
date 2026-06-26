import type { CommandId } from "@/kernel/commands/commandTypes";
import type { HysteresisExecutionTreeResource } from "@/kernel/api/apiTypes";
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

type ExplorerNodeKind =
  | "session.root"
  | "universe.root"
  | "objects.root"
  | "object.root"
  | "object.geometry"
  | "object.antenna"
  | "object.material"
  | "object.physics"
  | "object.regions"
  | "object.region"
  | "object.region.geometry"
  | "object.region.shape"
  | "object.region.mesh"
  | "object.region.magnetic-parameters"
  | "object.region.material"
  | "object.region.texture"
  | "object.region.visualization"
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
  | "airbox.mesh"
  | "airbox.mesh-quality"
  | "airbox.visualization"
  | "mesh.root"
  | "mesh.shared-domain"
  | "mesh.builds"
  | "mesh.quality"
  | "mesh.size-fields"
  | "mesh.regions"
  | "visualizations-2d.root"
  | "visualizations-2d.draft"
  | "visualizations-2d.parameter"
  | "visualizations-2d.plot"
  | "physics.couplings"
  | "physics.coupling"
  | "study.root"
  | "study.execution"
  | "study.recovery"
  | "study.stages"
  | "study.stage.action"
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
  | "study.stage.change_device"
  | "study.stage.save_state"
  | "results.root"
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
  | "resources.root"
  | "resources.analysis.frequency_domain"
  | "resources.analysis.frequency_domain.manifest"
  | "resources.analysis.frequency_domain.calculation_modes"
  | "resources.analysis.frequency_domain.fmr"
  | "resources.analysis.frequency_domain.dispersion"
  | "resources.analysis.frequency_domain.response_map"
  | "resources.mesh.periodic_pairs"
  | "resources.analysis.eigen.spectrum"
  | "resources.analysis.eigen.branches"
  | "resources.analysis.eigen.dispersion"
  | "resources.analysis.eigen.diagnostics"
  | "resources.analysis.eigen.mode_metadata"
  | "resources.analysis.eigen.mode_field"
  | "resources.analysis.frequency_response.sweep"
  | "resources.analysis.frequency_response.progress"
  | "resources.analysis.frequency_response.cancel_requested"
  | "resources.analysis.frequency_response.frequency_point"
  | "resources.analysis.frequency_response.field"
  | "resources.analysis.frequency_response.observables"
  | "resources.analysis.frequency_response.diagnostics"
  | "resources.field"
  | "resources.mesh"
  | "jobs.root"
  | "jobs.frequency_domain.root"
  | "jobs.frequency_domain.stage_run"
  | "jobs.frequency_domain.eigen_sample"
  | "jobs.frequency_domain.response_frequency"
  | "jobs.frequency_domain.response_progress"
  | "jobs.frequency_domain.artifact_export"
  | "jobs.command"
  | "diagnostics.root"
  | "diagnostics.frequency_domain.root"
  | "diagnostics.frequency_domain.capabilities"
  | "diagnostics.frequency_domain.equilibrium"
  | "diagnostics.frequency_domain.operator"
  | "diagnostics.frequency_domain.solver"
  | "diagnostics.frequency_domain.artifacts"
  | "diagnostics.frequency_domain.api_resources"
  | "diagnostics.frequency_domain.visualization"
  | "diagnostics.frequency_domain.periodic_floquet"
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
  | "unsupported";

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
  badge?: string;
  children?: ExplorerNode[];
  contextCommands?: CommandId[];
  contextCommandInputs?: Partial<Record<CommandId, unknown>>;
  analysisRunId?: string;
  analysisStageId?: string;
  artifactPath?: string;
  branchId?: string;
  calculationMode?: FrequencyDomainCalculationMode;
  crossSectionDraftId?: "draft";
  crossSectionPlotId?: string;
  fieldId?: string;
  extensionId?: string;
  fieldOrientation?: string;
  fieldRevision?: number | string;
  fmrPeakIndex?: number;
  frequencyIndex?: number;
  icon?: ExplorerIconToken;
  hysteresisExecutionNodeId?: string;
  hysteresisExecutionNodeKind?: string;
  hysteresisPointId?: number;
  hysteresisSelectionRef?: string;
  hysteresisSnapshotId?: string;
  measurementAxis?: string;
  meshIdentity?: string;
  modeIndex?: number;
  objectId?: string;
  observableId?: string;
  couplingId?: string;
  regionId?: string;
  resourceRef?: string;
  sampleIndex?: number;
  stageId?: string;
  stageIndex?: number;
  status?: ExplorerNodeStatus;
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

export interface ModelTreeSnapshot {
  couplings?: readonly ModelTreeCouplingSnapshot[];
  crossSections?: ModelTreeCrossSectionSnapshot | null;
  materials?: readonly ModelTreeMaterialSnapshot[];
  mesh?: ModelTreeMeshSnapshot | null;
  universe?: {
    id: string;
    label: string;
    size?: readonly [number, number, number] | null;
  } | null;
  objects?: readonly ModelTreeObjectSnapshot[];
  physicsInteractions?: readonly ModelTreePhysicsInteractionSnapshot[];
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
  device?: string | null;
  energyTolerance?: string | number | null;
  index: number;
  kind: string;
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
  partCount?: number | null;
  qualityStatus?: string | null;
  realizedSizeFieldCount?: number | null;
  regionCount?: number | null;
  sourceSceneRevision?: number | string | null;
}
