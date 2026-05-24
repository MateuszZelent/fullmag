import { isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_AIRBOX_VISUALIZATION,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";

import type { Viewport3DMeshPart } from "../viewport3dDomainAdapter";
import type {
  Viewport3DFieldRenderModel,
  Viewport3DTopologyRenderModel,
} from "../viewport3dRenderModel";
import { getViewport3DVisualProfile } from "../viewport3dVisualProfile";
import {
  AirboxLayer,
  SelectionHighlightLayer,
  airboxWireframeOpacityFromSettings,
  buildBoundsVolumeWireframePositions,
  resolveAirboxSurfaceColorState,
  resolveAirboxTopologyVisualizationSettings,
  resolveAirboxWireframeEdgeIndices,
  resolveAirboxWireframePrimitive,
  resolveAirboxWireframeSemantic,
} from "./BoundsLayers";
import { VERTEX_COLOR_MATERIAL_COLOR } from "./viewport3DLayerSettings";
import { resolveViewport3DMaterialProfile } from "./viewport3DMaterialProfile";

const colors = {
  accent: "#aaccff",
  background: "#000000",
  field: "#ffffff",
  mesh: "#dddddd",
  selection: "#ffff00",
  wire: "#999999",
};

const visibleWireframeAirbox: VisualizationTargetSettings = {
  ...DEFAULT_AIRBOX_VISUALIZATION,
  boundsVisible: false,
  geometryScope: "surface",
  opacityPercent: 35,
  pointsVisible: false,
  renderMode: "wireframe",
  shaderVisible: false,
  vectorsVisible: false,
  visible: true,
  wireframeVisible: true,
};

const materialProfile = resolveViewport3DMaterialProfile(
  getViewport3DVisualProfile("interactive"),
);

function airboxTopology(): Viewport3DTopologyRenderModel<Viewport3DMeshPart> {
  const part = {
    boundary_face_count: 1,
    boundary_face_start: 0,
    bounds_max: [1, 1, 1],
    bounds_min: [0, 0, 0],
    element_count: 1,
    element_start: 0,
    id: "airbox-part",
    label: "Airbox",
    node_count: 4,
    node_start: 0,
    role: "air",
  } as Viewport3DMeshPart;

  return {
    airboxParts: [
      {
        edgeIndices: null,
        part,
        surfaceIndices: null,
        surfaceNodeSelection: null,
        volumeEdgeIndices: null,
      },
    ],
    fallbackSurfaceIndices: new Uint32Array(),
    fallbackVolumeEdgeIndices: new Uint32Array(),
    magneticParts: [],
    nodeCount: 4,
    positions: new Float32Array(),
  };
}

describe("AirboxLayer", () => {
  it("renders wireframe-only airbox edges as hidden-edge overlays", () => {
    expect(resolveAirboxWireframeSemantic(visibleWireframeAirbox)).toBe(
      "hiddenEdges",
    );
    expect(
      resolveAirboxWireframeSemantic({
        ...visibleWireframeAirbox,
        shaderVisible: true,
      }),
    ).toBe("featureEdges");
    expect(
      resolveAirboxWireframeSemantic({
        ...visibleWireframeAirbox,
        geometryScope: "full",
        shaderVisible: true,
      }),
    ).toBe("hiddenEdges");
  });

  it("keeps full airbox wireframe scope when topology freshness is unknown", () => {
    expect(
      resolveAirboxTopologyVisualizationSettings(
        {
          ...visibleWireframeAirbox,
          geometryScope: "full",
          shaderVisible: true,
        },
        "unknown",
      ),
    ).toMatchObject({
      geometryScope: "full",
      renderMode: "wireframe",
      shaderVisible: false,
      wireframeVisible: true,
    });
  });

  it("uses volume edges for full airbox wireframe and surface edges for surface mode", () => {
    const surfaceEdges = new Uint32Array([0, 1, 1, 2]);
    const volumeEdges = new Uint32Array([0, 1, 1, 2, 2, 3]);
    const partModel = {
      edgeIndices: surfaceEdges,
      volumeEdgeIndices: volumeEdges,
    };

    expect(
      resolveAirboxWireframeEdgeIndices(
        "full",
        partModel,
      ),
    ).toBe(volumeEdges);
    expect(
      resolveAirboxWireframeEdgeIndices(
        "surface",
        partModel,
      ),
    ).toBe(surfaceEdges);
  });

  it("does not downgrade full airbox wireframe to surface edges when volume edges are unavailable", () => {
    const surfaceEdges = new Uint32Array([0, 1, 1, 2]);
    const partModel = {
      edgeIndices: surfaceEdges,
      volumeEdgeIndices: null,
    };

    expect(
      resolveAirboxWireframeEdgeIndices(
        "full",
        partModel,
      ),
    ).toBeNull();
    expect(
      resolveAirboxWireframeEdgeIndices(
        "surface",
        partModel,
      ),
    ).toBe(surfaceEdges);
  });

  it("keeps surface airbox wireframe on line segments when geometry exists", () => {
    expect(resolveAirboxWireframePrimitive(true, true)).toBe("lines");
    expect(resolveAirboxWireframePrimitive(true, false)).toBe("bounds");
    expect(resolveAirboxWireframePrimitive(false, true)).toBeNull();
  });

  it("uses procedural bounds volume as the primary full airbox wireframe", () => {
    expect(resolveAirboxWireframePrimitive(true, true, "full")).toBe("bounds");
    expect(resolveAirboxWireframePrimitive(true, false, "full")).toBe("bounds");
  });



  it("keeps airbox wireframe opacity independent from air surface opacity", () => {
    expect(
      airboxWireframeOpacityFromSettings({
        ...visibleWireframeAirbox,
        opacityPercent: 20,
        wireframeOpacityPercent: 100,
      }),
    ).toBe(1);
    expect(
      airboxWireframeOpacityFromSettings(
        {
          ...visibleWireframeAirbox,
          opacityPercent: 20,
          wireframeOpacityPercent: 80,
        },
        { opacity: 0.5 },
      ),
    ).toBe(0.4);
  });

  it("uses active field scalar colors for airbox surface coloring", () => {
    const colorsByComponent = {
      colors: new Float32Array(12).fill(0.5),
      range: { max: 1, min: -1 },
    };
    const fieldModel = {
      fullVectorSegments: null,
      partVectorSegments: new Map(),
      scalarColors: null,
      scalarColorsByMode: new Map([["x", colorsByComponent]]),
    } satisfies Viewport3DFieldRenderModel;

    expect(
      resolveAirboxSurfaceColorState(
        {
          ...DEFAULT_AIRBOX_VISUALIZATION,
          shaderVisible: true,
          surfaceColorSource: "component_x",
        },
        fieldModel,
        4,
        colors.mesh,
      ),
    ).toEqual({
      hasScalarColors: true,
      materialColor: VERTEX_COLOR_MATERIAL_COLOR,
      scalarColors: colorsByComponent,
      vertexColorsEnabled: true,
    });
  });

  it("builds an interior volume wireframe for full airbox fallback overlays", () => {
    const positions = buildBoundsVolumeWireframePositions(
      {
        center: [0, 0, 0],
        radius: Math.sqrt(3),
        size: [2, 2, 2],
      },
      2,
    );

    expect(positions).not.toBeNull();
    expect(positions?.length).toBe(162);
    expect(Array.from(positions ?? [])).toEqual(
      expect.arrayContaining([0, 0, -1, 0, 0, 1]),
    );
  });

  it("passes the airbox selection handler into mesh part layers", () => {
    const onSelectPart = vi.fn();
    const topologyModel = airboxTopology();
    const element = AirboxLayer({
      colors,
      fieldModel: null,
      materialProfile,
      onSelectPart,
      settings: visibleWireframeAirbox,
      topologyModel,
      topologyFreshness: "current",
      tracker: {} as never,
      vectorColorMode: "orientation",
      vectorStyle: {},
    });

    expect(isValidElement(element)).toBe(true);
    const fragment = element as ReactElement<{ children: ReactElement[] }>;
    const child = fragment.props.children[0];

    expect(isValidElement(child)).toBe(true);
    expect(child.props).toMatchObject({
      onSelectPart,
      materialProfile,
      settings: visibleWireframeAirbox,
      topologyModel,
      topologyFreshness: "current",
    });
  });
});

describe("SelectionHighlightLayer", () => {
  it("renders a high-emphasis bounds box for selected primitive or mesh bounds", () => {
    const element = SelectionHighlightLayer({
      bounds: {
        center: [1, 2, 3],
        radius: 4,
        size: [5, 6, 7],
      },
      colors,
      materialProfile,
    });

    expect(isValidElement(element)).toBe(true);
    const boundsBox = element as ReactElement<{
      bounds: {
        center: [number, number, number];
        radius: number;
        size: [number, number, number];
      };
      color: string;
      opacity: number;
    }>;
    expect(boundsBox.props).toMatchObject({
      bounds: {
        center: [1, 2, 3],
        radius: 4,
        size: [5, 6, 7],
      },
      color: colors.accent,
      opacity: materialProfile.selectionShell.opacity,
    });
  });

  it("passes null bounds through to the bounds renderer for no selection", () => {
    const element = SelectionHighlightLayer({
      bounds: null,
      colors,
      materialProfile,
    });
    const boundsBox = element as ReactElement<{ bounds: null }>;

    expect(boundsBox.props.bounds).toBeNull();
  });
});
