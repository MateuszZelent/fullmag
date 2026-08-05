import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  calls: [] as boolean[],
  discretization: "fdm",
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionStatusSelector: (selector: (value: unknown) => unknown) =>
    selector({
      data: {
        capabilities: { explicit_topology: false },
        domain: { discretization: testState.discretization },
        resources: { mesh_build_revision: 0, mesh_revision: 0 },
      },
    }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useDomainMetaResource: ({ enabled }: { enabled: boolean }) => {
    testState.calls.push(enabled);
    return {
      data:
        enabled
          ? {
              bounds: { min: [0, 0, 0], max: [2, 1, 1] },
              coordinate_system: "cartesian",
              counts: { cells: 2, elements: null, nodes: null, boundary_faces: null },
              dimension: 3,
              discretization: "fdm",
              domain_id: "domain:fdm",
              element_type: null,
              generation_id: "generation-1",
              grid: { origin: [0, 0, 0], shape: [2, 1, 1], spacing: [1, 1, 1] },
              units: { length: "m" },
            }
          : null,
      error: null,
      status: enabled ? "ready" : "idle",
    };
  },
  useFdmRegionMembershipResource: ({ enabled }: { enabled: boolean }) => {
    testState.calls.push(enabled);
    return {
      data: enabled ? {
        binary_path: "membership.bin",
        cell_count: 2,
        cell_m: [1, 1, 1],
        counts: [2, 1, 1],
        encoding: "u32le",
        freshness: "current",
        grid_fingerprint: "grid-1",
        magnetic_support: {
          active_cell_count: 1,
          active_unassigned_cell_count: 0,
          bounds_max_m: [1, 1, 1],
          bounds_min_m: [0, 0, 0],
          grid_fingerprint: "grid-1",
          inactive_cell_count: 1,
          semantic_role: "magnetic-support",
        },
        mesh_revision: 1,
        origin_m: [0, 0, 0],
        region_legend: [],
        region_membership_revision: 1,
        schema_version: "fdm_region_membership.v2",
      } : null,
      error: null,
      status: enabled ? "ready" : "idle",
    };
  },
}));

vi.mock("./AirboxOverviewPanel", () => ({
  AirboxOverviewPanel: () => <div>FEM Airbox child</div>,
}));
vi.mock("./AirboxMeshBuildPanel", () => ({ AirboxMeshBuildPanel: () => <div>FEM Airbox child</div> }));
vi.mock("./AirboxMeshOverviewPanel", () => ({ AirboxMeshOverviewPanel: () => <div>FEM Airbox child</div> }));
vi.mock("./AirboxMeshParametersPanel", () => ({ AirboxMeshParametersPanel: () => <div>FEM Airbox child</div> }));
vi.mock("./AirboxMeshQualityGatesPanel", () => ({ AirboxMeshQualityGatesPanel: () => <div>FEM Airbox child</div> }));
vi.mock("./AirboxMeshStatisticsPanel", () => ({ AirboxMeshStatisticsPanel: () => <div>FEM Airbox child</div> }));
vi.mock("./AirboxMeshTopologyPanel", () => ({ AirboxMeshTopologyPanel: () => <div>FEM Airbox child</div> }));

import type { Selection } from "@/kernel/selection/selectionTypes";
import { AirboxOverviewLanePanel } from "./AirboxInspectorLanePanel";

const selection = {
  kind: "airbox.root",
  label: "Airbox",
  moduleSource: "inspector",
  nodeId: "model:airbox",
  objectId: null,
  ref: null,
} satisfies Selection;

describe("AirboxInspectorLanePanel", () => {
  it("loads only DomainMeta and never mounts the FEM child in FDM", () => {
    testState.discretization = "fdm";
    testState.calls.length = 0;
    const html = renderToStaticMarkup(<AirboxOverviewLanePanel selection={selection} />);
    expect(testState.calls).toEqual([true, true]);
    expect(html).toContain("Structured FDM universe/grid extent");
    expect(html).toContain("Magnetic-support / universe role");
    expect(html).toContain("Universe outside magnetic support (domain presentation)");
    expect(html).not.toContain("Airbox Controls");
    expect(html).not.toContain("FEM Airbox child");
  });

  it("delegates to the existing FEM panel and does not load DomainMeta in FEM", () => {
    testState.discretization = "fem";
    testState.calls.length = 0;
    const html = renderToStaticMarkup(<AirboxOverviewLanePanel selection={selection} />);
    expect(testState.calls).toEqual([false, false]);
    expect(html).toContain("FEM Airbox child");
    expect(html).not.toContain("FDM Universe / Grid Extent");
  });
});
