import { describe, expect, it, vi } from "vitest";

import {
  beginViewport3DCameraGesture,
  cancelViewport3DCameraGesture,
  createViewport3DCameraGestureRef,
  disposeViewport3DCameraGesture,
  endViewport3DCameraGesture,
  markViewport3DCameraGestureChanged,
  settleViewport3DCameraGesture,
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

      const epoch = beginViewport3DCameraGesture(ref, "orbit");
      expect(viewport3DCameraGestureActive(ref)).toBe(true);
      expect(viewport3DFieldUpdateHoldActive()).toBe(true);

      markViewport3DCameraGestureChanged(ref, epoch);
      expect(settleViewport3DCameraGesture(ref, epoch)).toBe(true);
      expect(viewport3DCameraGestureActive(ref)).toBe(false);
      expect(viewport3DFieldUpdateHoldActive()).toBe(false);
    } finally {
      resetViewport3DFieldUpdateHoldForTest();
      vi.useRealTimers();
    }
  });

  it("does not let a stale gesture settle or release the current hold", () => {
    resetViewport3DFieldUpdateHoldForTest();
    try {
      const ref = createViewport3DCameraGestureRef();
      const first = beginViewport3DCameraGesture(ref, "orbit");
      const second = beginViewport3DCameraGesture(ref, "wheel");

      expect(second).toBeGreaterThan(first);
      expect(settleViewport3DCameraGesture(ref, first)).toBe(false);
      expect(viewport3DCameraGestureActive(ref)).toBe(true);
      expect(viewport3DFieldUpdateHoldActive()).toBe(true);

      markViewport3DCameraGestureChanged(ref, second);
      expect(settleViewport3DCameraGesture(ref, second)).toBe(true);
      expect(viewport3DCameraGestureActive(ref)).toBe(false);
      expect(viewport3DFieldUpdateHoldActive()).toBe(false);
    } finally {
      resetViewport3DFieldUpdateHoldForTest();
    }
  });

  it("cancels and disposes an active gesture idempotently", () => {
    resetViewport3DFieldUpdateHoldForTest();
    try {
      const ref = createViewport3DCameraGestureRef();
      const epoch = beginViewport3DCameraGesture(ref, "orientation-hud");

      expect(cancelViewport3DCameraGesture(ref, epoch)).toBe(true);
      expect(cancelViewport3DCameraGesture(ref, epoch)).toBe(false);
      expect(viewport3DFieldUpdateHoldActive()).toBe(false);

      beginViewport3DCameraGesture(ref, "projection");
      disposeViewport3DCameraGesture(ref);
      disposeViewport3DCameraGesture(ref);

      expect(viewport3DCameraGestureActive(ref)).toBe(false);
      expect(viewport3DFieldUpdateHoldActive()).toBe(false);
      expect(beginViewport3DCameraGesture(ref, "orbit")).toBe(-1);
    } finally {
      resetViewport3DFieldUpdateHoldForTest();
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
