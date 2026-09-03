import type { SliceAirboxRenderMode } from "@/src/features/slice2d";
import {
  defaultMeshEntityViewState,
  type FemMeshPart,
  type MeshEntityRenderPassState,
  type MeshEntityViewStateMap,
} from "@/lib/session/types";

function renderPassesFromSliceAirboxMode(
  renderMode: SliceAirboxRenderMode,
): MeshEntityRenderPassState {
  return {
    surface: renderMode === "surface" || renderMode === "surface+edges",
    wireframe: renderMode === "wireframe" || renderMode === "surface+edges",
    points: renderMode === "points",
  };
}

function isAirboxPart(part: Pick<FemMeshPart, "role">): boolean {
  return part.role === "air" || part.role === "outer_boundary";
}

export interface Slice2DAirboxViewStateInput {
  meshParts: FemMeshPart[];
  meshEntityViewState: MeshEntityViewStateMap;
  visible: boolean;
  renderMode: SliceAirboxRenderMode;
}

export function resolveSlice2DAirboxViewState({
  meshParts,
  meshEntityViewState,
  visible,
  renderMode,
}: Slice2DAirboxViewStateInput): MeshEntityViewStateMap {
  if (!meshParts.some(isAirboxPart)) {
    return meshEntityViewState;
  }

  const renderPasses = renderPassesFromSliceAirboxMode(renderMode);
  const next: MeshEntityViewStateMap = { ...meshEntityViewState };

  for (const part of meshParts) {
    if (!isAirboxPart(part)) continue;
    const current = next[part.id] ?? defaultMeshEntityViewState(part);
    next[part.id] = {
      ...current,
      visible,
      geometryVisible: visible,
      renderMode,
      renderPasses,
    };
  }

  return next;
}
