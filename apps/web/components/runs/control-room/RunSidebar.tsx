"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ModelTree, { buildFullmagModelTree } from "../../panels/ModelTree";
import { useCommand, useModel, useTransport, useViewport } from "./ControlRoomContext";
import { parseAnalyzeTreeNode } from "./analyzeSelection";
import {
  previewQuantityForTreeNode,
  resolveStudyStageExecutionState,
  resolveSelectedObjectId,
} from "./shared";
import {
  isVisualizationTreeNode,
  parseVisualizationPresetNodeId,
  VISUALIZATION_LOCAL_SECTION_NODE_ID,
  VISUALIZATION_PROJECT_SECTION_NODE_ID,
  VISUALIZATION_ROOT_NODE_ID,
  buildVisualizationPresetNodeId,
} from "./visualizationPresets";
import { meshWorkspaceNodeToDockTab, meshWorkspaceNodeToPreset } from "./meshWorkspace";
import { DEFAULT_CONVERGENCE_THRESHOLD } from "../../panels/SolverSettingsPanel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { TreeNodeData } from "../../panels/ModelTree";
import { useActiveStageLayout, useWorkspaceStore } from "@/lib/workspace/workspace-store";
import { useWorkspaceGraphStore } from "@/features/workspace-graph";
import { resultIconToken } from "@/features/analyze/registry/resultsTemplateRegistry";
import { parseResultNodeContext } from "@/features/analyze/model/resultNodeContext";
import { resultNodeToTreeNodeId } from "@/features/analyze/model/resultTreeNodeId";
import { materializeStudyPipeline } from "@/lib/study-builder/materialize";
import { getLiveApiClient } from "@/src/api/client/LiveApiClient";
import { isFemDiscretization } from "@/src/domain/capabilities";
import type { EigenModeSummary } from "@/components/analyze/eigenTypes";
import type { StudyPipelineDocumentState } from "@/lib/session/types";

function removeStudyPipelineNode(
  nodes: StudyPipelineDocumentState["nodes"],
  nodeId: string,
): StudyPipelineDocumentState["nodes"] {
  return nodes
    .filter((node) => node.id !== nodeId)
    .map((node) => {
      if (node.node_kind !== "group") {
        return node;
      }
      return {
        ...node,
        children: removeStudyPipelineNode(node.children, nodeId),
      };
    });
}

function toggleStudyPipelineNodeEnabled(
  nodes: StudyPipelineDocumentState["nodes"],
  nodeId: string,
): StudyPipelineDocumentState["nodes"] {
  return nodes.map((node) => {
    if (node.id === nodeId) {
      return {
        ...node,
        enabled: !node.enabled,
      };
    }
    if (node.node_kind !== "group") {
      return node;
    }
    return {
      ...node,
      children: toggleStudyPipelineNodeEnabled(node.children, nodeId),
    };
  });
}

type TreeFilterScope = "all" | "objects" | "mesh" | "physics" | "results";

function nodeMatchesScope(node: TreeNodeData, scope: TreeFilterScope): boolean {
  if (scope === "all") {
    return true;
  }
  const haystack = `${node.id} ${node.label} ${node.badge ?? ""}`.toLowerCase();
  switch (scope) {
    case "objects":
      return /^(objects|obj-|geo-|reg-|mat-|physobj-|mag-|ant-)/.test(node.id) || haystack.includes("object");
    case "mesh":
      return (
        /mesh|airbox|universe-airbox|domain|boundary|interface/.test(haystack) ||
        node.id.startsWith("mesh") ||
        node.id.includes("-mesh")
      );
    case "physics":
      return /^(physics|phys-|physobj-|physics-module-|physics-solver|solver)/.test(node.id) || haystack.includes("physics");
    case "results":
      return /^(results|res-|analyze|preview)/.test(node.id) || haystack.includes("result");
  }
}

function filterTreeNodes(
  nodes: TreeNodeData[],
  query: string,
  scope: TreeFilterScope,
): TreeNodeData[] {
  const normalizedQuery = query.trim().toLowerCase();
  return nodes.flatMap((node) => {
    const filteredChildren = node.children
      ? filterTreeNodes(node.children, normalizedQuery, scope)
      : [];
    const scopeMatch = nodeMatchesScope(node, scope);
    const queryMatch =
      normalizedQuery.length === 0 ||
      node.label.toLowerCase().includes(normalizedQuery) ||
      node.id.toLowerCase().includes(normalizedQuery) ||
      node.badge?.toLowerCase().includes(normalizedQuery);
    if ((scopeMatch && queryMatch) || filteredChildren.length > 0) {
      return [{ ...node, children: filteredChildren.length > 0 ? filteredChildren : node.children }];
    }
    return [];
  });
}

function countTreeNodes(nodes: TreeNodeData[]): number {
  return nodes.reduce(
    (count, node) => count + 1 + (node.children ? countTreeNodes(node.children) : 0),
    0,
  );
}

function uniqueSortedModeIndices(artifactPaths: string[]): number[] {
  const indices = new Set<number>();
  for (const path of artifactPaths) {
    if (!path.startsWith("eigen/modes/")) continue;
    const match = /mode_(\d+)\.json$/i.exec(path);
    if (!match) continue;
    const index = Number.parseInt(match[1], 10);
    if (Number.isFinite(index)) {
      indices.add(index);
    }
  }
  return Array.from(indices).sort((a, b) => a - b);
}

/**
 * RunSidebar — single-column explorer for the left dock.
 * Properties live in the right inspector to keep navigation width usable.
 */
export default function RunSidebar() {
  const model = useModel();
  const cmd = useCommand();
  const tp = useTransport();
  const vp = useViewport();
  const activeStageLayout = useActiveStageLayout();
  const launchIntent = useWorkspaceStore((state) => state.launchIntent);
  const [treeOpen, setTreeOpen] = useState(true);
  const [treeQuery, setTreeQuery] = useState("");
  const [treeFilterScope, setTreeFilterScope] = useState<TreeFilterScope>("all");
  const femDiscretization = cmd.domainCapabilities
    ? isFemDiscretization(cmd.domainCapabilities)
    : cmd.isFemBackend;
  const universeRole = useMemo(() => {
    if (!femDiscretization) {
      return "Grid / simulation domain";
    }
    switch (model.worldExtentSource) {
      case "declared_universe_manual":
        return "Declared universe / workspace framing";
      case "declared_universe_auto_padding":
        return "Auto-fit universe from bounds + padding";
      case "object_union_bounds":
        return "Object union bounds / preview framing";
      case "mesh_bounds":
        return "Mesh bounds / preview framing";
      default:
        return "Workspace framing";
    }
  }, [femDiscretization, model.worldExtentSource]);
  const runtimeDeclaredUniverse = model.domainFrame?.declared_universe ?? null;
  const artifactPaths = useMemo(
    () => (cmd.artifacts ?? []).map((artifact) => artifact.path),
    [cmd.artifacts],
  );
  const hasEigenSpectrumArtifact = useMemo(
    () =>
      artifactPaths.some(
        (path) => path === "eigen/spectrum.json" || path.startsWith("eigen/spectrum"),
      ),
    [artifactPaths],
  );
  const hasEigenDispersionArtifact = useMemo(
    () =>
      artifactPaths.some(
        (path) => path === "eigen/dispersion.json" || path.startsWith("eigen/dispersion"),
      ),
    [artifactPaths],
  );
  const savedEigenModeIndices = useMemo(
    () => uniqueSortedModeIndices(artifactPaths),
    [artifactPaths],
  );

  /* ── Derive eigen state from artifacts ── */
  const eigenModeCount = useMemo(() => {
    if (savedEigenModeIndices.length > 0) {
      return savedEigenModeIndices.length;
    }
    return null;
  }, [savedEigenModeIndices.length]);

  // Fetch spectrum summary for richer tree labels (frequency & polarization)
  const [spectrumModes, setSpectrumModes] = useState<EigenModeSummary[] | null>(null);
  useEffect(() => {
    if (!hasEigenSpectrumArtifact) {
      queueMicrotask(() => setSpectrumModes(null));
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = (await getLiveApiClient().eigen.getSpectrum()) as {
          modes?: EigenModeSummary[];
        };
        if (cancelled) return;
        if (!cancelled && Array.isArray(data.modes)) {
          setSpectrumModes(data.modes);
        }
      } catch {
        // Noncritical — tree will fall back to "Mode N" labels
      }
    })();
    return () => { cancelled = true; };
  }, [hasEigenSpectrumArtifact]);

  const eigenModeSummaries = useMemo(() => {
    const fmtGHz = (hz: number) => `${(hz / 1e9).toFixed(2)} GHz`;
    return savedEigenModeIndices.map((index) => {
      const spec = spectrumModes?.find((m) => m.index === index);
      if (spec) {
        return {
          index,
          label: `Mode ${index} · ${fmtGHz(spec.frequency_hz)} · ${spec.dominant_polarization}`,
        };
      }
      return { index, label: `Mode ${index}` };
    });
  }, [savedEigenModeIndices, spectrumModes]);
  const resultQuantityTree = useMemo(() => {
    const available = (cmd.quantities ?? []).filter((quantity) => quantity.available);
    const asTreeNode = (quantity: (typeof available)[number]) => ({
      id: quantity.id,
      label: quantity.label,
      kind: quantity.kind,
      unit: quantity.unit,
    });
    const field = available
      .filter((quantity) => quantity.kind !== "global_scalar")
      .map(asTreeNode);
    const scalar = available
      .filter((quantity) => quantity.kind === "global_scalar")
      .map(asTreeNode);
    return { field, scalar };
  }, [cmd.quantities]);
  const hasResultsSection = useMemo(() => {
    const hasEigen = hasEigenSpectrumArtifact || savedEigenModeIndices.length > 0;
    const hasDispersion = hasEigenDispersionArtifact;
    const hasScalarRows = tp.scalarRows.length > 0;
    const hasRuntimeSteps = (cmd.run?.total_steps ?? 0) > 0;
    const graphResults = useWorkspaceGraphStore.getState().snapshot.resultsWorkspace;
    const graphHasResults =
      graphResults.solutions.length > 0 ||
      graphResults.datasets.length > 0 ||
      graphResults.derivedValues.length > 0 ||
      graphResults.plotGroups.length > 0 ||
      graphResults.tables.length > 0 ||
      graphResults.analyses.length > 0 ||
      graphResults.exports.length > 0 ||
      graphResults.reports.length > 0;
    return (
      hasEigen ||
      hasDispersion ||
      hasScalarRows ||
      hasRuntimeSteps ||
      graphHasResults ||
      model.resultWorkspaceEntries.length > 0 ||
      resultQuantityTree.field.length > 0 ||
      resultQuantityTree.scalar.length > 0
    );
  }, [
    cmd.run?.total_steps,
    hasEigenDispersionArtifact,
    hasEigenSpectrumArtifact,
    model.resultWorkspaceEntries.length,
    resultQuantityTree.field.length,
    resultQuantityTree.scalar.length,
    savedEigenModeIndices.length,
    tp.scalarRows.length,
  ]);
  const graphResultsWorkspace = useWorkspaceGraphStore((state) => state.snapshot.resultsWorkspace);
  const graphSelection = useWorkspaceGraphStore((state) => state.snapshot.selection);
  const setGraphSelection = useWorkspaceGraphStore((state) => state.setSelection);
  const graphEnabled = true;
  const resultWorkspaceEntriesForTree = useMemo(() => {
    const entries = [
      ...graphResultsWorkspace.solutions.map((entry) => ({
        id: resultNodeToTreeNodeId("solution", entry.id),
        label: entry.label,
        icon: resultIconToken("solution"),
        badge: entry.solutionKind.replaceAll("_", " "),
        status: graphResultsWorkspace.activeResultNodeId === entry.id ? ("active" as const) : ("ready" as const),
        group: entry.pinned ? ("pinned" as const) : ("auto" as const),
        createdAtUnixMs: entry.createdAt,
      })),
      ...graphResultsWorkspace.datasets.map((entry) => ({
        id: resultNodeToTreeNodeId("dataset", entry.id),
        label: entry.label,
        icon: resultIconToken("dataset"),
        badge: `${entry.sampleCount} samples`,
        status: graphResultsWorkspace.activeResultNodeId === entry.id ? ("active" as const) : ("ready" as const),
        group: entry.pinned ? ("pinned" as const) : ("auto" as const),
        createdAtUnixMs: entry.createdAt,
      })),
      ...graphResultsWorkspace.derivedValues.map((entry) => ({
        id: resultNodeToTreeNodeId("derived_value", entry.id),
        label: entry.label,
        icon: resultIconToken("derived_value"),
        badge: entry.unit ?? null,
        status: graphResultsWorkspace.activeResultNodeId === entry.id ? ("active" as const) : ("ready" as const),
        group: entry.pinned ? ("pinned" as const) : ("auto" as const),
        createdAtUnixMs: entry.createdAt,
      })),
      ...graphResultsWorkspace.plotGroups.map((entry) => ({
        id: resultNodeToTreeNodeId("plot_group", entry.id),
        label: entry.label,
        icon: resultIconToken("plot_group"),
        badge: `${entry.plots.length} plots`,
        status: graphResultsWorkspace.activeResultNodeId === entry.id ? ("active" as const) : ("ready" as const),
        group: entry.pinned ? ("pinned" as const) : ("auto" as const),
        createdAtUnixMs: entry.createdAt,
      })),
      ...graphResultsWorkspace.tables.map((entry) => ({
        id: resultNodeToTreeNodeId("table", entry.id),
        label: entry.label,
        icon: resultIconToken("table"),
        badge: `${entry.columns.length} columns`,
        status: graphResultsWorkspace.activeResultNodeId === entry.id ? ("active" as const) : ("ready" as const),
        group: entry.pinned ? ("pinned" as const) : ("auto" as const),
        createdAtUnixMs: entry.createdAt,
      })),
      ...graphResultsWorkspace.analyses.map((entry) => ({
        id: resultNodeToTreeNodeId("analysis", entry.id),
        label: entry.label,
        icon: resultIconToken("analysis"),
        badge: entry.analysisKind,
        status: graphResultsWorkspace.activeResultNodeId === entry.id ? ("active" as const) : ("ready" as const),
        group: entry.pinned ? ("pinned" as const) : ("auto" as const),
        createdAtUnixMs: entry.createdAt,
      })),
      ...graphResultsWorkspace.exports.map((entry) => ({
        id: resultNodeToTreeNodeId("export", entry.id),
        label: entry.label,
        icon: resultIconToken("export"),
        badge: entry.format.toUpperCase(),
        status: graphResultsWorkspace.activeResultNodeId === entry.id ? ("active" as const) : ("ready" as const),
        group: entry.pinned ? ("pinned" as const) : ("auto" as const),
        createdAtUnixMs: entry.createdAt,
      })),
      ...graphResultsWorkspace.reports.map((entry) => ({
        id: resultNodeToTreeNodeId("report", entry.id),
        label: entry.label,
        icon: resultIconToken("report"),
        badge: `${entry.sections.length} sections`,
        status: graphResultsWorkspace.activeResultNodeId === entry.id ? ("active" as const) : ("ready" as const),
        group: entry.pinned ? ("pinned" as const) : ("auto" as const),
        createdAtUnixMs: entry.createdAt,
      })),
    ];
    return entries.sort((a, b) => {
      const aIsAuto = a.group !== "pinned";
      const bIsAuto = b.group !== "pinned";
      if (aIsAuto !== bIsAuto) {
        return aIsAuto ? 1 : -1;
      }
      return aIsAuto ? a.createdAtUnixMs - b.createdAtUnixMs : b.createdAtUnixMs - a.createdAtUnixMs;
    });
  }, [graphResultsWorkspace]);

  const stageExecutionState = useMemo(() => {
    return resolveStudyStageExecutionState({
      stageExecution: cmd.stageExecution,
      totalStages: model.studyStages.length,
      workspaceStatus: cmd.workspaceStatus,
      activityLabel: cmd.activity.label ?? null,
    });
  }, [cmd.activity.label, cmd.stageExecution, cmd.workspaceStatus, model.studyStages.length]);

  const pipelineStageIndexesByNodeId = useMemo(() => {
    const document =
      model.studyPipeline ?? model.modelBuilderGraph?.study.study_pipeline ?? null;
    if (!document) {
      return {};
    }
    const materialized = materializeStudyPipeline(document);
    const entries: Array<[string, number[]]> = [];
    const collectEntries = (mapEntries: typeof materialized.map): void => {
      for (const entry of mapEntries) {
        entries.push([entry.nodeId, entry.stageIndexes]);
        if (entry.childEntries?.length) {
          collectEntries(entry.childEntries);
        }
      }
    };
    collectEntries(materialized.map);
    return Object.fromEntries(entries);
  }, [model.modelBuilderGraph?.study.study_pipeline, model.studyPipeline]);

  /* ── Build model tree nodes ── */
  const modelTreeNodes = useMemo(
    () =>
      buildFullmagModelTree({
        graph: model.modelBuilderGraph,
        sceneDocument: model.sceneDocument,
        studyLabel: launchIntent?.displayName ?? model.modelBuilderGraph?.study.label ?? "Simulation",
        backend: femDiscretization ? "FEM" : "FDM",
        universeMode: runtimeDeclaredUniverse?.mode ?? null,
        universeDeclaredSize: runtimeDeclaredUniverse?.size ?? null,
        universeEffectiveSize: model.worldExtent,
        universeCenter: model.worldCenter,
        universePadding: runtimeDeclaredUniverse?.padding ?? null,
        universeRole,
        domainMeshMode: model.effectiveFemMesh?.domain_mesh_mode ?? null,
        airPartElementCount: model.airPart?.element_count ?? null,
        airPartNodeCount: model.airPart?.node_count ?? null,
        geometryKind: model.mesherSourceKind ?? undefined,
        materialName:
          model.material?.name
            ?? (model.material?.msat != null ? `Msat=${(model.material.msat / 1e3).toFixed(0)} kA/m` : undefined),
        materialMsat: model.material?.msat,
        materialAex: model.material?.aex,
        materialAlpha: model.material?.alpha,
        meshStatus: model.effectiveFemMesh ? "ready" : "pending",
        meshElements: model.effectiveFemMesh?.elements.length,
        meshNodes: model.effectiveFemMesh?.nodes.length,
        meshFeOrder: model.meshFeOrder,
        meshName: model.meshName,
        solverStatus: tp.hasSolverTelemetry ? "active" : "pending",
        solverIntegrator: model.solverPlan?.integrator ?? model.solverSettings.integrator,
        solverRelaxAlgorithm: model.solverPlan?.relaxation?.algorithm ?? model.solverSettings.relaxAlgorithm,
        demagRealization: model.scriptBuilderDemagRealization,
        capabilities: cmd.capabilities,
        metadata: cmd.metadata,
        exchangeEnabled: model.material?.exchangeEnabled,
        demagEnabled: model.material?.demagEnabled,
        zeemanField:
          model.sceneDocument?.study.external_field
          ?? model.modelBuilderGraph?.study.external_field
          ?? model.material?.zeemanField
          ?? null,
        convergenceStatus:
          tp.hasSolverTelemetry && tp.effectiveDmDt > 0 && tp.effectiveDmDt < (Number(model.solverSettings.torqueTolerance) || DEFAULT_CONVERGENCE_THRESHOLD)
            ? "ready"
            : tp.hasSolverTelemetry
              ? "active"
              : undefined,
        scalarRowCount: tp.scalarRows.length,
        showResultsSection: hasResultsSection,
        resultsFieldQuantities: resultQuantityTree.field,
        resultsScalarQuantities: resultQuantityTree.scalar,
        resultWorkspaceEntries: resultWorkspaceEntriesForTree,
        eigenModeCount,
        eigenModeSummaries,
        eigenHasDispersion: hasEigenDispersionArtifact,
        hasVortexData: tp.scalarRows.length > 4,
        visualizationProjectPresets: model.visualizationProjectPresets,
        visualizationLocalPresets: model.visualizationLocalPresets,
        activeVisualizationPresetRef: model.activeVisualizationPresetRef,
        activeStudyStageIndex: stageExecutionState.activeStageIndex,
        completedStudyStageIndexes: stageExecutionState.completedStageIndexes,
        studyStageStatuses: stageExecutionState.stageStatuses,
        pipelineStageIndexesByNodeId,
      }),
    [
      model.modelBuilderGraph, model.sceneDocument, model.effectiveFemMesh, tp.hasSolverTelemetry, femDiscretization, model.material,
      model.scriptBuilderDemagRealization, cmd.capabilities, cmd.metadata,
      model.mesherSourceKind, model.meshFeOrder, model.meshName,
      model.solverPlan?.integrator, model.solverPlan?.relaxation?.algorithm,
      model.solverSettings.integrator, model.solverSettings.relaxAlgorithm, model.solverSettings.torqueTolerance,
      tp.effectiveDmDt, tp.scalarRows.length, model.worldCenter, model.worldExtent, runtimeDeclaredUniverse?.mode, runtimeDeclaredUniverse?.padding, runtimeDeclaredUniverse?.size,
      universeRole, hasResultsSection, resultQuantityTree.field, resultQuantityTree.scalar, resultWorkspaceEntriesForTree, eigenModeCount, eigenModeSummaries, hasEigenDispersionArtifact,
      launchIntent?.displayName, model.airPart?.element_count, model.airPart?.node_count,
      model.visualizationProjectPresets, model.visualizationLocalPresets, model.activeVisualizationPresetRef,
      stageExecutionState.activeStageIndex, stageExecutionState.completedStageIndexes, stageExecutionState.stageStatuses, pipelineStageIndexesByNodeId,
    ],
  );

  /* ── Determine active node (from explicit selection or viewport context) ── */
  const fallbackNodeId = useMemo(() => {
    const isMeshView = femDiscretization && vp.effectiveViewMode === "Mesh";
    const sharedAirboxDomain =
      model.effectiveFemMesh?.domain_mesh_mode === "shared_domain_mesh_with_air";
    if (isMeshView) {
      if (sharedAirboxDomain) {
        if (model.femDockTab === "quality") return "mesh-quality";
        if (model.femDockTab === "pipeline") return "mesh-pipeline";
        if (model.femDockTab === "view") return "mesh-view";
        if (model.femDockTab === "mesher") return "universe-airbox-mesh";
        return "universe-airbox-mesh";
      }
      if (model.femDockTab === "quality") return "universe-mesh-quality";
      if (model.femDockTab === "pipeline") return "universe-mesh-pipeline";
      if (model.femDockTab === "view") return "universe-mesh-view";
      if (model.femDockTab === "mesher") return "universe-mesh-size";
      return "universe-mesh";
    }
    if (vp.previewControlsActive) return "res-fields";
    if (activeStageLayout.leftDock === "results-tree") return "results";
    if (activeStageLayout.leftDock === "study-tree") return "study";
    if (activeStageLayout.leftDock === "model") return "study-root";
    if (cmd.interactiveControlsEnabled) return "physics-solver";
    const firstObjectId =
      model.sceneDocument?.objects[0]?.name ??
      model.sceneDocument?.objects[0]?.id ??
      model.modelBuilderGraph?.objects.items[0]?.id;
    if (firstObjectId) return `obj-${firstObjectId}`;
    return "objects";
  }, [activeStageLayout.leftDock, vp.effectiveViewMode, model.effectiveFemMesh?.domain_mesh_mode, model.femDockTab, cmd.interactiveControlsEnabled,
      femDiscretization, model.modelBuilderGraph, model.sceneDocument, vp.previewControlsActive]);

  const activeNodeId = (graphEnabled ? graphSelection.activeNodeId : null) ?? model.selectedSidebarNodeId ?? fallbackNodeId;
  const filteredModelTreeNodes = useMemo(
    () => filterTreeNodes(modelTreeNodes, treeQuery, treeFilterScope),
    [modelTreeNodes, treeFilterScope, treeQuery],
  );
  const filteredTreeNodeCount = useMemo(
    () => countTreeNodes(filteredModelTreeNodes),
    [filteredModelTreeNodes],
  );
  const selectModelNode = useCallback((id: string) => {
    if (graphEnabled) {
      const resultContext = parseResultNodeContext(id);
      let activeResultNodeId: string | null = null;
      if (resultContext) {
        switch (resultContext.kind) {
          case "results-analysis":
            activeResultNodeId = resultContext.analysisId;
            break;
          case "results-solution":
            activeResultNodeId = resultContext.solutionId;
            break;
          case "results-dataset":
            activeResultNodeId = resultContext.datasetId;
            break;
          case "results-dataset-solution":
            activeResultNodeId = resultContext.solutionId;
            break;
          case "results-derived-value":
            activeResultNodeId = resultContext.derivedValueId;
            break;
          case "results-plot-group":
            activeResultNodeId = resultContext.plotGroupId;
            break;
          case "results-table":
            activeResultNodeId = resultContext.tableId;
            break;
          case "results-export-node":
            activeResultNodeId = resultContext.exportId;
            break;
          case "results-report":
            activeResultNodeId = resultContext.reportId;
            break;
          default:
            activeResultNodeId = null;
        }
      }
      setGraphSelection({
        activeNodeId: id,
        activeResultNodeId,
      });
    }
    const visualizationPresetNode = parseVisualizationPresetNodeId(id);
    if (visualizationPresetNode) {
      model.setSelectedSidebarNodeId(id);
      model.setSelectedObjectId(null);
      model.setSelectedEntityId(null);
      model.setFocusedEntityId(null);
      model.setActiveVisualizationPresetRef({
        source: visualizationPresetNode.source,
        preset_id: visualizationPresetNode.presetId,
      });
      return;
    }
    if (isVisualizationTreeNode(id)) {
      model.setSelectedSidebarNodeId(id);
      model.setSelectedObjectId(null);
      model.setSelectedEntityId(null);
      model.setFocusedEntityId(null);
      return;
    }
    const analyzeTarget = parseAnalyzeTreeNode(id);
    if (analyzeTarget) {
      model.setSelectedSidebarNodeId(id);
      vp.setWorkspaceMode("analyze");
      model.openAnalyze(analyzeTarget);
      return;
    }
    const resultContext = parseResultNodeContext(id);
    if (
      resultContext &&
      resultContext.kind !== "results-root" &&
      resultContext.kind !== "results-overview" &&
      resultContext.kind !== "results-fields" &&
      resultContext.kind !== "results-field-quantity" &&
      resultContext.kind !== "results-derived-scalars" &&
      resultContext.kind !== "results-state-io" &&
      resultContext.kind !== "results-export" &&
      resultContext.kind !== "results-datasets" &&
      resultContext.kind !== "results-solutions" &&
      resultContext.kind !== "results-analyses"
    ) {
      model.setSelectedSidebarNodeId(id);
      model.setSelectedObjectId(null);
      model.setSelectedEntityId(null);
      model.setFocusedEntityId(null);
      vp.setWorkspaceMode("analyze");
      return;
    }
    const objectId = resolveSelectedObjectId(id, model.sceneDocument ?? model.modelBuilderGraph);
    model.setSelectedSidebarNodeId(id);
    model.setSelectedObjectId(objectId);
    // P0 fix: selection must NOT reset isolate.
    // Only update objectViewMode if we're NOT currently in isolate mode,
    // or if the user explicitly requests it via the isolate pill.
    if (model.objectViewMode !== "isolate") {
      model.setObjectViewMode("context");
    }
    if (id === "universe-airbox" || id === "universe-airbox-mesh") {
      const airPartId = model.airPart?.id ?? null;
      model.setSelectedEntityId(airPartId);
      model.setFocusedEntityId(null);
      return;
    }
    if (objectId) {
      // Tree selection should only change selection/highlight state.
      // Camera focus stays reserved for explicit actions like "Focus in 3D".
      model.setSelectedEntityId(null);
      model.setFocusedEntityId(null);
      return;
    }
    model.setSelectedEntityId(null);
    model.setFocusedEntityId(null);
  }, [graphEnabled, model, setGraphSelection, vp]);

  /* ── Tree click handler ── */
  const handleTreeClick = useCallback((id: string) => {
    selectModelNode(id);
    if (parseAnalyzeTreeNode(id)) {
      return;
    }
    if (id.startsWith("res-analysis-")) {
      model.openResultWorkspaceEntry(id.replace("res-analysis-", ""));
      vp.setWorkspaceMode("analyze");
      return;
    }
    const resultContext = parseResultNodeContext(id);
    if (
      resultContext?.kind === "results-solution" ||
      resultContext?.kind === "results-dataset" ||
      resultContext?.kind === "results-dataset-solution" ||
      resultContext?.kind === "results-derived-value" ||
      resultContext?.kind === "results-plot-group" ||
      resultContext?.kind === "results-table" ||
      resultContext?.kind === "results-export-node" ||
      resultContext?.kind === "results-report"
    ) {
      vp.setWorkspaceMode("analyze");
      return;
    }
    if (id === "res-dataset-eigen-spectrum") {
      model.openAnalyze({ tab: "spectrum", selectedModeIndex: null });
      return;
    }
    if (id === "res-dataset-eigen-dispersion") {
      model.openAnalyze({ tab: "dispersion", selectedModeIndex: null });
      return;
    }
    if (id === "res-dataset-time-series" || id === "res-dataset-final-state") {
      const defaultFieldQuantity =
        vp.quickPreviewTargets.find((target) => target.id === "m" && target.available)?.id ??
        vp.quickPreviewTargets.find((target) => target.available)?.id ??
        null;
      if (defaultFieldQuantity) {
        vp.requestPreviewQuantity(defaultFieldQuantity);
      }
      if (femDiscretization && vp.effectiveViewMode === "Mesh") {
        vp.handleViewModeChange("3D");
      }
      return;
    }
    const visualizationPresetNode = parseVisualizationPresetNodeId(id);
    if (visualizationPresetNode) {
      model.applyVisualizationPreset({
        source: visualizationPresetNode.source,
        preset_id: visualizationPresetNode.presetId,
      });
      return;
    }
    if (
      id === VISUALIZATION_ROOT_NODE_ID ||
      id === VISUALIZATION_PROJECT_SECTION_NODE_ID ||
      id === VISUALIZATION_LOCAL_SECTION_NODE_ID
    ) {
      return;
    }
    const selectedObjectId = resolveSelectedObjectId(
      id,
      model.sceneDocument ?? model.modelBuilderGraph,
    );
    const isUniverseNode = id === "universe" || id.startsWith("universe-");
    const isGeometryScopedNode =
      id === "geometry" ||
      id === "objects" ||
      id.startsWith("obj-") ||
      id.startsWith("geo-") ||
      id.startsWith("reg-") ||
      id.startsWith("mat-") ||
      id.startsWith("physobj-") ||
      selectedObjectId != null;
    switch (id) {
      case "geometry":
      case "objects":
        if (femDiscretization && !model.effectiveFemMesh) model.openFemMeshWorkspace("mesh");
        else vp.handleViewModeChange("3D");
        return;
      case "mesh":
      case "mesh-view":
      case "mesh-size":
      case "mesh-algorithm":
      case "mesh-quality":
      case "mesh-pipeline":
      case "universe-airbox-mesh":
      case "universe-mesh":
      case "universe-mesh-view":
      case "universe-mesh-size":
      case "universe-mesh-algorithm":
      case "universe-mesh-quality":
      case "universe-mesh-pipeline": {
        if (!femDiscretization) return;
        const preset = meshWorkspaceNodeToPreset(id);
        if (preset) {
          model.applyMeshWorkspacePreset(preset);
          return;
        }
        const dockTab = meshWorkspaceNodeToDockTab(id);
        if (dockTab) {
          model.openFemMeshWorkspace(dockTab);
        }
        return;
      }
      case "results": case "res-fields":
        if (femDiscretization && vp.effectiveViewMode === "Mesh") vp.handleViewModeChange("3D");
        return;
      case "antennas":
        // Show the inspector with AntennaPanel
        return;
      default: {
        const isAntennaNode = id.startsWith("ant-");
        if (isAntennaNode) {
          // Try to preview antenna field when clicking on a specific antenna
          if (vp.quickPreviewTargets.some((t) => t.id === "H_ant" && t.available)) {
            vp.requestPreviewQuantity("H_ant");
          }
          vp.handleViewModeChange("3D");
          return;
        }
        const isMagneticTextureNode = id.startsWith("mag-");
        if (isMagneticTextureNode) {
          // Magnetic-texture authoring should only update tree selection/inspector.
          // It must not mutate viewport mode or carry mesh-workspace render presets into 3D.
          return;
        }
        // Per-object mesh nodes (e.g. "geo-nanoflower-mesh") → open mesh workspace
        const isObjectMeshNode = id.startsWith("geo-") && id.endsWith("-mesh");
        if (isObjectMeshNode) {
          if (femDiscretization) {
            model.openFemMeshWorkspace("mesh");
          } else {
            vp.handleViewModeChange("Mesh");
          }
          return;
        }
        if (isUniverseNode || isGeometryScopedNode) {
          if (femDiscretization && !model.effectiveFemMesh) model.openFemMeshWorkspace("mesh");
          else vp.handleViewModeChange("3D");
          return;
        }
        const isPhysicsNode =
          id === "physics" ||
          id === "physics-solver" ||
          id.startsWith("physics-module-") ||
          id.startsWith("phys-");
        if (isPhysicsNode) {
          // Physics inspector navigation should not implicitly change the rendered viewport quantity.
          return;
        }
        const previewTarget = previewQuantityForTreeNode(id);
        if (previewTarget && vp.quickPreviewTargets.some((t) => t.id === previewTarget && t.available)) {
          vp.requestPreviewQuantity(previewTarget);
        }
      }
    }
  }, [femDiscretization, model, vp, selectModelNode]);

  const handleTreeContextAction = useCallback((nodeId: string, action: string) => {
    if (nodeId.startsWith("res-analysis-")) {
      const id = nodeId.replace("res-analysis-", "");
      const existing = model.resultWorkspaceEntries.find((entry) => entry.id === id);
      if (!existing) {
        return;
      }
      if (action === "rename") {
        const nextLabel = window.prompt("Analysis name", existing?.label ?? "Analysis");
        if (nextLabel && nextLabel.trim().length > 0) {
          model.renameResultWorkspaceEntry(id, nextLabel.trim());
        }
        return;
      }
      if (action === "duplicate") {
        const duplicateId = model.duplicateResultWorkspaceEntry(id);
        if (duplicateId) {
          model.setSelectedSidebarNodeId(`res-analysis-${duplicateId}`);
          model.openResultWorkspaceEntry(duplicateId);
        }
        return;
      }
      if (action === "toggle-pin") {
        model.setResultWorkspacePinned(id, !existing.pinned);
        return;
      }
      if (action === "delete") {
        const accepted = window.confirm("Delete this analysis entry from Results tree?");
        if (accepted) {
          model.removeResultWorkspaceEntry(id);
        }
        return;
      }
    }
    const visualizationPresetNode = parseVisualizationPresetNodeId(nodeId);
    if (visualizationPresetNode) {
      const ref = {
        source: visualizationPresetNode.source,
        preset_id: visualizationPresetNode.presetId,
      } as const;
      if (action === "apply") {
        model.applyVisualizationPreset(ref);
        model.setSelectedSidebarNodeId(nodeId);
        return;
      }
      if (action === "rename") {
        const existing =
          (visualizationPresetNode.source === "project"
            ? model.visualizationProjectPresets
            : model.visualizationLocalPresets
          ).find((preset) => preset.id === visualizationPresetNode.presetId);
        const nextName = window.prompt("Preset name", existing?.name ?? "Visualization");
        if (nextName && nextName.trim().length > 0) {
          model.renameVisualizationPreset(ref, nextName.trim());
        }
        return;
      }
      if (action === "duplicate") {
        const created = model.duplicateVisualizationPreset(ref);
        if (created) {
          model.setSelectedSidebarNodeId(
            buildVisualizationPresetNodeId(created.source, created.preset_id),
          );
        }
        return;
      }
      if (action === "delete") {
        const accepted = window.confirm("Delete this visualization preset?");
        if (accepted) {
          model.deleteVisualizationPreset(ref);
        }
        return;
      }
      if (action === "save-project") {
        const created = model.copyVisualizationPresetToSource(ref, "project");
        if (created) {
          model.setSelectedSidebarNodeId(
            buildVisualizationPresetNodeId(created.source, created.preset_id),
          );
        }
        return;
      }
      if (action === "save-local") {
        const created = model.copyVisualizationPresetToSource(ref, "local");
        if (created) {
          model.setSelectedSidebarNodeId(
            buildVisualizationPresetNodeId(created.source, created.preset_id),
          );
        }
        return;
      }
    }
    if (action === "delete-stage" && nodeId.startsWith("study-stage-node:")) {
      const match = nodeId.match(/^study-stage-node:(.+?)(?:\/|$)/);
      if (match && model.studyPipeline) {
        const stageId = match[1];
        const accepted = window.confirm("Delete this stage from the pipeline?");
        if (accepted) {
          const nextDocument: StudyPipelineDocumentState = {
            ...model.studyPipeline,
            nodes: removeStudyPipelineNode(model.studyPipeline.nodes, stageId),
          };
          model.setStudyPipeline(nextDocument);
          const compiled = materializeStudyPipeline(nextDocument);
          model.setStudyStages(compiled.stages);
        }
      }
      return;
    }
    if (action === "toggle-stage" && nodeId.startsWith("study-stage-node:")) {
      const match = nodeId.match(/^study-stage-node:(.+?)(?:\/|$)/);
      if (match && model.studyPipeline) {
        const stageId = match[1];
        const nextDocument: StudyPipelineDocumentState = {
          ...model.studyPipeline,
          nodes: toggleStudyPipelineNodeEnabled(model.studyPipeline.nodes, stageId),
        };
        model.setStudyPipeline(nextDocument);
        const compiled = materializeStudyPipeline(nextDocument);
        model.setStudyStages(compiled.stages);
      }
      return;
    }
    if (action === "focus") {
      const objectId = resolveSelectedObjectId(
        nodeId,
        model.sceneDocument ?? model.modelBuilderGraph,
      );
      if (!objectId) {
        return;
      }
      selectModelNode(nodeId);
      if (femDiscretization && !model.effectiveFemMesh) {
        model.requestFocusObject(objectId);
        model.openFemMeshWorkspace("mesh");
        return;
      }
      vp.handleViewModeChange("3D");
      model.requestFocusObject(objectId);
      return;
    }
  }, [femDiscretization, model, selectModelNode, vp]);

  const handleTreeToggle = useCallback(() => {
    setTreeOpen((prev) => !prev);
  }, []);

  return (
    <div className="flex h-full w-full border-l border-border/10 bg-background/80">
      <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background/55">
        <button
          type="button"
          className="flex w-full items-center border-b border-border/10 px-3 py-2 text-left transition-colors hover:bg-muted/20"
          onClick={handleTreeToggle}
          aria-expanded={treeOpen}
        >
          <span
            className={cn(
              "mr-2 flex h-4 w-4 items-center justify-center text-[10px] text-primary/60 transition-transform duration-200",
              treeOpen && "rotate-90",
            )}
          >
            ▸
          </span>
          <span className="text-[0.72rem] font-semibold tracking-wide text-foreground/90">
            Explorer
          </span>
          <span className="ml-auto rounded-sm bg-primary/80 px-1.5 py-0.5 text-[0.58rem] font-mono font-bold tracking-tight text-primary-foreground shadow-sm">
            {femDiscretization ? "FEM" : "FDM"}
          </span>
        </button>
        {treeOpen ? (
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <ScrollArea className="h-full w-full">
              <div className="space-y-2 p-2 select-none">
                <div className="space-y-2 rounded-lg border border-border/15 bg-background/40 p-2">
                  <Input
                    value={treeQuery}
                    onChange={(event) => setTreeQuery(event.target.value)}
                    placeholder="Search tree…"
                    className="h-9 bg-background/60 text-[0.78rem]"
                    aria-label="Search model tree"
                  />
                  <div className="flex flex-wrap gap-1">
                    {(
                      [
                        ["all", "All"],
                        ["objects", "Objects"],
                        ["mesh", "Mesh"],
                        ["physics", "Physics"],
                        ["results", "Results"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={cn(
                          "rounded-md border px-2 py-1 text-[0.65rem] font-medium transition-colors",
                          treeFilterScope === value
                            ? "border-primary/30 bg-primary/12 text-primary"
                            : "border-border/20 bg-background/30 text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                        )}
                        onClick={() => setTreeFilterScope(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[0.66rem] text-muted-foreground">
                    <span className="truncate">
                      {filteredTreeNodeCount.toLocaleString()} visible node
                      {filteredTreeNodeCount === 1 ? "" : "s"}
                    </span>
                    {(treeQuery.length > 0 || treeFilterScope !== "all") ? (
                      <button
                        type="button"
                        className="rounded px-1.5 py-0.5 text-[0.62rem] font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                        onClick={() => {
                          setTreeQuery("");
                          setTreeFilterScope("all");
                        }}
                      >
                        Reset
                      </button>
                    ) : null}
                  </div>
                </div>
                <ModelTree
                  nodes={filteredModelTreeNodes}
                  activeId={activeNodeId}
                  onNodeClick={handleTreeClick}
                  onContextAction={handleTreeContextAction}
                  compact
                />
              </div>
            </ScrollArea>
          </div>
        ) : null}
      </section>
    </div>
  );
}
