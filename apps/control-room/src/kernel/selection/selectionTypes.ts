import type { ModuleId } from "../types";
import type { CrossSectionQualityMetric } from "../api/apiTypes";
import type {
  AnalysisFieldOverlayKContextKind,
  AnalysisFieldOverlayRepresentation,
  AnalysisFieldOverlaySource,
} from "../visualization/AnalysisFieldOverlayController";

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
  | "object.mode_visualization";

type MeshQualitySelectionMetric = CrossSectionQualityMetric;
export type RegionVisualizationTargetId = `region:${string}:${string}`;

export type LiveChartSelection = {
  kind: "live.chart";
  descriptorId: string;
};

export type LiveChartPointSelection = {
  kind: "live.chart-point";
  descriptorId: string;
  seriesId: string;
  pointIndex: number;
  revision: string | number;
};

export type LiveChartSelectionRef = LiveChartSelection & {
  nodeId: string;
  type: "live-chart";
};

export type LiveChartPointSelectionRef = LiveChartPointSelection & {
  nodeId: string;
  type: "live-chart-point";
};

export const LIVE_CHART_SELECTION_IDENTITY_MAX_LENGTH = 256;
const LIVE_CHART_DESCRIPTOR_ID_MAX_LENGTH = 128;
const LIVE_CHART_IDENTITY_PREFIX = "live:chart:";
const LEGACY_LIVE_CHART_IDENTITY = "analysis:charts:default";

export type LiveChartSelectionMigrationSource = "legacy-live-preference";

function parseLiveChartDescriptorId(encoded: string): string | null {
  if (
    encoded.length === 0 ||
    encoded.length > LIVE_CHART_DESCRIPTOR_ID_MAX_LENGTH ||
    !/^(?:[A-Za-z0-9\-_.!~*'()]|%[0-9A-F]{2})+$/.test(encoded)
  ) {
    return null;
  }

  try {
    const descriptorId = decodeURIComponent(encoded);
    return descriptorId.length > 0 &&
      descriptorId.length <= LIVE_CHART_DESCRIPTOR_ID_MAX_LENGTH &&
      !/[/:\\\u0000-\u001F\u007F]/.test(descriptorId) &&
      encodeURIComponent(descriptorId) === encoded
      ? descriptorId
      : null;
  } catch {
    return null;
  }
}

/**
 * Parses only the current live-chart identity namespace. Legacy Analysis
 * identities remain Analysis identities outside the explicit migration reader.
 */
export function parseLiveChartSelectionIdentity(
  identity: string,
): LiveChartSelection | null {
  if (
    identity.length > LIVE_CHART_SELECTION_IDENTITY_MAX_LENGTH ||
    !identity.startsWith(LIVE_CHART_IDENTITY_PREFIX)
  ) {
    return null;
  }
  const descriptorId = parseLiveChartDescriptorId(
    identity.slice(LIVE_CHART_IDENTITY_PREFIX.length),
  );
  return descriptorId !== null
    ? { descriptorId, kind: "live.chart" }
    : null;
}

export function serializeLiveChartSelectionIdentity(
  selection: LiveChartSelection,
): string | null {
  if (
    selection.descriptorId.length === 0 ||
    selection.descriptorId.length > LIVE_CHART_DESCRIPTOR_ID_MAX_LENGTH ||
    /[/:\\\u0000-\u001F\u007F]/.test(selection.descriptorId)
  ) {
    return null;
  }
  const identity = `${LIVE_CHART_IDENTITY_PREFIX}${encodeURIComponent(selection.descriptorId)}`;
  return identity.length <= LIVE_CHART_SELECTION_IDENTITY_MAX_LENGTH
    ? identity
    : null;
}

/**
 * Read the one legacy live identity only while migrating old live preferences.
 * Remove after one released schema version has written `fm:live-chart-preferences:v1`
 * and browser migration tests prove no old live identity remains.
 */
export function readLegacyLiveChartSelectionIdentity(
  identity: string,
  source: LiveChartSelectionMigrationSource | "current-selection",
): LiveChartSelection | null {
  return source === "legacy-live-preference" && identity === LEGACY_LIVE_CHART_IDENTITY
    ? { descriptorId: "default", kind: "live.chart" }
    : null;
}
export interface VisualizationMeshPartLike {
  geometry_id?: string | null;
  id: string;
  label?: string | null;
  object_id?: string | null;
  role?: string | null;
}

const AIRBOX_ROLES = new Set(["air", "airbox"]);
const AIRBOX_IDS = new Set(["airbox", "__air__", "__airbox__"]);

export function isVisualizationAirboxRole(role: string | null | undefined): boolean {
  return AIRBOX_ROLES.has(role?.trim().toLowerCase() ?? "");
}

export function isVisualizationAirboxId(id: string | null | undefined): boolean {
  let normalized = id?.trim().toLowerCase() ?? "";
  while (normalized.startsWith("part:") || normalized.startsWith("object:")) {
    normalized = normalized.slice(normalized.indexOf(":") + 1);
  }
  if (normalized.endsWith("_geom")) {
    normalized = normalized.slice(0, -"_geom".length);
  }
  return AIRBOX_IDS.has(normalized);
}

export function isVisualizationAirboxIdentity(value: {
  geometry_id?: string | null;
  id?: string | null;
  object_id?: string | null;
  role?: string | null;
}): boolean {
  return (
    isVisualizationAirboxRole(value.role) ||
    [value.id, value.object_id, value.geometry_id].some(isVisualizationAirboxId)
  );
}

export function visualizationTargetIdForSceneObject(
  objectId: string,
  regionId?: string | null,
): `object:${string}` | RegionVisualizationTargetId {
  const targetObjectId = canonicalVisualizationSceneObjectId(objectId);
  if (!regionId) return `object:${targetObjectId}`;
  return `region:${targetObjectId}:${encodeURIComponent(regionId)}`;
}

export function modeVisualizationTargetId(
  objectId: string,
  source: AnalysisFieldOverlaySource,
  fieldId: string,
): `mode:${string}:${AnalysisFieldOverlaySource}:${string}` {
  return `mode:${objectId}:${source}:${encodeURIComponent(fieldId)}`;
}

export function canonicalVisualizationSceneObjectId(objectId: string): string {
  return objectId.endsWith("_geom") ? objectId.slice(0, -5) : objectId;
}

export function canonicalVisualizationPartTargetId(partId: string): string {
  return `part:${partId}`;
}

export function visualizationPartScopeIdFromTargetId(targetId: string): string {
  return targetId.startsWith("part:")
    ? targetId.slice("part:".length)
    : targetId;
}

export function visualizationObjectIdForMeshPartLike(part: {
  geometry_id?: string | null;
  object_id?: string | null;
  role?: string | null;
}): string | null {
  if (isVisualizationAirboxIdentity(part)) return null;
  const objectId = part.object_id ?? part.geometry_id;
  return objectId ? canonicalVisualizationSceneObjectId(objectId) : null;
}

export type MeshElementFamily = "hex8" | "prism6" | "pyramid5" | "tet4";
export type FdmCellMaskState = "inactive" | "active-unassigned" | "region";
export type FdmDomainSelectionKind =
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
  | "mesh.grid.universe-outside-support";

export type FdmDomainSelectionScope =
  | "domain"
  | "descriptor"
  | "common"
  | "layers"
  | "layer"
  | "layer-native-grid"
  | "layer-mask"
  | "layer-transfer"
  | "layer-provenance"
  | "magnetic-support"
  | "active-unassigned"
  | "mask"
  | "provenance"
  | "region"
  | "universe-outside-support";

export type SelectionRef =
  | LiveChartSelectionRef
  | LiveChartPointSelectionRef
  | {
      descriptorId: string;
      kind: string;
      nodeId: string;
      resourceKey: string;
      type: "runtime-explorer";
    }
  | {
      kind: "model.planar.monitor";
      monitorId: string;
      nodeId: string;
      type: "planar-monitor";
      visualizationTargetId: `planar-monitor:${string}`;
    }
  | {
      kind: FdmDomainSelectionKind;
      nodeId: string;
      /**
       * Optional owner identity for region-scoped FDM mesh selections.
       *
       * Region identifiers are scoped by ferromagnetic object in the
       * membership legend. Keep this optional for legacy nodes that only
       * published a region id; new nodes must carry it when available.
       */
      objectId?: string;
      layerId?: string;
      regionId?: string;
      scope: FdmDomainSelectionScope;
      type: "fdm-domain";
      visualizationTargetId:
        | "fdm-domain"
        | `fdm-native-layer:${string}`
        | "fdm-universe-outside-support"
        | RegionVisualizationTargetId;
    }
  | {
      cellOrdinal: string;
      gridFingerprint: string;
      ijk: readonly [number, number, number];
      kind: "fdm.cell";
      maskState: FdmCellMaskState;
      membershipRevision: string;
      nodeId: "model:mesh:grid";
      numericRegionId: number | null;
      regionId: string | null;
      type: "fdm-cell";
      visualizationTargetId: "fdm-domain";
    }
  | {
      boundaryFaceIndex?: number | null;
      carrierPartId?: string;
      elementFamily?: MeshElementFamily | null;
      globalCellOrdinal?: string | null;
      kind: ObjectSelectionKind;
      nodeId: string;
      objectId: string;
      extensionId?: string;
      regionId?: string;
      type: "scene-object";
      visualizationTargetId: `object:${string}` | RegionVisualizationTargetId;
    }
  | {
      boundaryFaceIndex?: number | null;
      carrierPartId?: string;
      elementFamily?: MeshElementFamily | null;
      globalCellOrdinal?: string | null;
      kind:
        | "airbox.root"
        | "airbox.mesh"
        | "airbox.mesh.parameters"
        | "airbox.mesh.quality-gates"
        | "airbox.mesh.statistics"
        | "airbox.mesh.topology"
        | "airbox.mesh.build"
        | "airbox.visualization"
        | "airbox.visualization.debug"
        | "airbox.multilayer.target";
      nodeId: string;
      type: "airbox";
      visualizationTargetId: "airbox" | "fdm-universe-outside-support";
    }
  | {
      boundaryFaceIndex?: number | null;
      carrierPartId?: string;
      elementFamily?: MeshElementFamily | null;
      globalCellOrdinal?: string | null;
      kind: "mesh-part" | "mesh-part-airbox";
      nodeId: string;
      objectId: string | null;
      type: "mesh-part";
      visualizationTargetId: string;
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
      draftId: "draft";
      kind: "model.planar.monitor.draft";
      nodeId: string;
      type: "planar-monitor-draft";
      visualizationTargetId: "planar-monitor:draft";
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
      currentTransportId?: string;
      currentTransportIndex?: number;
      kind: "physics.current-transport";
      nodeId: string;
      type: "current-transport";
    }
  | {
      currentTransportId: string;
      kind: "physics.structured-current-closure";
      nodeId: string;
      structuredCurrentClosureId: string;
      type: "structured-current-closure";
    }
  | {
      currentTransportId: string;
      kind: "physics.structured-current-source-cut";
      nodeId: string;
      structuredCurrentClosureId: string;
      structuredCurrentSourceCutId: string;
      type: "structured-current-source-cut";
    }
  | {
      draft?: boolean;
      kind: "physics.spin-transport";
      nodeId: string;
      regionId?: string;
      spinTransportId?: string;
      spinTransportIndex?: number;
      type: "spin-transport";
    }
  | {
      draft?: boolean;
      kind: "physics.spin-interface";
      nodeId: string;
      spinInterfaceId?: string;
      spinInterfaceIndex?: number;
      spinInterfaceOwnerId?: string;
      type: "spin-interface";
    }
  | {
      kind: "physics.spin-torque";
      nodeId: string;
      spinTorqueId?: string;
      spinTorqueIndex?: number;
      type: "spin-torque";
    }
  | {
      kind: "physics.oersted-field";
      nodeId: string;
      oerstedFieldId?: string;
      oerstedFieldIndex?: number;
      type: "oersted-field";
    }
  | {
      kind: "physics.module";
      nodeId: string;
      physicsActivation?: string;
      physicsModuleId: string;
      physicsModuleKind: string;
      physicsScopeKind: string;
      physicsScopeObjectIds?: readonly string[];
      regionId?: string;
      type: "physics-module";
    }
  | {
      draft?: boolean;
      fieldDriveId?: string;
      kind: "physics.field-drives" | "physics.field-drive";
      nodeId: string;
      type: "physics-field-drive";
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
      chartId: string;
      displayUnits: Record<string, string>;
      kind: "results.quick_chart";
      nodeId: string;
      range: { fromSI: number; toSI: number } | null;
      selectedSeriesIds: readonly string[];
      tableId: string;
      type: "quick-chart";
      xAxisId: string;
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
        | "study.stage.add_field_drive"
        | "study.stage.autosave"
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
        | "study.stage.fft_response"
        | "study.stage.hysteresis"
        | "study.stage.relax"
        | "study.stage.run"
        | "study.stage.table_autosave"
        | "study.stage.change_device"
        | "study.stage.save_state";
      hysteresisExecutionNodeId?: string;
      hysteresisExecutionNodeKind?: string;
      hysteresisPointId?: number;
      hysteresisSelectionRef?: string;
      nodeId: string;
      resourceRef?: string;
      stageId: string;
      stageIndex: number;
      type: "study-stage";
    }
  | {
      analysisRunId?: string;
      analysisStageId?: string;
      artifactRevision?: number | string;
      equilibriumId?: string;
      kContextKind?: AnalysisFieldOverlayKContextKind;
      artifactPath?: string;
      branchId?: string;
      calculationMode?: string;
      fieldId?: string;
      fmrPeakIndex?: number;
      frequencyHz?: number;
      frequencyIndex?: number;
      kPathCoordinateRadPerM?: number;
      kind: string;
      modeIndex?: number;
      nodeId: string;
      observableId?: string;
      representation?: AnalysisFieldOverlayRepresentation | string;
      resourceRef?: string;
      sampleIndex?: number;
      source?: AnalysisFieldOverlaySource;
      studyProduct?: string;
      type: "frequency-domain";
      wavevectorKf?: readonly [number, number, number];
    }
  | {
      analysisRunId?: string;
      analysisStageId?: string;
      artifactRevision?: number | string;
      equilibriumId?: string;
      fieldId: string;
      frequencyHz?: number;
      frequencyIndex?: number;
      kContextKind?: AnalysisFieldOverlayKContextKind;
      kPathCoordinateRadPerM?: number;
      kind: "object.mode_visualization";
      modeIndex?: number;
      nodeId: string;
      objectId: string;
      resourceRef?: string;
      representation?: AnalysisFieldOverlayRepresentation;
      sampleIndex?: number;
      source: AnalysisFieldOverlaySource;
      studyProduct?: string;
      type: "mode-visualization";
      view?: string;
      visualizationTargetId: `mode:${string}:${AnalysisFieldOverlaySource}:${string}`;
      wavevectorKf?: readonly [number, number, number];
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

function arrayEquals(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function centroidEquals(
  left: readonly [number, number, number] | null | undefined,
  right: readonly [number, number, number] | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

function recordEquals(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const entries = Object.entries(left);
  return entries.length === Object.keys(right).length &&
    entries.every(([key, value]) => right[key] === value);
}

export function selectionRefEquals(
  left: Selection["ref"],
  right: Selection["ref"],
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.type !== right.type) return false;

  switch (left.type) {
    case "runtime-explorer":
      return (
        right.type === "runtime-explorer" &&
        left.descriptorId === right.descriptorId &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.resourceKey === right.resourceKey
      );
    case "live-chart":
      return (
        right.type === "live-chart" &&
        left.kind === right.kind &&
        left.descriptorId === right.descriptorId &&
        left.nodeId === right.nodeId
      );
    case "live-chart-point":
      return (
        right.type === "live-chart-point" &&
        left.kind === right.kind &&
        left.descriptorId === right.descriptorId &&
        left.seriesId === right.seriesId &&
        left.pointIndex === right.pointIndex &&
        left.revision === right.revision &&
        left.nodeId === right.nodeId
      );
    case "planar-monitor":
      return (
        right.type === "planar-monitor" &&
        left.kind === right.kind &&
        left.monitorId === right.monitorId &&
        left.nodeId === right.nodeId &&
        left.visualizationTargetId === right.visualizationTargetId
      );
    case "fdm-domain":
      return (
        right.type === "fdm-domain" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        nullableStringEquals(left.objectId, right.objectId) &&
        nullableStringEquals(left.layerId, right.layerId) &&
        nullableStringEquals(left.regionId, right.regionId) &&
        left.scope === right.scope &&
        left.visualizationTargetId === right.visualizationTargetId
      );
    case "fdm-cell":
      return (
        right.type === "fdm-cell" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.visualizationTargetId === right.visualizationTargetId &&
        left.cellOrdinal === right.cellOrdinal &&
        left.ijk[0] === right.ijk[0] &&
        left.ijk[1] === right.ijk[1] &&
        left.ijk[2] === right.ijk[2] &&
        left.maskState === right.maskState &&
        left.numericRegionId === right.numericRegionId &&
        left.regionId === right.regionId &&
        left.gridFingerprint === right.gridFingerprint &&
        left.membershipRevision === right.membershipRevision
      );
    case "scene-object":
      return (
        right.type === "scene-object" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.objectId === right.objectId &&
        nullableStringEquals(left.extensionId, right.extensionId) &&
        nullableStringEquals(left.regionId, right.regionId) &&
        nullableStringEquals(left.carrierPartId, right.carrierPartId) &&
        (left.boundaryFaceIndex ?? null) ===
          (right.boundaryFaceIndex ?? null) &&
        (left.globalCellOrdinal ?? null) ===
          (right.globalCellOrdinal ?? null) &&
        nullableStringEquals(left.elementFamily, right.elementFamily) &&
        left.visualizationTargetId === right.visualizationTargetId
      );
    case "airbox":
      return (
        right.type === "airbox" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        nullableStringEquals(left.carrierPartId, right.carrierPartId) &&
        (left.boundaryFaceIndex ?? null) ===
          (right.boundaryFaceIndex ?? null) &&
        (left.globalCellOrdinal ?? null) ===
          (right.globalCellOrdinal ?? null) &&
        nullableStringEquals(left.elementFamily, right.elementFamily) &&
        left.visualizationTargetId === right.visualizationTargetId
      );
    case "mesh-part":
      return (
        right.type === "mesh-part" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        nullableStringEquals(left.carrierPartId, right.carrierPartId) &&
        nullableStringEquals(left.objectId, right.objectId) &&
        (left.boundaryFaceIndex ?? null) ===
          (right.boundaryFaceIndex ?? null) &&
        (left.globalCellOrdinal ?? null) ===
          (right.globalCellOrdinal ?? null) &&
        nullableStringEquals(left.elementFamily, right.elementFamily) &&
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
    case "planar-monitor-draft":
      return (
        right.type === "planar-monitor-draft" &&
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
    case "spin-transport":
      return (
        right.type === "spin-transport" &&
        left.draft === right.draft &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.regionId === right.regionId &&
        left.spinTransportId === right.spinTransportId &&
        left.spinTransportIndex === right.spinTransportIndex
      );
    case "current-transport":
      return (
        right.type === "current-transport" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.currentTransportId === right.currentTransportId &&
        left.currentTransportIndex === right.currentTransportIndex
      );
    case "structured-current-closure":
      return (
        right.type === "structured-current-closure" &&
        left.currentTransportId === right.currentTransportId &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.structuredCurrentClosureId === right.structuredCurrentClosureId
      );
    case "structured-current-source-cut":
      return (
        right.type === "structured-current-source-cut" &&
        left.currentTransportId === right.currentTransportId &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.structuredCurrentClosureId === right.structuredCurrentClosureId &&
        left.structuredCurrentSourceCutId === right.structuredCurrentSourceCutId
      );
    case "spin-interface":
      return (
        right.type === "spin-interface" &&
        left.draft === right.draft &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.spinInterfaceId === right.spinInterfaceId &&
        left.spinInterfaceIndex === right.spinInterfaceIndex &&
        left.spinInterfaceOwnerId === right.spinInterfaceOwnerId
      );
    case "spin-torque":
      return (
        right.type === "spin-torque" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.spinTorqueId === right.spinTorqueId &&
        left.spinTorqueIndex === right.spinTorqueIndex
      );
    case "oersted-field":
      return (
        right.type === "oersted-field" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.oerstedFieldId === right.oerstedFieldId &&
        left.oerstedFieldIndex === right.oerstedFieldIndex
      );
    case "physics-module":
      return (
        right.type === "physics-module" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.physicsModuleId === right.physicsModuleId &&
        left.physicsModuleKind === right.physicsModuleKind &&
        left.physicsScopeKind === right.physicsScopeKind &&
        left.physicsActivation === right.physicsActivation &&
        left.regionId === right.regionId &&
        arrayEquals(left.physicsScopeObjectIds, right.physicsScopeObjectIds)
      );
    case "physics-field-drive":
      return (
        right.type === "physics-field-drive" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.fieldDriveId === right.fieldDriveId
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
    case "quick-chart":
      return (
        right.type === "quick-chart" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.chartId === right.chartId &&
        left.tableId === right.tableId &&
        left.xAxisId === right.xAxisId &&
        left.selectedSeriesIds.length === right.selectedSeriesIds.length &&
        left.selectedSeriesIds.every((id, index) => id === right.selectedSeriesIds[index]) &&
        left.range?.fromSI === right.range?.fromSI &&
        left.range?.toSI === right.range?.toSI &&
        recordEquals(left.displayUnits, right.displayUnits)
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
        nullableStringEquals(
          left.hysteresisSelectionRef,
          right.hysteresisSelectionRef,
        ) &&
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
        (left.artifactRevision ?? null) === (right.artifactRevision ?? null) &&
        nullableStringEquals(left.equilibriumId, right.equilibriumId) &&
        nullableStringEquals(left.fieldId, right.fieldId) &&
        (left.fmrPeakIndex ?? null) === (right.fmrPeakIndex ?? null) &&
        (left.frequencyHz ?? null) === (right.frequencyHz ?? null) &&
        left.frequencyIndex === right.frequencyIndex &&
        nullableStringEquals(left.kContextKind, right.kContextKind) &&
        (left.kPathCoordinateRadPerM ?? null) ===
          (right.kPathCoordinateRadPerM ?? null) &&
        left.modeIndex === right.modeIndex &&
        nullableStringEquals(left.observableId, right.observableId) &&
        nullableStringEquals(left.representation, right.representation) &&
        nullableStringEquals(left.resourceRef, right.resourceRef) &&
        left.sampleIndex === right.sampleIndex &&
        nullableStringEquals(left.source, right.source) &&
        nullableStringEquals(left.studyProduct, right.studyProduct) &&
        centroidEquals(left.wavevectorKf, right.wavevectorKf)
      );
    case "mode-visualization":
      return (
        right.type === "mode-visualization" &&
        left.kind === right.kind &&
        left.nodeId === right.nodeId &&
        left.objectId === right.objectId &&
        nullableStringEquals(left.analysisRunId, right.analysisRunId) &&
        nullableStringEquals(left.analysisStageId, right.analysisStageId) &&
        (left.artifactRevision ?? null) === (right.artifactRevision ?? null) &&
        nullableStringEquals(left.equilibriumId, right.equilibriumId) &&
        left.fieldId === right.fieldId &&
        left.source === right.source &&
        (left.frequencyHz ?? null) === (right.frequencyHz ?? null) &&
        left.frequencyIndex === right.frequencyIndex &&
        nullableStringEquals(left.kContextKind, right.kContextKind) &&
        (left.kPathCoordinateRadPerM ?? null) ===
          (right.kPathCoordinateRadPerM ?? null) &&
        left.modeIndex === right.modeIndex &&
        nullableStringEquals(left.representation, right.representation) &&
        nullableStringEquals(left.resourceRef, right.resourceRef) &&
        left.sampleIndex === right.sampleIndex &&
        nullableStringEquals(left.studyProduct, right.studyProduct) &&
        nullableStringEquals(left.view, right.view) &&
        left.visualizationTargetId === right.visualizationTargetId &&
        centroidEquals(left.wavevectorKf, right.wavevectorKf)
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
