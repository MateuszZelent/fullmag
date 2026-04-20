/**
 * Maps legacy preview POST endpoints to a single PUT /display.
 * Used during migration to translate old updatePreview("/component", {component: "x"})
 * calls to new updateDisplay({component: "x"}) calls.
 *
 * The current DisplayUpdate schema supports: quantity_id, component, colormap,
 * range_min, range_max.  Paths that map to fields not yet in the schema are
 * logged and silently ignored so callers don't break.
 */
import type { DisplayUpdate } from "../../types";

export function legacyPreviewToDisplayUpdate(
  path: string,
  payload?: Record<string, unknown>,
): DisplayUpdate {
  const update: DisplayUpdate = {};

  switch (path) {
    case "/component":
      update.component = (payload?.component as string) ?? null;
      break;

    case "/colormap":
      update.colormap = (payload?.colormap as string) ?? null;
      break;

    case "/contrastRange":
      update.range_min = (payload?.min as number) ?? null;
      update.range_max = (payload?.max as number) ?? null;
      break;

    case "/autoScaleEnabled":
      // Reset explicit range when auto-scale is re-enabled
      if (payload?.autoScaleEnabled) {
        update.range_min = null;
        update.range_max = null;
      }
      break;

    case "/selection":
      if (payload?.quantityId)
        update.quantity_id = payload.quantityId as string;
      if (payload?.component !== undefined)
        update.component = (payload.component as string) ?? null;
      break;

    // The following legacy paths target display properties that are not yet
    // part of the DisplayUpdate schema.  We map them here for documentation
    // and forward-compatibility – they will be wired once the schema expands.
    case "/everyN":
    case "/maxPoints":
    case "/layer":
    case "/allLayers":
    case "/vectorGlyphs":
    case "/XChosenSize":
    case "/YChosenSize":
      // Not representable in current DisplayUpdate – silently skip
      break;

    default:
      console.warn(
        `[DisplayConsolidation] Unknown preview path: ${path}`,
      );
      break;
  }

  return update;
}
