import { describe, expect, it } from "vitest";

import {
  resolveHslReferenceVisible,
  viewport3dStore,
} from "./viewport3dStore";

describe("viewport3dStore", () => {
  it("keeps the canonical camera snapshot in module-local state", () => {
    viewport3dStore.resetForTest();

    viewport3dStore.setCamera({
      position: [3, 2, 1],
      target: [0.5, 0.25, 0],
    });

    expect(viewport3dStore.getSnapshot().camera).toEqual({
      position: [3, 2, 1],
      target: [0.5, 0.25, 0],
    });
  });

  it("reset-camera restores the default camera snapshot", () => {
    viewport3dStore.resetForTest();

    viewport3dStore.setCamera({
      position: [9, 9, 9],
      target: [1, 1, 1],
    });

    viewport3dStore.resetCamera();

    expect(viewport3dStore.getSnapshot().camera).toEqual({
      position: [2, 1.4, 2],
      target: [0, 0, 0],
    });
  });

  it("defaults orientation widget preferences for the v2 viewport", () => {
    viewport3dStore.resetForTest();

    expect(viewport3dStore.getSnapshot().widgets).toEqual({
      viewCubeVisible: true,
      hslReferenceMode: "auto",
    });
  });

  it("updates view cube and HSL reference preferences", () => {
    viewport3dStore.resetForTest();

    viewport3dStore.toggleViewCube();
    viewport3dStore.setHslReferenceMode("off");

    expect(viewport3dStore.getSnapshot().widgets).toEqual({
      viewCubeVisible: false,
      hslReferenceMode: "off",
    });
  });

  it("derives HSL reference visibility from mode and vector coloring", () => {
    expect(resolveHslReferenceVisible("auto", "orientation")).toBe(true);
    expect(resolveHslReferenceVisible("auto", "magnitude")).toBe(false);
    expect(resolveHslReferenceVisible("on", "magnitude")).toBe(true);
    expect(resolveHslReferenceVisible("off", "orientation")).toBe(false);
  });
});
