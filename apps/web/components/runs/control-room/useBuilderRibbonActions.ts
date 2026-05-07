import { useCallback, useEffect } from "react";
import type { PrimitiveKind } from "@/features/geometry-builder/model/types";
import { useGeometryBuilderStore } from "@/features/geometry-builder/store/useGeometryBuilderStore";
import { useSelectedObjectId, useSelectionActions } from "@/features/selection";
import { createScenePrimitiveAuthoringUpdate } from "@/features/geometry-builder/scene/scenePrimitiveAuthoring";
import { useSceneAuthoringActions } from "@/src/hooks/resources/useSceneDocument";
import type {
  ModelContextValue,
  ViewportContextValue,
  WorkspaceMode,
} from "./context-hooks";
import {
  resetSceneEditorToCameraFirst,
  shouldForceCameraFirstViewport,
} from "./workspaceViewportGuards";

export function useBuilderRibbonActions({
  activeCoreTab,
  currentStage,
  femDiscretization,
  model,
  setActiveCoreTab,
  setRightInspectorOpen,
  viewport,
  workspaceStage,
}: {
  activeCoreTab: string | null;
  currentStage: string;
  femDiscretization: boolean;
  model: ModelContextValue;
  setActiveCoreTab: (tab: string) => void;
  setRightInspectorOpen: (open: boolean) => void;
  viewport: ViewportContextValue;
  workspaceStage: WorkspaceMode;
}) {
  const builderModeEnabled = useGeometryBuilderStore((state) => state.builderMode.enabled);
  const builderViewportTool = useGeometryBuilderStore((state) => state.viewportTool);
  const builderSelection = useGeometryBuilderStore((state) => state.builderSelection);
  const validateBuilderAll = useGeometryBuilderStore((state) => state.validateAll);
  const setBuilderViewportTool = useGeometryBuilderStore((state) => state.setViewportTool);
  const requestBuilderFocusSelected = useGeometryBuilderStore(
    (state) => state.requestFocusSelected,
  );
  const requestBuilderFrameAll = useGeometryBuilderStore(
    (state) => state.requestFrameAll,
  );
  const setBuilderPrimitiveTransform = useGeometryBuilderStore((state) => state.setPrimitiveTransform);
  const getBuilderPrimitive = useGeometryBuilderStore((state) => state.getPrimitive);
  const getBackendBuildBlockedReason = useGeometryBuilderStore(
    (state) => state.getBackendBuildBlockedReason,
  );
  const builderUniverseOrigin = useGeometryBuilderStore((state) => state.graph.universe.origin);
  const toggleBuilderSnap = useGeometryBuilderStore((state) => state.toggleSnap);
  const disableBuilderMode = useGeometryBuilderStore((state) => state.disableBuilder);
  const sceneAuthoring = useSceneAuthoringActions();
  const selectedObjectId = useSelectedObjectId();
  const {
    setFocusedEntityId,
    setSelectedEntityId,
    setSelectedObjectId,
    setSelectedSidebarNodeId,
  } = useSelectionActions();
  const selectedBuilderPrimitiveId =
    builderSelection.type === "primitive" ? builderSelection.id : null;

  useEffect(() => {
    const geometryTabSelected = activeCoreTab === "Geometry" || currentStage === "build";
    if (!geometryTabSelected && builderModeEnabled) {
      disableBuilderMode();
    }
    if (!geometryTabSelected) {
      return;
    }
    if (viewport.effectiveViewMode !== "3D") {
      viewport.handleViewModeChange("3D");
    }
  }, [
    activeCoreTab,
    builderModeEnabled,
    currentStage,
    disableBuilderMode,
    viewport.effectiveViewMode,
    viewport.handleViewModeChange,
  ]);

  useEffect(() => {
    if (!shouldForceCameraFirstViewport({
      workspaceMode: workspaceStage,
      activeCoreTab,
      effectiveViewMode: viewport.effectiveViewMode,
    })) {
      return;
    }
    if (model.activeTransformScope !== null) {
      model.setActiveTransformScope(null);
    }
    if (model.sceneDocument?.editor.active_transform_scope != null || model.sceneDocument?.editor.gizmo_mode != null) {
      model.setSceneDocument((previous) => resetSceneEditorToCameraFirst(previous));
    }
    if (builderViewportTool !== "camera") {
      setBuilderViewportTool("camera");
    }
  }, [
    activeCoreTab,
    builderViewportTool,
    model.activeTransformScope,
    model.sceneDocument,
    model.setActiveTransformScope,
    model.setSceneDocument,
    setBuilderViewportTool,
    viewport.effectiveViewMode,
    workspaceStage,
  ]);

  const handleBuilderAddPrimitive = useCallback((kind: PrimitiveKind) => {
    setActiveCoreTab("Geometry");
    if (builderModeEnabled) {
      disableBuilderMode();
    }
    if (viewport.effectiveViewMode !== "3D") {
      viewport.handleViewModeChange("3D");
    }
    const referenceOverlay =
      selectedObjectId
        ? model.objectOverlays.find((overlay) => overlay.id === selectedObjectId) ?? null
        : null;
    const fallbackOverlay = model.objectOverlays[0] ?? null;
    const prev = model.sceneDocument;
    if (!prev) return;
    let update: ReturnType<typeof createScenePrimitiveAuthoringUpdate>;
    try {
      update = createScenePrimitiveAuthoringUpdate({
        scene: prev,
        kind,
        placementOverlay: referenceOverlay ?? fallbackOverlay,
      });
    } catch (error) {
      console.warn("scene primitive creation is not available", error);
      return;
    }
    model.setSceneDocument(update.scene);
    void sceneAuthoring
      .createObject(update.createObjectRequest)
      .then(() => sceneAuthoring.updateSceneMergePatch(update.postCreateMergePatch))
      .then((committedScene) => {
        model.setSceneDocument(committedScene);
      })
      .catch((error) => {
        console.error("failed to commit authoring primitive to backend scene", error);
        void sceneAuthoring
          .updateSceneMergePatch(update.mergePatch)
          .then((committedScene) => {
            model.setSceneDocument(committedScene);
          })
          .catch((fallbackError) => {
            console.error("failed to fallback commit authoring primitive merge patch", fallbackError);
            model.setSceneDocument(prev);
          });
      });
    if (viewport.sidebarCollapsed) {
      viewport.setSidebarCollapsed(false);
    }
    setSelectedSidebarNodeId(`geo-${update.selectedObjectId}`);
    setSelectedObjectId(update.selectedObjectId);
    setSelectedEntityId(null);
    setFocusedEntityId(null);
    model.requestFocusObject(update.selectedObjectId);
    setRightInspectorOpen(true);
    model.setActiveTransformScope("object");
    setBuilderViewportTool("move");
  }, [
    builderModeEnabled,
    disableBuilderMode,
    model,
    sceneAuthoring,
    setActiveCoreTab,
    setBuilderViewportTool,
    setRightInspectorOpen,
    viewport,
  ]);

  const handleBuilderSetViewportMode = useCallback((mode: "camera" | "manipulate") => {
    setBuilderViewportTool(mode === "camera" ? "camera" : selectedBuilderPrimitiveId ? "move" : "select");
  }, [selectedBuilderPrimitiveId, setBuilderViewportTool]);

  const handleBuilderSetTransformTool = useCallback((tool: "move" | "rotate" | "scale") => {
    setBuilderViewportTool(tool);
    if (activeCoreTab === "Geometry" && selectedObjectId) {
      model.setActiveTransformScope("object");
      model.setSceneDocument((prev) =>
        prev
          ? {
              ...prev,
              editor: {
                ...prev.editor,
                active_transform_scope: "object",
                gizmo_mode: tool === "move" ? "translate" : tool,
              },
            }
          : prev,
      );
    }
  }, [activeCoreTab, model, selectedObjectId, setBuilderViewportTool]);

  const handleBuilderCenterInUniverse = useCallback((primitiveId: string) => {
    const primitive = getBuilderPrimitive(primitiveId);
    if (!primitive) return;
    setBuilderPrimitiveTransform(primitiveId, {
      ...primitive.transform,
      translation: [...builderUniverseOrigin],
    });
  }, [builderUniverseOrigin, getBuilderPrimitive, setBuilderPrimitiveTransform]);

  const handleBuilderBuildGeometry = useCallback(() => {
    setRightInspectorOpen(true);
  }, [setRightInspectorOpen]);

  const handleBuilderBuildMesh = useCallback(async () => {
    const backendBlockedReason = getBackendBuildBlockedReason(Boolean(femDiscretization));
    if (backendBlockedReason || !femDiscretization || !model.sceneDocument?.objects.length) {
      setRightInspectorOpen(true);
      return;
    }
    try {
      await model.handleStudyDomainMeshGenerate("geometry_scene_build_mesh");
    } catch {
      // Mesh pipeline already surfaces command errors in the shared command state.
    }
  }, [femDiscretization, getBackendBuildBlockedReason, model, setRightInspectorOpen]);

  const handleBuilderBuildAll = useCallback(() => {
    void handleBuilderBuildMesh();
  }, [
    handleBuilderBuildMesh,
  ]);

  const handleBuilderValidateGeometry = useCallback(() => {
    void validateBuilderAll();
    setRightInspectorOpen(true);
  }, [setRightInspectorOpen, validateBuilderAll]);

  const handleBuilderFocusSelected = useCallback(() => {
    requestBuilderFocusSelected();
    setBuilderViewportTool("camera");
  }, [requestBuilderFocusSelected, setBuilderViewportTool]);

  const handleBuilderFrameAll = useCallback(() => {
    requestBuilderFrameAll();
    setBuilderViewportTool("camera");
  }, [requestBuilderFrameAll, setBuilderViewportTool]);

  return {
    builderModeEnabled,
    handleBuilderAddPrimitive,
    handleBuilderBuildAll,
    handleBuilderBuildGeometry,
    handleBuilderBuildMesh,
    handleBuilderCenterInUniverse,
    handleBuilderFocusSelected,
    handleBuilderFrameAll,
    handleBuilderSetTransformTool,
    handleBuilderSetViewportMode,
    handleBuilderValidateGeometry,
    toggleBuilderSnap,
  };
}
