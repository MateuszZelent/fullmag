/**
 * Layer D – FEM Viewport Engine: Render Model
 *
 * Pure function that builds the ordered list of RenderLayers
 * from mesh parts + viewport state.  Extracted from the ~100-line
 * `visibleLayers` useMemo inside FemMeshView3D.
 */

import type { FemMeshPart, MeshEntityViewState, MeshEntityViewStateMap } from "../../../lib/session/types";
import { defaultMeshEntityViewState } from "../../../lib/session/types";
import type { ObjectViewMode } from "../../../components/runs/control-room/shared";
import type {
  FemFerromagnetVisibilityMode,
  FemVectorDomainFilter,
} from "@/components/preview/FemMeshView3D";
import type { PartRenderData } from "./femTopologyCache";
import { partMeshTint, partEdgeTint } from "../../../components/preview/fem/femColorUtils";
import { DEFAULT_VIEWPORT_VISUAL_PROFILE } from "../../../lib/profiles/frontendRuntimeProfiles";

/* ── Constants (sourced from viewport visual profile) ── */
const DIMMED_MIN_MAGNETIC = DEFAULT_VIEWPORT_VISUAL_PROFILE.dimmedMinMagnetic;
const DIMMED_MIN_AIR = DEFAULT_VIEWPORT_VISUAL_PROFILE.dimmedMinAir;
const SELECTED_LIFT_MAGNETIC = DEFAULT_VIEWPORT_VISUAL_PROFILE.selectedLiftMagnetic;
const SELECTED_LIFT_AIR = DEFAULT_VIEWPORT_VISUAL_PROFILE.selectedLiftAir;

export interface RenderLayer {
  part: FemMeshPart;
  viewState: MeshEntityViewState;
  boundaryFaceIndices: number[] | null;
  elementIndices: number[] | null;
  nodeMask: Uint8Array | null;
  surfaceFaces: [number, number, number][] | null;
  isPrimaryForCamera: boolean;
  isMagnetic: boolean;
  isSelected: boolean;
  isDimmed: boolean;
  meshColor: string;
  edgeColor: string;
}

export interface BuildVisibleLayersInput {
  meshParts: readonly FemMeshPart[];
  partRenderDataById: ReadonlyMap<string, PartRenderData>;
  meshEntityViewState: MeshEntityViewStateMap;
  objectViewMode: ObjectViewMode;
  vectorDomainFilter: FemVectorDomainFilter;
  ferromagnetVisibilityMode: FemFerromagnetVisibilityMode;
  selectedObjectId: string | null;
  selectedEntityId: string | null;
  focusedEntityId: string | null;
  airSegmentVisible: boolean;
  showArrows?: boolean;
}

/**
 * Build ordered render layers from mesh parts + current viewport state.
 * This is a pure function — call it inside a `useMemo`.
 */
export function buildVisibleLayers(input: BuildVisibleLayersInput): RenderLayer[] {
  const {
    meshParts,
    partRenderDataById,
    meshEntityViewState,
    objectViewMode,
    vectorDomainFilter: effectiveVectorDomainFilter,
    ferromagnetVisibilityMode,
    selectedObjectId,
    selectedEntityId,
    focusedEntityId,
    airSegmentVisible,
    showArrows: showArrows,
  } = input;
  const showArrowsEnabled = showArrows ?? true;

  if (meshParts.length === 0) return [];

  const layers: RenderLayer[] = [];

  const preferredCameraPartId =
    (focusedEntityId && meshParts.some((p) => p.id === focusedEntityId)
      ? focusedEntityId
      : null) ??
    (selectedEntityId && meshParts.some((p) => p.id === selectedEntityId)
      ? selectedEntityId
      : null);

  const selectedPart = preferredCameraPartId
    ? meshParts.find((p) => p.id === preferredCameraPartId) ?? null
    : null;

  const selectedAirPartId = selectedPart?.role === "air" ? selectedPart.id : null;
  const selectedObjectIdForHighlight =
    selectedObjectId ??
    (selectedPart?.role === "magnetic_object" ? selectedPart.object_id : null) ??
    null;

  const hasSelection = Boolean(selectedAirPartId || selectedObjectIdForHighlight || preferredCameraPartId);
  const isAirboxOnly = effectiveVectorDomainFilter === "airbox_only" && showArrowsEnabled;

  for (const part of meshParts) {
    const baseViewState = meshEntityViewState[part.id] ?? defaultMeshEntityViewState(part);

    const isSelected =
      selectedAirPartId != null
        ? part.id === selectedAirPartId
        : selectedObjectIdForHighlight != null
          ? part.object_id === selectedObjectIdForHighlight
          : preferredCameraPartId != null
            ? part.id === preferredCameraPartId
            : false;

    const isDimmed = hasSelection && !isSelected && objectViewMode === "context";

    const viewState: MeshEntityViewState = {
      ...baseViewState,
      renderMode: baseViewState.renderMode,
      opacity: isDimmed
        ? Math.min(baseViewState.opacity, part.role === "air" ? DIMMED_MIN_AIR : DIMMED_MIN_MAGNETIC)
        : isSelected
          ? Math.max(baseViewState.opacity, part.role === "air" ? SELECTED_LIFT_AIR : SELECTED_LIFT_MAGNETIC)
          : baseViewState.opacity,
    };

    const magneticHiddenInAirboxOnly =
      isAirboxOnly && part.role === "magnetic_object" && ferromagnetVisibilityMode === "hide";

    const explicitlySelected =
      (selectedAirPartId != null && part.id === selectedAirPartId) ||
      (preferredCameraPartId != null && part.id === preferredCameraPartId);

    const selectionKeepsVisible =
      isSelected &&
      (part.role !== "air" || (explicitlySelected && airSegmentVisible));

    const visibleForMode =
      objectViewMode === "isolate" && hasSelection
        ? isSelected && (viewState.visible || selectionKeepsVisible)
        : viewState.visible || selectionKeepsVisible;

    if (!visibleForMode || magneticHiddenInAirboxOnly) continue;

    const resolvedViewState: MeshEntityViewState =
      isAirboxOnly && part.role === "magnetic_object" && ferromagnetVisibilityMode === "ghost"
        ? {
            ...viewState,
            opacity: Math.min(viewState.opacity, 22),
          }
        : viewState;

    const data = partRenderDataById.get(part.id);
    layers.push({
      part,
      viewState: resolvedViewState,
      boundaryFaceIndices: data?.boundaryFaceIndices ?? null,
      elementIndices: data?.elementIndices ?? null,
      nodeMask: data?.nodeMask ?? null,
      surfaceFaces: data?.surfaceFaces ?? null,
      isPrimaryForCamera: preferredCameraPartId ? part.id === preferredCameraPartId : false,
      isMagnetic: part.role === "magnetic_object",
      isSelected,
      isDimmed,
      meshColor:
        isAirboxOnly && part.role === "magnetic_object" && ferromagnetVisibilityMode === "ghost"
          ? "#94a3b8"
          : partMeshTint(part),
      edgeColor:
        isAirboxOnly && part.role === "magnetic_object" && ferromagnetVisibilityMode === "ghost"
          ? "#cbd5e1"
          : partEdgeTint(part, isSelected, isDimmed),
    });
  }

  if (layers.length > 0 && !layers.some((l) => l.isPrimaryForCamera)) {
    layers[0] = { ...layers[0], isPrimaryForCamera: true };
  }

  return layers;
}
