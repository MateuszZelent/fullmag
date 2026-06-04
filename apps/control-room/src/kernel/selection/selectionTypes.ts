import type { ModuleId } from "../types";
import type { CrossSectionQualityMetric } from "../api/apiTypes";

type ObjectSelectionKind =
  | "object.root"
  | "object.geometry"
  | "object.material"
  | "object.physics"
  | "object.regions"
  | "object.region-magnetic-texture"
  | "object.magnetic-parameters"
  | "object.magnetic-texture"
  | "object.mesh"
  | "object.visualization";

type MeshQualitySelectionMetric = CrossSectionQualityMetric;

export type SelectionRef =
  | {
      kind: ObjectSelectionKind;
      nodeId: string;
      objectId: string;
      regionId?: string;
      type: "scene-object";
      visualizationTargetId: `object:${string}`;
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
      chartId: string;
      kind: "analysis.chart";
      nodeId: string;
      tableId: string;
      type: "analysis-chart";
    }
  | {
      kind:
        | "study.stage.action"
        | "study.stage.eigenmodes"
        | "study.stage.relax"
        | "study.stage.run";
      nodeId: string;
      stageId: string;
      stageIndex: number;
      type: "study-stage";
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
    case "analysis-chart":
      return (
        right.type === "analysis-chart" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.chartId === right.chartId &&
        left.tableId === right.tableId
      );
    case "study-stage":
      return (
        right.type === "study-stage" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.stageId === right.stageId &&
        left.stageIndex === right.stageIndex
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
