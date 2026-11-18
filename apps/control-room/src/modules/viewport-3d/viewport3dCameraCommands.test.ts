import { describe, expect, it, vi } from "vitest";
import { registerViewport3DProjectionOwner, toggleRegisteredViewport3DProjection } from "./viewport3dCameraCommands";

describe("active 3D camera projection commands", () => {
  it("patches the active owner and preserves rapid repeated toggles", () => {
    const patch = vi.fn();
    const release = registerViewport3DProjectionOwner("perspective", patch);
    try {
      expect(toggleRegisteredViewport3DProjection()).toBe(true);
      expect(toggleRegisteredViewport3DProjection()).toBe(true);
      expect(patch.mock.calls).toEqual([[{ projection: "orthographic" }], [{ projection: "perspective" }]]);
    } finally { release(); }
    expect(toggleRegisteredViewport3DProjection()).toBe(false);
  });
  it("does not route to an old saved owner or release its replacement", () => {
    const oldPatch = vi.fn(); const currentPatch = vi.fn();
    const releaseOld = registerViewport3DProjectionOwner("perspective", oldPatch);
    const releaseCurrent = registerViewport3DProjectionOwner("orthographic", currentPatch);
    releaseOld();
    try {
      toggleRegisteredViewport3DProjection();
      expect(oldPatch).not.toHaveBeenCalled();
      expect(currentPatch).toHaveBeenCalledWith({ projection: "perspective" });
    } finally { releaseCurrent(); }
  });
});
