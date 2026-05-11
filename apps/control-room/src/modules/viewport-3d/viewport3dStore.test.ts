import { describe, expect, it } from "vitest";

import { viewport3dStore } from "./viewport3dStore";

describe("viewport3dStore", () => {
  it("keeps the canonical camera snapshot in module-local state", () => {
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
});
