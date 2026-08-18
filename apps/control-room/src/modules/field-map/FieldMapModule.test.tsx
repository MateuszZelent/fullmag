import { act, type ReactNode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

import FieldMapModule from "./FieldMapModule";

const mocks = vi.hoisted(() => ({
  meta: vi.fn(),
  probeData: null as null | { occupancy: string; scalar: number | null; u_m: number; v_m: number },
  queuePatch: vi.fn(),
  renderModel: vi.fn(),
  renderReady: false,
  surface: vi.fn(),
  visualization: {
    data: null as Record<string, unknown> | null,
    error: null as Error | null,
    status: "loading" as "error" | "loading" | "ready",
    optimisticData: null as Record<string, unknown> | null,
  },
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    layout: { get: () => ({ activeViewportMainModuleId: "field-map" }) },
    visualizationSync: { queuePatch: mocks.queuePatch },
  }),
}));

vi.mock("@/kernel/api/codecs", () => ({
  decodeFieldVector: () => ({ values: new Float64Array([1]) }),
}));

vi.mock("./model/fieldMapRenderModel", () => ({
  buildFieldMapRenderModel: (input: unknown) => {
    const override = mocks.renderModel(input);
    return override ?? {
      diagnostics: [],
      display: { axisUnit: "m", legendUnit: "A/m", probeScale: 1 },
      layers: (input as { layers: unknown }).layers,
      range: null,
    };
  },
  normalizePlanarColorRange: () => null,
  projectPlanarVectors: () => null,
  resolveFieldMapAuxiliaryDiagnostics: () => [],
  surfaceProjectionStatus: () => "resolved",
}));

vi.mock("./renderer/PlanarSurface", () => ({
  PlanarSurface: ({
    model,
    probeOverlay,
  }: {
    model: unknown;
    probeOverlay?: ReactNode;
  }) => {
    mocks.surface(model);
    return (
      <div className="fm-field-map__canvas-stack">
        <output data-planar-render-layers={JSON.stringify((model as { layers: unknown }).layers)} />
        {probeOverlay}
      </div>
    );
  },
}));

vi.mock("@/kernel/resources/planarFieldResources", () => ({
  planarFieldQueryFromMeta: () => ({
    ok: true,
    query: {
      component: "magnitude",
      quality: "interactive",
      resolution_x: 256,
      resolution_y: 128,
      scope_kind: "monitor_target",
      vector_budget: 512,
    },
  }),
  usePlanarFieldMetaResource: (...args: unknown[]) => {
    mocks.meta(...args);
    const requestedSource = args[1] as { kind?: string } | undefined;
    const isDefault = requestedSource?.kind === "default";
    return mocks.renderReady
      ? {
          data: {
            canonical_unit: "A/m",
            etag: "meta-authoritative",
            field_backend: "fdm",
            field_device: "cpu",
            field_precision: "double",
            field_source: "live",
            field_revision: "4",
            fold_count: 0,
            frame: {
              bounds_uv_m: [0, 1, 0, 1],
              normal: [0, 0, 1],
              origin_m: isDefault ? [11, 22, 32] : [0, 0, 0],
              u_axis: [1, 0, 0],
              v_axis: [0, 1, 0],
            },
            mesh_overlay_descriptor: {
              available: true,
              boundary_classification: "exact",
              codec: "fmcs.v4",
            },
            operator: { kind: "plane_sample" },
            source: isDefault
              ? {
                  default_slice_hash: "default-slice-hash",
                  default_slice_revision: "3",
                  domain_generation_id: "domain-generation-1",
                  kind: "default",
                }
              : {
                  kind: "monitor",
                  monitor_hash: "monitor-hash",
                  monitor_id: "plane-1",
                  monitor_revision: "2",
                },
            overlap_count: 0,
            resolution: [256, 128],
            sample_token: "planar-sample-v3:current",
            sampling_execution: "cpu",
          },
          error: null,
          status: "ready",
        }
      : { data: null, error: null, status: "idle" };
  },
  usePlanarMaskResource: () => ({ data: null, error: null, status: "idle" }),
  usePlanarMeshOverlayResource: () => ({ data: null, error: null, status: "idle" }),
  usePlanarProbeResource: () => ({ data: mocks.probeData, error: null, status: mocks.probeData ? "ready" : "idle" }),
  usePlanarScalarResource: () => mocks.renderReady
    ? { data: { data: new ArrayBuffer(8), etag: "scalar-authoritative" }, error: null, status: "ready" }
    : { data: null, error: null, status: "idle" },
  usePlanarVectorResource: () => ({ data: null, error: null, status: "idle" }),
}));

vi.mock("@/kernel/resources/planarMonitorResources", () => ({
  usePlanarMonitorResource: () => ({ data: null, error: null, status: "idle" }),
  usePlanarMonitorsResource: () => ({
    data: { monitors: [{ id: "plane-1" }] },
    error: null,
    status: "ready",
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useDomainMetaResource: () => ({ data: null, error: null, status: "idle" }),
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionStatusSelector: () => null,
}));

vi.mock("@/kernel/selection/useSelection", () => ({
  useSelectionSelector: () => ({ snapshotId: null, stageId: null }),
}));

vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: () => mocks.visualization,
}));

describe("FieldMapModule planar state ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.visualization.data = null;
    mocks.visualization.error = null;
    mocks.visualization.status = "loading";
    mocks.visualization.optimisticData = null;
    mocks.renderReady = false;
    mocks.probeData = null;
  });

  it("does not invent a quantity or component while the server profile is loading", () => {
    const html = renderToStaticMarkup(<FieldMapModule />);

    expect(html).toContain("Loading planar visualization state");
    expect(html).not.toContain("magnitude");
    expect(mocks.meta).toHaveBeenCalledWith("", { kind: "default" }, expect.any(Object), {
      enabled: false,
    });
  });

  it("hydrates the same loading snapshot without reading client-only field-map identity", async () => {
    const serverHtml = renderToString(<FieldMapModule />);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    (container as unknown as { innerHTML: string }).innerHTML = serverHtml;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let root: ReturnType<typeof hydrateRoot>;
    try {
      await act(async () => {
        root = hydrateRoot(container as unknown as Element, <FieldMapModule />);
        await Promise.resolve();
      });

      expect(serverHtml).toContain("Loading planar visualization state");
      expect(consoleError.mock.calls.flat().join(" ")).not.toContain("hydration");
    } finally {
      await act(async () => root!.unmount());
      consoleError.mockRestore();
      dom.restore();
    }
  });

  it("renders the default source without selecting the first monitor", async () => {
    mocks.visualization.data = {
      planar: {
        component: "magnitude",
        layers: { mesh: true, vectors: false },
        quantity_id: "m",
        resolution: { height: 128, width: 256 },
        source: { kind: "default" },
        default_slice: {
          operator: { kind: "plane_sample" },
          plane: "xy",
          position_fraction: 0.5,
        },
        view_scope: { kind: "monitor_target" },
      },
    };
    mocks.visualization.status = "ready";
    mocks.visualization.optimisticData = null;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => {
        root.render(<FieldMapModule />);
        await Promise.resolve();
      });

      expect(mocks.queuePatch).not.toHaveBeenCalled();
      expect(mocks.meta).toHaveBeenCalledWith(
        "m",
        { kind: "default" },
        expect.any(Object),
        { enabled: true },
      );
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("publishes source and runtime provenance for a default sample in the DOM", () => {
    mocks.visualization.data = {
      planar: {
        colormap: "viridis",
        component: "magnitude",
        default_slice: {
          operator: { kind: "plane_sample" },
          plane: "xz",
          position_fraction: 0.25,
        },
        display_unit: "A/m",
        interaction: { pan_u_m: 0, pan_v_m: 0, zoom: 1 },
        layers: { mesh: true, vectors: false },
        quantity_id: "m",
        quality: "interactive",
        range: { mode: "auto" },
        resolution: { height: 128, width: 256 },
        source: { kind: "default" },
        vector_style: { color_mode: "orientation", length_mode: "uniform", scale: 1 },
        view_scope: { kind: "monitor_target" },
      },
    };
    mocks.visualization.status = "ready";
    mocks.renderReady = true;

    const html = renderToStaticMarkup(<FieldMapModule />);

    expect(html).toContain('data-planar-source-kind="default"');
    expect(html).toContain('data-planar-source-id="default"');
    expect(html).toContain('data-planar-source-hash="default-slice-hash"');
    expect(html).toContain('data-planar-source-revision="3"');
    expect(html).toContain('data-planar-default-plane="xz"');
    expect(html).toContain('data-planar-position-fraction="0.25"');
    expect(html).toContain('data-planar-resolved-coordinate-m="22"');
    expect(html).toContain('data-planar-domain-generation-id="domain-generation-1"');
    expect(html).toContain('data-planar-field-backend="fdm"');
    expect(html).toContain('data-planar-field-device="cpu"');
    expect(html).toContain('data-planar-field-precision="double"');
    expect(html).toContain('data-planar-sample-token="planar-sample-v3:current"');
    expect(mocks.renderModel).toHaveBeenCalledWith(expect.objectContaining({
      frame: expect.objectContaining({ origin: [11, 22, 32] }),
    }));
  });

  it("does not duplicate Inspector-owned planar selection controls", () => {
    mocks.visualization.data = {
      planar: {
        colormap: "viridis",
        component: "magnitude",
        default_slice: {
          operator: { kind: "plane_sample" },
          plane: "xy",
          position_fraction: 0.5,
        },
        display_unit: "A/m",
        interaction: { pan_u_m: 0, pan_v_m: 0, zoom: 1 },
        layers: { mesh: true, raster: true, vectors: false },
        quantity_id: "m",
        quality: "interactive",
        range: { mode: "auto" },
        resolution: { height: 128, width: 256 },
        source: { kind: "default" },
        vector_style: { color_mode: "orientation", length_mode: "uniform", scale: 1 },
        view_scope: { kind: "monitor_target" },
      },
    };
    mocks.visualization.status = "ready";
    mocks.renderReady = true;

    const html = renderToStaticMarkup(<FieldMapModule />);

    expect(html).not.toContain('aria-label="Planar field selection controls"');
    for (const label of ["Source", "Quantity", "Component", "Plane"]) {
      expect(html).not.toContain(`aria-label="${label}"`);
    }
  });

  it("renders a horizontal scalar instrument with min, ramp, and max in display units", () => {
    mocks.visualization.data = {
      planar: {
        colormap: "viridis",
        component: "magnitude",
        display_unit: "kA/m",
        interaction: { pan_u_m: 0, pan_v_m: 0, zoom: 1 },
        layers: { mesh: true, probes: true, raster: true, vectors: false },
        quantity_id: "m",
        range: { mode: "auto" },
        resolution: { height: 128, width: 256 },
        source: { kind: "default" },
        default_slice: {
          operator: { kind: "plane_sample" },
          plane: "xy",
          position_fraction: 0.5,
        },
        vector_style: { color_mode: "orientation", length_mode: "uniform", scale: 1 },
        view_scope: { kind: "monitor_target" },
      },
    };
    mocks.visualization.status = "ready";
    mocks.renderReady = true;
    mocks.renderModel.mockImplementationOnce((input: unknown) => ({
      diagnostics: [],
      bounds: [0, 1, 0, 1],
      frame: {
        normal: [0, 0, 1],
        origin: [11, 22, 32],
        uAxis: [1, 0, 0],
        vAxis: [0, 1, 0],
      },
      viewport: [0, 1, 0, 1],
      display: { axisUnit: "m", legendUnit: "kA/m", probeScale: 1e-3 },
      layers: (input as { layers: unknown }).layers,
      range: { max: 2_000, min: -1_000 },
    }));

    mocks.probeData = { occupancy: "occupied", scalar: 1_000, u_m: 2, v_m: 3 };
    const html = renderToStaticMarkup(<FieldMapModule />);

    expect(html).toContain('class="fm-field-map__colorbar"');
    expect(html).toContain("Rendered range");
    expect(html).toContain("-1 kA/m");
    expect(html).toContain("2 kA/m");
    expect(html).toContain('class="fm-field-map__colorbar-ramp" data-colormap="viridis"');
    expect(html).toContain(
      "background:linear-gradient(to right, rgb(68, 1, 84), rgb(49, 104, 142), rgb(53, 183, 121), rgb(253, 231, 37))",
    );

    const minIndex = html.indexOf("-1 kA/m");
    const rampIndex = html.indexOf('class="fm-field-map__colorbar-ramp"');
    const maxIndex = html.indexOf("2 kA/m");
    expect(minIndex).toBeLessThan(rampIndex);
    expect(rampIndex).toBeLessThan(maxIndex);
    expect(html).toContain("<th scope=\"row\">x</th><td>13 m</td>");
    expect(html).toContain("<th scope=\"row\">y</th><td>25 m</td>");
    expect(html).not.toContain("<th scope=\"row\">u</th>");
    expect(html).not.toContain("<th scope=\"row\">v</th>");
    expect(html).toContain(
      '<div class="fm-field-map__canvas-stack"><output data-planar-render-layers=',
    );
    expect(html).toMatch(
      /<div class="fm-field-map__canvas-stack">[\s\S]*<table class="fm-field-map__pinned-probe">[\s\S]*<\/table><\/div>/,
    );
  });

  it("keeps the canonical plan and sample identity stable while optimistic layers alter rendered flags", () => {
    const planar = {
      colormap: "viridis",
      component: "magnitude",
      interaction: { pan_u_m: 0, pan_v_m: 0, zoom: 1 },
      layers: { boundaries: false, contours: false, mesh: true, probes: false, raster: true, vectors: true },
      quality: "interactive",
      quantity_id: "h_eff",
      resolution: { height: 128, vector_budget: 512, width: 256 },
      source: { kind: "monitor", monitor_id: "plane-authoritative" },
      vector_style: { color_mode: "orientation", length_mode: "uniform", scale: 1 },
      view_scope: { kind: "monitor_target" },
    };
    mocks.visualization.data = { planar };
    mocks.visualization.optimisticData = {
      planar: {
        ...planar,
        component: "normal",
        layers: { ...planar.layers, mesh: false, vectors: false },
        quality: "export",
        resolution: { height: 1024, vector_budget: 1000, width: 1024 },
        quantity_id: "m",
        source: { kind: "monitor", monitor_id: "plane-pending" },
      },
    };
    mocks.visualization.status = "ready";
    mocks.renderReady = true;

    renderToStaticMarkup(<FieldMapModule />);

    expect(mocks.meta).toHaveBeenCalledWith(
      "h_eff",
      { kind: "monitor", monitorId: "plane-authoritative" },
      expect.objectContaining({ include_mesh: true, quality: "interactive", resolution_x: 256, resolution_y: 128, vector_budget: 512 }),
      { enabled: true },
    );
    expect(mocks.renderModel).toHaveBeenLastCalledWith(expect.objectContaining({
      layers: expect.objectContaining({ mesh: false, vectors: false }),
      vectorBudget: 512,
    }));

    mocks.meta.mockClear();
    mocks.renderModel.mockClear();
    mocks.visualization.data = mocks.visualization.optimisticData;
    mocks.visualization.optimisticData = null;
    renderToStaticMarkup(<FieldMapModule />);

    expect(mocks.meta).toHaveBeenCalledWith(
      "m",
      { kind: "monitor", monitorId: "plane-pending" },
      expect.objectContaining({ include_mesh: false, quality: "export", resolution_x: 1024, resolution_y: 1024, vector_budget: 0 }),
      { enabled: true },
    );
  });
});
