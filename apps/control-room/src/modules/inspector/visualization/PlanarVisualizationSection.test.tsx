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
  components: 3,
  discretization: "fem",
  queuePatch: vi.fn(),
  maskStatus: "ready" as "error" | "idle" | "loading" | "ready" | "stale",
  overlay: {
    available: true,
    boundary_classification: "exact",
    codec: "fmcs.v4",
  },
  planar: {
    visible: true,
    colormap: "viridis",
    component: "magnitude",
    display_unit: "A/m",
    layers: {
      boundaries: true,
      bounds: false,
      contours: false,
      mesh: true,
      points: false,
      probes: true,
      raster: true,
      vectors: false,
    },
    quantity_id: "h_eff",
    source: { kind: "monitor", monitor_id: "plane-1" } as
      | { kind: "default" }
      | { kind: "monitor"; monitor_id: string },
    default_slice: {
      operator: { kind: "plane_sample" },
      plane: "xy" as const,
      position_fraction: 0.5,
    },
    range: { mode: "manual", min: -1, max: 1 },
    raster_opacity: 1,
    viewport_colorbar_visible: true,
    wireframe_style: { color: "#94a3b8", opacity: 1 },
    point_style: { color: "#89b4fa", opacity: 1, size: 3 },
    interaction: { pan_u_m: 0, pan_v_m: 0, zoom: 1 },
    quality: "interactive",
    resolution: { height: 256, vector_budget: 512, width: 512 },
    vector_style: {
      color_mode: "orientation",
      length_mode: "uniform",
      monochrome_color: "#cdd6f4",
      opacity: 1,
      scale: 1,
      thickness: 1,
    },
    view_scope: { kind: "monitor_target" } as
      | { kind: "monitor_target" }
      | { kind: "mesh_part"; scope_id: string }
      | { kind: "airbox" },
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
  planarFieldQueryFromMeta: () => ({ ok: true, query: { sample_token: "planar-sample-v2:sample" } }),
  usePlanarFieldMetaResource: () => ({
    data: {
      canonical_unit: "A/m",
      component: "magnitude",
      field_backend: "fem",
      field_device: "cpu",
      field_precision: "double",
      field_source: "live",
      mesh_overlay_descriptor: mocks.overlay,
      occupancy: { occupied_measure: 1 },
      operator: { kind: "plane_sample" },
      source: {
        kind: "monitor",
        monitor_hash: "sha256:monitor",
        monitor_id: "plane-1",
        monitor_revision: "2",
      },
      sampling_method: "fdm_cell_constant",
      sampling_execution: "cpu",
    },
    error: null,
    status: "ready",
  }),
  usePlanarMaskResource: () => ({ data: mocks.maskStatus === "ready" ? new ArrayBuffer(1) : null, error: null, status: mocks.maskStatus }),
}));

vi.mock("@/kernel/resources/planarMonitorResources", () => ({
  usePlanarMonitorsResource: () => ({
    data: {
      monitors: [{ id: "plane-1", name: "Mid-plane" }],
    },
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useDomainMetaResource: () => ({
    data: {
      bounds: { min: [10, 20, 30], max: [14, 26, 42] },
    },
    error: null,
    status: "ready",
  }),
}));

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useFieldCatalogResource: () => ({
    data: {
      quantities: [
        {
          available: true,
          components: mocks.components,
          label: "Magnetization",
          quantity_id: "m",
          unit: "1",
        },
        {
          available: true,
          components: mocks.components,
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
    selector({ data: { domain: { discretization: mocks.discretization } } }),
}));

vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: () => ({
    data: { planar: mocks.planar },
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
    mocks.components = 3;
    mocks.maskStatus = "ready";
    mocks.discretization = "fem";
    mocks.planar.source = { kind: "monitor", monitor_id: "plane-1" };
    mocks.planar.view_scope = { kind: "monitor_target" };
  });

  it("always offers Default and exposes plane/position controls without a monitor", () => {
    mocks.planar.source = { kind: "default" };
    mocks.planar.default_slice = {
      operator: { kind: "plane_sample" },
      plane: "xy",
      position_fraction: 0.5,
    };
    const html = renderToStaticMarkup(
      <PlanarVisualizationSection selection={selection} />,
    );

    expect(html).toContain('aria-label="Source"');
    expect(html).toContain(">Default<");
    expect(html).toContain('aria-label="Plane"');
    expect(html).toContain('aria-label="Position"');
    expect(html).toContain('aria-label="Coordinate (z)"');
    expect(html).toContain('aria-label="Sampling"');
    expect(html).not.toContain("Select monitor");
  });

  it("owns the source, quantity, component, and default-plane controls", () => {
    mocks.planar.source = { kind: "default" };
    const html = renderToStaticMarkup(
      <PlanarVisualizationSection selection={selection} />,
    );

    expect(html).toMatch(
      /<div(?=[^>]*aria-label="Planar field selection controls")(?=[^>]*role="group")[^>]*>/,
    );
    for (const label of ["Source", "Quantity", "Component", "Plane"]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
  });

  it("fails closed for points while the canonical occupancy mask is unavailable", () => {
    mocks.maskStatus = "loading";
    const html = renderToStaticMarkup(<PlanarVisualizationSection selection={selection} />);
    expect(html).toContain('aria-label="Toggle Points"');
    expect(html).toContain("disabled");
    expect(html).toContain("Sample points require the canonical occupancy mask.");
  });

  it("server-renders shared quantity, component, unit, range and scope controls", () => {
    const html = renderToStaticMarkup(
      <PlanarVisualizationSection selection={selection} />,
    );

    expect(html).toContain("Display");
    expect(html).toContain("Mid-plane");
    expect(html).toContain("Effective field (A/m)");
    expect(html).toContain("in plane magnitude");
    expect(html).toContain("Display unit");
    expect(html).toContain('aria-label="Range mode"');
    expect(html).toContain("Use target scope");
    expect(html).not.toContain("sessions/current");
  });

  it("shows runtime field provenance in the planar inspector", () => {
    const html = renderToStaticMarkup(
      <PlanarVisualizationSection selection={selection} />,
    );

    expect(html).toContain("Field backend");
    expect(html).toContain("fem");
    expect(html).toContain("Field device");
    expect(html).toContain("cpu");
    expect(html).toContain("Field precision");
    expect(html).toContain("double");
    expect(html).toContain("Field source");
    expect(html).toContain("live");
  });

  it("renders the same visualization Inspector composition as 3D plus planar controls", () => {
    const html = renderToStaticMarkup(
      <PlanarVisualizationSection selection={selection} />,
    );

    for (const section of [
      "Display",
      "Surface Coloring",
      "Vectors",
      "Wireframe",
      "Source &amp; Slice",
      "Sampling &amp; Resolution",
    ]) {
      expect(html).toContain(section);
    }
    for (const label of [
      "Render mode",
      "Toggle Visible",
      "Toggle Bounds",
      "Toggle Vectors",
      "Raster opacity",
      "Range mode",
      "Viewport colorbar",
      "Wireframe color value",
      "Wireframe opacity",
      "Vector density",
      "Vector scale",
      "Vector opacity",
      "Vector thickness",
      "Vector length mode",
      "Vector color mode",
      "Render quality",
      "Resolution width",
      "Resolution height",
      "Interaction zoom",
    ]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).not.toContain("Geometry layers");
  });

  it("uses the canonical icon and summary navigation style for planar sections", () => {
    const html = renderToStaticMarkup(
      <PlanarVisualizationSection selection={selection} />,
    );

    expect(html).toContain("lucide-scan-line");
    expect(html).toContain("lucide-palette");
    expect(html).toContain("lucide-arrow-right-left");
    expect(html).toContain("Mid-plane • Monitor");
    expect(html).toContain("Viridis • Manual range");
    expect(html).toContain("Quiver • 512");
  });

  it("maps Shaded to a continuous heatmap without mesh or boundaries", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<PlanarVisualizationSection selection={selection} />));
      await act(async () => clickControl(container, "Shaded"));
      expect(mocks.queuePatch).toHaveBeenCalledWith({
        planar: {
          layers: {
            ...mocks.planar.layers,
            boundaries: false,
            mesh: false,
            points: false,
            raster: true,
          },
        },
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("patches every planar presentation control through the canonical resource", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<PlanarVisualizationSection selection={selection} />));
      await act(async () => change(findControl(container, "Source"), "plane-1"));
      await act(async () => change(findControl(container, "Quantity"), "m"));
      await act(async () => change(findControl(container, "Component"), "normal"));
      await act(async () => change(findControl(container, "Color map"), "inferno"));
      await act(async () => change(findControl(container, "Display unit"), "kA/m"));
      await act(async () => change(findControl(container, "Range mode"), "symmetric"));
      await act(async () => change(findControl(container, "Range minimum"), "-2"));
      await act(async () => change(findControl(container, "Range maximum"), "4"));
      await act(async () => change(findControl(container, "Raster opacity"), "0.5"));
      await act(async () => clickControl(container, "Toggle Bounds"));
      await act(async () => clickControl(container, "Toggle Contours"));
      await act(async () => clickControl(container, "Toggle Points"));
      await act(async () => clickControl(container, "Toggle Vectors"));
      await act(async () => clickControl(container, "Toggle Probes"));
      await act(async () => change(findControl(container, "Vector density"), "768"));
      await act(async () => change(findControl(container, "Vector scale"), "1.5"));
      await act(async () => change(findControl(container, "Vector opacity"), "0.5"));
      await act(async () => change(findControl(container, "Vector thickness"), "2"));
      await act(async () => change(findControl(container, "Render quality"), "export"));
      await act(async () => change(findControl(container, "Resolution width"), "768"));
      await act(async () => change(findControl(container, "Resolution height"), "384"));
      await act(async () => change(findControl(container, "Interaction zoom"), "2"));
      await act(async () => change(findControl(container, "Vector length mode"), "magnitude"));
      await act(async () => change(findControl(container, "Vector color mode"), "monochrome"));
      await act(async () => clickButton(container, "Use target scope"));

      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { source: { kind: "monitor", monitor_id: "plane-1" } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { component: "magnitude", quantity_id: "m" } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { component: "normal" } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { colormap: "inferno" } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { display_unit: "kA/m" } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { range: { mode: "symmetric", min: null, max: null } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { range: { mode: "manual", min: -2, max: 1 } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { range: { mode: "manual", min: -1, max: 4 } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { raster_opacity: 0.5 } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { layers: { boundaries: true, bounds: true, contours: false, mesh: true, points: false, probes: true, raster: true, vectors: false } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { layers: { boundaries: true, bounds: false, contours: true, mesh: true, points: false, probes: true, raster: true, vectors: false } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { layers: { boundaries: true, bounds: false, contours: false, mesh: true, points: true, probes: true, raster: true, vectors: false } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { layers: { boundaries: true, bounds: false, contours: false, mesh: true, points: false, probes: true, raster: true, vectors: true } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { layers: { boundaries: true, bounds: false, contours: false, mesh: true, points: false, probes: false, raster: true, vectors: false } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { resolution: { height: 256, vector_budget: 768, width: 512 } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { vector_style: { ...mocks.planar.vector_style, scale: 1.5 } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { vector_style: { ...mocks.planar.vector_style, opacity: 0.5 } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { vector_style: { ...mocks.planar.vector_style, thickness: 2 } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { quality: "export" } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { resolution: { height: 256, vector_budget: 512, width: 768 } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { resolution: { height: 384, vector_budget: 512, width: 512 } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { interaction: { pan_u_m: 0, pan_v_m: 0, zoom: 2 } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { vector_style: { ...mocks.planar.vector_style, length_mode: "magnitude" } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { vector_style: { ...mocks.planar.vector_style, color_mode: "monochrome" } } });
      expect(mocks.queuePatch).toHaveBeenCalledWith({ planar: { view_scope: { kind: "monitor_target" } } });
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
    expect(html).toContain("Exact boundaries are unavailable for this overlay descriptor.");
    mocks.overlay.boundary_classification = "exact";
  });

  it("fails closed for unavailable FDM boundary evidence with an explicit reason", () => {
    mocks.overlay.available = false;
    const html = renderToStaticMarkup(<PlanarVisualizationSection selection={selection} />);
    expect(html).not.toContain('aria-label="Shaded + Wireframe"');
    expect(html).toContain("Mesh overlay is unavailable for this sample.");
    mocks.overlay.available = true;
  });

  it.each([
    [
      "an unsupported fmcs.v3 descriptor",
      () => { mocks.overlay.codec = "fmcs.v3"; },
      "Mesh overlay",
      "Mesh overlay requires the fmcs.v4 or fmfg.v1 descriptor codec.",
    ],
    [
      "an FDM mesh-part scope",
      () => {
        mocks.discretization = "fdm";
        mocks.planar.view_scope = { kind: "mesh_part", scope_id: "part-1" };
      },
      "Mesh overlay",
      "Structured FDM sampling does not support mesh-part or airbox scope.",
    ],
    [
      "an FDM airbox scope",
      () => {
        mocks.discretization = "fdm";
        mocks.planar.view_scope = { kind: "airbox" };
      },
      "Mesh overlay",
      "Structured FDM sampling does not support mesh-part or airbox scope.",
    ],
    [
      "a scalar quantity vector control",
      () => { mocks.components = 1; },
      "Vector density",
      "The selected scalar quantity has no vector components.",
    ],
  ])("renders disabled controls and a visible reason for %s", async (_name, configure, label, reason) => {
    configure();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<PlanarVisualizationSection selection={selection} />));
      if (label === "Mesh overlay") {
        expect(container.textContent).toContain("Mesh overlay");
        expect(findElements(container, (element) => element.getAttribute("aria-label") === "Shaded + Wireframe")).toHaveLength(0);
      } else {
        expect(findControl(container, label).disabled).toBe(true);
      }
      expect(container.textContent).toContain(reason);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function findControl(root: TestNode, label: string): TestElement {
  const control = findElements(root, (element) => element.getAttribute("aria-label") === label)[0];
  if (!control) throw new Error(`Missing control ${label}`);
  return control;
}

function change(element: TestElement, value: string): void {
  const tracker = (element as TestElement & {
    _valueTracker?: { setValue: (next: string) => void };
  })._valueTracker;
  const previous = element.value;
  element.value = value;
  tracker?.setValue(previous);
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

function clickButton(root: TestNode, label: string): void {
  const button = findElements(
    root,
    (element) => element.tagName === "BUTTON" && element.textContent === label,
  )[0];
  if (!button) throw new Error(`Missing button ${label}`);
  button.click();
}

function clickControl(root: TestNode, label: string): void {
  const button = findElements(
    root,
    (element) =>
      element.tagName === "BUTTON" && element.getAttribute("aria-label") === label,
  )[0];
  if (!button) throw new Error(`Missing button ${label}`);
  button.click();
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
