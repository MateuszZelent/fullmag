/**
 * Maps legacy preview POST endpoints to a single PUT /display.
 * Used during migration to translate old updatePreview("/component", {component: "x"})
 * calls to new updateDisplay({component: "x"}) calls.
 *
 * The current DisplayUpdate schema supports: active_quantity_id, component, colormap,
 * contrast_min, contrast_max, auto_contrast, vector_density, slice_mode,
 * slice_layer, vector_glyphs. Paths that map to fields not yet in the schema are
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
      update.component = (payload?.component as string) ?? "3D";
      break;

    case "/colormap":
      update.colormap = (payload?.colormap as string) ?? "viridis";
      break;

    case "/contrastRange":
      update.contrast_min = (payload?.min as number) ?? null;
      update.contrast_max = (payload?.max as number) ?? null;
      break;

    case "/autoScaleEnabled":
      update.auto_contrast = Boolean(payload?.autoScaleEnabled);
      break;

    case "/selection":
      if (payload?.quantityId)
        update.active_quantity_id = payload.quantityId as string;
      if (payload?.component !== undefined)
        update.component = (payload.component as string) ?? "3D";
      break;

    case "/everyN":
      if (payload?.everyN !== undefined) {
        update.vector_density = Number(payload.everyN);
      }
      break;

    case "/layer":
      if (payload?.layer !== undefined) {
        update.slice_layer = Number(payload.layer);
      }
      break;

    case "/allLayers":
      if (payload?.allLayers !== undefined) {
        update.slice_mode = payload.allLayers ? "all" : "single";
      }
      break;

    case "/vectorGlyphs":
      if (payload?.vectorGlyphs !== undefined) {
        update.vector_glyphs = Boolean(payload.vectorGlyphs);
      }
      break;

    // The following legacy paths target display properties that are not yet
    // part of the DisplayUpdate schema.  We map them here for documentation
    // and forward-compatibility – they will be wired once the schema expands.
    case "/maxPoints":
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
