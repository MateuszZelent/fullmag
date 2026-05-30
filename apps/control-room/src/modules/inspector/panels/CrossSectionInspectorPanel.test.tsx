import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  beginCrossSectionDraft,
  commitCrossSectionDraft,
  resetCrossSectionWorkspaceForTests,
  updateCrossSectionDraft,
} from "@/kernel/workspace/crossSectionWorkspace";

import { CrossSectionInspectorPanel } from "./CrossSectionInspectorPanel";

vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: () => ({
    data: {
      clip: {
        axis: "z",
        enabled: true,
        flipped: false,
        position_percent: 50,
      },
      revision: 4,
      slice: {
        axis: "z",
        mesh_quality_metric: "gamma",
        show_mesh: true,
      },
    },
    error: null,
    status: "ready",
  }),
}));

vi.mock("@/kernel/resources/crossSectionResources", () => ({
  useCrossSectionQualityResource: () => ({
    data: {
      perElementQuality: new Float32Array([0.2, 0.8]),
      range: { min: 0.2, max: 0.8 },
    },
    error: null,
    status: "ready",
  }),
  useCrossSectionResource: () => ({
    data: {
      bounds: { uMin: 0, uMax: 4, vMin: 0, vMax: 2 },
      intersectionEdgeNodeIds: new Uint32Array(16),
      intersectionEdgeT: new Float32Array(8),
      intersectionKinds: new Uint32Array([0, 1, 0, 1, 0, 0, 1, 0]),
      intersectionWorld: new Float32Array(24),
      parentElementIds: new Uint32Array([7, 8]),
      polygonCount: 2,
      polygonOffsets: new Uint32Array([0, 4, 8]),
      segmentCount: 0,
      segments: new Float32Array(),
      vertexCount: 8,
      vertices: new Float32Array([
        0, 0,
        2, 0,
        2, 2,
        0, 2,
        2, 0,
        4, 0,
        4, 2,
        2, 2,
      ]),
    },
    error: null,
    status: "ready",
  }),
}));

const selection: Selection = {
  kind: "mesh.cross-section",
  label: "Cross-section parent tet 8",
  moduleSource: "viewport-2d",
  nodeId: "model:mesh:quality:cross-section:8",
  objectId: null,
  ref: {
    centroid: [3, 1, 0],
    elementIndex: 8,
    kind: "mesh.quality.element",
    metric: "gamma",
    nodeId: "model:mesh:quality:cross-section:8",
    type: "mesh-quality-element",
    visualizationTargetId: "mesh:quality:element:8",
  },
};

describe("CrossSectionInspectorPanel", () => {
  beforeEach(() => {
    resetCrossSectionWorkspaceForTests();
  });

  it("renders cut-plane parameters, quality stats, and selected parent tet", () => {
    const html = renderToStaticMarkup(
      <CrossSectionInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Cut Plane");
    expect(html).toContain("XY");
    expect(html).toContain("Universe");
    expect(html).toContain("50");
    expect(html).toContain("0");
    expect(html).toContain("Cross-Section Statistics");
    expect(html).toContain("Mesh nodes on plane");
    expect(html).toContain("Edge-plane intersections");
    expect(html).toContain("Intersection points");
    expect(html).toContain("2");
    expect(html).toContain("3");
    expect(html).toContain("5");
    expect(html).toContain("Selected Element");
    expect(html).toContain("8");
    expect(html).toContain("0.800");
  });

  it("renders the saved frame parameters for a committed plot selection", () => {
    beginCrossSectionDraft();
    updateCrossSectionDraft({
      metric: "aspect_ratio",
      name: "Interface cut",
      plane: "xz",
      positionPercent: 25,
      rotationDegrees: 12.5,
    });
    const plot = commitCrossSectionDraft();
    if (!plot) throw new Error("Expected committed cross-section plot");

    const html = renderToStaticMarkup(
      <CrossSectionInspectorPanel
        selection={{
          kind: "mesh.cross-section.plot",
          label: plot.name,
          moduleSource: "explorer",
          nodeId: `model:visualizations-2d:${plot.id}`,
          objectId: null,
          ref: {
            kind: "mesh.cross-section.plot",
            nodeId: `model:visualizations-2d:${plot.id}`,
            plotId: plot.id,
            type: "cross-section-plot",
            visualizationTargetId: `cross-section:plot:${plot.id}`,
          },
        }}
      />,
    );

    expect(html).toContain("Interface cut");
    expect(html).toContain("XZ");
    expect(html).toContain("Universe");
    expect(html).toContain("25");
    expect(html).toContain("12.5");
    expect(html).toContain("aspect_ratio");
  });
});
