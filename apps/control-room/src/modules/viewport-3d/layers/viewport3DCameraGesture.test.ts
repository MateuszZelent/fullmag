import { describe, expect, it, vi } from "vitest";

import {
  beginViewport3DCameraGesture,
  createViewport3DCameraGestureRef,
  endViewport3DCameraGesture,
  VIEWPORT_3D_CAMERA_FIELD_UPDATE_RELEASE_DELAY_MS,
  viewport3DCameraGestureActive,
  type Viewport3DCameraGestureRef,
} from "./viewport3DCameraGesture";
import {
  resetViewport3DFieldUpdateHoldForTest,
  viewport3DFieldUpdateHoldActive,
} from "../viewport3dFieldUpdateHold";

describe("viewport3DCameraGesture", () => {
  it("tracks active OrbitControls gestures", () => {
    vi.useFakeTimers();
    resetViewport3DFieldUpdateHoldForTest();
    try {
      const ref = createViewport3DCameraGestureRef();

      expect(viewport3DCameraGestureActive(ref)).toBe(false);
      expect(viewport3DFieldUpdateHoldActive()).toBe(false);

      beginViewport3DCameraGesture(ref);
      expect(viewport3DCameraGestureActive(ref)).toBe(true);
      expect(viewport3DFieldUpdateHoldActive()).toBe(true);

      endViewport3DCameraGesture(ref);
      expect(viewport3DCameraGestureActive(ref)).toBe(false);
      expect(viewport3DFieldUpdateHoldActive()).toBe(true);

      vi.advanceTimersByTime(
        VIEWPORT_3D_CAMERA_FIELD_UPDATE_RELEASE_DELAY_MS - 1,
      );
      expect(viewport3DFieldUpdateHoldActive()).toBe(true);

      vi.advanceTimersByTime(1);
      expect(viewport3DFieldUpdateHoldActive()).toBe(false);
    } finally {
      resetViewport3DFieldUpdateHoldForTest();
      vi.useRealTimers();
    }
  });

  it("treats a missing gesture ref as inactive during viewport remount churn", () => {
    resetViewport3DFieldUpdateHoldForTest();
    const ref = undefined as unknown as Viewport3DCameraGestureRef;

    expect(viewport3DCameraGestureActive(ref)).toBe(false);
    expect(() => beginViewport3DCameraGesture(ref)).not.toThrow();
    expect(() => endViewport3DCameraGesture(ref)).not.toThrow();
  });
});
