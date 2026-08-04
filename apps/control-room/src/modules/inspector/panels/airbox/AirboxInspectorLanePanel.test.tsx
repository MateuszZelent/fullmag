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
              bounds: { min: [0, 0, 0], max: [1, 1, 1] },
              coordinate_system: "cartesian",
              counts: { cells: 1, elements: null, nodes: null, boundary_faces: null },
              dimension: 3,
              discretization: "fdm",
              domain_id: "domain:fdm",
              element_type: null,
              generation_id: "generation-1",
              grid: { origin: [0, 0, 0], shape: [1, 1, 1], spacing: [1, 1, 1] },
              units: { length: "m" },
            }
          : null,
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
    expect(testState.calls).toEqual([true]);
    expect(html).toContain("Structured FDM universe/grid extent");
    expect(html).toContain("Magnetic-support / universe role");
    expect(html).toContain("not published");
    expect(html).not.toContain("Airbox Controls");
    expect(html).not.toContain("FEM Airbox child");
  });

  it("delegates to the existing FEM panel and does not load DomainMeta in FEM", () => {
    testState.discretization = "fem";
    testState.calls.length = 0;
    const html = renderToStaticMarkup(<AirboxOverviewLanePanel selection={selection} />);
    expect(testState.calls).toEqual([false]);
    expect(html).toContain("FEM Airbox child");
    expect(html).not.toContain("FDM Universe / Grid Extent");
  });
});
