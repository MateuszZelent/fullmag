import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  beginCrossSectionDraft,
  commitCrossSectionDraft,
  resetCrossSectionWorkspaceForTests,
  updateCrossSectionDraft,
  updateCrossSectionPlot,
} from "@/kernel/workspace/crossSectionWorkspace";

import {
  createInspectorEditSessionStore,
  InspectorEditSessionProvider,
} from "../InspectorEditSession";
import { CrossSectionInspectorPanel } from "./CrossSectionInspectorPanel";

const resourceMocks = vi.hoisted(() => ({
  crossSection: null as null | Record<string, unknown>,
  qualityEnabled: [] as boolean[],
  sessionIdentity: {
    requestScopeEpoch: "1",
    sessionEpoch: "1",
    sessionId: "cross-section-test",
  },
}));

vi.mock("@/kernel/KernelContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/kernel/KernelContext")>()),
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

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => resourceMocks.sessionIdentity,
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
    const { createRoot } = await import("react-dom/client");
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

  it("blocks New Image for pending plot text, preserves it on same-plot updates, and clears it on retarget", async () => {
    const firstPlot = createSavedPlot("First image", 25, 1.25);
    const secondPlot = createSavedPlot("Second image", 75, 2.25);
    const editSessionStore = createInspectorEditSessionStore();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const renderSelection = (plot: ReturnType<typeof createSavedPlot>) =>
      root.render(
        <InspectorEditSessionProvider store={editSessionStore}>
          <CrossSectionInspectorPanel selection={selectionForPlot(plot)} />
        </InspectorEditSessionProvider>,
      );
    try {
      await act(async () => renderSelection(firstPlot));

      const edgeWidth = findElement(container, "Edge width");
      if (!edgeWidth) throw new Error("Missing Edge width input");
      await act(async () => editInput(edgeWidth, "-"));
      expect(edgeWidth.value).toBe("-");
      expect(findButton(container, "New Image").getAttribute("disabled")).toBe("");
      expect(editSessionStore.getCurrentSession()).toMatchObject({
        applyBlockReason: "Correct Edge width before applying.",
        dirty: true,
        valid: false,
      });

      const updatedFirstPlot = updateCrossSectionPlot(firstPlot.id, {
        name: "First image renamed",
      });
      if (!updatedFirstPlot) throw new Error("Expected updated first plot");
      await act(async () => renderSelection(updatedFirstPlot));
      expect(findElement(container, "Edge width")?.value).toBe("-");

      await act(async () => renderSelection(secondPlot));
      expect(findElement(container, "Edge width")?.value).toBe("2.25");
      expect(editSessionStore.getCurrentSession()).toBeNull();
      expect(findButton(container, "New Image").getAttribute("disabled")).toBeNull();
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

function findButton(root: TestNode, text: string): TestElement {
  const button = findElements(
    root,
    (element) => element.tagName === "BUTTON" && element.textContent.includes(text),
  )[0];
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

function findElements(
  root: TestNode,
  predicate: (element: TestElement) => boolean,
): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode): void => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    node.childNodes.forEach(visit);
  };
  visit(root);
  return found;
}

function editInput(input: TestElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new TestEvent("input", { bubbles: true }));
}

function createSavedPlot(name: string, positionPercent: number, edgeWidth: number) {
  beginCrossSectionDraft();
  updateCrossSectionDraft({ name, positionPercent, edgeWidth });
  const plot = commitCrossSectionDraft();
  if (!plot) throw new Error("Expected saved cross-section plot");
  return plot;
}

function selectionForPlot(plot: ReturnType<typeof createSavedPlot>): Selection {
  return {
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
  };
}
