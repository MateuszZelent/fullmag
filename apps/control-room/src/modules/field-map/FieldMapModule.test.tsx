import { act } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

import FieldMapModule from "./FieldMapModule";

const mocks = vi.hoisted(() => ({
  meta: vi.fn(),
  queuePatch: vi.fn(),
  visualization: {
    data: null as Record<string, unknown> | null,
    error: null as Error | null,
    status: "loading" as "error" | "loading" | "ready",
  },
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    layout: { get: () => ({ activeViewportMainModuleId: "field-map" }) },
    visualizationSync: { queuePatch: mocks.queuePatch },
  }),
}));

vi.mock("@/kernel/resources/planarFieldResources", () => ({
  planarFieldQueryFromMeta: vi.fn(),
  usePlanarFieldMetaResource: (...args: unknown[]) => {
    mocks.meta(...args);
    return { data: null, error: null, status: "idle" };
  },
  usePlanarMaskResource: () => ({ data: null, error: null, status: "idle" }),
  usePlanarMeshOverlayResource: () => ({ data: null, error: null, status: "idle" }),
  usePlanarProbeResource: () => ({ data: null, error: null, status: "idle" }),
  usePlanarScalarResource: () => ({ data: null, error: null, status: "idle" }),
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
});
