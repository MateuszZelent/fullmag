import { act } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString, renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PlanarCropState,
  PlanarFieldMetaResource,
  QuantityCatalogResource,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { fieldMapSurfaceStore } from "@/kernel/visualization/fieldMapSurfaceStore";
import { resolvePlanarSectionGeometryFromMeta } from "@/kernel/visualization/planarSectionModel";
import {
  findElements,
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { createInspectorEditSessionStore, InspectorEditSessionProvider } from "../InspectorEditSession";
import { createFieldLayer, type PlanarFieldLayer } from "./planarFieldLayers";
import { PlanarVisualizationSection } from "./PlanarVisualizationSection";

type Planar = NonNullable<VisualizationStateResource["planar"]>;

const mocks = vi.hoisted(() => ({
  components: 3,
  discretization: "fem",
  section: null as unknown,
  optimisticPlanar: null as unknown,
  queuePatch: vi.fn(),
  queuePlanarFieldOverlayPatch: vi.fn(),
  queuePlanarTargetOverride: vi.fn(),
  queuePlanarCropPatch: vi.fn(),
  flushNow: vi.fn(async () => undefined),
  execute: vi.fn(async () => ({ status: "completed" })),
  targets: {
    airbox: { scope: "airbox", scope_id: "airbox", label: "Airbox" },
    objects: [{ scope: "object", scope_id: "free-layer", label: "film" }] as { scope: string; scope_id: string; label?: string }[],
    parts: [{ scope: "part", scope_id: "tetrahedra" }],
  },
  planar: null as unknown as Record<string, unknown>,
}));

function basePlanar(): Planar {
  return {
    visible: true,
    layer_model: "layers",
    colormap: "hsl_direction",
    component: "magnitude",
    display_unit: null,
    crop: null,
    layers: {
      boundaries: false,
      bounds: false,
      contours: false,
      mesh: true,
      points: false,
      probes: true,
      raster: true,
      streamlines: false,
      vectors: false,
    },
    quantity_id: "m",
    source: { kind: "default" },
    default_slice: { operator: { kind: "plane_sample" }, plane: "xy", position_fraction: 0.5 },
    range: { mode: "auto", min: null, max: null },
    raster_opacity: 1,
    viewport_colorbar_visible: true,
    wireframe_style: { color: "#94a3b8", opacity: 1 },
    target_overrides: [
      { scope: "object", scope_id: "free-layer", wireframe_style: { color: "#ff0000", opacity: 0.4 } },
      { scope: "airbox", scope_id: "airbox", wireframe_style: { color: "#00ff00", opacity: 0.6 } },
    ],
    point_style: { color: "#89b4fa", opacity: 1, size: 3 },
    interaction: { pan_u_m: 0, pan_v_m: 0, zoom: 1 },
    quality: "interactive",
    resolution: { height: 512, vector_budget: 2000, width: 512 },
    vector_style: {
      color_mode: "orientation", length_mode: "uniform", monochrome_color: "#cdd6f4",
      opacity: 1, scale: 1, thickness: 1,
    },
    field_overlays: [createFieldLayer("all")],
    multislice: { enabled: false, position_fractions: [0.25, 0.5, 0.75] },
    view_scope: { kind: "monitor_target" },
  } as Planar;
}

function planar(): Planar {
  return mocks.planar as unknown as Planar;
}

const filmLayer = (overrides: Partial<PlanarFieldLayer> = {}): PlanarFieldLayer => ({
  ...createFieldLayer({ id: "object:free-layer", kind: "object" }),
  ...overrides,
});

vi.mock("@/kernel/KernelContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/kernel/KernelContext")>()),
  useKernel: () => ({
    commands: { execute: mocks.execute, getSessionScopeKey: () => null },
    visualizationSync: {
      flushNow: mocks.flushNow,
      queuePatch: mocks.queuePatch,
      queuePlanarCropPatch: mocks.queuePlanarCropPatch,
      queuePlanarFieldOverlayPatch: mocks.queuePlanarFieldOverlayPatch,
      queuePlanarTargetOverride: mocks.queuePlanarTargetOverride,
    },
  }),
}));

vi.mock("@/kernel/resources/planarFieldResources", () => ({
  planarFieldQueryFromMeta: () => ({ ok: true, query: { sample_token: "planar-sample-v2:sample" } }),
  usePlanarFieldMetaResource: () => ({
    data: {
      canonical_unit: "1",
      component: "magnitude",
      field_backend: "fem",
      field_device: "cpu",
      field_precision: "double",
      field_source: "live",
      frame: {
        bounds_uv_m: [-25e-9, 25e-9, -30e-9, 30e-9],
        full_bounds_uv_m: [-25e-9, 25e-9, -30e-9, 30e-9],
      },
      mesh_overlay_descriptor: { available: true, boundary_classification: "exact", codec: "fmcs.v4" },
      occupancy: { occupied_measure: 1 },
      operator: { kind: "plane_sample" },
      section: mocks.section,
      source: { kind: "default", default_slice_hash: "sha256:slice", default_slice_revision: "1" },
      sampling_method: "fem_plane_sample",
      sampling_execution: "cpu",
    },
    error: null,
    status: "ready",
  }),
  usePlanarMaskResource: () => ({ data: new ArrayBuffer(1), error: null, status: "ready" }),
}));

vi.mock("@/kernel/resources/planarMonitorResources", () => ({
  usePlanarMonitorsResource: () => ({ data: { monitors: [{ id: "plane-1", name: "Mid-plane" }] } }),
}));

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useQuantityCatalogResource: () => ({
    data: {
      schema_version: "1.0",
      quantities: ["m", "h_eff", "H_demag"].map((id) => ({
        id, label: id, description: "", domain: "magnetic_only",
        shape: mocks.components === 1 ? "spatial_scalar" : "vector_field",
        unit: id === "m" ? "1" : "A/m", n_comp: mocks.components, location: "node",
        normalization_hint: "none", interactive_preview: true,
        supports_preview_2d: true, supports_preview_3d: true,
        supports_history: false, supports_export: true, capability_state: "supported",
        solver_capability: "supported", requestable: true, renderable: true,
        materializable: true, materialization_state: "complete", publication_state: "interactive",
        resolved_capability: {
          quantity_id: id, provider: "available",
          request: "field_vector", materialization: "materialized", render: "renderable",
          publication: "interactive", scope: "object", lane: "test", precision: "double", carriers: [],
        },
      })),
    } satisfies QuantityCatalogResource,
    error: null,
    status: "ready",
  }),
  useFieldCatalogResource: () => ({
    data: {
      quantities: [
        { available: true, components: mocks.components, label: "Magnetization", quantity_id: "m", unit: "1" },
        { available: true, components: mocks.components, label: "Effective field", quantity_id: "h_eff", unit: "A/m" },
        { available: true, components: mocks.components, label: "Demagnetizing field", quantity_id: "H_demag", unit: "A/m" },
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
    data: { planar: mocks.planar, targets: mocks.targets },
    optimisticData: mocks.optimisticPlanar ? { planar: mocks.optimisticPlanar, targets: mocks.targets } : null,
    status: "ready",
  }),
}));

const objectSelection: Selection = {
  kind: "model.object",
  label: "Free layer",
  moduleSource: "inspector",
  nodeId: "model:object:free-layer",
  objectId: "free-layer",
  ref: null,
};

const airboxSelection: Selection = {
  kind: "airbox.visualization",
  label: "Airbox",
  moduleSource: "inspector",
  nodeId: "model:airbox:visualization",
  objectId: null,
  ref: {
    kind: "airbox.visualization",
    nodeId: "model:airbox:visualization",
    type: "airbox",
    visualizationTargetId: "airbox",
  },
};

const regionSelection: Selection = {
  kind: "object.region.visualization",
  label: "Airbox",
  moduleSource: "inspector",
  nodeId: "model:object:free-layer:region:r1",
  objectId: "free-layer",
  ref: {
    kind: "object.region.visualization",
    nodeId: "model:object:free-layer:region:r1",
    objectId: "free-layer",
    regionId: "r1",
    type: "scene-object",
    visualizationTargetId: "region:free-layer:r1",
  },
};

const sceneSelection: Selection = {
  kind: "scene",
  label: "Scene",
  moduleSource: "inspector",
  nodeId: "model:scene",
  objectId: null,
  ref: null,
};

async function mount(selection: Selection) {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const root = createRoot(container as unknown as Element);
  const store = createInspectorEditSessionStore();
  const render = () => root.render(
    <InspectorEditSessionProvider store={store}>
      <PlanarVisualizationSection selection={selection} />
    </InspectorEditSessionProvider>,
  );
  await act(async () => render());
  return {
    container,
    dom,
    rerender: () => act(async () => render()),
    store,
    unmount: async () => {
      await act(async () => root.unmount());
      dom.restore();
    },
  };
}

function lastOverlayWrite(): { layers: PlanarFieldLayer[]; touched: string } {
  const call = mocks.queuePlanarFieldOverlayPatch.mock.calls.at(-1);
  if (!call) throw new Error("No field layer write");
  return { layers: call[0].planar.field_overlays, touched: call[1] };
}

describe("PlanarVisualizationSection", () => {
  beforeEach(() => {
    fieldMapSurfaceStore.reset();
    mocks.planar = basePlanar() as unknown as Record<string, unknown>;
    mocks.optimisticPlanar = null;
    mocks.components = 3;
    mocks.section = null;
    for (const fn of [mocks.queuePatch, mocks.queuePlanarFieldOverlayPatch, mocks.queuePlanarTargetOverride,
      mocks.queuePlanarCropPatch, mocks.flushNow, mocks.execute]) fn.mockClear();
  });

  it("shows one status line instead of four overview tiles", () => {
    const html = renderToStaticMarkup(<PlanarVisualizationSection selection={sceneSelection} />);
    expect(html).toContain('aria-label="2D view status"');
    expect(html).toContain("2D view closed");
    expect(html).toContain("Mesh ready");
    expect(html).not.toContain("Display Passes");
    expect(html).not.toContain("Quantity Source");
    expect(html).toContain("1 / 16");
  });

  it("selects the layer of the object selected in the model tree", async () => {
    planar().field_overlays = [createFieldLayer("all"), filmLayer()];
    const view = await mount(objectSelection);
    try {
      const rows = findElements(view.container, (element) => element.getAttribute("data-layer-id") !== null);
      expect(rows.map((row) => row.getAttribute("data-layer-id"))).toEqual(["all", "object:free-layer"]);
      expect(rows[1]!.getAttribute("aria-current")).toBe("true");
      expect(rows[1]!.textContent).toContain("film · m · direction");
      expect(view.container.textContent).toContain("Field in film");
      expect(view.container.textContent).toContain("Own setting · Magnetization · direction");
    } finally {
      await view.unmount();
    }
  });

  it("shows the inherited field of an object and creates its layer only from a chosen quantity", async () => {
    const view = await mount(objectSelection);
    try {
      expect(mocks.queuePlanarFieldOverlayPatch).not.toHaveBeenCalled();
      expect(view.container.textContent).toContain("Inherited from All objects · Magnetization · direction");
      await act(async () => change(findControl(view.container, "Quantity"), "H_demag"));
      const write = lastOverlayWrite();
      expect(write.touched).toBe("object:free-layer");
      expect(write.layers.map((layer) => layer.id)).toEqual(["object:free-layer", "all"]);
      expect(write.layers[0]).toMatchObject({
        quantity_id: "H_demag", colormap: "viridis", view_scope: { kind: "object", scope_id: "free-layer" },
      });
      expect(mocks.queuePatch).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });

  it("adds an Airbox layer without changing the base view scope", async () => {
    const view = await mount(airboxSelection);
    try {
      expect(view.container.textContent).toContain("Not drawn in the 2D view");
      await act(async () => change(findControl(view.container, "Quantity"), "h_eff"));
      const write = lastOverlayWrite();
      expect(write.touched).toBe("airbox");
      expect(write.layers[0]).toMatchObject({ id: "airbox", quantity_id: "h_eff", view_scope: { kind: "airbox" } });
      const patch = mocks.queuePlanarFieldOverlayPatch.mock.calls.at(-1)![0].planar;
      expect(Object.keys(patch)).toEqual(["field_overlays"]);
      expect(mocks.queuePatch).not.toHaveBeenCalled();
      expect(planar().view_scope).toEqual({ kind: "monitor_target" });
    } finally {
      await view.unmount();
    }
  });

  it("renders a masked pass as on with a toolbar note", async () => {
    planar().field_overlays = [filmLayer({ vectors_visible: true })];
    const view = await mount(objectSelection);
    try {
      const vectors = findControl(view.container, "Toggle Arrows");
      expect(vectors.getAttribute("aria-pressed")).toBe("true");
      expect(vectors.textContent).toContain("hidden in toolbar");
      expect(findControl(view.container, "Toggle Points").getAttribute("aria-pressed")).toBe("false");
    } finally {
      await view.unmount();
    }
  });

  it("flushes a quantity change at once and writes only the selected layer", async () => {
    const all = createFieldLayer("all");
    planar().field_overlays = [filmLayer(), all];
    const view = await mount(objectSelection);
    try {
      await act(async () => change(findControl(view.container, "Quantity"), "h_eff"));
      const write = lastOverlayWrite();
      expect(write.touched).toBe("object:free-layer");
      expect(write.layers[0]).toMatchObject({ quantity_id: "h_eff", component: "magnitude" });
      expect(write.layers[1]).toBe(all);
      expect(mocks.flushNow).toHaveBeenCalledTimes(1);
      expect(mocks.queuePatch).not.toHaveBeenCalled();
      expect(mocks.execute).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });

  it.each([
    { name: "Object", selected: objectSelection, layer: () => filmLayer() },
    { name: "Airbox", selected: airboxSelection, layer: () => createFieldLayer({ id: "airbox", kind: "airbox" }) },
  ])("preserves the $name Inspector root, focus and scroll through pending and ACK", async ({ selected, layer }) => {
    planar().field_overlays = [layer()];
    const view = await mount(selected);
    try {
      const findPanel = () => findElements(view.container, (element) =>
        (element.getAttribute("class") ?? "").split(" ").includes("fm-inspector-panel"))[0];
      const panel = findPanel()!;
      const opacity = findControl(view.container, "Raster opacity");
      panel.scrollTop = 127;
      opacity.focus();
      await act(async () => change(opacity, "0.5"));
      const pending = lastOverlayWrite().layers;
      mocks.optimisticPlanar = { ...planar(), field_overlays: pending };
      await view.rerender();
      expect(findPanel()).toBe(panel);
      mocks.planar = { ...planar(), field_overlays: pending } as unknown as Record<string, unknown>;
      mocks.optimisticPlanar = null;
      await view.rerender();
      expect(findPanel()).toBe(panel);
      expect(view.dom.document.activeElement).toBe(opacity);
      expect(panel.scrollTop).toBe(127);
      expect(findControl(view.container, "Quantity").disabled).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  it("queues only the selected Object and Airbox wireframe overrides", async () => {
    const view = await mount(objectSelection);
    try {
      await act(async () => change(findControl(view.container, "Wireframe opacity"), "0.2"));
      expect(mocks.queuePlanarTargetOverride).toHaveBeenLastCalledWith({
        kind: "upsert",
        target: { id: "object:free-layer", kind: "object", label: "Free layer" },
        wireframeStyle: { color: "#ff0000", opacity: 0.2 },
      });
    } finally {
      await view.unmount();
    }
    const airbox = await mount(airboxSelection);
    try {
      await act(async () => change(findControl(airbox.container, "Wireframe opacity"), "0.25"));
      expect(mocks.queuePlanarTargetOverride).toHaveBeenLastCalledWith({
        kind: "upsert",
        target: { id: "airbox", kind: "airbox", label: "Airbox" },
        wireframeStyle: { color: "#00ff00", opacity: 0.25 },
      });
      expect(mocks.queuePatch).not.toHaveBeenCalled();
    } finally {
      await airbox.unmount();
    }
  });

  it("keeps unsupported target wireframes read-only", async () => {
    const view = await mount(regionSelection);
    try {
      expect(findControl(view.container, "Wireframe opacity").disabled).toBe(true);
      expect(mocks.queuePlanarTargetOverride).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });

  it("converts a position in nm to the slice fraction and rejects non-numbers", async () => {
    mocks.section = {
      cut_element_count: 12, layer_count: null, layer_index: null, layer_spacing_m: null,
      layer_stops_m: [], navigation_step_kind: "continuous", navigation_step_m: null,
      normal_axis: "z", normal_max_m: 50e-9, normal_min_m: 0, plane: "xy",
      requested_coordinate_m: 25e-9, requested_fraction: 0.5, resolved_coordinate_m: 25e-9,
      stops_kind: "continuous",
    } as NonNullable<PlanarFieldMetaResource["section"]>;
    fieldMapSurfaceStore.set({
      sectionGeometry: resolvePlanarSectionGeometryFromMeta(mocks.section as PlanarFieldMetaResource["section"], "xy"),
    });
    const view = await mount(sceneSelection);
    try {
      const position = findControl(view.container, "Position (z)");
      expect(position.value).toBe("25");
      await act(async () => change(position, "abc"));
      await act(async () => commit(position));
      expect(mocks.queuePatch).not.toHaveBeenCalled();
      expect(view.container.textContent).toContain("Position must be a finite value in nm.");
      await act(async () => change(position, "12.5"));
      await act(async () => commit(position));
      const slice = mocks.queuePatch.mock.calls.at(-1)![0].planar.default_slice;
      expect(slice).toMatchObject({ plane: "xy", operator: { kind: "plane_sample" } });
      expect(slice.position_fraction).toBeCloseTo(0.25, 12);
      await act(async () => change(position, "900"));
      await act(async () => commit(position));
      expect(mocks.queuePatch.mock.calls.at(-1)![0].planar.default_slice.position_fraction).toBe(1);
      for (const label of ["Source", "Plane", "Mode"]) expect(findControl(view.container, label)).toBeTruthy();
    } finally {
      await view.unmount();
    }
  });

  it("clears the crop with a source change and keeps monitor planes read-only", async () => {
    const view = await mount(sceneSelection);
    try {
      await act(async () => change(findControl(view.container, "Source"), "plane-1"));
      expect(mocks.queuePatch).toHaveBeenLastCalledWith({
        planar: { source: { kind: "monitor", monitor_id: "plane-1" }, crop: null },
      });
    } finally {
      await view.unmount();
    }
    planar().source = { kind: "monitor", monitor_id: "plane-1" };
    const monitor = await mount(sceneSelection);
    try {
      expect(monitor.container.textContent).toContain("Defined by the monitor");
      expect(findControl(monitor.container, "Position (z)").disabled).toBe(true);
    } finally {
      await monitor.unmount();
    }
  });

  it("edits the crop window with field validation and clears it", async () => {
    const view = await mount(sceneSelection);
    try {
      expect(findControl(view.container, "x min").getAttribute("placeholder")).toBe("-25");
      expect(findControl(view.container, "y max").getAttribute("placeholder")).toBe("30");
      await act(async () => change(findControl(view.container, "x min"), "40"));
      await act(async () => commit(findControl(view.container, "x min")));
      expect(mocks.queuePlanarCropPatch).not.toHaveBeenCalled();
      expect(view.container.textContent).toContain("Minimum must be below the maximum.");
      await act(async () => change(findControl(view.container, "x min"), "-20"));
      await act(async () => commit(findControl(view.container, "x min")));
      const sent = mocks.queuePlanarCropPatch.mock.calls.at(-1)![0] as PlanarCropState;
      expect(sent.u_min_m).toBeCloseTo(-20e-9);
      expect(sent.u_max_m).toBeCloseTo(25e-9);
    } finally {
      await view.unmount();
    }
    planar().crop = { u_min_m: -10e-9, u_max_m: 10e-9, v_min_m: -5e-9, v_max_m: 5e-9 };
    const cropped = await mount(sceneSelection);
    try {
      expect(findControl(cropped.container, "x min").value).toBe("-10");
      await act(async () => clickButton(cropped.container, "Clear crop"));
      expect(mocks.queuePlanarCropPatch).toHaveBeenLastCalledWith(null);
      await act(async () => clickButton(cropped.container, "Fit"));
      expect(mocks.execute.mock.calls.at(-1)?.[0]).toBe("field-map.fit");
    } finally {
      await cropped.unmount();
    }
  });

  it("registers a live edit session whose reset keeps source and default slice", async () => {
    planar().layers = { ...planar().layers, vectors: true };
    const view = await mount(sceneSelection);
    try {
      const session = view.store.getCurrentSession();
      expect(session?.mode).toBe("liveViewport");
      expect(session?.dirty).toBe(true);
      await act(async () => { await session!.reset(); });
      const patch = mocks.queuePatch.mock.calls.at(-1)![0].planar;
      expect(patch).not.toHaveProperty("source");
      expect(patch).not.toHaveProperty("default_slice");
      expect(patch).toMatchObject({ layer_model: "layers", crop: null, layers: { vectors: false, raster: true } });
      expect(patch.field_overlays).toEqual([createFieldLayer("all")]);
      expect(mocks.flushNow).toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });

  it("shows a legacy state as its migrated layers and converts it on the first edit", async () => {
    Object.assign(planar(), { layer_model: "legacy", field_overlays: [], quantity_id: "m" });
    const view = await mount(objectSelection);
    try {
      expect(view.container.textContent).not.toContain("Base field (legacy)");
      expect(view.container.textContent).toContain("Inherited from All objects · Magnetization · direction");
      const rows = findElements(view.container, (element) => element.getAttribute("data-layer-id") !== null);
      expect(rows.map((row) => row.getAttribute("data-layer-id"))).toEqual(["all"]);
      await act(async () => change(findControl(view.container, "Quantity"), "H_demag"));
      const patch = mocks.queuePlanarFieldOverlayPatch.mock.calls.at(-1)![0].planar;
      expect(patch.layer_model).toBe("layers");
      expect(patch.field_overlays.map((layer: PlanarFieldLayer) => layer.id)).toEqual(["object:free-layer", "all"]);
      expect(patch.field_overlays[1]).toMatchObject({ quantity_id: "m", view_scope: { kind: "monitor_target" } });
      expect(mocks.flushNow).toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });

  it("switches the section plane through the shared 2D plane command", async () => {
    const view = await mount(airboxSelection);
    try {
      const group = findControl(view.container, "Section plane");
      const yz = findElements(group, (element) => element.getAttribute("role") === "radio" && element.textContent.trim() === "YZ")[0]!;
      await act(async () => yz.click());
      expect(mocks.execute).toHaveBeenCalledWith("field-map.plane.yz", expect.anything());
      expect(mocks.queuePatch).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });

  it("hydrates its server snapshot without a mismatch", async () => {
    const serverHtml = renderToString(<PlanarVisualizationSection selection={objectSelection} />);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    (container as unknown as { innerHTML: string }).innerHTML = serverHtml;
    const recoverableErrors: Error[] = [];
    let root: ReturnType<typeof hydrateRoot>;
    try {
      await act(async () => {
        root = hydrateRoot(container as unknown as Element, <PlanarVisualizationSection selection={objectSelection} />, {
          onRecoverableError: (error) => recoverableErrors.push(error instanceof Error ? error : new Error(String(error))),
        });
        await Promise.resolve();
      });
      expect(recoverableErrors).toEqual([]);
    } finally {
      await act(async () => root!.unmount());
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
  const tracker = (element as TestElement & { _valueTracker?: { setValue: (next: string) => void } })._valueTracker;
  const previous = element.value;
  element.value = value;
  tracker?.setValue(previous);
  element.dispatchEvent(new TestEvent(element.tagName === "INPUT" ? "input" : "change", { bubbles: true }));
}

/**
 * Commits a number draft the way leaving the field does. The test DOM cannot
 * dispatch keydown on inputs (React's input-event polyfill needs attachEvent).
 */
function commit(element: TestElement): void {
  element.dispatchEvent(new TestEvent("focusout", { bubbles: true }));
}

function clickButton(root: TestNode, label: string): void {
  const button = findElements(root, (element) => element.tagName === "BUTTON" && element.textContent.trim() === label)[0];
  if (!button) throw new Error(`Missing button ${label}`);
  button.click();
}
