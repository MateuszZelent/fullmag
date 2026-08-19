import type { ModeCompositionResource } from "../visualization/ModeCompositionController";

/**
 * A resource identity, not a display/appearance key. The generated v2 path is
 * bound by the facade at the API boundary; phase/style choices never affect it.
 */
export const MODE_COMPOSITION_ACTIVE_RESOURCE_KEY =
  "visualization:mode-composition:active";

export function resolveModeCompositionRevision(
  resource: ModeCompositionResource,
): number | null {
  return Number.isSafeInteger(resource.revision) && resource.revision >= 0
    ? resource.revision
    : null;
}
