import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  calls: [] as boolean[],
  discretization: "fdm" as "fdm" | "fem" | null,
  authoringMethod: null as "fdm" | "fem" | null,
  publishedTopology: false,
  topologyResourceGenerationId: "generation-1",
  fdmMembershipGenerationId: "generation-1",
  fdmMembershipStatus: "ready" as "ready" | "loading" | "stale" | "error",
  resolvedDiscretization: null as "fdm" | "fem" | null,
}));

const kernelMocks = vi.hoisted(() => ({
  commands: { execute: vi.fn() },
  layout: { openBottomPanel: vi.fn() },
  selection: { set: vi.fn() },
}));

vi.mock("@/kernel/KernelContext", () => ({ useKernel: () => kernelMocks }));
vi.mock("@/kernel/commands/commandContext", () => ({ createCommandContext: () => ({}) }));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  SESSION_STATUS_RESOURCE_KEY: "session:status",
  useSessionStatusSelector: (selector: (value: unknown) => unknown) =>
    selector({
      data: testState.discretization === null && !testState.authoringMethod
        ? null
        : {
        capabilities: {
          explicit_topology: false,
          ...(testState.authoringMethod
            ? { active_lane: { authored: { discretization: testState.authoringMethod }, requested: { discretization: testState.authoringMethod }, resolved: testState.resolvedDiscretization ? { discretization: testState.resolvedDiscretization } : null } }
            : {}),
        },
        domain: {
          cell_count: testState.publishedTopology ? 2 : undefined,
          discretization: testState.publishedTopology
            ? "fem"
            : testState.discretization,
          generation_id: testState.publishedTopology ? "generation-1" : undefined,
        },
        resources: {
          domain_generation_id: testState.publishedTopology
            ? testState.topologyResourceGenerationId
            : undefined,
          mesh_build_revision: 0,
          mesh_revision: testState.publishedTopology ? 5 : 0,
          topology_revision: testState.publishedTopology ? 6 : 0,
        },
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
        domain_generation_id: testState.fdmMembershipGenerationId,
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
      status: enabled ? testState.fdmMembershipStatus : "idle",
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
const parameterPanelLanes = vi.hoisted(() => ({ values: [] as Array<{ lane: string; runtimeLane: string | null }> }));
vi.mock("./AirboxMeshParametersPanel", () => ({
  AirboxMeshParametersPanel: ({ lane = "fem", runtimeLane = null }: { lane?: string; runtimeLane?: string | null }) => {
    parameterPanelLanes.values.push({ lane, runtimeLane });
    return <div>{lane} policy editor</div>;
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
  beforeEach(() => {
    testState.calls.length = 0;
    parameterPanelLanes.values.length = 0;
    testState.discretization = "fdm";
    testState.authoringMethod = null;
    testState.publishedTopology = false;
    testState.topologyResourceGenerationId = "generation-1";
    testState.fdmMembershipGenerationId = "generation-1";
    testState.fdmMembershipStatus = "ready";
    testState.resolvedDiscretization = null;
  });

  it.each([
    AirboxOverviewLanePanel,
    AirboxMeshParametersLanePanel,
    AirboxMeshQualityGatesLanePanel,
    AirboxMeshStatisticsLanePanel,
    AirboxMeshTopologyLanePanel,
    AirboxMeshBuildLanePanel,
  ])("preserves resource and provenance details without a duplicate result path for %s", (Panel) => {
    testState.discretization = "fem";

    const html = renderToStaticMarkup(<Panel selection={selection} />);

    expect(html).toContain('data-inspector-owner="airbox-inspector"');
    expect(html).not.toContain('aria-label="Scientific result path"');
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

  it("does not infer the runtime lane from a legacy FDM Airbox selection", () => {
    testState.discretization = null;
    testState.authoringMethod = null;
    testState.calls.length = 0;

    const html = renderToStaticMarkup(
      <AirboxOverviewLanePanel selection={explicitFdmSelection} />,
    );

    expect(testState.calls).toEqual([false, false]);
    expect(html).not.toContain("Airbox · FDM structured universe");
    expect(html).not.toContain("FEM Airbox child");
    expect(html).toContain("The accepted model method has not been published.");
    expect(html).not.toContain("runtime lane conflict");
  });

  it("keeps accepted requested FEM policy authoring available before runtime resolution", () => {
    testState.discretization = "fdm";
    testState.authoringMethod = "fem";
    testState.resolvedDiscretization = null;
    testState.calls.length = 0;
    parameterPanelLanes.values.length = 0;

    const html = renderToStaticMarkup(
      <AirboxMeshParametersLanePanel selection={selection} />,
    );

    expect(html).toContain("fem policy editor");
    expect(html).not.toContain("FEM topology (read-only)");
    expect(parameterPanelLanes.values).toEqual([{ lane: "fem", runtimeLane: null }]);
    expect(testState.calls).toEqual([false, false]);
  });

  it.each([
    AirboxMeshQualityGatesLanePanel,
    AirboxMeshStatisticsLanePanel,
    AirboxMeshTopologyLanePanel,
  ])("allows read-only published FEM topology inspection from an unresolved runtime for %s", (Panel) => {
    testState.discretization = null;
    testState.authoringMethod = "fem";
    testState.publishedTopology = true;

    const html = renderToStaticMarkup(<Panel selection={selection} />);

    expect(html).toContain("FEM Airbox child");
    expect(html).toContain("runtime lane unresolved");
    expect(html).toContain("FEM topology (read-only)");
    expect(html).toContain("Runtime lane remains unresolved");
    expect(testState.calls).toEqual([false, false]);
  });

  it("keeps FEM topology inspection closed when the published generation identity conflicts", () => {
    testState.discretization = null;
    testState.authoringMethod = "fem";
    testState.publishedTopology = true;
    testState.topologyResourceGenerationId = "generation-old";

    const html = renderToStaticMarkup(
      <AirboxMeshTopologyLanePanel selection={selection} />,
    );

    expect(html).not.toContain("FEM Airbox child");
    expect(html).not.toContain("FEM topology (read-only)");
    expect(html).toContain("Mesh facts and build actions wait for runtime-lane resolution.");
  });

  it.each([
    ["loading", "loading"],
    ["stale", "stale"],
    ["error", "error"],
  ] as const)("does not report FDM descriptor completeness as available while membership is %s", (membershipStatus, expectedStatus) => {
    testState.discretization = "fdm";
    testState.fdmMembershipStatus = membershipStatus;

    const html = renderToStaticMarkup(
      <AirboxMeshQualityGatesLanePanel selection={selection} />,
    );

    expect(html).toContain("FDM Airbox quality");
    expect(html).toContain(`>${expectedStatus}<`);
    expect(html).toContain("not current for this grid");
  });

  it.each([
    ["loading", "FDM membership data is loading"],
    ["stale", "FDM membership data is stale"],
    ["error", "FDM membership data failed to load"],
  ] as const)(
    "withholds cached FDM membership counts and shows the model notice while membership is %s",
    (membershipStatus, expectedNotice) => {
      testState.discretization = "fdm";
      testState.fdmMembershipStatus = membershipStatus;

      const html = renderToStaticMarkup(
        <AirboxMeshStatisticsLanePanel selection={selection} />,
      );

      expect(html).toContain("Airbox cells");
      expect(html).toMatch(/Airbox cells<\/span><span[^>]*>not materialized<\/span>/);
      expect(html).toContain(expectedNotice);
      expect(html).not.toContain("Membership freshness");
      expect(html).not.toContain("not current for this grid");
    },
  );

  it("withholds FDM membership counts when cached membership belongs to another generation", () => {
    testState.discretization = "fdm";
    testState.fdmMembershipGenerationId = "generation-old";

    const html = renderToStaticMarkup(
      <AirboxMeshStatisticsLanePanel selection={selection} />,
    );

    expect(html).toContain("does not match the current structured grid");
    expect(html).not.toContain("Membership freshness");
    expect(html).not.toContain("not current for this grid");
    expect(html).toMatch(/Airbox cells<\/span><span[^>]*>not materialized<\/span>/);
  });

  it("does not expose runtime actions when the resolved lane conflicts with authored intent", () => {
    testState.discretization = "fdm";
    testState.authoringMethod = "fem";
    testState.resolvedDiscretization = "fdm";
    parameterPanelLanes.values.length = 0;

    renderToStaticMarkup(<AirboxMeshParametersLanePanel selection={selection} />);

    expect(parameterPanelLanes.values).toEqual([{ lane: "fem", runtimeLane: null }]);
  });

  it("uses the current runtime lane despite a legacy FDM Airbox selection", () => {
    testState.discretization = "fem";
    testState.calls.length = 0;

    const html = renderToStaticMarkup(
      <AirboxOverviewLanePanel selection={explicitFdmSelection} />,
    );

    expect(testState.calls).toEqual([false, false]);
    expect(html).not.toContain("Airbox selection is unavailable");
    expect(html).not.toContain("Airbox · FDM structured universe");
    expect(html).toContain("FEM Airbox child");
  });

  it("uses the shared parameters panel with an explicit FDM lane", () => {
    testState.discretization = "fdm";
    testState.authoringMethod = null;
    testState.resolvedDiscretization = null;
    testState.calls.length = 0;
    parameterPanelLanes.values.length = 0;

    const html = renderToStaticMarkup(
      <AirboxMeshParametersLanePanel selection={selection} />,
    );

    expect(parameterPanelLanes.values).toEqual([{ lane: "fdm", runtimeLane: "fdm" }]);
    expect(html).toContain("fdm policy editor");
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
