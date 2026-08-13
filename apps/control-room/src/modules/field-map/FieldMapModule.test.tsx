import { act } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

import FieldMapModule from "./FieldMapModule";

const mocks = vi.hoisted(() => ({
  meta: vi.fn(),
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
    mocks.renderModel(input);
    return {
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
  PlanarSurface: ({ model }: { model: unknown }) => {
    mocks.surface(model);
    return <output data-planar-render-layers={JSON.stringify((model as { layers: unknown }).layers)} />;
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
    return mocks.renderReady
      ? {
          data: {
            canonical_unit: "A/m",
            etag: "meta-authoritative",
            field_revision: "4",
            fold_count: 0,
            frame: {
              bounds_uv_m: [0, 1, 0, 1],
              normal: [0, 0, 1],
              u_axis: [1, 0, 0],
              v_axis: [0, 1, 0],
            },
            mesh_overlay_descriptor: {
              available: true,
              boundary_classification: "exact",
              codec: "fmcs.v4",
            },
            monitor_hash: "monitor-hash",
            monitor_revision: "2",
            overlap_count: 0,
            resolution: [256, 128],
          },
          error: null,
          status: "ready",
        }
      : { data: null, error: null, status: "idle" };
  },
  usePlanarMaskResource: () => ({ data: null, error: null, status: "idle" }),
  usePlanarMeshOverlayResource: () => ({ data: null, error: null, status: "idle" }),
  usePlanarProbeResource: () => ({ data: null, error: null, status: "idle" }),
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
  });

  it("does not invent a quantity or component while the server profile is loading", () => {
    const html = renderToStaticMarkup(<FieldMapModule />);

    expect(html).toContain("Loading planar visualization state");
    expect(html).not.toContain("magnitude");
    expect(mocks.meta).toHaveBeenCalledWith("", "", expect.any(Object), {
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

  it("bootstraps the first monitor through one server-owned planar patch", async () => {
    mocks.visualization.data = {
      planar: {
        active_monitor_id: null,
        component: "magnitude",
        layers: { mesh: true, vectors: false },
        quantity_id: "m",
        resolution: { height: 128, width: 256 },
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

      expect(mocks.queuePatch).toHaveBeenCalledTimes(1);
      expect(mocks.queuePatch).toHaveBeenCalledWith({
        planar: { active_monitor_id: "plane-1" },
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps the canonical plan and sample identity stable while optimistic layers alter rendered flags", () => {
    const planar = {
      active_monitor_id: "plane-authoritative",
      colormap: "viridis",
      component: "magnitude",
      interaction: { pan_u_m: 0, pan_v_m: 0, zoom: 1 },
      layers: { boundaries: false, contours: false, mesh: true, probes: false, raster: true, vectors: true },
      quality: "interactive",
      quantity_id: "h_eff",
      resolution: { height: 128, vector_budget: 512, width: 256 },
      vector_style: { color_mode: "orientation", length_mode: "uniform", scale: 1 },
      view_scope: { kind: "monitor_target" },
    };
    mocks.visualization.data = { planar };
    mocks.visualization.optimisticData = {
      planar: {
        ...planar,
        active_monitor_id: "plane-pending",
        component: "normal",
        layers: { ...planar.layers, mesh: false, vectors: false },
        quality: "export",
        resolution: { height: 1024, vector_budget: 1000, width: 1024 },
        quantity_id: "m",
      },
    };
    mocks.visualization.status = "ready";
    mocks.renderReady = true;

    renderToStaticMarkup(<FieldMapModule />);

    expect(mocks.meta).toHaveBeenCalledWith(
      "h_eff",
      "plane-authoritative",
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
      "plane-pending",
      expect.objectContaining({ include_mesh: false, quality: "export", resolution_x: 1024, resolution_y: 1024, vector_budget: 0 }),
      { enabled: true },
    );
  });
});
