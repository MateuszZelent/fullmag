import { startTransition, useCallback, useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  MeshEntityViewStateMap,
  SceneDocument,
  VisualizationPreset,
  VisualizationPresetFdmState,
  VisualizationPresetRef,
  VisualizationPresetSource,
} from "../../../../lib/session/types";
import type {
  ClipAxis,
  FemArrowColorMode,
  FemFerromagnetVisibilityMode,
  FemVectorDomainFilter,
  RenderMode,
} from "@/components/preview/FemMeshView3D";
import type {
  ObjectViewMode,
  SlicePlane,
  VectorComponent,
  ViewportMode,
} from "../shared";
import type { CapabilityMap, VisualizationStatePatch } from "@/src/api/types";
import { isFemDiscretization } from "@/src/domain/capabilities";
import {
  cloneVisualizationPreset,
  createDefaultVisualizationPreset,
  nextVisualizationPresetName,
} from "../visualizationPresets";
import {
  normalizePersistedMeshEntityViewState,
  sameVisualizationPresetRef,
  sameVisualizationPresets,
  serializeMeshEntityViewStateForScene,
} from "../controlRoomUtils";
import {
  visualizationPatchForClip,
  visualizationPatchForOpacity,
  visualizationPatchForRenderMode,
} from "../visualizationStateSync";
import { useVisualizationStore, selectEffectiveViewportVizState } from "@/features/visualization/store/useVisualizationStore";
import { useShallow } from "zustand/react/shallow";

export interface UseVisualizationPresetsParams {
  /* Current UI state for building presets */
  effectiveViewMode: ViewportMode;
  isFemBackend: boolean;
  domainCapabilities?: CapabilityMap | null;
  requestedPreviewQuantity: string;
  requestedPreviewMaxPoints: number;
  objectViewMode: ObjectViewMode;
  meshEntityViewState: MeshEntityViewStateMap;
  fdmVisualizationSettings: VisualizationPresetFdmState;
  component: VectorComponent;
  plane: SlicePlane;
  sliceIndex: number;
  selectedQuantity: string;

  /* Data-plane cache for fast-path quantity switching */
  cachedFieldQuantities: ReadonlySet<string>;
  handleViewModeChange: (mode: string) => void;

  /* Preset data */
  projectVisualizationPresets: VisualizationPreset[];
  localVisualizationPresets: VisualizationPreset[];
  activeVisualizationPresetRef: VisualizationPresetRef | null;

  /* Flags */
  previewControlsActive: boolean;

  /* Refs */
  lastAppliedVisualizationPresetRef: MutableRefObject<string | null>;

  /* Setters for CRUD */
  setSceneDocumentDraft: Dispatch<SetStateAction<SceneDocument | null>>;
  setLocalVisualizationPresets: Dispatch<SetStateAction<VisualizationPreset[]>>;
  setActiveVisualizationPresetRef: Dispatch<SetStateAction<VisualizationPresetRef | null>>;

  /* Setters for apply */
  setSelectedQuantity: Dispatch<SetStateAction<string>>;
  setComponent: Dispatch<SetStateAction<VectorComponent>>;
  setPlane: Dispatch<SetStateAction<SlicePlane>>;
  setSliceIndex: Dispatch<SetStateAction<number>>;
  setObjectViewMode: Dispatch<SetStateAction<ObjectViewMode>>;
  setMeshEntityViewState: Dispatch<SetStateAction<MeshEntityViewStateMap>>;
  setFdmVisualizationSettings: (v: VisualizationPresetFdmState) => void;

  /* Callback */
  patchDisplay: (patch: VisualizationStatePatch) => Promise<void>;
}

export function useVisualizationPresets(params: UseVisualizationPresetsParams) {
  const {
    effectiveViewMode,
    isFemBackend,
    domainCapabilities,
    requestedPreviewQuantity,
    requestedPreviewMaxPoints,
    objectViewMode,
    meshEntityViewState,
    fdmVisualizationSettings,
    component,
    plane,
    sliceIndex,
    selectedQuantity,
    cachedFieldQuantities,
    handleViewModeChange,
    projectVisualizationPresets,
    localVisualizationPresets,
    activeVisualizationPresetRef,
    previewControlsActive,
    lastAppliedVisualizationPresetRef,
    setSceneDocumentDraft,
    setLocalVisualizationPresets,
    setActiveVisualizationPresetRef,
    setSelectedQuantity,
    setComponent,
    setPlane,
    setSliceIndex,
    setObjectViewMode,
    setMeshEntityViewState,
    setFdmVisualizationSettings,
    patchDisplay,
  } = params;

  // Read effective viz state from the store (no more prop drilling).
  const effectiveViz = useVisualizationStore(useShallow(selectEffectiveViewportVizState));
  const {
    meshRenderMode, meshOpacity, meshClipEnabled, meshClipAxis, meshClipPos,
    meshShowArrows, femArrowColorMode, femArrowMonoColor, femArrowAlpha,
    femArrowLengthScale, femArrowThickness, femVectorDomainFilter,
    femFerromagnetVisibilityMode, airMeshVisible, airMeshOpacity,
  } = effectiveViz;
  const femDiscretization = domainCapabilities
    ? isFemDiscretization(domainCapabilities)
    : isFemBackend;

  const buildVisualizationPresetFromCurrent = useCallback(
    (name: string, id?: string): VisualizationPreset => {
      const mode: VisualizationPreset["mode"] = effectiveViewMode === "2D" ? "2D" : "3D";
      const domain: VisualizationPreset["domain"] = femDiscretization ? "fem" : "fdm";
      const now = Date.now();
      const basePreset = createDefaultVisualizationPreset({
        id,
        name,
        quantity: requestedPreviewQuantity,
        domain,
        mode,
        nowUnixMs: now,
      });
      return cloneVisualizationPreset(basePreset, {
        quantity: requestedPreviewQuantity,
        mode,
        domain,
        fem: {
          render_mode: meshRenderMode,
          opacity: meshOpacity,
          clip_enabled: meshClipEnabled,
          clip_axis: meshClipAxis,
          clip_pos: meshClipPos,
          show_arrows: meshShowArrows,
          max_points: requestedPreviewMaxPoints,
          arrow_color_mode: femArrowColorMode,
          arrow_mono_color: femArrowMonoColor,
          arrow_alpha: femArrowAlpha,
          arrow_length_scale: femArrowLengthScale,
          arrow_thickness: femArrowThickness,
          object_view_mode: objectViewMode,
          vector_domain_filter: femVectorDomainFilter,
          ferromagnet_visibility_mode: femFerromagnetVisibilityMode,
          air_mesh_visible: airMeshVisible,
          air_mesh_opacity: airMeshOpacity,
          mesh_entity_view_state: serializeMeshEntityViewStateForScene(meshEntityViewState),
        },
        fdm: {
          ...fdmVisualizationSettings,
        },
        two_d: {
          component,
          plane,
          slice_index: sliceIndex,
        },
        camera: {
          projection: null,
          navigation: null,
          preset: null,
        },
        created_at_unix_ms: now,
        updated_at_unix_ms: now,
      });
    },
    [
      airMeshOpacity,
      airMeshVisible,
      component,
      effectiveViewMode,
      femArrowAlpha,
      femArrowColorMode,
      femArrowLengthScale,
      femArrowMonoColor,
      femArrowThickness,
      femFerromagnetVisibilityMode,
      femVectorDomainFilter,
      fdmVisualizationSettings,
      femDiscretization,
      meshClipAxis,
      meshClipEnabled,
      meshClipPos,
      meshEntityViewState,
      meshOpacity,
      meshRenderMode,
      meshShowArrows,
      objectViewMode,
      plane,
      requestedPreviewMaxPoints,
      requestedPreviewQuantity,
      sliceIndex,
    ],
  );

  const createVisualizationPreset = useCallback(
    (source: VisualizationPresetSource = "project"): VisualizationPresetRef => {
      const existing =
        source === "project" ? projectVisualizationPresets : localVisualizationPresets;
      const preset = buildVisualizationPresetFromCurrent(nextVisualizationPresetName(existing));
      const ref: VisualizationPresetRef = { source, preset_id: preset.id };
      if (source === "project") {
        setSceneDocumentDraft((previousScene) => {
          if (!previousScene) {
            return previousScene;
          }
          return {
            ...previousScene,
            editor: {
              ...previousScene.editor,
              visualization_presets: [...previousScene.editor.visualization_presets, preset],
            },
          };
        });
      } else {
        setLocalVisualizationPresets((previous) => [...previous, preset]);
      }
      setActiveVisualizationPresetRef(ref);
      return ref;
    },
    [
      buildVisualizationPresetFromCurrent,
      localVisualizationPresets,
      projectVisualizationPresets,
    ],
  );

  const updateVisualizationPreset = useCallback(
    (
      ref: VisualizationPresetRef,
      update: (preset: VisualizationPreset) => VisualizationPreset,
    ) => {
      const applyUpdate = (preset: VisualizationPreset): VisualizationPreset =>
        cloneVisualizationPreset(update(preset), {
          updated_at_unix_ms: Date.now(),
        });
      if (ref.source === "project") {
        setSceneDocumentDraft((previousScene) => {
          if (!previousScene) {
            return previousScene;
          }
          const nextPresets = previousScene.editor.visualization_presets.map((preset) =>
            preset.id === ref.preset_id ? applyUpdate(preset) : preset,
          );
          if (
            sameVisualizationPresets(
              previousScene.editor.visualization_presets,
              nextPresets,
            )
          ) {
            return previousScene;
          }
          return {
            ...previousScene,
            editor: {
              ...previousScene.editor,
              visualization_presets: nextPresets,
            },
          };
        });
      } else {
        setLocalVisualizationPresets((previous) =>
          previous.map((preset) =>
            preset.id === ref.preset_id ? applyUpdate(preset) : preset,
          ),
        );
      }
    },
    [],
  );

  const renameVisualizationPreset = useCallback(
    (ref: VisualizationPresetRef, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) {
        return;
      }
      updateVisualizationPreset(ref, (preset) => ({
        ...preset,
        name: trimmed,
      }));
    },
    [updateVisualizationPreset],
  );

  const duplicateVisualizationPreset = useCallback(
    (
      ref: VisualizationPresetRef,
      targetSource: VisualizationPresetSource = ref.source,
    ): VisualizationPresetRef | null => {
      const sourceList =
        ref.source === "project" ? projectVisualizationPresets : localVisualizationPresets;
      const sourcePreset = sourceList.find((preset) => preset.id === ref.preset_id);
      if (!sourcePreset) {
        return null;
      }
      const targetList =
        targetSource === "project" ? projectVisualizationPresets : localVisualizationPresets;
      const duplicatedName = `${sourcePreset.name} Copy`;
      let duplicatedId = createDefaultVisualizationPreset({
        name: duplicatedName,
        quantity: sourcePreset.quantity,
        domain: sourcePreset.domain,
        mode: sourcePreset.mode,
      }).id;
      while (targetList.some((preset) => preset.id === duplicatedId)) {
        duplicatedId = createDefaultVisualizationPreset({
          name: duplicatedName,
          quantity: sourcePreset.quantity,
          domain: sourcePreset.domain,
          mode: sourcePreset.mode,
        }).id;
      }
      const duplicated = cloneVisualizationPreset(sourcePreset, {
        id: duplicatedId,
        name: duplicatedName,
      });
      if (targetSource === "project") {
        setSceneDocumentDraft((previousScene) => {
          if (!previousScene) {
            return previousScene;
          }
          return {
            ...previousScene,
            editor: {
              ...previousScene.editor,
              visualization_presets: [
                ...previousScene.editor.visualization_presets,
                duplicated,
              ],
            },
          };
        });
      } else {
        setLocalVisualizationPresets((previous) => [...previous, duplicated]);
      }
      const nextRef = { source: targetSource, preset_id: duplicated.id } as const;
      setActiveVisualizationPresetRef(nextRef);
      return nextRef;
    },
    [localVisualizationPresets, projectVisualizationPresets],
  );

  const copyVisualizationPresetToSource = useCallback(
    (
      ref: VisualizationPresetRef,
      targetSource: VisualizationPresetSource,
    ): VisualizationPresetRef | null => duplicateVisualizationPreset(ref, targetSource),
    [duplicateVisualizationPreset],
  );

  const deleteVisualizationPreset = useCallback((ref: VisualizationPresetRef) => {
    if (ref.source === "project") {
      setSceneDocumentDraft((previousScene) => {
        if (!previousScene) {
          return previousScene;
        }
        return {
          ...previousScene,
          editor: {
            ...previousScene.editor,
            visualization_presets: previousScene.editor.visualization_presets.filter(
              (preset) => preset.id !== ref.preset_id,
            ),
          },
        };
      });
    } else {
      setLocalVisualizationPresets((previous) =>
        previous.filter((preset) => preset.id !== ref.preset_id),
      );
    }
    setActiveVisualizationPresetRef((previous) =>
      sameVisualizationPresetRef(previous, ref) ? null : previous,
    );
  }, []);

  const applyVisualizationPreset = useCallback(
    (ref: VisualizationPresetRef, options?: { scopePartIds?: string[] }) => {
      const sourceList =
        ref.source === "project" ? projectVisualizationPresets : localVisualizationPresets;
      const preset = sourceList.find((entry) => entry.id === ref.preset_id);
      if (!preset) {
        return;
      }
      const isScoped = options?.scopePartIds != null && options.scopePartIds.length > 0;
      setActiveVisualizationPresetRef(ref);

      // Global-only fields: quantity, viewMode, 2D settings (always applied)
      if (preset.quantity && preset.quantity !== selectedQuantity) {
        startTransition(() => {
          setSelectedQuantity(preset.quantity);
        });
        // Data-plane fast path: skip control-plane POST if field is already cached.
        if (!cachedFieldQuantities.has(preset.quantity) && previewControlsActive) {
          void patchDisplay({ active_quantity_id: preset.quantity });
        }
      }
      if (preset.mode === "2D") {
        handleViewModeChange("2D");
        setComponent(preset.two_d.component);
        setPlane(preset.two_d.plane);
        setSliceIndex(Math.max(0, Math.trunc(preset.two_d.slice_index)));
      } else {
        handleViewModeChange("3D");
      }

      if (femDiscretization && preset.domain === "fem") {
        setObjectViewMode(preset.fem.object_view_mode);

        if (isScoped) {
          void patchDisplay({
            layers: {
              vectors: {
                visible: preset.fem.show_arrows,
                domain: preset.fem.vector_domain_filter,
              },
            },
            vector_style: {
              color_mode: preset.fem.arrow_color_mode,
              mono_color: preset.fem.arrow_mono_color,
              alpha: preset.fem.arrow_alpha,
              length_scale: preset.fem.arrow_length_scale,
              thickness: preset.fem.arrow_thickness,
              ferromagnet_visibility: preset.fem.ferromagnet_visibility_mode,
            },
            ...(requestedPreviewMaxPoints !== preset.fem.max_points
              ? {
                  max_points: preset.fem.max_points,
                  sampling: {
                    max_points: preset.fem.max_points,
                  },
                }
              : {}),
          });
          // ── Scoped apply: only merge targeted parts' view state ──
          // Global defaults (meshRenderMode, meshOpacity, clip, air) are untouched.
          const presetViewState = normalizePersistedMeshEntityViewState(
            preset.fem.mesh_entity_view_state,
          );
          const scopeSet = new Set(options.scopePartIds);
          setMeshEntityViewState((prev) => {
            const next = { ...prev };
            for (const partId of scopeSet) {
              if (presetViewState[partId]) {
                next[partId] = presetViewState[partId];
              }
            }
            return next;
          });
        } else {
          // ── Global apply (default): set everything ──
          const renderPatch = visualizationPatchForRenderMode(preset.fem.render_mode);
          const opacityPatch = visualizationPatchForOpacity(preset.fem.opacity);
          const clipPatch = visualizationPatchForClip({
            enabled: preset.fem.clip_enabled,
            axis: preset.fem.clip_axis,
            positionPercent: preset.fem.clip_pos,
          });
          void patchDisplay({
            ...renderPatch,
            ...clipPatch,
            layers: {
              ...renderPatch.layers,
              ...opacityPatch.layers,
              vectors: {
                visible: preset.fem.show_arrows,
                domain: preset.fem.vector_domain_filter,
              },
              airbox: {
                visible: preset.fem.air_mesh_visible,
                opacity: Math.max(0, Math.min(100, preset.fem.air_mesh_opacity)) / 100,
              },
            },
            vector_style: {
              color_mode: preset.fem.arrow_color_mode,
              mono_color: preset.fem.arrow_mono_color,
              alpha: preset.fem.arrow_alpha,
              length_scale: preset.fem.arrow_length_scale,
              thickness: preset.fem.arrow_thickness,
              ferromagnet_visibility: preset.fem.ferromagnet_visibility_mode,
            },
            ...(requestedPreviewMaxPoints !== preset.fem.max_points
              ? {
                  max_points: preset.fem.max_points,
                  sampling: {
                    max_points: preset.fem.max_points,
                  },
                }
              : {}),
          });
          setMeshEntityViewState(
            normalizePersistedMeshEntityViewState(preset.fem.mesh_entity_view_state),
          );
        }
      } else if (!femDiscretization && preset.domain === "fdm") {
        setFdmVisualizationSettings({ ...preset.fdm });
      }
    },
    [
      femDiscretization,
      localVisualizationPresets,
      handleViewModeChange,
      previewControlsActive,
      cachedFieldQuantities,
      projectVisualizationPresets,
      requestedPreviewMaxPoints,
      selectedQuantity,
      patchDisplay,
    ],
  );

  useEffect(() => {
    if (!activeVisualizationPresetRef) {
      lastAppliedVisualizationPresetRef.current = null;
      return;
    }
    const key = `${activeVisualizationPresetRef.source}:${activeVisualizationPresetRef.preset_id}`;
    if (lastAppliedVisualizationPresetRef.current === key) {
      return;
    }
    lastAppliedVisualizationPresetRef.current = key;
    applyVisualizationPreset(activeVisualizationPresetRef);
  }, [activeVisualizationPresetRef, applyVisualizationPreset]);

  return {
    buildVisualizationPresetFromCurrent,
    createVisualizationPreset,
    updateVisualizationPreset,
    renameVisualizationPreset,
    duplicateVisualizationPreset,
    copyVisualizationPresetToSource,
    deleteVisualizationPreset,
    applyVisualizationPreset,
  };
}
