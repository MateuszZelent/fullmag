import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  MeshEntityViewStateMap,
  SceneDocument,
  VisualizationPreset,
  VisualizationPresetRef,
} from "@/lib/session/types";
import type { ObjectViewMode } from "../shared";
import {
  DEFAULT_AIR_MESH_OPACITY,
  normalizeVisualizationPresetRef,
  samePersistedMeshEntityViewState,
  sameVisualizationPresetRef,
  sameVisualizationPresets,
  serializeMeshEntityViewStateForScene,
} from "../controlRoomUtils";
import type { ViewportVisualizationState } from "../visualizationStateSync";

export function useSceneEditorDraftSync({
  activeTransformScope,
  activeVisualizationPresetRef,
  effectiveViewportVisualizationState,
  focusedEntityId,
  meshEntityViewState,
  objectViewMode,
  projectVisualizationPresets,
  selectedEntityId,
  selectedObjectId,
  setSceneDocumentDraft,
}: {
  activeTransformScope: "object" | "texture" | null;
  activeVisualizationPresetRef: VisualizationPresetRef | null;
  effectiveViewportVisualizationState: ViewportVisualizationState;
  focusedEntityId: string | null;
  meshEntityViewState: MeshEntityViewStateMap;
  objectViewMode: ObjectViewMode;
  projectVisualizationPresets: VisualizationPreset[];
  selectedEntityId: string | null;
  selectedObjectId: string | null;
  setSceneDocumentDraft: Dispatch<SetStateAction<SceneDocument | null>>;
}) {
  useEffect(() => {
    const persistedMeshEntityViewState = serializeMeshEntityViewStateForScene(meshEntityViewState);
    const normalizedActivePresetRef = normalizeVisualizationPresetRef(
      activeVisualizationPresetRef,
    );
    setSceneDocumentDraft((previousScene) => {
      if (!previousScene) {
        return previousScene;
      }
      const previousEditor = previousScene.editor;
      const nextAirMeshOpacity = Number.isFinite(effectiveViewportVisualizationState.airMeshOpacity)
        ? effectiveViewportVisualizationState.airMeshOpacity
        : DEFAULT_AIR_MESH_OPACITY;
      if (
        previousEditor.selected_object_id === selectedObjectId &&
        previousEditor.selected_entity_id === selectedEntityId &&
        previousEditor.focused_entity_id === focusedEntityId &&
        previousEditor.object_view_mode === objectViewMode &&
        previousEditor.vector_domain_filter === effectiveViewportVisualizationState.femVectorDomainFilter &&
        previousEditor.ferromagnet_visibility_mode === effectiveViewportVisualizationState.femFerromagnetVisibilityMode &&
        previousEditor.active_transform_scope === activeTransformScope &&
        previousEditor.air_mesh_visible === effectiveViewportVisualizationState.airMeshVisible &&
        previousEditor.air_mesh_opacity === nextAirMeshOpacity &&
        sameVisualizationPresets(
          previousEditor.visualization_presets,
          projectVisualizationPresets,
        ) &&
        sameVisualizationPresetRef(
          previousEditor.active_visualization_preset_ref,
          normalizedActivePresetRef,
        ) &&
        samePersistedMeshEntityViewState(
          previousEditor.mesh_entity_view_state,
          persistedMeshEntityViewState,
        )
      ) {
        return previousScene;
      }
      return {
        ...previousScene,
        editor: {
          ...previousEditor,
          selected_object_id: selectedObjectId,
          selected_entity_id: selectedEntityId,
          focused_entity_id: focusedEntityId,
          object_view_mode: objectViewMode,
          vector_domain_filter: effectiveViewportVisualizationState.femVectorDomainFilter,
          ferromagnet_visibility_mode: effectiveViewportVisualizationState.femFerromagnetVisibilityMode,
          active_transform_scope: activeTransformScope,
          air_mesh_visible: effectiveViewportVisualizationState.airMeshVisible,
          air_mesh_opacity: nextAirMeshOpacity,
          mesh_entity_view_state: persistedMeshEntityViewState,
          visualization_presets: projectVisualizationPresets,
          active_visualization_preset_ref: normalizedActivePresetRef,
        },
      };
    });
  }, [
    activeTransformScope,
    activeVisualizationPresetRef,
    effectiveViewportVisualizationState.airMeshOpacity,
    effectiveViewportVisualizationState.airMeshVisible,
    effectiveViewportVisualizationState.femFerromagnetVisibilityMode,
    effectiveViewportVisualizationState.femVectorDomainFilter,
    focusedEntityId,
    meshEntityViewState,
    objectViewMode,
    projectVisualizationPresets,
    selectedEntityId,
    selectedObjectId,
    setSceneDocumentDraft,
  ]);
}
