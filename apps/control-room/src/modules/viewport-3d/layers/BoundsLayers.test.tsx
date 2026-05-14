import { isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_AIRBOX_VISUALIZATION,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";

import type { Viewport3DMeshPart } from "../viewport3dDomainAdapter";
import type { Viewport3DTopologyRenderModel } from "../viewport3dRenderModel";
import { getViewport3DVisualProfile } from "../viewport3dVisualProfile";
import {
  AirboxLayer,
  SelectionHighlightLayer,
  resolveAirboxTopologyVisualizationSettings,
  resolveAirboxWireframeEdgeIndices,
  resolveAirboxWireframeSemantic,
} from "./BoundsLayers";
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
