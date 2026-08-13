import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSimulationPreparationTestDom,
  TestElement,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  beginCrossSectionDraft,
  commitCrossSectionDraft,
  resetCrossSectionWorkspaceForTests,
  updateCrossSectionDraft,
} from "@/kernel/workspace/crossSectionWorkspace";

import { CrossSectionInspectorPanel } from "./CrossSectionInspectorPanel";

const resourceMocks = vi.hoisted(() => ({
  crossSection: null as null | Record<string, unknown>,
  qualityEnabled: [] as boolean[],
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    layout: {
      setActiveViewportMainModule: vi.fn(),
      setFocusedSlot: vi.fn(),
      setPanelVisible: vi.fn(),
    },
    selection: {
      set: vi.fn(),
    },
  }),
}));

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
  useCrossSectionQualityResource: (
    _query: unknown,
    options: { enabled?: boolean },
  ) => {
    resourceMocks.qualityEnabled.push(options.enabled ?? true);
    return {
      data: {
        perElementQuality: new Float32Array([0.2, 0.8]),
        range: { min: 0.2, max: 0.8 },
      },
      error: null,
      status: "ready",
    };
  },
  useCrossSectionResource: () =>
    resourceMocks.crossSection ?? {
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
    },
}));

const selection: Selection = {
  kind: "mesh.cross-section",
  label: "Cross-section parent tet 8",
  moduleSource: "cross-section-image",
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
    resourceMocks.crossSection = null;
    resourceMocks.qualityEnabled.length = 0;
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

  it("renders the saved frame parameters for a committed plot selection", async () => {
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

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
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
      ));
      expect(findElement(container, "Name")?.value).toBe("Interface cut");
      expect(findElement(container, "Position")?.value).toBe("25");
      expect(findElement(container, "Rotation")?.value).toBe("12.5");
      expect(container.textContent).toContain("Plot Parameters");
      expect(container.textContent).toContain("New Image");
      expect(findElement(container, "Position slider")).toBeDefined();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("renders a dedicated mixed-topology unsupported state without requesting quality", () => {
    resourceMocks.crossSection = {
      data: null,
      error: Object.assign(new Error("cross-section slicing is tet4-only"), {
        code: "mixed_topology_not_supported",
        status: 409,
      }),
      status: "error",
    };

    const html = renderToStaticMarkup(
      <CrossSectionInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Mixed topology cross-sections are not supported");
    expect(html).toContain("prism and pyramid cells");
    expect(html).not.toContain("cross-section slicing is tet4-only");
    expect(resourceMocks.qualityEnabled).toEqual([false]);
  });
});

function findElement(root: TestNode, ariaLabel: string): TestElement | undefined {
  if (root instanceof TestElement && root.getAttribute("aria-label") === ariaLabel) return root;
  for (const child of root.childNodes) {
    const match = findElement(child, ariaLabel);
    if (match) return match;
  }
  return undefined;
}
