import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  calls: [] as boolean[],
  discretization: "fdm" as "fdm" | "fem" | null,
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionStatusSelector: (selector: (value: unknown) => unknown) =>
    selector({
      data: testState.discretization === null ? null : {
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
  useSceneResource: ({ enabled }: { enabled: boolean }) => ({
    data: enabled ? { objects: [] } : null,
    error: null,
    status: enabled ? "ready" : "idle",
  }),
}));

vi.mock("./AirboxOverviewPanel", () => ({
  AirboxOverviewPanel: () => <div>FEM Airbox child</div>,
}));
vi.mock("./AirboxMeshBuildPanel", () => ({ AirboxMeshBuildPanel: () => <div>FEM Airbox child</div> }));
vi.mock("./AirboxMeshOverviewPanel", () => ({ AirboxMeshOverviewPanel: () => <div>FEM Airbox child</div> }));
const parameterPanelLanes = vi.hoisted(() => ({ values: [] as string[] }));
vi.mock("./AirboxMeshParametersPanel", () => ({
  AirboxMeshParametersPanel: ({ lane = "fem" }: { lane?: string }) => {
    parameterPanelLanes.values.push(lane);
    return <div>{lane === "fdm" ? "FDM Airbox parameters" : "FEM Airbox child"}</div>;
  },
}));
vi.mock("./AirboxMeshQualityGatesPanel", () => ({ AirboxMeshQualityGatesPanel: () => <div>FEM Airbox child</div> }));
vi.mock("./AirboxMeshStatisticsPanel", () => ({ AirboxMeshStatisticsPanel: () => <div>FEM Airbox child</div> }));
vi.mock("./AirboxMeshTopologyPanel", () => ({ AirboxMeshTopologyPanel: () => <div>FEM Airbox child</div> }));

import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  AirboxMeshBuildLanePanel,
  AirboxMeshParametersLanePanel,
  AirboxMeshQualityGatesLanePanel,
  AirboxMeshStatisticsLanePanel,
  AirboxMeshTopologyLanePanel,
  AirboxOverviewLanePanel,
} from "./AirboxInspectorLanePanel";

const selection = {
  kind: "airbox.root",
  label: "Airbox",
  moduleSource: "inspector",
  nodeId: "model:airbox",
  objectId: null,
  ref: null,
} satisfies Selection;

const explicitFdmSelection = {
  ...selection,
  ref: {
    kind: "airbox.root",
    nodeId: "model:airbox",
    type: "airbox",
    visualizationTargetId: "fdm-universe-outside-support",
  },
} satisfies Selection;

const staleAirboxSelection = {
  ...selection,
  ref: {
    availability: "partial",
    contractGap: "Airbox manifest is older than the authored policy.",
    executionState: "running",
    kind: "airbox.root",
    nodeId: "model:airbox",
    resourceState: "stale",
    type: "airbox",
    visualizationTargetId: "airbox",
  },
} satisfies Selection;

describe("AirboxInspectorLanePanel", () => {
  it.each([
    AirboxOverviewLanePanel,
    AirboxMeshParametersLanePanel,
    AirboxMeshQualityGatesLanePanel,
    AirboxMeshStatisticsLanePanel,
    AirboxMeshTopologyLanePanel,
    AirboxMeshBuildLanePanel,
  ])("uses the shared scientific identity frame for %s", (Panel) => {
    testState.discretization = "fem";

    const html = renderToStaticMarkup(<Panel selection={selection} />);

    expect(html).toContain('data-inspector-owner="airbox-inspector"');
    expect(html).toContain('aria-label="Scientific result path"');
    expect(html).toContain("Resource");
    expect(html).toContain("Provenance");
  });

  it("keeps Airbox status facets and contract gaps visible in the shared frame", () => {
    testState.discretization = "fem";

    const html = renderToStaticMarkup(
      <AirboxOverviewLanePanel selection={staleAirboxSelection} />,
    );

    expect(html).toContain(">stale<");
    expect(html).toContain(">running<");
    expect(html).toContain(">partial<");
    expect(html).toContain("Airbox manifest is older than the authored policy.");
  });

  it("loads only DomainMeta and never mounts the FEM child in FDM", () => {
    testState.discretization = "fdm";
    testState.calls.length = 0;
    const html = renderToStaticMarkup(<AirboxOverviewLanePanel selection={selection} />);
    expect(testState.calls).toEqual([true, true]);
    expect(html).toContain("Airbox · FDM structured universe");
    expect(html).toContain("Airbox role");
    expect(html).toContain("Airbox outside magnetic support (domain presentation)");
    expect(html).not.toContain("Airbox Controls");
    expect(html).not.toContain("FEM Airbox child");
    expect(html).not.toContain("shared-domain");
    expect(html).toContain("Published structured-grid artifact");
  });

  it("delegates to the existing FEM panel and does not load DomainMeta in FEM", () => {
    testState.discretization = "fem";
    testState.calls.length = 0;
    const html = renderToStaticMarkup(<AirboxOverviewLanePanel selection={selection} />);
    expect(testState.calls).toEqual([false, false]);
    expect(html).toContain("FEM Airbox child");
    expect(html).not.toContain("FDM Universe / Grid Extent");
  });

  it("honors an explicit FDM Airbox selection while runtime status is unavailable", () => {
    testState.discretization = null;
    testState.calls.length = 0;

    const html = renderToStaticMarkup(
      <AirboxOverviewLanePanel selection={explicitFdmSelection} />,
    );

    expect(testState.calls).toEqual([true, true]);
    expect(html).toContain("Airbox · FDM structured universe");
    expect(html).not.toContain("FEM Airbox child");
  });

  it("fails closed when the explicit Airbox target conflicts with runtime status", () => {
    testState.discretization = "fem";
    testState.calls.length = 0;

    const html = renderToStaticMarkup(
      <AirboxOverviewLanePanel selection={explicitFdmSelection} />,
    );

    expect(testState.calls).toEqual([false, false]);
    expect(html).toContain("Airbox selection is unavailable");
    expect(html).not.toContain("Airbox · FDM structured universe");
    expect(html).not.toContain("FEM Airbox child");
  });

  it("uses the shared parameters panel with an explicit FDM lane", () => {
    testState.discretization = "fdm";
    testState.calls.length = 0;
    parameterPanelLanes.values.length = 0;

    const html = renderToStaticMarkup(
      <AirboxMeshParametersLanePanel selection={selection} />,
    );

    expect(parameterPanelLanes.values).toEqual(["fdm"]);
    expect(html).toContain("FDM Airbox parameters");
    expect(html).not.toContain("Airbox · FDM structured universe");
  });

  it.each([
    [AirboxMeshQualityGatesLanePanel, "FDM Airbox quality", "FEM element quality", "not applicable"],
    [AirboxMeshStatisticsLanePanel, "FDM Airbox statistics", "Total cells", "2"],
    [AirboxMeshTopologyLanePanel, "FDM Airbox topology", "Explicit element topology", "not applicable"],
    [AirboxMeshBuildLanePanel, "FDM Airbox provenance", "Grid fingerprint", "grid-1"],
  ] as const)(
    "renders a dedicated %s panel instead of repeating the extent overview",
    (Panel, title, factLabel, factValue) => {
      testState.discretization = "fdm";
      const html = renderToStaticMarkup(<Panel selection={selection} />);

      expect(html).toContain(title);
      expect(html).toContain(factLabel);
      expect(html).toContain(factValue);
      expect(html).not.toContain("Airbox · FDM structured universe");
    },
  );
});
