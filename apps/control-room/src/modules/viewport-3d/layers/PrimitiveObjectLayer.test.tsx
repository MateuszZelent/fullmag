import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { DEFAULT_OBJECT_VISUALIZATION } from "@/kernel/visualization/ObjectVisualizationController";
import { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DPrimitiveObject } from "../viewport3dPrimitiveModel";
import type { Viewport3DColors } from "../viewport3dTypes";
import { getViewport3DVisualProfile } from "../viewport3dVisualProfile";

vi.mock("../viewport3dBatchedInvalidate", () => ({
  useBatchedInvalidate: () => vi.fn(),
}));

import { PrimitiveObjectLayer } from "./PrimitiveObjectLayer";
import { createAntennaPrimitiveTextures } from "./antennaPrimitiveTextures";
import { primitiveMonoColorForRole } from "@/kernel/visualization/primitiveSurfaceColor";
import { resolveViewport3DMaterialProfile } from "./viewport3DMaterialProfile";

import {
  buildPrimitiveTransformGizmoSegments,
  createPrimitiveObjectGeometry,
  releasePrimitiveObjectGeometry,
  resolvePrimitiveObjectRenderSettings,
  shouldRenderPrimitiveObject,
  shouldRenderPrimitiveTransformGizmo,
  trackPrimitiveObjectGeometry,
  primitiveDraftOverlayObject,
  primitiveObjectSurfaceColor,
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
  it("releases tracked geometry across mount, draft change, and unmount", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const tracker = new Viewport3DResourceTracker();
    const colors: Viewport3DColors = {
      accent: "#89b4fa",
      background: "#11111b",
      field: "#a6e3a1",
      mesh: "#313244",
      textPrimary: "#cdd6f4",
      textSecondary: "#bac2de",
      wire: "#6c7086",
    };
    const render = (size: number) => (
      <PrimitiveObjectLayer
        colors={colors}
        getObjectSettings={() => DEFAULT_OBJECT_VISUALIZATION}
        materialProfile={resolveViewport3DMaterialProfile(
          getViewport3DVisualProfile("interactive"),
        )}
        onSelectObject={() => undefined}
        primitiveModel={{
          draftOverlay: primitiveDraftOverlayObject({
            dimensions: [size, 4e-7, 6e-8],
            errors: {},
            kind: "Box",
            translation: [0, 0, 0],
          }),
          objects: [],
          sceneRevision: -1,
        }}
        tracker={tracker}
      />
    );
    try {
      await act(async () => root.render(render(2e-7)));
      expect(tracker.getSnapshot().geometries).toBeGreaterThan(0);
      const mountedCount = tracker.getSnapshot().geometries;

      await act(async () => root.render(render(3e-7)));
      expect(tracker.getSnapshot().geometries).toBe(mountedCount);

      await act(async () => root.unmount());
      expect(tracker.getSnapshot().geometries).toBe(0);
    } finally {
      dom.restore();
    }
  });
  it("adapts a draft to a separate stable overlay carrier without topology provenance", () => {
    const overlay = primitiveDraftOverlayObject({
      dimensions: [2e-7, 4e-7, 6e-8],
      errors: {},
      kind: "Box",
      translation: [7e-9, 8e-9, 9e-9],
    });

    expect(overlay).not.toBeNull();
    expect(overlay!).toMatchObject({
      geometryKey: "draft:Box:2e-7,4e-7,6e-8:7e-9,8e-9,9e-9",
      objectId: "draft:primitive",
      sceneRevision: -1,
      bounds: { center: [7e-9, 8e-9, 9e-9], size: [2e-7, 4e-7, 6e-8] },
    });
    expect(overlay!.meshState).toBe("primitive-only");
  });
  it("keeps ordinary primitives unlit and gives antennas a light-independent metallic finish", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./PrimitiveObjectLayer.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("<meshBasicMaterial");
    expect(source).not.toContain("<meshStandardMaterial");
    expect(source).toContain("<meshMatcapMaterial");
  });

  it("keeps Primitive field-free and routes its presentation through the color resolver", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./PrimitiveObjectLayer.tsx", import.meta.url)),
      "utf8",
    );
    const primitiveSurfaceSource = source.slice(
      source.indexOf("function RenderablePrimitiveObject"),
      source.indexOf("function PrimitiveObjectGizmo"),
    );

    expect(primitiveSurfaceSource).toMatch(
      /primitiveObjectSurfaceColor\(\s*object,\s*renderSettings,\s*colors,\s*primitiveColorAssignments,\s*\)/,
    );
    expect(primitiveSurfaceSource).toContain("renderPlan.primitive.opacity");
    expect(primitiveSurfaceSource).toContain("renderPlan.points.visible");
    expect(primitiveSurfaceSource).toContain("pointColorFromSettings");
    expect(primitiveSurfaceSource).not.toContain("fieldModel");
    expect(primitiveSurfaceSource).not.toContain("scalarColors");
    expect(primitiveSurfaceSource).not.toContain("magnetizationTexturePreview");
  });

  it("shows the antenna primitive preference without confusing a solid shader override", () => {
    expect(primitiveMonoColorForRole("antenna", "var(--fm-surface-magnetic)"))
      .toBe("var(--fm-surface-antenna)");
    expect(primitiveMonoColorForRole("antenna", "#c8a050")).toBe("#c8a050");
    expect(primitiveMonoColorForRole("magnetic", "var(--fm-surface-magnetic)"))
      .toBe("var(--fm-surface-magnetic)");
  });

  it("keeps the repeatable brushed finish subtle and bounded", () => {
    const first = createAntennaPrimitiveTextures();
    const second = createAntennaPrimitiveTextures();
    const pixels = first.brush.image.data as Uint8Array;
    expect(pixels.byteLength + (first.matcap.image.data as Uint8Array).byteLength)
      .toBeLessThanOrEqual(32 * 1024);
    const tones = Array.from(pixels).filter((_, index) => index % 4 !== 3);
    expect(Math.min(...tones)).toBeGreaterThanOrEqual(230);
    expect(Math.max(...tones) - Math.min(...tones)).toBeGreaterThan(10);
    expect(pixels).toEqual(second.brush.image.data);
    first.matcap.dispose();
    first.brush.dispose();
    second.matcap.dispose();
    second.brush.dispose();
  });

  it("uses the antenna theme by default while preserving literal color overrides", () => {
    const colors: Viewport3DColors = {
      accent: "#89b4fa",
      antenna: "#f9e2af",
      background: "#11111b",
      field: "#a6e3a1",
      mesh: "#313244",
      textPrimary: "#cdd6f4",
      textSecondary: "#bac2de",
      wire: "#6c7086",
    };
    expect(primitiveObjectSurfaceColor({ role: "antenna" }, DEFAULT_OBJECT_VISUALIZATION, colors))
      .toBe(colors.antenna);
    expect(primitiveObjectSurfaceColor({ role: "magnetic" }, DEFAULT_OBJECT_VISUALIZATION, colors))
      .toBe(colors.mesh);
    expect(primitiveObjectSurfaceColor({ role: "antenna" }, {
      ...DEFAULT_OBJECT_VISUALIZATION,
      surfaceColorSource: "solid",
      shaderMonoColor: "#123456",
    }, colors)).toBe("#123456");
    expect(primitiveObjectSurfaceColor({ role: "antenna" }, {
      ...DEFAULT_OBJECT_VISUALIZATION,
      surfaceColorSource: "orientation",
      primitiveMonoColor: "#654321",
    }, colors)).toBe("#654321");
  });

  it("creates primitive geometry variants from object bounds", () => {
    expect(createPrimitiveObjectGeometry(primitiveObject("box")).type).toBe(
      "BoxGeometry",
    );
    expect(createPrimitiveObjectGeometry(primitiveObject("sphere")).type).toBe(
      "SphereGeometry",
    );
    const cylinderGeometry = createPrimitiveObjectGeometry(primitiveObject("cylinder"));
    expect(cylinderGeometry.type).toBe("CylinderGeometry");
    cylinderGeometry.computeBoundingBox();
    expect(cylinderGeometry.boundingBox?.min.z).toBeCloseTo(-3);
    expect(cylinderGeometry.boundingBox?.max.z).toBeCloseTo(3);
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

  it("does not confuse ordinary wireframe with an unavailable manipulate mode", () => {
    expect(
      shouldRenderPrimitiveTransformGizmo({
        ...DEFAULT_OBJECT_VISUALIZATION,
        renderMode: "wireframe",
        shaderVisible: true,
        visible: true,
        wireframeVisible: true,
      }),
    ).toBe(false);
  });

  it("keeps preview until replacement geometry exists even when the manifest is ready", () => {
    expect(
      shouldRenderPrimitiveObject(
        { ...primitiveObject("box"), meshState: "mesh-ready" },
        { ...DEFAULT_OBJECT_VISUALIZATION, primitiveVisible: true },
      ),
    ).toBe(true);
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

  it("hands a ready object from primitive preview to realized geometry and back without changing settings", () => {
    const object = { ...primitiveObject("box"), meshState: "mesh-ready" as const };
    const settings = { ...DEFAULT_OBJECT_VISUALIZATION, primitiveVisible: false, shaderVisible: true };
    expect(shouldRenderPrimitiveObject(object, settings, false)).toBe(true);
    expect(resolvePrimitiveObjectRenderSettings(object, settings).primitiveVisible).toBe(true);
    expect(shouldRenderPrimitiveObject(object, settings, true)).toBe(false);
    expect(shouldRenderPrimitiveObject(object, settings, false)).toBe(true);
    expect(settings.primitiveVisible).toBe(false);
    expect(shouldRenderPrimitiveObject(object, { ...settings, visible: false }, false)).toBe(false);
  });

  it("does not render a primitive fallback when a realized FDM carrier owns the object", () => {
    expect(
      shouldRenderPrimitiveObject(
        { ...primitiveObject("box"), meshState: "primitive-only" },
        DEFAULT_OBJECT_VISUALIZATION,
        true,
      ),
    ).toBe(false);
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

  it("uses a field-free primitive fill for a requested shaded pre-mesh pass", () => {
    const settings = resolvePrimitiveObjectRenderSettings(
      primitiveObject("box"),
      { ...DEFAULT_OBJECT_VISUALIZATION, primitiveVisible: false, shaderVisible: true },
    );

    expect(settings.primitiveVisible).toBe(true);
    expect(settings.shaderVisible).toBe(true);
  });

  it("keeps wireframe-only intent but provides shaded fallback while replacement geometry is absent", () => {
    expect(
      resolvePrimitiveObjectRenderSettings(
        primitiveObject("box"),
        { ...DEFAULT_OBJECT_VISUALIZATION, primitiveVisible: false, shaderVisible: false, wireframeVisible: true },
      ).primitiveVisible,
    ).toBe(false);
    expect(
      resolvePrimitiveObjectRenderSettings(
        { ...primitiveObject("box"), meshState: "mesh-ready" },
        { ...DEFAULT_OBJECT_VISUALIZATION, primitiveVisible: false, shaderVisible: true },
      ).primitiveVisible,
    ).toBe(true);
  });

  it("renders a primitive-only points pass without a field payload", () => {
    expect(
      shouldRenderPrimitiveObject(
        primitiveObject("box"),
        {
          ...DEFAULT_OBJECT_VISUALIZATION,
          pointsVisible: true,
          shaderVisible: false,
          wireframeVisible: false,
        },
      ),
    ).toBe(true);
  });
});
