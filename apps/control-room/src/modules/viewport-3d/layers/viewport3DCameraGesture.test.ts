import { describe, expect, it } from "vitest";

import {
  beginViewport3DCameraGesture,
  createViewport3DCameraGestureRef,
  endViewport3DCameraGesture,
  viewport3DCameraGestureActive,
  type Viewport3DCameraGestureRef,
} from "./viewport3DCameraGesture";

describe("viewport3DCameraGesture", () => {
  it("tracks active OrbitControls gestures", () => {
    const ref = createViewport3DCameraGestureRef();

    expect(viewport3DCameraGestureActive(ref)).toBe(false);

    beginViewport3DCameraGesture(ref);
    expect(viewport3DCameraGestureActive(ref)).toBe(true);

    endViewport3DCameraGesture(ref);
    expect(viewport3DCameraGestureActive(ref)).toBe(false);
  });

  it("treats a missing gesture ref as inactive during viewport remount churn", () => {
    const ref = undefined as unknown as Viewport3DCameraGestureRef;

    expect(viewport3DCameraGestureActive(ref)).toBe(false);
    expect(() => beginViewport3DCameraGesture(ref)).not.toThrow();
    expect(() => endViewport3DCameraGesture(ref)).not.toThrow();
  });
});
