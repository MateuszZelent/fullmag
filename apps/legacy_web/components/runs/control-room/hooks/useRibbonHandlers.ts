"use client";

/**
 * useRibbonHandlers — extracted from ControlRoomShell.
 *
 * Groups inline callbacks that bridge the ribbon bar to model/viewport
 * actions: study pipeline operations, magnetization presets, transform
 * scoping, antenna management, and result analysis creation.
 *
 * This reduces ControlRoomShell's callback section by ~200 LOC.
 */

import { useCallback, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { ScriptBuilderMagneticInteractionKind } from "@/lib/session/types";
import {
  MAGNETIC_PRESET_CATALOG,
  type MagneticPresetKind,
} from "@/lib/magnetizationPresetCatalog";
import {
  ensureObjectPhysicsStack,
  upsertObjectInteraction,
} from "@/lib/session/magneticPhysics";
import { assignMagneticPreset } from "@/lib/session/magnetizationAssetActions";
import {
  appendNode,
  createMacroNode,
  createPrimitiveNode,
  duplicateNode,
  insertNodeNear,
  toggleNodeEnabled,
} from "@/lib/study-builder/operations";
import { materializeStudyPipeline } from "@/lib/study-builder/materialize";
import { buildPipelineStudyStageNodeId } from "@/lib/study-builder/node-context";
import type {
  StudyPipelineDocument,
  StudyPrimitiveStageKind,
} from "@/lib/study-builder/types";
import { buildVisualizationPresetNodeId } from "../visualizationPresets";
import { parseAnalyzeTreeNode } from "../analyzeSelection";
import { parseResultNodeContext } from "@/features/analyze/model/resultNodeContext";
import { recordFrontendDebugEvent } from "@/lib/workspace/navigation-debug";
import {
  resolveSelectedObjectId,
  resolveAntennaNodeName,
} from "../shared";
import {
  buildResultWorkspaceEntryInput,
  makeRibbonAntenna,
  resolveStudyAnchorNodeId,
  syncStudyRuntimeState,
  type ResultAnalysisKind,
} from "../controlRoomShellHelpers";
import { useSelectionActions } from "@/features/selection";

const WORKSPACE_ANALYZE_HREF = "/workspace/analyze";

interface UseRibbonHandlersDeps {
  _model: ReturnType<typeof import("../context-hooks").useModel>;
  _cmd: ReturnType<typeof import("../context-hooks").useCommand>;
  _viewport: ReturnType<typeof import("../context-hooks").useViewport>;
  selectedSidebarNodeId: string | null;
  authoringStudyDocument: StudyPipelineDocument;
  setActiveCoreTab: (tab: string) => void;
  setActiveContextualTab: (tab: string | null) => void;
}

export function useRibbonHandlers({
  _model,
  _cmd,
  _viewport,
  selectedSidebarNodeId,
  authoringStudyDocument,
  setActiveCoreTab,
  setActiveContextualTab,
}: UseRibbonHandlersDeps) {
  const { setSelectedObjectId } = useSelectionActions();
  const router = useRouter();
  const pathname = usePathname();

  const selectedAntennaName = useMemo(
    () =>
      resolveAntennaNodeName(
        selectedSidebarNodeId,
        _cmd.scriptBuilderCurrentModules.map((module) => module.name),
      ),
    [selectedSidebarNodeId, _cmd.scriptBuilderCurrentModules],
  );

  const quickPreviewTargets = _viewport.quickPreviewTargets;
  const requestPreviewQuantity = _viewport.requestPreviewQuantity;

  const maybePreviewAntennaField = useCallback(() => {
    if (quickPreviewTargets.some((target) => target.id === "H_ant" && target.available)) {
      requestPreviewQuantity("H_ant");
    }
  }, [quickPreviewTargets, requestPreviewQuantity]);

  const openAnalyzeCenterTab = useCallback(
    (
      selection?: Parameters<typeof _model.openAnalyze>[0],
      debug?: { nodeId?: string; resultWorkspaceId?: string; source?: string },
    ) => {
      setActiveCoreTab("Results");
      setActiveContextualTab(null);
      _model.openAnalyzeSurface({
        selection,
        resultWorkspaceId: debug?.resultWorkspaceId,
        source: debug?.source ?? "run-control-room",
      });
      if (pathname !== WORKSPACE_ANALYZE_HREF) {
        recordFrontendDebugEvent("run-control-room", "router_replace_analyze_tab", debug ?? {});
        router.replace(WORKSPACE_ANALYZE_HREF);
      }
    },
    [_model.openAnalyzeSurface, pathname, router, setActiveContextualTab, setActiveCoreTab],
  );

  const handleSelectModelNode = useCallback((nodeId: string) => {
    _model.selectSidebarNode(nodeId);
    setSelectedObjectId(resolveSelectedObjectId(nodeId, _model.modelBuilderGraph));
    const analyzeTarget = parseAnalyzeTreeNode(nodeId);
    if (analyzeTarget) {
      openAnalyzeCenterTab(analyzeTarget, { nodeId, source: "analyze_target" });
      return;
    }
    const resultContext = parseResultNodeContext(nodeId);
    if (nodeId.startsWith("res-analysis-")) {
      openAnalyzeCenterTab(undefined, {
        nodeId,
        resultWorkspaceId: nodeId.replace("res-analysis-", ""),
        source: "result_workspace",
      });
      return;
    }
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
      openAnalyzeCenterTab(undefined, { nodeId, source: "results_node" });
      return;
    }
    if (_viewport.sidebarCollapsed) {
      _viewport.setSidebarCollapsed(false);
    }
    if (nodeId === "antennas" || nodeId.startsWith("ant-")) {
      maybePreviewAntennaField();
    }
  }, [
    _model,
    setSelectedObjectId,
    _viewport.sidebarCollapsed,
    _viewport.setSidebarCollapsed,
    maybePreviewAntennaField,
    openAnalyzeCenterTab,
  ]);

  const handleAddAntenna = useCallback((kind: "MicrostripAntenna" | "CPWAntenna") => {
    const nextModule = makeRibbonAntenna(kind, _cmd.scriptBuilderCurrentModules);
    _model.setScriptBuilderCurrentModules((prev) => [...prev, nextModule]);
    if (_viewport.sidebarCollapsed) {
      _viewport.setSidebarCollapsed(false);
    }
    _model.selectSidebarNode(`ant-${nextModule.name}`);
    setSelectedObjectId(null);
    maybePreviewAntennaField();
  }, [_cmd.scriptBuilderCurrentModules, _model, _viewport.sidebarCollapsed, _viewport.setSidebarCollapsed, setSelectedObjectId, maybePreviewAntennaField]);

  const handleCreateVisualizationPreset = useCallback(() => {
    const ref = _model.createVisualizationPreset("project");
    const nodeId = buildVisualizationPresetNodeId(ref.source, ref.preset_id);
    handleSelectModelNode(nodeId);
    _model.applyVisualizationPreset(ref);
  }, [_model.createVisualizationPreset, _model.applyVisualizationPreset, handleSelectModelNode]);

  const handleObjectAddInteraction = useCallback(
    (objectId: string, kind: ScriptBuilderMagneticInteractionKind) => {
      if (!objectId) return;
      _model.setSceneDocument((prev) => {
        if (!prev) return prev;
        const target = prev.objects.find(
          (object) => object.id === objectId || object.name === objectId,
        );
        if (!target) return prev;
        const material = prev.materials.find((entry) => entry.id === target.material_ref);
        const currentStack = ensureObjectPhysicsStack(
          target.physics_stack,
          material?.properties.Dind ?? null,
        );
        const nextStack = upsertObjectInteraction(currentStack, kind, { enabled: true });
        const nextObjectName = target.name || target.id;
        return {
          ...prev,
          objects: prev.objects.map((object) =>
            object.id === target.id || object.name === nextObjectName
              ? { ...object, physics_stack: nextStack }
              : object,
          ),
          materials:
            kind === "interfacial_dmi"
              ? prev.materials.map((entry) =>
                  entry.id === target.material_ref
                    ? {
                        ...entry,
                        properties: {
                          ...entry.properties,
                          Dind:
                            entry.properties.Dind != null
                              ? entry.properties.Dind
                              : Number(nextStack.find((item) => item.kind === "interfacial_dmi")?.params?.dind ?? 1e-3),
                        },
                      }
                    : entry,
                )
              : prev.materials,
        };
      });
      if (_viewport.sidebarCollapsed) {
        _viewport.setSidebarCollapsed(false);
      }
      setSelectedObjectId(objectId);
      _model.selectSidebarNode(`physobj-${objectId}`);
    },
    [_model, setSelectedObjectId, _viewport.sidebarCollapsed, _viewport.setSidebarCollapsed],
  );

  const handleAssignMagnetizationPreset = useCallback(
    (objectId: string, kind: MagneticPresetKind) => {
      _viewport.handleViewModeChange("3D");
      setSelectedObjectId(objectId);
      _model.selectSidebarNode(`mag-${objectId}`);
      _model.setSceneDocument((prev) => {
        if (!prev) return prev;
        const target = prev.objects.find(
          (object) => object.id === objectId || object.name === objectId,
        );
        if (!target) return prev;
        const magnetizationRef = target.magnetization_ref;
        if (!magnetizationRef) return prev;
        const descriptor = MAGNETIC_PRESET_CATALOG.find((entry) => entry.kind === kind);
        if (!descriptor) return prev;
        return assignMagneticPreset(prev, magnetizationRef, descriptor, {
          objectId,
        });
      });
    },
    [_model, setSelectedObjectId, _viewport.handleViewModeChange],
  );

  const handleSetTransformScope = useCallback(
    (scope: "camera" | "object" | "texture") => {
      _viewport.handleViewModeChange("3D");
      const nextScope = scope === "camera" ? null : scope;
      _model.setActiveTransformScope(nextScope);
      _model.setSceneDocument((prev) =>
        prev
          ? {
              ...prev,
              editor: {
                ...prev.editor,
                active_transform_scope: nextScope,
              },
            }
          : prev,
      );
    },
    [_model.setActiveTransformScope, _model.setSceneDocument, _viewport.handleViewModeChange],
  );

  const handleSetTextureTransformMode = useCallback(
    (objectId: string, mode: "translate" | "rotate" | "scale") => {
      _viewport.handleViewModeChange("3D");
      setSelectedObjectId(objectId);
      _model.selectSidebarNode(`mag-${objectId}-transform`);
      _model.setActiveTransformScope("texture");
      _model.setSceneDocument((prev) => {
        if (!prev) return prev;
        const target = prev.objects.find(
          (object) => object.id === objectId || object.name === objectId,
        );
        if (!target) return prev;
        const magnetizationRef = target.magnetization_ref;
        if (!magnetizationRef) return prev;
        const asset = prev.magnetization_assets.find(
          (entry) => entry.id === magnetizationRef,
        );
        let next = prev;
        if (asset?.kind !== "preset_texture") {
          const fallback = MAGNETIC_PRESET_CATALOG.find((entry) => entry.kind === "uniform");
          if (fallback) {
            next = assignMagneticPreset(next, magnetizationRef, fallback, {
              objectId,
            });
          }
        }
        return {
          ...next,
          editor: {
            ...next.editor,
            active_transform_scope: "texture",
            gizmo_mode: mode,
          },
        };
      });
    },
    [_model, setSelectedObjectId, _viewport.handleViewModeChange],
  );

  // Study pipeline operations
  const commitStudyDocument = useCallback((next: StudyPipelineDocument, nextSelectedNodeId?: string | null) => {
    const compiled = materializeStudyPipeline(next);
    _model.setStudyPipeline(next);
    _model.setStudyStages(compiled.stages);
    syncStudyRuntimeState({ setRunUntilInput: _cmd.setRunUntilInput, setSolverSettings: _model.setSolverSettings }, compiled.stages);
    if (nextSelectedNodeId) {
      handleSelectModelNode(nextSelectedNodeId);
    }
  }, [_cmd.setRunUntilInput, _model.setSolverSettings, _model.setStudyPipeline, _model.setStudyStages, handleSelectModelNode]);

  const handleStudyAddPrimitive = useCallback((
    kind: StudyPrimitiveStageKind,
    placement: "append" | "before" | "after",
  ) => {
    const nextNode = createPrimitiveNode(kind);
    const anchorId = resolveStudyAnchorNodeId(authoringStudyDocument, selectedSidebarNodeId);
    const nextDocument =
      !anchorId || placement === "append"
        ? appendNode(authoringStudyDocument, nextNode)
        : insertNodeNear(authoringStudyDocument, anchorId, placement, nextNode);
    commitStudyDocument(nextDocument, buildPipelineStudyStageNodeId(nextNode.id));
  }, [authoringStudyDocument, commitStudyDocument, selectedSidebarNodeId]);

  const handleStudyAddMacro = useCallback((
    kind:
      | "hysteresis_loop"
      | "field_sweep_relax"
      | "field_sweep_relax_snapshot"
      | "relax_run"
      | "relax_eigenmodes"
      | "parameter_sweep"
      | "current_sweep_run"
      | "dc_bias_plus_rf_probe",
    placement: "append" | "before" | "after",
  ) => {
    const nextNode = createMacroNode(kind);
    const anchorId = resolveStudyAnchorNodeId(authoringStudyDocument, selectedSidebarNodeId);
    const nextDocument =
      !anchorId || placement === "append"
        ? appendNode(authoringStudyDocument, nextNode)
        : insertNodeNear(authoringStudyDocument, anchorId, placement, nextNode);
    commitStudyDocument(nextDocument, buildPipelineStudyStageNodeId(nextNode.id));
  }, [authoringStudyDocument, commitStudyDocument, selectedSidebarNodeId]);

  const handleStudyDuplicateSelected = useCallback(() => {
    const anchorId = resolveStudyAnchorNodeId(authoringStudyDocument, selectedSidebarNodeId);
    if (!anchorId) return;
    commitStudyDocument(duplicateNode(authoringStudyDocument, anchorId));
  }, [authoringStudyDocument, commitStudyDocument, selectedSidebarNodeId]);

  const handleStudyToggleSelectedEnabled = useCallback(() => {
    const anchorId = resolveStudyAnchorNodeId(authoringStudyDocument, selectedSidebarNodeId);
    if (!anchorId) return;
    commitStudyDocument(toggleNodeEnabled(authoringStudyDocument, anchorId));
  }, [authoringStudyDocument, commitStudyDocument, selectedSidebarNodeId]);

  const handleAddResultAnalysis = useCallback(
    (kind: ResultAnalysisKind) => {
      const quantityId = _viewport.requestedPreviewQuantity;
      const quantityLabel = _viewport.quantityDescriptor?.label ?? quantityId;
      const quantityBadge = _viewport.quantityDescriptor?.unit ?? null;
      const id = _model.addResultWorkspaceEntry(buildResultWorkspaceEntryInput(kind, {
        now: Date.now(),
        quantityId,
        quantityLabel,
        quantityBadge,
      }));
      openAnalyzeCenterTab(undefined, {
        resultWorkspaceId: id,
        source: "create_result_entry",
      });
    },
    [_model.addResultWorkspaceEntry, _viewport.requestedPreviewQuantity, _viewport.quantityDescriptor, openAnalyzeCenterTab],
  );

  return {
    selectedAntennaName,
    openAnalyzeCenterTab,
    handleSelectModelNode,
    handleAddAntenna,
    handleCreateVisualizationPreset,
    handleObjectAddInteraction,
    handleAssignMagnetizationPreset,
    handleSetTransformScope,
    handleSetTextureTransformMode,
    handleStudyAddPrimitive,
    handleStudyAddMacro,
    handleStudyDuplicateSelected,
    handleStudyToggleSelectedEnabled,
    handleAddResultAnalysis,
  };
}
