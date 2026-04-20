import { describe, it, expect } from "vitest";
import { legacyPreviewToDisplayUpdate } from "../DisplayConsolidation";

describe("DisplayConsolidation", () => {
  it("/component maps to component field", () => {
    const update = legacyPreviewToDisplayUpdate("/component", {
      component: "x",
    });
    expect(update.component).toBe("x");
  });

  it("/component defaults to null when payload missing", () => {
    const update = legacyPreviewToDisplayUpdate("/component");
    expect(update.component).toBeNull();
  });

  it("/colormap maps to colormap field", () => {
    const update = legacyPreviewToDisplayUpdate("/colormap", {
      colormap: "viridis",
    });
    expect(update.colormap).toBe("viridis");
  });

  it("/contrastRange maps to range_min and range_max", () => {
    const update = legacyPreviewToDisplayUpdate("/contrastRange", {
      min: -1,
      max: 1,
    });
    expect(update.range_min).toBe(-1);
    expect(update.range_max).toBe(1);
  });

  it("/autoScaleEnabled resets range when enabled", () => {
    const update = legacyPreviewToDisplayUpdate("/autoScaleEnabled", {
      autoScaleEnabled: true,
    });
    expect(update.range_min).toBeNull();
    expect(update.range_max).toBeNull();
  });

  it("/autoScaleEnabled does not reset range when disabled", () => {
    const update = legacyPreviewToDisplayUpdate("/autoScaleEnabled", {
      autoScaleEnabled: false,
    });
    expect(update.range_min).toBeUndefined();
    expect(update.range_max).toBeUndefined();
  });

  it("/selection maps quantity_id and component", () => {
    const update = legacyPreviewToDisplayUpdate("/selection", {
      quantityId: "m",
      component: "z",
    });
    expect(update.quantity_id).toBe("m");
    expect(update.component).toBe("z");
  });

  // Legacy paths that are not yet in DisplayUpdate schema → empty update
  for (const path of [
    "/everyN",
    "/maxPoints",
    "/layer",
    "/allLayers",
    "/vectorGlyphs",
    "/XChosenSize",
    "/YChosenSize",
  ]) {
    it(`${path} returns empty update (not yet in schema)`, () => {
      const update = legacyPreviewToDisplayUpdate(path, { value: 42 });
      expect(Object.keys(update).length).toBe(0);
    });
  }

  it("unknown path returns empty update", () => {
    const update = legacyPreviewToDisplayUpdate("/unknownPath");
    expect(Object.keys(update).length).toBe(0);
  });
});
