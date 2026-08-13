import { act } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString, renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";

import { PlanarVisualizationSection } from "./PlanarVisualizationSection";
import {
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

const mocks = vi.hoisted(() => ({
  queuePatch: vi.fn(),
  overlay: {
    available: true,
    boundary_classification: "exact",
    codec: "fmcs.v4",
  },
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    visualizationSync: {
      queuePatch: mocks.queuePatch,
    },
  }),
}));

vi.mock("@/kernel/resources/planarFieldResources", () => ({
  usePlanarFieldMetaResource: () => ({
    data: {
      canonical_unit: "A/m",
      mesh_overlay_descriptor: mocks.overlay,
      occupancy: { occupied_measure: 1 },
      sampling_method: "fdm_cell_constant",
    },
    status: "ready",
  }),
}));

vi.mock("@/kernel/resources/planarMonitorResources", () => ({
  usePlanarMonitorsResource: () => ({
    data: {
      monitors: [{ id: "plane-1", name: "Mid-plane" }],
    },
  }),
}));

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useFieldCatalogResource: () => ({
    data: {
      quantities: [
        {
          available: true,
          components: 3,
          label: "Magnetization",
          quantity_id: "m",
          unit: "1",
        },
        {
          available: true,
          components: 3,
          label: "Effective field",
          quantity_id: "h_eff",
          unit: "A/m",
        },
      ],
    },
  }),
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionStatusSelector: (selector: (status: unknown) => unknown) =>
    selector({ data: { domain: { discretization: "fem" } } }),
}));

vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: () => ({
    data: {
      planar: {
        active_monitor_id: "plane-1",
        colormap: "viridis",
        component: "magnitude",
        display_unit: "A/m",
        layers: {
          boundaries: true,
          contours: false,
          mesh: true,
          probes: true,
          raster: true,
          vectors: false,
        },
        quantity_id: "h_eff",
        range: { mode: "auto", min: null, max: null },
        raster_opacity: 1,
        interaction: { pan_u_m: 0, pan_v_m: 0, zoom: 1 },
        quality: "interactive",
        resolution: { height: 256, vector_budget: 512, width: 512 },
        vector_style: { color_mode: "orientation", length_mode: "uniform", scale: 1 },
        view_scope: { kind: "target" },
      },
    },
    optimisticData: null,
  }),
}));

const selection: Selection = {
  kind: "model.object",
  label: "Free layer",
  moduleSource: "inspector",
  nodeId: "model:object:free-layer",
  objectId: "free-layer",
  ref: null,
};

describe("PlanarVisualizationSection", () => {
  beforeEach(() => {
    mocks.queuePatch.mockClear();
    mocks.overlay.available = true;
    mocks.overlay.boundary_classification = "exact";
    mocks.overlay.codec = "fmcs.v4";
  });

  it("server-renders shared quantity, component, unit, range and scope controls", () => {
    const html = renderToStaticMarkup(
      <PlanarVisualizationSection selection={selection} />,
    );

    expect(html).toContain("2D visualization");
    expect(html).toContain("Mid-plane");
    expect(html).toContain("Effective field (A/m)");
    expect(html).toContain("in plane magnitude");
    expect(html).toContain("Display unit");
    expect(html).toContain('aria-label="Range mode"');
    expect(html).toContain("Use target scope");
    expect(html).not.toContain("sessions/current");
  });

  it("renders the complete v7 planar presentation contract without 3D-only controls", () => {
    const html = renderToStaticMarkup(
      <PlanarVisualizationSection selection={selection} />,
    );

    for (const label of [
      "Raster opacity",
      "Range mode",
      "Layer raster",
      "Layer contours",
      "Layer mesh",
      "Layer boundaries",
      "Layer vectors",
      "Layer probes",
      "Glyph",
      "Vector density",
      "Vector scale",
      "Vector length mode",
      "Vector color mode",
      "Render quality",
      "Resolution width",
      "Resolution height",
      "Interaction zoom",
    ]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).toContain("Mesh overlay: exact boundaries");
    expect(html).not.toContain("Surface opacity");
    expect(html).not.toContain("Wireframe opacity");
  });

  it("patches every planar presentation control through the canonical resource", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<PlanarVisualizationSection selection={selection} />));
      await act(async () => change(findControl(container, "Color map"), "inferno"));
      await act(async () => change(findControl(container, "Display unit"), "kA/m"));
      await act(async () => change(findControl(container, "Range mode"), "symmetric"));
      await act(async () => toggle(findControl(container, "Layer raster")));
      await act(async () => toggle(findControl(container, "Layer contours")));
      await act(async () => toggle(findControl(container, "Layer mesh")));
      await act(async () => toggle(findControl(container, "Layer boundaries")));
      await act(async () => toggle(findControl(container, "Layer vectors")));
      await act(async () => toggle(findControl(container, "Layer probes")));
      await act(async () => change(findControl(container, "Render quality"), "export"));
      await act(async () => change(findControl(container, "Vector length mode"), "magnitude"));
      await act(async () => change(findControl(container, "Vector color mode"), "monochrome"));

      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { colormap: "inferno" } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { display_unit: "kA/m" } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { range: { mode: "symmetric", min: null, max: null } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { layers: { boundaries: true, contours: false, mesh: true, probes: true, raster: false, vectors: false } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { layers: { boundaries: true, contours: true, mesh: true, probes: true, raster: true, vectors: false } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { layers: { boundaries: true, contours: false, mesh: false, probes: true, raster: true, vectors: false } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { layers: { boundaries: false, contours: false, mesh: true, probes: true, raster: true, vectors: false } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { layers: { boundaries: true, contours: false, mesh: true, probes: true, raster: true, vectors: true } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { layers: { boundaries: true, contours: false, mesh: true, probes: false, raster: true, vectors: false } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { quality: "export" } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { vector_style: { color_mode: "orientation", length_mode: "magnitude", scale: 1 } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { vector_style: { color_mode: "monochrome", length_mode: "uniform", scale: 1 } } });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("hydrates its server snapshot without a mismatch", async () => {
    const serverHtml = renderToString(<PlanarVisualizationSection selection={selection} />);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    (container as unknown as { innerHTML: string }).innerHTML = serverHtml;
    const recoverableErrors: Error[] = [];
    let root: ReturnType<typeof hydrateRoot>;
    try {
      await act(async () => {
        root = hydrateRoot(container as unknown as Element, <PlanarVisualizationSection selection={selection} />, {
          onRecoverableError: (error) => recoverableErrors.push(
            error instanceof Error ? error : new Error(String(error)),
          ),
        });
        await Promise.resolve();
      });
      expect(recoverableErrors).toEqual([]);
    } finally {
      await act(async () => root!.unmount());
      dom.restore();
    }
  });

  it("fails closed for degraded mesh-boundary descriptors with an explicit reason", () => {
    mocks.overlay.available = true;
    mocks.overlay.boundary_classification = "degraded_v3";
    const html = renderToStaticMarkup(<PlanarVisualizationSection selection={selection} />);
    expect(html).toContain('aria-label="Layer boundaries"');
    expect(html).toContain("disabled");
    expect(html).toContain("Exact boundaries are unavailable for this overlay descriptor.");
    mocks.overlay.boundary_classification = "exact";
  });

  it("fails closed for unavailable FDM boundary evidence with an explicit reason", () => {
    mocks.overlay.available = false;
    const html = renderToStaticMarkup(<PlanarVisualizationSection selection={selection} />);
    expect(html).toContain('aria-label="Layer boundaries"');
    expect(html).toContain("Mesh overlay is unavailable for this sample.");
    expect(html).toContain("Mesh overlay degraded or unavailable");
    mocks.overlay.available = true;
  });
});

function findControl(root: TestNode, label: string): TestElement {
  const control = findElements(root, (element) => element.getAttribute("aria-label") === label)[0];
  if (!control) throw new Error(`Missing control ${label}`);
  return control;
}

function change(element: TestElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new TestEvent(
    element.tagName === "INPUT" ? "input" : "change",
    { bubbles: true },
  ));
}

function toggle(element: TestElement): void {
  const control = element as TestElement & { checked?: boolean };
  control.checked = !control.checked;
  element.dispatchEvent(new TestEvent("click", { bubbles: true }));
}


function findElements(root: TestNode, predicate: (element: TestElement) => boolean): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode) => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    node.childNodes.forEach(visit);
  };
  visit(root);
  return found;
}
