import type { SelectionRef } from "@/kernel/selection/selectionTypes";
import { visualizationTargetIdForSceneObject } from "@/kernel/selection/selectionTypes";
import type { KernelApi, ModuleId } from "@/kernel/types";
import { selectCrossSectionPlot } from "@/kernel/workspace/crossSectionWorkspace";

import type { ExplorerNode } from "./explorerTypes";

type StudyStageSelectionKind = Extract<
  SelectionRef,
  { type: "study-stage" }
>["kind"];

const STUDY_STAGE_SELECTION_KINDS = new Set<string>([
  "study.stage.action",
  "study.stage.add_field_drive",
  "study.stage.autosave",
  "study.stage.eigenmodes",
  "study.stage.eigenmodes.setup",
  "study.stage.eigenmodes.calculation_mode",
  "study.stage.eigenmodes.equilibrium",
  "study.stage.eigenmodes.operator",
  "study.stage.eigenmodes.boundary",
  "study.stage.eigenmodes.periodic_pairs",
  "study.stage.eigenmodes.k_path",
  "study.stage.eigenmodes.solver",
  "study.stage.eigenmodes.outputs",
  "study.stage.eigenmodes.diagnostics",
  "study.stage.frequency_response",
  "study.stage.frequency_response.setup",
  "study.stage.frequency_response.calculation_mode",
  "study.stage.frequency_response.equilibrium",
  "study.stage.frequency_response.operator",
  "study.stage.frequency_response.boundary",
  "study.stage.frequency_response.periodic_pairs",
  "study.stage.frequency_response.k_grid",
  "study.stage.frequency_response.excitation",
  "study.stage.frequency_response.sweep",
  "study.stage.frequency_response.solver",
  "study.stage.frequency_response.outputs",
  "study.stage.frequency_response.diagnostics",
  "study.stage.fft_response",
  "study.stage.hysteresis",
  "study.stage.relax",
  "study.stage.run",
  "study.stage.table_autosave",
  "study.stage.change_device",
  "study.stage.save_state",
]);

function isStudyStageSelectionKind(
  kind: ExplorerNode["kind"],
): kind is StudyStageSelectionKind {
  return STUDY_STAGE_SELECTION_KINDS.has(kind);
}

function extensionIdFromNode(node: ExplorerNode): string | undefined {
  if (node.extensionId) return node.extensionId;
  if (node.kind === "object.extension.topological-charge") {
    return "topological_charge";
  }
  return undefined;
}

function modeVisualizationSourceFromNode(
  node: ExplorerNode,
): "eigen-mode" | "frequency-response" | null {
  if (node.analysisFieldSource) return node.analysisFieldSource;
  if (node.fieldId?.startsWith("analysis:eigen:")) return "eigen-mode";
  if (node.fieldId?.startsWith("analysis:frequency-response:")) {
    return "frequency-response";
  }
  return null;
}

function modeVisualizationViewFromNode(node: ExplorerNode): string | undefined {
  if (node.analysisFieldView) return node.analysisFieldView;
  const marker = ":view:";
  const markerIndex = node.id.lastIndexOf(marker);
  return markerIndex >= 0 ? node.id.slice(markerIndex + marker.length) : undefined;
}

function modeVisualizationTargetId(
  objectId: string,
  source: "eigen-mode" | "frequency-response",
  fieldId: string,
): `mode:${string}:${typeof source}:${string}` {
  return `mode:${objectId}:${source}:${encodeURIComponent(fieldId)}`;
}

function selectionRefFromNode(node: ExplorerNode): SelectionRef | null {
  if (node.kind === "mesh.unassigned.part" && node.meshPartId) {
    return {
      carrierPartId: node.meshPartId,
      kind: "mesh-part",
      nodeId: node.id,
      objectId: null,
      type: "mesh-part",
      visualizationTargetId:
        node.visualizationTargetId ?? node.meshPartId,
    };
  }

  if (isFrequencyDomainSelectionNode(node)) {
    return {
      ...(node.analysisRunId ? { analysisRunId: node.analysisRunId } : {}),
      ...(node.analysisStageId ? { analysisStageId: node.analysisStageId } : {}),
      ...(node.artifactPath ? { artifactPath: node.artifactPath } : {}),
      ...(node.branchId ? { branchId: node.branchId } : {}),
      ...(node.calculationMode ? { calculationMode: node.calculationMode } : {}),
      ...(node.fieldId ? { fieldId: node.fieldId } : {}),
      ...(node.fmrPeakIndex !== undefined
        ? { fmrPeakIndex: node.fmrPeakIndex }
        : {}),
      ...(node.frequencyIndex !== undefined
        ? { frequencyIndex: node.frequencyIndex }
        : {}),
      kind: node.kind,
      ...(node.modeIndex !== undefined ? { modeIndex: node.modeIndex } : {}),
      nodeId: node.id,
      ...(node.observableId ? { observableId: node.observableId } : {}),
      ...(node.resourceRef ? { resourceRef: node.resourceRef } : {}),
      ...(node.sampleIndex !== undefined ? { sampleIndex: node.sampleIndex } : {}),
      type: "frequency-domain",
    };
  }

  if (
    node.objectId &&
    node.fieldId &&
    (node.kind === "object.mode_visualization" ||
      node.kind === "object.mode_visualization.group" ||
      node.kind === "object.mode_visualization.field" ||
      node.kind === "object.mode_visualization.view")
  ) {
    const source = modeVisualizationSourceFromNode(node);
    if (!source) return null;
    return {
      fieldId: node.fieldId,
      ...(node.frequencyIndex !== undefined
        ? { frequencyIndex: node.frequencyIndex }
        : {}),
      kind: node.kind,
      ...(node.modeIndex !== undefined ? { modeIndex: node.modeIndex } : {}),
      nodeId: node.id,
      objectId: node.objectId,
      ...(node.sampleIndex !== undefined ? { sampleIndex: node.sampleIndex } : {}),
      source,
      type: "mode-visualization",
      ...(modeVisualizationViewFromNode(node)
        ? { view: modeVisualizationViewFromNode(node) }
        : {}),
      visualizationTargetId: modeVisualizationTargetId(
        node.objectId,
        source,
        node.fieldId,
      ),
    };
  }

  if (
    node.objectId &&
    (node.kind === "object.root" ||
      node.kind === "object.geometry" ||
      node.kind === "object.antenna" ||
      node.kind === "object.material" ||
      node.kind === "object.physics" ||
      node.kind === "object.regions" ||
      node.kind === "object.region" ||
      node.kind === "object.region.geometry" ||
      node.kind === "object.region.shape" ||
      node.kind === "object.region.mesh" ||
      node.kind === "object.region.magnetic-parameters" ||
      node.kind === "object.region.material" ||
      node.kind === "object.region.texture" ||
      node.kind === "object.region.visualization" ||
      node.kind === "object.region.visualization.debug" ||
      node.kind === "object.region.regions" ||
      node.kind === "object.region.diagnostics" ||
      node.kind === "object.region-magnetic-texture" ||
      node.kind === "object.magnetic-parameters" ||
      node.kind === "object.magnetic-texture" ||
      node.kind === "object.magnetic-texture.asset" ||
      node.kind === "object.magnetic-texture.load" ||
      node.kind === "object.magnetic-texture.transform" ||
      node.kind === "object.mesh" ||
      node.kind === "object.extension.topological-charge" ||
      node.kind === "object.visualization" ||
      node.kind === "object.visualization.debug")
  ) {
    const extensionId = extensionIdFromNode(node);
    return {
      kind: node.kind,
      nodeId: node.id,
      objectId: node.objectId,
      ...(extensionId ? { extensionId } : {}),
      ...(node.regionId ? { regionId: node.regionId } : {}),
      type: "scene-object",
      visualizationTargetId: visualizationTargetIdForSceneObject(
        node.objectId,
        node.regionId,
      ),
    };
  }

  if (
    node.kind === "airbox.root" ||
    node.kind === "airbox.mesh" ||
    node.kind === "airbox.mesh.parameters" ||
    node.kind === "airbox.mesh.quality-gates" ||
    node.kind === "airbox.mesh.statistics" ||
    node.kind === "airbox.mesh.topology" ||
    node.kind === "airbox.mesh.build" ||
    node.kind === "airbox.visualization" ||
    node.kind === "airbox.visualization.debug"
  ) {
    return {
      kind: node.kind,
      nodeId: node.id,
      type: "airbox",
      visualizationTargetId: "airbox",
    };
  }

  if (node.kind === "model.planar.monitor" && node.monitorId) {
    return {
      kind: "model.planar.monitor",
      monitorId: node.monitorId,
      nodeId: node.id,
      type: "planar-monitor",
      visualizationTargetId: `planar-monitor:${node.monitorId}`,
    };
  }

  if (node.kind === "model.planar.monitor.draft") {
    return {
      draftId: "draft",
      kind: "model.planar.monitor.draft",
      nodeId: node.id,
      type: "planar-monitor-draft",
      visualizationTargetId: "planar-monitor:draft",
    };
  }

  if (
    node.kind === "visualizations-2d.draft" ||
    (node.kind === "visualizations-2d.parameter" && node.crossSectionDraftId)
  ) {
    return {
      draftId: node.crossSectionDraftId ?? "draft",
      kind: "mesh.cross-section.draft",
      nodeId: node.id,
      type: "cross-section-draft",
      visualizationTargetId: "cross-section:draft",
    };
  }

  if (
    (node.kind === "visualizations-2d.plot" ||
      node.kind === "visualizations-2d.parameter") &&
    node.crossSectionPlotId
  ) {
    return {
      kind: "mesh.cross-section.plot",
      nodeId: node.id,
      plotId: node.crossSectionPlotId,
      type: "cross-section-plot",
      visualizationTargetId: `cross-section:plot:${node.crossSectionPlotId}`,
    };
  }

  if (
    node.kind === "study.root" ||
    node.kind === "study.stages" ||
    node.kind === "study.execution" ||
    node.kind === "study.recovery"
  ) {
    return {
      kind: node.kind,
      nodeId: node.id,
      type: "study",
    };
  }

  if (
    node.kind === "study.stage.action" &&
    node.stageId &&
    node.stageIndex !== undefined &&
    node.hysteresisSnapshotId &&
    node.hysteresisPointId !== undefined
  ) {
    return {
      ...(node.fieldOrientation ? { fieldOrientation: node.fieldOrientation } : {}),
      ...(node.fieldRevision !== undefined ? { fieldRevision: node.fieldRevision } : {}),
      kind: "study.stage.action",
      ...(node.measurementAxis ? { measurementAxis: node.measurementAxis } : {}),
      ...(node.meshIdentity ? { meshIdentity: node.meshIdentity } : {}),
      nodeId: node.id,
      pointId: node.hysteresisPointId,
      quantityId: "m",
      ...(node.resourceRef ? { resourceRef: node.resourceRef } : {}),
      snapshotId: node.hysteresisSnapshotId,
      stageId: node.stageId,
      stageIndex: node.stageIndex,
      targetId: `hysteresis-step:${node.stageId}:${node.hysteresisPointId}`,
      type: "hysteresis-snapshot",
    };
  }

  if (
    node.stageId &&
    node.stageIndex !== undefined &&
    isStudyStageSelectionKind(node.kind)
  ) {
    return {
      ...(node.hysteresisExecutionNodeId
        ? { hysteresisExecutionNodeId: node.hysteresisExecutionNodeId }
        : {}),
      ...(node.hysteresisExecutionNodeKind
        ? { hysteresisExecutionNodeKind: node.hysteresisExecutionNodeKind }
        : {}),
      ...(node.hysteresisPointId !== undefined
        ? { hysteresisPointId: node.hysteresisPointId }
        : {}),
      ...(node.hysteresisSelectionRef
        ? { hysteresisSelectionRef: node.hysteresisSelectionRef }
        : {}),
      ...(node.resourceRef ? { resourceRef: node.resourceRef } : {}),
      kind: node.kind,
      nodeId: node.id,
      stageId: node.stageId,
      stageIndex: node.stageIndex,
      type: "study-stage",
    };
  }

  if (node.kind === "physics.coupling" && node.couplingId) {
    return {
      couplingId: node.couplingId,
      kind: "physics.coupling",
      nodeId: node.id,
      type: "physics-coupling",
    };
  }

  if (node.kind === "physics.field-drive" && node.fieldDriveId) {
    return {
      fieldDriveId: node.fieldDriveId,
      kind: "physics.field-drive",
      nodeId: node.id,
      type: "physics-field-drive",
    };
  }

  return null;
}

function isFrequencyDomainSelectionNode(node: ExplorerNode): boolean {
  return (
    node.kind.startsWith("results.frequency_domain") ||
    node.kind.startsWith("results.eigen") ||
    node.kind.startsWith("results.frequency_response") ||
    node.kind.startsWith("resources.analysis.frequency_domain") ||
    node.kind.startsWith("resources.analysis.eigen") ||
    node.kind.startsWith("resources.analysis.frequency_response") ||
    node.kind === "resources.mesh.periodic_pairs" ||
    node.kind.startsWith("jobs.frequency_domain") ||
    node.kind.startsWith("diagnostics.frequency_domain")
  );
}

export function selectExplorerNode(
  kernel: KernelApi,
  node: ExplorerNode,
  source: ModuleId,
): void {
  if (node.crossSectionPlotId) {
    selectCrossSectionPlot(node.crossSectionPlotId);
  }
  const ref = selectionRefFromNode(node);
  kernel.selection.set(
    {
      kind:
        ref?.type === "cross-section-draft" ||
        ref?.type === "cross-section-plot" ||
        ref?.type === "planar-monitor-draft" ||
        ref?.type === "mesh-part"
          ? ref.kind
          : node.kind,
      label: node.label,
      nodeId: node.id,
      objectId: node.objectId ?? null,
      ref,
    },
    source,
  );
}
