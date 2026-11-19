import { afterEach, describe, expect, it, vi } from "vitest";

import { fieldMapSurfaceStore as fieldMapStore } from "./fieldMapSurfaceStore";

const GEOMETRY = {
  layerCount: 8,
  layerSpacing: 7.5e-9,
  nativeResolution: [64, 32] as const,
  normal: "z" as const,
  normalExtent: 60e-9,
  normalMax: 60e-9,
  normalMin: 0,
  plane: "xy" as const,
  u: "x" as const,
  v: "y" as const,
};

describe("field-map surface store", () => {
  afterEach(() => fieldMapStore.reset());

  it("publishes derived section geometry and evidence once per real change", () => {
    const listener = vi.fn();
    const unsubscribe = fieldMapStore.subscribe(listener);

    fieldMapStore.set({ sectionGeometry: GEOMETRY });
    fieldMapStore.set({ sectionGeometry: { ...GEOMETRY } });
    fieldMapStore.set({ evidenceStatus: "ready" });
    fieldMapStore.set({ evidenceStatus: "ready" });

    expect(fieldMapStore.get().sectionGeometry?.layerCount).toBe(8);
    expect(fieldMapStore.get().evidenceStatus).toBe("ready");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("publishes a new continuous navigation step for the same section", () => {
    const continuous = { ...GEOMETRY, layerCount: null, layerSpacing: null, nativeResolution: null };
    fieldMapStore.set({ sectionGeometry: continuous });
    fieldMapStore.set({ sectionGeometry: { ...continuous, navigationStepM: 20e-9 } });
    expect(fieldMapStore.get().sectionGeometry?.navigationStepM).toBe(20e-9);
  });

  it("uses the same deterministic snapshot for server and first client render", () => {
    expect(fieldMapStore.get()).toEqual({ evidenceStatus: null, objectLayers: [], planar: null, sectionGeometry: null });
  });

  it("publishes realized object layers once per real change", () => {
    const listener = vi.fn();
    const unsubscribe = fieldMapStore.subscribe(listener);
    const layer = { max: 2e-9, min: 0, name: "film", objectId: "film" };

    fieldMapStore.set({ objectLayers: [layer] });
    const published = fieldMapStore.get().objectLayers;
    fieldMapStore.set({ objectLayers: [{ ...layer }] });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(fieldMapStore.get().objectLayers).toBe(published);
    unsubscribe();
  });
});
