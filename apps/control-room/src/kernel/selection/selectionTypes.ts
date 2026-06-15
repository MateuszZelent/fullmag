import type { ModuleId } from "../types";
import type { CrossSectionQualityMetric } from "../api/apiTypes";

type ObjectSelectionKind =
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
  | "object.visualization";

type MeshQualitySelectionMetric = CrossSectionQualityMetric;
export type RegionVisualizationTargetId = `region:${string}:${string}`;

export function visualizationTargetIdForSceneObject(
  objectId: string,
  regionId?: string | null,
): `object:${string}` | RegionVisualizationTargetId {
  if (!regionId) return `object:${objectId}`;
  return `region:${objectId}:${encodeURIComponent(regionId)}`;
}

export type SelectionRef =
  | {
      kind: ObjectSelectionKind;
      nodeId: string;
      objectId: string;
      regionId?: string;
      type: "scene-object";
      visualizationTargetId: `object:${string}` | RegionVisualizationTargetId;
    }
  | {
      kind: "airbox.mesh" | "airbox.mesh-quality" | "airbox.visualization";
      nodeId: string;
      type: "airbox";
      visualizationTargetId: "airbox";
    }
  | {
      centroid: [number, number, number] | null;
      elementIndex: number;
      kind: "mesh.quality.element";
      metric?: MeshQualitySelectionMetric;
      nodeId: string;
      type: "mesh-quality-element";
      visualizationTargetId: `mesh:quality:element:${number}`;
    }
  | {
      kind: "mesh.quality.metric";
      metric: MeshQualitySelectionMetric;
      nodeId: string;
      type: "mesh-quality-metric";
      visualizationTargetId: `mesh:quality:metric:${MeshQualitySelectionMetric}`;
    }
  | {
      draftId: "draft";
      kind: "mesh.cross-section.draft";
      nodeId: string;
      type: "cross-section-draft";
      visualizationTargetId: "cross-section:draft";
    }
  | {
      kind: "mesh.cross-section.plot";
      nodeId: string;
      plotId: string;
      type: "cross-section-plot";
      visualizationTargetId: `cross-section:plot:${string}`;
    }
  | {
      couplingId: string;
      kind: "physics.coupling";
      nodeId: string;
      type: "physics-coupling";
    }
  | {
      chartId: string;
      kind: "analysis.chart";
      nodeId: string;
      tableId: string;
      type: "analysis-chart";
    }
  | {
      chartId: string;
      kind: "analysis.chart-point";
      nodeId: string;
      quantity: string;
      rowIndex: number;
      seriesId: string;
      stageId?: string | null;
      pointId?: number | null;
      tableId: string;
      type: "analysis-chart-point";
      x: number;
      y: number;
      snapshotId?: string | null;
      resourceRef?: string | null;
      targetId?: string | null;
      targetKind?: "hysteresis-step" | null;
      quantityId?: string | null;
      meshIdentity?: string | null;
      fieldOrientation?: string | null;
      measurementAxis?: string | null;
      fieldRevision?: string | number | null;
    }
  | {
      kind: "study.execution" | "study.recovery" | "study.root" | "study.stages";
      nodeId: string;
      type: "study";
    }
  | {
      kind: "study.stage.action";
      fieldOrientation?: string | null;
      fieldRevision?: string | number | null;
      measurementAxis?: string | null;
      meshIdentity?: string | null;
      nodeId: string;
      pointId: number;
      quantityId: string;
      resourceRef?: string;
      snapshotId: string;
      stageId: string;
      stageIndex: number;
      targetId: `hysteresis-step:${string}:${number}`;
      type: "hysteresis-snapshot";
    }
  | {
      kind:
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
        | "study.stage.save_state";
      hysteresisExecutionNodeId?: string;
      hysteresisExecutionNodeKind?: string;
      hysteresisPointId?: number;
      nodeId: string;
      resourceRef?: string;
      stageId: string;
      stageIndex: number;
      type: "study-stage";
    }
  | {
      analysisRunId?: string;
      analysisStageId?: string;
      artifactPath?: string;
      branchId?: string;
      calculationMode?: string;
      fieldId?: string;
      fmrPeakIndex?: number;
      frequencyIndex?: number;
      kind: string;
      modeIndex?: number;
      nodeId: string;
      observableId?: string;
      resourceRef?: string;
      sampleIndex?: number;
      type: "frequency-domain";
    };

export interface Selection {
  /** Selected scene object ID (geometry body, mesh region, etc.) */
  objectId: string | null;
  /** Selected explorer tree node ID */
  nodeId: string | null;
  /** Typed semantic kind for inspector and command gating. */
  kind: string | null;
  /** Human-readable selected label for panels and diagnostics. */
  label: string | null;
  /** Discriminated semantic selection ref shared by explorer, inspector, and viewport. */
  ref: SelectionRef | null;
  /** Module that last set the selection */
  moduleSource: ModuleId | null;
}

export const EMPTY_SELECTION: Selection = {
  kind: null,
  label: null,
  objectId: null,
  nodeId: null,
  ref: null,
  moduleSource: null,
};

function nullableStringEquals(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return (left ?? null) === (right ?? null);
}

function centroidEquals(
  left: readonly [number, number, number] | null | undefined,
  right: readonly [number, number, number] | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

export function selectionRefEquals(
  left: Selection["ref"],
  right: Selection["ref"],
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.type !== right.type) return false;

  switch (left.type) {
    case "scene-object":
      return (
        right.type === "scene-object" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.objectId === right.objectId &&
        nullableStringEquals(left.regionId, right.regionId) &&
        left.visualizationTargetId === right.visualizationTargetId
      );
    case "airbox":
      return (
        right.type === "airbox" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.visualizationTargetId === right.visualizationTargetId
      );
    case "mesh-quality-element":
      return (
        right.type === "mesh-quality-element" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.elementIndex === right.elementIndex &&
        nullableStringEquals(left.metric, right.metric) &&
        centroidEquals(left.centroid, right.centroid) &&
        left.visualizationTargetId === right.visualizationTargetId
      );
    case "mesh-quality-metric":
      return (
        right.type === "mesh-quality-metric" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.metric === right.metric &&
        left.visualizationTargetId === right.visualizationTargetId
      );
    case "cross-section-draft":
      return (
        right.type === "cross-section-draft" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.draftId === right.draftId &&
        left.visualizationTargetId === right.visualizationTargetId
      );
    case "cross-section-plot":
      return (
        right.type === "cross-section-plot" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.plotId === right.plotId &&
        left.visualizationTargetId === right.visualizationTargetId
      );
    case "physics-coupling":
      return (
        right.type === "physics-coupling" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.couplingId === right.couplingId
      );
    case "analysis-chart":
      return (
        right.type === "analysis-chart" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.chartId === right.chartId &&
        left.tableId === right.tableId
      );
    case "analysis-chart-point":
      return (
        right.type === "analysis-chart-point" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.chartId === right.chartId &&
        left.tableId === right.tableId &&
        left.seriesId === right.seriesId &&
        nullableStringEquals(left.stageId, right.stageId) &&
        (left.pointId ?? null) === (right.pointId ?? null) &&
        left.quantity === right.quantity &&
        left.rowIndex === right.rowIndex &&
        left.x === right.x &&
        left.y === right.y &&
        left.snapshotId === right.snapshotId &&
        nullableStringEquals(left.resourceRef, right.resourceRef) &&
        nullableStringEquals(left.targetId, right.targetId) &&
        nullableStringEquals(left.targetKind, right.targetKind) &&
        nullableStringEquals(left.quantityId, right.quantityId) &&
        nullableStringEquals(left.meshIdentity, right.meshIdentity) &&
        nullableStringEquals(left.fieldOrientation, right.fieldOrientation) &&
        nullableStringEquals(left.measurementAxis, right.measurementAxis) &&
        (left.fieldRevision ?? null) === (right.fieldRevision ?? null)
      );
    case "study":
      return (
        right.type === "study" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId
      );
    case "hysteresis-snapshot":
      return (
        right.type === "hysteresis-snapshot" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.stageId === right.stageId &&
        left.stageIndex === right.stageIndex &&
        left.pointId === right.pointId &&
        left.snapshotId === right.snapshotId &&
        left.quantityId === right.quantityId &&
        nullableStringEquals(left.resourceRef, right.resourceRef) &&
        nullableStringEquals(left.meshIdentity, right.meshIdentity) &&
        nullableStringEquals(left.fieldOrientation, right.fieldOrientation) &&
        nullableStringEquals(left.measurementAxis, right.measurementAxis) &&
        (left.fieldRevision ?? null) === (right.fieldRevision ?? null) &&
        left.targetId === right.targetId
      );
    case "study-stage":
      return (
        right.type === "study-stage" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.stageId === right.stageId &&
        left.stageIndex === right.stageIndex &&
        nullableStringEquals(
          left.hysteresisExecutionNodeId,
          right.hysteresisExecutionNodeId,
        ) &&
        nullableStringEquals(
          left.hysteresisExecutionNodeKind,
          right.hysteresisExecutionNodeKind,
        ) &&
        (left.hysteresisPointId ?? null) ===
          (right.hysteresisPointId ?? null) &&
        nullableStringEquals(left.resourceRef, right.resourceRef)
      );
    case "frequency-domain":
      return (
        right.type === "frequency-domain" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        nullableStringEquals(left.analysisRunId, right.analysisRunId) &&
        nullableStringEquals(left.analysisStageId, right.analysisStageId) &&
        nullableStringEquals(left.artifactPath, right.artifactPath) &&
        nullableStringEquals(left.branchId, right.branchId) &&
        nullableStringEquals(left.calculationMode, right.calculationMode) &&
        nullableStringEquals(left.fieldId, right.fieldId) &&
        left.frequencyIndex === right.frequencyIndex &&
        left.modeIndex === right.modeIndex &&
        nullableStringEquals(left.observableId, right.observableId) &&
        nullableStringEquals(left.resourceRef, right.resourceRef) &&
        left.sampleIndex === right.sampleIndex
      );
  }
}

export function selectionSnapshotEquals(
  previous: Selection,
  next: Selection,
): boolean {
  return (
    previous.kind === next.kind &&
    previous.label === next.label &&
    previous.objectId === next.objectId &&
    previous.nodeId === next.nodeId &&
    previous.moduleSource === next.moduleSource &&
    selectionRefEquals(previous.ref, next.ref)
  );
}
