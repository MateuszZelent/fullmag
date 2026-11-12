import type { VisualizationStatePatch, VisualizationStateResource } from "@/kernel/api/apiTypes";

type PlanarState = NonNullable<VisualizationStateResource["planar"]>;
type PlanarPatch = NonNullable<VisualizationStatePatch["planar"]>;

function sourceChanges(current: PlanarState, patch: PlanarPatch): boolean {
  const next = patch.source;
  if (!next) return false;
  if (next.kind !== current.source.kind) return true;
  return next.kind === "monitor" && current.source.kind === "monitor" &&
    next.monitor_id !== current.source.monitor_id;
}

function planeChanges(current: PlanarState, patch: PlanarPatch): boolean {
  const plane = patch.default_slice?.plane;
  return plane !== undefined && plane !== null && plane !== current.default_slice.plane;
}

/**
 * A crop lives in the u/v axes of one plane (Review Focus 3): a patch that
 * changes the plane or the source clears it in the same request, unless it
 * sets a new crop itself. The backend applies the same rule; sending it
 * keeps the optimistic state from requesting the new plane with a stale
 * window.
 */
export function withStalePlanarCropCleared<TPatch extends PlanarPatch>(
  current: PlanarState | null | undefined,
  patch: TPatch,
): TPatch {
  if (!current?.crop || patch.crop !== undefined) return patch;
  return sourceChanges(current, patch) || planeChanges(current, patch)
    ? { ...patch, crop: null }
    : patch;
}
