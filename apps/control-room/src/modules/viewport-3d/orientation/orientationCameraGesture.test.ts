import { describe, expect, it, vi } from "vitest";

import {
  beginViewport3DCameraGesture,
  createViewport3DCameraGestureRef,
  settleViewport3DCameraGesture,
  viewport3DCameraGestureActive,
} from "../layers/viewport3DCameraGesture";
import { beginOrientationCameraGesture, commitOrientationCameraGesture } from "./orientationCameraGesture";

describe("orientation camera gestures", () => {
  it("does not let a completed HUD save settle a newer camera gesture", async () => {
    const gesture = createViewport3DCameraGestureRef();
    const first = beginOrientationCameraGesture(gesture);
    let resolveSave!: () => void;
    const save = new Promise<void>((resolve) => { resolveSave = resolve; });
    const end = vi.fn();
    const commit = commitOrientationCameraGesture(gesture, first, () => save, end);
    const second = beginViewport3DCameraGesture(gesture, "orbit");

    resolveSave();
    await commit;

    expect(end).not.toHaveBeenCalled();
    expect(viewport3DCameraGestureActive(gesture)).toBe(true);
    expect(settleViewport3DCameraGesture(gesture, second)).toBe(true);
  });

  it("releases the gesture even when the save callback throws synchronously", async () => {
    const gesture = createViewport3DCameraGestureRef();
    const epoch = beginOrientationCameraGesture(gesture);
    const end = vi.fn();
    await expect(commitOrientationCameraGesture(gesture, epoch, () => {
      throw new Error("save failed");
    }, end)).rejects.toThrow("save failed");

    expect(end).toHaveBeenCalledExactlyOnceWith(epoch);
    expect(viewport3DCameraGestureActive(gesture)).toBe(false);
  });

  it("gives separate HUD gestures distinct epochs and ignores an obsolete commit", async () => {
    const gesture = createViewport3DCameraGestureRef();
    const first = beginOrientationCameraGesture(gesture);
    const second = beginOrientationCameraGesture(gesture);
    const save = vi.fn();
    const end = vi.fn();

    await commitOrientationCameraGesture(gesture, first, save, end);

    expect(second).toBeGreaterThan(first);
    expect(save).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    settleViewport3DCameraGesture(gesture, second);
  });
});
