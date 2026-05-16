import { describe, expect, it, vi } from "vitest";

import { DEFAULT_OBJECT_VISUALIZATION } from "@/kernel/visualization/ObjectVisualizationController";
import { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DPrimitiveObject } from "../viewport3dPrimitiveModel";

import {
  buildPrimitiveTransformGizmoSegments,
  createPrimitiveObjectGeometry,
  releasePrimitiveObjectGeometry,
  shouldRenderPrimitiveTransformGizmo,
  trackPrimitiveObjectGeometry,
} from "./PrimitiveObjectLayer";

function primitiveObject(
  kind: Viewport3DPrimitiveObject["kind"],
): Viewport3DPrimitiveObject {
  return {
    bounds: {
      center: [0, 0, 0],
      radius: 2,
      size: [2, 4, 6],
    },
    fallbackLabel: "primitive",
    geometryKey: `object:${kind}`,
    kind,
    label: "Object",
    magnetizationTexturePreview: null,
    meshState: "primitive-only",
    objectId: `object-${kind}`,
    sceneRevision: 1,
  };
}

describe("PrimitiveObjectLayer geometry resources", () => {
  it("creates primitive geometry variants from object bounds", () => {
    expect(createPrimitiveObjectGeometry(primitiveObject("box")).type).toBe(
      "BoxGeometry",
    );
    expect(createPrimitiveObjectGeometry(primitiveObject("sphere")).type).toBe(
      "SphereGeometry",
    );
    expect(createPrimitiveObjectGeometry(primitiveObject("cylinder")).type).toBe(
      "CylinderGeometry",
    );
  });

  it("tracks and releases primitive geometry through the viewport tracker", () => {
    const tracker = new Viewport3DResourceTracker();
    const geometry = trackPrimitiveObjectGeometry(tracker, primitiveObject("box"));
    const dispose = vi.spyOn(geometry, "dispose");

    expect(tracker.getSnapshot().geometries).toBe(1);

    releasePrimitiveObjectGeometry(tracker, geometry);

    expect(dispose).toHaveBeenCalledOnce();
    expect(tracker.getSnapshot().geometries).toBe(0);
  });

  it("builds a local transform gizmo from primitive bounds", () => {
    expect(Array.from(buildPrimitiveTransformGizmoSegments(primitiveObject("box"))))
      .toEqual([
        0, 0, 0,
        expect.closeTo(2.16), 0, 0,
        0, 0, 0,
        0, expect.closeTo(2.16), 0,
        0, 0, 0,
        0, 0, expect.closeTo(2.16),
      ]);
  });

  it("does not draw primitive transform gizmo in surface-only mode", () => {
    expect(
      shouldRenderPrimitiveTransformGizmo({
        ...DEFAULT_OBJECT_VISUALIZATION,
        renderMode: "surface",
        shaderVisible: true,
        wireframeVisible: false,
      }),
    ).toBe(false);
    expect(shouldRenderPrimitiveTransformGizmo(DEFAULT_OBJECT_VISUALIZATION))
      .toBe(true);
  });
});
