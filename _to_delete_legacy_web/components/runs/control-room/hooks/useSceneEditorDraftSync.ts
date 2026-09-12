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
import { useVisualizationStore } from "@/features/visualization/store/useVisualizationStore";
import { selectEffectiveViewportVizState } from "@/features/visualization/store/useVisualizationStore";

export function useSceneEditorDraftSync({
  activeTransformScope,
  activeVisualizationPresetRef,
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
  focusedEntityId: string | null;
  meshEntityViewState: MeshEntityViewStateMap;
  objectViewMode: ObjectViewMode;
  projectVisualizationPresets: VisualizationPreset[];
  selectedEntityId: string | null;
  selectedObjectId: string | null;
  setSceneDocumentDraft: Dispatch<SetStateAction<SceneDocument | null>>;
}) {
  // Read only the 4 fields we need from the effective viz state, via the store.
  const airMeshOpacity = useVisualizationStore((s) => selectEffectiveViewportVizState(s).airMeshOpacity);
  const airMeshVisible = useVisualizationStore((s) => selectEffectiveViewportVizState(s).airMeshVisible);
  const femFerromagnetVisibilityMode = useVisualizationStore((s) => selectEffectiveViewportVizState(s).femFerromagnetVisibilityMode);
  const femVectorDomainFilter = useVisualizationStore((s) => selectEffectiveViewportVizState(s).femVectorDomainFilter);

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
      const nextAirMeshOpacity = Number.isFinite(airMeshOpacity)
        ? airMeshOpacity
        : DEFAULT_AIR_MESH_OPACITY;
      if (
        previousEditor.selected_object_id === selectedObjectId &&
        previousEditor.selected_entity_id === selectedEntityId &&
        previousEditor.focused_entity_id === focusedEntityId &&
        previousEditor.object_view_mode === objectViewMode &&
        previousEditor.vector_domain_filter === femVectorDomainFilter &&
        previousEditor.ferromagnet_visibility_mode === femFerromagnetVisibilityMode &&
        previousEditor.active_transform_scope === activeTransformScope &&
        previousEditor.air_mesh_visible === airMeshVisible &&
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
          vector_domain_filter: femVectorDomainFilter,
          ferromagnet_visibility_mode: femFerromagnetVisibilityMode,
          active_transform_scope: activeTransformScope,
          air_mesh_visible: airMeshVisible,
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
    airMeshOpacity,
    airMeshVisible,
    femFerromagnetVisibilityMode,
    femVectorDomainFilter,
    focusedEntityId,
    meshEntityViewState,
    objectViewMode,
    projectVisualizationPresets,
    selectedEntityId,
    selectedObjectId,
    setSceneDocumentDraft,
  ]);
}
