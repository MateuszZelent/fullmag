import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_OBJECT_VISUALIZATION } from "@/kernel/visualization/ObjectVisualizationController";
import { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DPrimitiveObject } from "../viewport3dPrimitiveModel";

import {
  buildPrimitiveTransformGizmoSegments,
  createPrimitiveObjectGeometry,
  releasePrimitiveObjectGeometry,
  shouldRenderPrimitiveObject,
  shouldRenderPrimitiveTransformGizmo,
  trackPrimitiveObjectGeometry,
} from "./PrimitiveObjectLayerModel";

function primitiveObject(
  kind: Viewport3DPrimitiveObject["kind"],
): Viewport3DPrimitiveObject {
  return {
    bounds: {
      center: [0, 0, 0],
      radius: 2,
      size: [2, 4, 6],
    },
    csgPreview: null,
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
  it("uses unlit materials for primitive preview surfaces", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./PrimitiveObjectLayer.tsx", import.meta.url)),
      "utf8",
    );
    const modelSource = readFileSync(
      fileURLToPath(new URL("./PrimitiveObjectLayerModel.ts", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("<meshBasicMaterial");
    expect(source).not.toContain("<meshStandardMaterial");
    expect(modelSource).not.toContain("computeVertexNormals");
  });

  it("keeps Primitive field-free and driven only by its monochrome local style", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./PrimitiveObjectLayer.tsx", import.meta.url)),
      "utf8",
    );
    const primitiveSurfaceSource = source.slice(
      source.indexOf("function RenderablePrimitiveObject"),
      source.indexOf("function PrimitiveObjectGizmo"),
    );

    expect(primitiveSurfaceSource).toContain("settings.primitiveMonoColor");
    expect(primitiveSurfaceSource).toContain("renderPlan.primitive.opacity");
    expect(primitiveSurfaceSource).not.toContain("fieldModel");
    expect(primitiveSurfaceSource).not.toContain("scalarColors");
    expect(primitiveSurfaceSource).not.toContain("magnetizationTexturePreview");
  });

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

  it("creates a visible CSG preview for box-minus-cylinder objects", () => {
    const geometry = createPrimitiveObjectGeometry({
      ...primitiveObject("box-cylinder-difference"),
      bounds: {
        center: [0, 0, 0],
        radius: 5,
        size: [10, 20, 2],
      },
      csgPreview: {
        boxSize: [10, 20, 2],
        cylinderAxis: [0, 0, 1],
        cylinderCenter: [0, 0, 0],
        cylinderHeight: 2,
        cylinderRadius: 2,
        kind: "box-cylinder-difference",
      },
    });

    expect(geometry.type).toBe("ExtrudeGeometry");
    expect(geometry.attributes.position.count).toBeGreaterThan(
      createPrimitiveObjectGeometry(primitiveObject("box")).attributes.position.count,
    );
  });

  it("keeps cardinal-axis CSG previews in the owner box bounds", () => {
    for (const axis of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ] satisfies Array<[number, number, number]>) {
      const geometry = createPrimitiveObjectGeometry({
        ...primitiveObject("box-cylinder-difference"),
        bounds: {
          center: [0, 0, 0],
          radius: 5,
          size: [10, 20, 2],
        },
        csgPreview: {
          boxSize: [10, 20, 2],
          cylinderAxis: axis,
          cylinderCenter: [0, 0, 0],
          cylinderHeight: 10,
          cylinderRadius: 0.4,
          kind: "box-cylinder-difference",
        },
      });

      geometry.computeBoundingBox();
      const box = geometry.boundingBox;

      expect(geometry.type).toBe("ExtrudeGeometry");
      expect((box?.max.x ?? 0) - (box?.min.x ?? 0)).toBeCloseTo(10);
      expect((box?.max.y ?? 0) - (box?.min.y ?? 0)).toBeCloseTo(20);
      expect((box?.max.z ?? 0) - (box?.min.z ?? 0)).toBeCloseTo(2);
    }
  });

  it("falls back to a box preview for unsupported non-cardinal CSG cylinder axes", () => {
    const geometry = createPrimitiveObjectGeometry({
      ...primitiveObject("box-cylinder-difference"),
      csgPreview: {
        boxSize: [10, 20, 2],
        cylinderAxis: [1, 1, 0],
        cylinderCenter: [0, 0, 0],
        cylinderHeight: 10,
        cylinderRadius: 2,
        kind: "box-cylinder-difference",
      },
    });

    expect(geometry.type).toBe("BoxGeometry");
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
      .toBe(false);
  });

  it("renders pre-mesh channels only before mesh-ready state", () => {
    expect(
      shouldRenderPrimitiveObject(
        { ...primitiveObject("box"), meshState: "mesh-ready" },
        { ...DEFAULT_OBJECT_VISUALIZATION, primitiveVisible: true },
      ),
    ).toBe(false);
    expect(
      shouldRenderPrimitiveObject(
        { ...primitiveObject("box"), meshState: "primitive-only" },
        DEFAULT_OBJECT_VISUALIZATION,
      ),
    ).toBe(true);
    expect(
      shouldRenderPrimitiveObject(
        { ...primitiveObject("box"), meshState: "primitive-only" },
        { ...DEFAULT_OBJECT_VISUALIZATION, primitiveVisible: true },
      ),
    ).toBe(true);
  });

  it("keeps pre-mesh wireframe and bounds independent from primitive fill", () => {
    const settingsWithoutPrimitiveFlag = {
      ...DEFAULT_OBJECT_VISUALIZATION,
    };
    delete settingsWithoutPrimitiveFlag.primitiveVisible;

    expect(
      shouldRenderPrimitiveObject(
        { ...primitiveObject("box"), meshState: "primitive-only" },
        settingsWithoutPrimitiveFlag,
      ),
    ).toBe(true);
    expect(
      shouldRenderPrimitiveObject(
        { ...primitiveObject("box"), meshState: "primitive-only" },
        {
          ...settingsWithoutPrimitiveFlag,
          boundsVisible: false,
          shaderVisible: false,
          wireframeVisible: false,
        },
      ),
    ).toBe(false);
  });
});
