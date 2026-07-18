import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";

import { PlanarVisualizationSection } from "./PlanarVisualizationSection";

const mocks = vi.hoisted(() => ({
  queuePatch: vi.fn(),
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

vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: () => ({
    data: {
      planar: {
        active_monitor_id: "plane-1",
        auto_contrast: true,
        colormap: "viridis",
        component: "magnitude",
        contrast_max: null,
        contrast_min: null,
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
        resolution: { height: 256, vector_budget: 512, width: 512 },
      },
    },
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
  it("server-renders shared quantity, component, unit, range and scope controls", () => {
    const html = renderToStaticMarkup(
      <PlanarVisualizationSection selection={selection} />,
    );

    expect(html).toContain("2D visualization");
    expect(html).toContain("Mid-plane");
    expect(html).toContain("Effective field (A/m)");
    expect(html).toContain("in plane magnitude");
    expect(html).toContain("Display unit");
    expect(html).toContain('aria-label="Automatic planar color range"');
    expect(html).toContain("Use target scope");
    expect(html).not.toContain("/v2/");
  });
});
