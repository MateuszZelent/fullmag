import type {
  FdmDomainSelectionScope,
  FdmDomainSelectionKind,
  RegionVisualizationTargetId,
  SelectionRef,
} from "@/kernel/selection/selectionTypes";
import {
  modeVisualizationTargetId,
  visualizationTargetIdForSceneObject,
} from "@/kernel/selection/selectionTypes";
import type { KernelApi, ModuleId } from "@/kernel/types";
import type { PostprocessingDefinitionKind } from "@/shared/domain/analysis/postprocessingTypes";
import { targetForFdmNativeLayer } from "@/kernel/visualization/ObjectVisualizationController";
import { selectCrossSectionPlot } from "@/kernel/workspace/crossSectionWorkspace";
import { parsePinnedQuickChart } from "@/kernel/workspace/quickChartWorkspace";

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

const FDM_DOMAIN_SELECTION_KINDS = new Set<FdmDomainSelectionKind>([
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
]);

const FDM_DOMAIN_SELECTION_SCOPES: Record<
  FdmDomainSelectionKind,
  FdmDomainSelectionScope
> = {
  "mesh.grid": "domain",
  "mesh.grid.active-unassigned": "active-unassigned",
  "mesh.grid.descriptor": "descriptor",
  "mesh.grid.common": "common",
  "mesh.grid.layers": "layers",
  "mesh.grid.layer": "layer",
  "mesh.grid.layer.native-grid": "layer-native-grid",
  "mesh.grid.layer.mask": "layer-mask",
  "mesh.grid.layer.transfer": "layer-transfer",
  "mesh.grid.layer.provenance": "layer-provenance",
  "mesh.grid.magnetic-support": "magnetic-support",
  "mesh.grid.mask": "mask",
  "mesh.grid.provenance": "provenance",
  "mesh.grid.region": "region",
  "mesh.grid.universe-outside-support": "universe-outside-support",
};

function isFdmDomainSelectionKind(
  kind: ExplorerNode["kind"],
): kind is FdmDomainSelectionKind {
  return FDM_DOMAIN_SELECTION_KINDS.has(kind as FdmDomainSelectionKind);
}

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

function postprocessingDefinitionKindFromNode(
  node: ExplorerNode,
): PostprocessingDefinitionKind | null {
  if (node.kind.startsWith("results.analysis_views")) return "analysis_view";
  if (node.kind.startsWith("results.derived_values")) return "derived_value";
  if (node.kind.startsWith("results.tables")) return "table";
  if (node.kind.startsWith("results.exports")) return "export";
  return null;
}

function postprocessingRootKind(
  definitionKind: PostprocessingDefinitionKind,
): ExplorerNode["kind"] {
  if (definitionKind === "analysis_view") return "results.analysis_views.root";
  if (definitionKind === "derived_value") return "results.derived_values.root";
  if (definitionKind === "table") return "results.tables.root";
  return "results.exports.root";
}

export function selectionRefFromNode(node: ExplorerNode): SelectionRef | null {
  if (node.runtimeDescriptorId && node.runtimeResourceKey) {
    return {
      descriptorId: node.runtimeDescriptorId,
      kind: node.kind,
      nodeId: node.id,
      resourceKey: node.runtimeResourceKey,
      type: "runtime-explorer",
    };
  }

  if (node.kind === "results.quick_chart") {
    const descriptor = parsePinnedQuickChart(node);
    if (!descriptor) return null;
    return {
      chartId: descriptor.chartId,
      displayUnits: descriptor.displayUnits,
      kind: "results.quick_chart",
      nodeId: node.id,
      range: descriptor.range,
      selectedSeriesIds: descriptor.selectedSeriesIds,
      tableId: descriptor.tableId,
      type: "quick-chart",
      xAxisId: descriptor.xAxisId,
    };
  }

  const postprocessingKind = postprocessingDefinitionKindFromNode(node);
  if (postprocessingKind) {
    return {
      artifactKind: node.postprocessingArtifactKind ?? null,
      catalogRevision: node.postprocessingCatalogRevision ?? null,
      contractGap: node.postprocessingContractGap ?? null,
      definitionKind: postprocessingKind,
      freshness: node.postprocessingFreshness ?? "unknown",
      kind: node.kind,
      nodeId: node.id,
      ownerId: node.postprocessingOwnerId ?? null,
      ownerKind: node.postprocessingOwnerKind ?? null,
      ownerReadiness: node.postprocessingOwnerReadiness ?? "unavailable",
      ownerResourceRevision: node.postprocessingResourceRevision ?? null,
      ownerSchemaRevision: node.postprocessingSchemaRevision ?? null,
      resourceRef: node.resourceRef ?? null,
      scope: node.kind.endsWith(".root") ? "root" : "definition",
      type: "postprocessing",
    };
  }

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

  // Visualization and Debug are public Airbox controls.  The FDM structured
  // grid is a renderer carrier, not a second user-facing target.  Normalize
  // old persisted FDM selections here as well as newly authored nodes.
  if (
    node.kind === "airbox.visualization" ||
    node.kind === "airbox.visualization.debug"
  ) {
    return {
      ...(node.availability ? { availability: node.availability } : {}),
      ...(node.contractGap !== undefined ? { contractGap: node.contractGap } : {}),
      ...(node.executionState ? { executionState: node.executionState } : {}),
      kind: node.kind,
      nodeId: node.id,
      ...(node.resourceState ? { resourceState: node.resourceState } : {}),
      type: "airbox",
      visualizationTargetId: "airbox",
    };
  }

  if (isFdmDomainSelectionKind(node.kind)) {
    if (node.kind === "mesh.grid.region" && !node.regionId) return null;
    const nativeLayerTarget =
      node.layerId && node.kind.startsWith("mesh.grid.layer")
        ? (targetForFdmNativeLayer(node.layerId).id as `fdm-native-layer:${string}`)
        : null;
    return {
      kind: node.kind,
      nodeId: node.id,
      ...(node.objectId ? { objectId: node.objectId } : {}),
      ...(node.layerId ? { layerId: node.layerId } : {}),
      ...(node.kind === "mesh.grid.region" ? { regionId: node.regionId } : {}),
      scope: FDM_DOMAIN_SELECTION_SCOPES[node.kind],
      type: "fdm-domain",
      visualizationTargetId:
        node.kind === "mesh.grid.universe-outside-support"
          ? "fdm-universe-outside-support"
          : node.kind === "mesh.grid.region" && node.objectId && node.regionId
            ? visualizationTargetIdForSceneObject(
                node.objectId,
                node.regionId,
              ) as RegionVisualizationTargetId
            : nativeLayerTarget ?? "fdm-domain",
    };
  }

  if (
    node.kind === "fdm.cell" &&
    node.cellOrdinal &&
    node.cellIJK &&
    node.gridFingerprint &&
    node.membershipRevision &&
    node.cellMaskState
  ) {
    return {
      cellOrdinal: node.cellOrdinal,
      gridFingerprint: node.gridFingerprint,
      ijk: node.cellIJK,
      kind: "fdm.cell",
      maskState: node.cellMaskState,
      membershipRevision: node.membershipRevision,
      nodeId: "model:mesh:grid",
      numericRegionId: node.numericRegionId ?? null,
      regionId: node.regionId ?? null,
      type: "fdm-cell",
      visualizationTargetId: "fdm-domain",
    };
  }

  if (node.kind === "mesh.unassigned") {
    return {
      kind: "mesh-part",
      nodeId: "model:mesh:unassigned",
      objectId: null,
      type: "mesh-part",
      visualizationTargetId: "mesh:unassigned",
    };
  }

  if (isFrequencyDomainSelectionNode(node)) {
    return {
      ...(node.analysisRunId ? { analysisRunId: node.analysisRunId } : {}),
      ...(node.analysisStageId ? { analysisStageId: node.analysisStageId } : {}),
      ...(node.artifactRevision !== undefined
        ? { artifactRevision: node.artifactRevision }
        : {}),
      ...(node.availability ? { availability: node.availability } : {}),
      ...(node.contractGap !== undefined ? { contractGap: node.contractGap } : {}),
      ...(node.equilibriumId ? { equilibriumId: node.equilibriumId } : {}),
      ...(node.executionState ? { executionState: node.executionState } : {}),
      ...(node.kContextKind ? { kContextKind: node.kContextKind } : {}),
      ...(node.normalization ? { normalization: node.normalization } : {}),
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
      ...(node.frequencyHz !== undefined ? { frequencyHz: node.frequencyHz } : {}),
      kind: node.kind,
      ...(node.kPathCoordinateRadPerM !== undefined
        ? { kPathCoordinateRadPerM: node.kPathCoordinateRadPerM }
        : {}),
      ...(node.modeIndex !== undefined ? { modeIndex: node.modeIndex } : {}),
      nodeId: node.id,
      ...(node.observableId ? { observableId: node.observableId } : {}),
      ...(node.resourceRef ? { resourceRef: node.resourceRef } : {}),
      ...(node.resourceState ? { resourceState: node.resourceState } : {}),
      ...(node.analysisFieldRepresentation
        ? { representation: node.analysisFieldRepresentation }
        : {}),
      ...(node.sampleIndex !== undefined ? { sampleIndex: node.sampleIndex } : {}),
      ...(node.analysisFieldSource ? { source: node.analysisFieldSource } : {}),
      ...(node.studyProduct ? { studyProduct: node.studyProduct } : {}),
      type: "frequency-domain",
      ...(node.wavevectorKf ? { wavevectorKf: node.wavevectorKf } : {}),
    };
  }

  if (
    node.objectId &&
    node.fieldId &&
    node.kind === "object.mode_visualization"
  ) {
    const source = modeVisualizationSourceFromNode(node);
    if (!source) return null;
    return {
      ...(node.analysisRunId ? { analysisRunId: node.analysisRunId } : {}),
      ...(node.analysisStageId ? { analysisStageId: node.analysisStageId } : {}),
      ...(node.artifactRevision !== undefined
        ? { artifactRevision: node.artifactRevision }
        : {}),
      ...(node.equilibriumId ? { equilibriumId: node.equilibriumId } : {}),
      fieldId: node.fieldId,
      ...(node.frequencyIndex !== undefined
        ? { frequencyIndex: node.frequencyIndex }
        : {}),
      ...(node.frequencyHz !== undefined ? { frequencyHz: node.frequencyHz } : {}),
      kind: node.kind,
      ...(node.kContextKind ? { kContextKind: node.kContextKind } : {}),
      ...(node.normalization ? { normalization: node.normalization } : {}),
      ...(node.kPathCoordinateRadPerM !== undefined
        ? { kPathCoordinateRadPerM: node.kPathCoordinateRadPerM }
        : {}),
      ...(node.modeIndex !== undefined ? { modeIndex: node.modeIndex } : {}),
      nodeId: node.id,
      objectId: node.objectId,
      ...(node.resourceRef ? { resourceRef: node.resourceRef } : {}),
      ...(node.analysisFieldRepresentation
        ? { representation: node.analysisFieldRepresentation }
        : {}),
      ...(node.sampleIndex !== undefined ? { sampleIndex: node.sampleIndex } : {}),
      source,
      ...(node.studyProduct ? { studyProduct: node.studyProduct } : {}),
      type: "mode-visualization",
      ...(node.analysisFieldView ? { view: node.analysisFieldView } : {}),
      visualizationTargetId: modeVisualizationTargetId(
        node.objectId,
        source,
        node.fieldId,
      ),
      ...(node.wavevectorKf ? { wavevectorKf: node.wavevectorKf } : {}),
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
    node.kind === "airbox.multilayer.target"
  ) {
    const isPublicAirboxVisualization =
      node.kind === "airbox.root" ||
      node.kind === "airbox.multilayer.target";
    return {
      kind: node.kind,
      nodeId: node.id,
      type: "airbox",
      visualizationTargetId:
        !isPublicAirboxVisualization &&
        node.visualizationTargetId === "fdm-universe-outside-support"
          ? "fdm-universe-outside-support"
          : "airbox",
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

  if (
    node.kind === "physics.structured-current-closure" &&
    node.currentTransportId &&
    node.structuredCurrentClosureId
  ) {
    return {
      currentTransportId: node.currentTransportId,
      kind: "physics.structured-current-closure",
      nodeId: node.id,
      structuredCurrentClosureId: node.structuredCurrentClosureId,
      type: "structured-current-closure",
    };
  }

  if (
    node.kind === "physics.structured-current-source-cut" &&
    node.currentTransportId &&
    node.structuredCurrentClosureId &&
    node.structuredCurrentSourceCutId
  ) {
    return {
      currentTransportId: node.currentTransportId,
      kind: "physics.structured-current-source-cut",
      nodeId: node.id,
      structuredCurrentClosureId: node.structuredCurrentClosureId,
      structuredCurrentSourceCutId: node.structuredCurrentSourceCutId,
      type: "structured-current-source-cut",
    };
  }

  if (
    node.kind === "physics.module" &&
    node.physicsModuleId &&
    node.physicsModuleKind &&
    node.physicsScopeKind
  ) {
    if (node.physicsModuleKind === "current_transport") {
      return {
        currentTransportId: node.physicsModuleId,
        kind: "physics.current-transport",
        nodeId: node.id,
        type: "current-transport",
      };
    }
    if (node.physicsModuleKind === "spin_transport") {
      return {
        kind: "physics.spin-transport",
        nodeId: node.id,
        spinTransportId: node.physicsModuleId,
        type: "spin-transport",
      };
    }
    if (node.physicsModuleKind === "spin_interface") {
      return {
        kind: "physics.spin-interface",
        nodeId: node.id,
        spinInterfaceId: node.physicsModuleId,
        ...(node.physicsDependencyIds?.[0]
          ? { spinInterfaceOwnerId: node.physicsDependencyIds[0] }
          : {}),
        type: "spin-interface",
      };
    }
    if (node.physicsModuleKind === "spin_torque") {
      return {
        kind: "physics.spin-torque",
        nodeId: node.id,
        spinTorqueId: node.physicsModuleId,
        type: "spin-torque",
      };
    }
    if (node.physicsModuleKind === "oersted_field") {
      return {
        kind: "physics.oersted-field",
        nodeId: node.id,
        oerstedFieldId: node.physicsModuleId,
        type: "oersted-field",
      };
    }
    if (node.physicsModuleKind === "regional_field_drive") {
      return {
        fieldDriveId: node.physicsModuleId,
        kind: "physics.field-drive",
        nodeId: node.id,
        type: "physics-field-drive",
      };
    }
    return {
      kind: "physics.module",
      nodeId: node.id,
      physicsActivation: node.physicsActivation,
      physicsModuleId: node.physicsModuleId,
      physicsModuleKind: node.physicsModuleKind,
      physicsScopeKind: node.physicsScopeKind,
      ...(node.physicsScopeObjectIds
        ? { physicsScopeObjectIds: node.physicsScopeObjectIds }
        : {}),
      ...(node.regionId ? { regionId: node.regionId } : {}),
      type: "physics-module",
    };
  }

  return null;
}

function findExplorerNode(
  nodes: readonly ExplorerNode[],
  nodeId: string | null,
): ExplorerNode | null {
  if (!nodeId) return null;
  for (const node of nodes) {
    if (node.id === nodeId) return node;
    const child = findExplorerNode(node.children ?? [], nodeId);
    if (child) return child;
  }
  return null;
}

function findExplorerNodeByKind(
  nodes: readonly ExplorerNode[],
  kind: ExplorerNode["kind"],
): ExplorerNode | null {
  for (const node of nodes) {
    if (node.kind === kind) return node;
    const child = findExplorerNodeByKind(node.children ?? [], kind);
    if (child) return child;
  }
  return null;
}

export function resolveCurrentExplorerSelectionNode(
  nodes: readonly ExplorerNode[],
  selectedNodeId: string | null,
  ref: SelectionRef | null,
  currentTree: readonly ExplorerNode[] = nodes,
): ExplorerNode | null {
  const selected = findExplorerNode(nodes, selectedNodeId);
  if (selected) return selected;
  if (ref?.type !== "postprocessing") return null;
  // A definition selection is tied to an immutable owner identity. If that
  // owner is no longer in the current snapshot, never silently retarget the
  // selection to a family root with different semantics.
  if (ref.scope === "definition") return null;
  const rootKind = postprocessingRootKind(ref.definitionKind);
  const familyRoot = findExplorerNodeByKind(currentTree, rootKind);
  if (familyRoot) return familyRoot;
  const resultsRoot = findExplorerNodeByKind(currentTree, "results.root");
  return resultsRoot?.availability === "unavailable" ? resultsRoot : null;
}

const FREQUENCY_DOMAIN_RESULT_KINDS = new Set<ExplorerNode["kind"]>([
  "results.resonance.root",
  "results.resonance.modal.stage",
  "results.resonance.driven.stage",
  "results.resonance.modal.spectrum",
  "results.resonance.modal.modes",
  "results.resonance.modal.mode",
  "results.resonance.modal.coupling",
  "results.resonance.modal.provenance",
  "results.resonance.driven.spectrum",
  "results.resonance.driven.peaks",
  "results.resonance.driven.frequency_points",
  "results.resonance.driven.fields",
  "results.resonance.driven.field",
  "results.resonance.driven.provenance",
  "results.dispersion.root",
  "results.dispersion.modal.stage",
  "results.dispersion.driven.stage",
  "results.dispersion.k_sampling",
  "results.dispersion.modal.relation",
  "results.dispersion.modal.branches",
  "results.dispersion.modal.modes_at_k",
  "results.dispersion.modal.mode_at_k",
  "results.dispersion.modal.provenance",
  "results.dispersion.driven.response_map",
  "results.dispersion.driven.field_at_k",
  "results.dispersion.driven.provenance",
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
]);

function isFrequencyDomainSelectionNode(node: ExplorerNode): boolean {
  return FREQUENCY_DOMAIN_RESULT_KINDS.has(node.kind);
}

export function selectExplorerNode(
  kernel: KernelApi,
  node: ExplorerNode,
  source: ModuleId,
): void {
  if (node.selectable === false) return;
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
        ref?.type === "mesh-part" ||
        ref?.type === "current-transport" ||
        ref?.type === "spin-transport" ||
        ref?.type === "spin-interface" ||
        ref?.type === "spin-torque" ||
        ref?.type === "oersted-field" ||
        ref?.type === "physics-field-drive" ||
        ref?.type === "physics-module"
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
