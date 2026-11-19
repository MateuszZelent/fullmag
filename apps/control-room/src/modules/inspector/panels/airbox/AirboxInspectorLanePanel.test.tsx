import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  calls: [] as boolean[],
  publishedFemMesh: false,
  executionState: "awaiting_command",
  discretization: "fdm" as "fdm" | "fem" | null,
  authoringMethod: null as "fdm" | "fem" | null,
  publishedTopology: false,
  topologyResourceGenerationId: "generation-1",
  multilayerLayoutStatus: "ready" as "idle" | "loading" | "ready" | "stale" | "error",
  multilayerLayoutData: null as unknown,
  multilayerLayoutError: null as Error | null,
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
        lifecycle: { solver: testState.executionState },
        capabilities: {
          explicit_topology: testState.publishedFemMesh,
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
          mesh_revision: testState.publishedTopology ? 5 : testState.publishedFemMesh ? 2 : 0,
          topology_revision: testState.publishedTopology ? 6 : 0,
        },
      },
    }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useFdmMultilayerLayoutResource: ({ enabled }: { enabled: boolean }) => ({
    data: enabled ? testState.multilayerLayoutData : null,
    error: enabled ? testState.multilayerLayoutError : null,
    refreshError: null,
    status: enabled ? testState.multilayerLayoutStatus : "idle",
  }),
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
import type { FdmMultilayerLayoutResource } from "@/kernel/api/apiTypes";
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

const singleGridLayout = {
  airbox: {
    carrier_available: false,
    h_demag_available: false,
    h_eff_available: false,
    unavailable_reason: "not_fdm_multilayer",
  },
  available: false,
  backend: "fdm",
  domain_generation_id: "generation-1",
  execution_revision: 1,
  layers: [],
  layout_revision: 1,
  observation_revision: 1,
  schema_version: "fdm-multilayer-layout.v1",
  unavailable_reason: "not_fdm_multilayer",
} satisfies FdmMultilayerLayoutResource;

const targetOnlyLayout = {
  airbox: {
    carrier_available: true,
    carrier_fingerprint:
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    carrier_revision: 7,
    cell_size_m: [2.5e-9, 2.5e-9, 2.5e-9],
    cells: [240, 240, 26],
    h_demag_available: true,
    h_eff_available: false,
    h_eff_unavailable_reason: "airbox_heff_not_available_v1",
    origin_m: [-300e-9, -300e-9, -5e-9],
    sample_count: 1_497_600,
    source_grid_fingerprints: ["sha256:native-grid"],
    source_policy: "target_only",
    source_runtime_identity: { backend: "fdm_multilayer_cpu_reference" },
    target_only: true,
    value_count: 4_492_800,
  },
  available: true,
  backend: "fdm_multilayer",
  domain_generation_id: "generation-1",
  execution_revision: 1,
  layers: [],
  layout_fingerprint: "sha256:layout",
  layout_revision: 8,
  observation_revision: 9,
  resolved_mode: "three_d",
  schema_version: "fdm-multilayer-layout.v1",
} satisfies FdmMultilayerLayoutResource;

const canonicalAirboxSelection = {
  ...selection,
  ref: {
    kind: "airbox.root",
    nodeId: "model:airbox",
    type: "airbox",
    visualizationTargetId: "airbox",
  },
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
    testState.publishedFemMesh = false;
    testState.executionState = "awaiting_command";
    parameterPanelLanes.values.length = 0;
    testState.discretization = "fdm";
    testState.authoringMethod = null;
    testState.publishedTopology = false;
    testState.topologyResourceGenerationId = "generation-1";
    testState.multilayerLayoutStatus = "ready";
    testState.multilayerLayoutData = singleGridLayout;
    testState.multilayerLayoutError = null;
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
    testState.executionState = "unknown";

    const html = renderToStaticMarkup(
      <AirboxOverviewLanePanel selection={staleAirboxSelection} />,
    );

    expect(html).toContain(">stale<");
    expect(html).toContain(">running<");
    expect(html).toContain(">partial<");
    expect(html).toContain("Airbox manifest is older than the authored policy.");
  });

  it("keeps the SingleGrid FDM DomainMeta fallback when the layout reports no multilayer", () => {
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

  it.each([
    [AirboxOverviewLanePanel, "overview"],
    [AirboxMeshStatisticsLanePanel, "statistics"],
    [AirboxMeshTopologyLanePanel, "topology"],
    [AirboxMeshBuildLanePanel, "build"],
    [AirboxMeshQualityGatesLanePanel, "quality"],
  ] as const)("uses the validated target-only layout carrier for %s", (Panel, view) => {
    testState.discretization = "fdm";
    testState.multilayerLayoutData = targetOnlyLayout;

    const html = renderToStaticMarkup(<Panel selection={canonicalAirboxSelection} />);

    expect(html).toContain('data-fdm-airbox-grid-source="layout.airbox"');
    expect(html).toContain(`data-fdm-airbox-mesh-view="${view}"`);
    expect(html).toContain("Certified target-only observation grid");
    expect(html).toContain("Target-only");
    expect(html).toContain("[240, 240, 26]");
    expect(html).toContain("1,497,600");
    expect(html).toContain("[-3e-7, -3e-7, -5e-9]");
    expect(html).toContain("[3e-7, 3e-7, 6e-8]");
    expect(html).toContain("[2.5e-9, 2.5e-9, 2.5e-9]");
    expect(html).not.toContain("Airbox · FDM structured universe");
    expect(html).not.toContain("Airbox cells");
    expect(html).not.toContain("Magnetic cells");
    expect(html).not.toContain("[2, 1, 1]");
  });

  it("does not confuse a missing ready response with a SingleGrid layout", () => {
    testState.discretization = "fdm";
    testState.multilayerLayoutData = null;
    const html = renderToStaticMarkup(
      <AirboxOverviewLanePanel selection={canonicalAirboxSelection} />,
    );
    expect(html).toContain("The Airbox layout response is missing.");
    expect(html).not.toContain("Airbox · FDM structured universe");
    expect(html).not.toContain("[2, 1, 1]");
  });

  it.each([
    ["loading", "loading"],
    ["stale", "stale"],
    ["error", "layout read failed"],
  ] as const)("withholds DomainMeta Airbox facts while the target layout is %s", (status, expectedMessage) => {
    testState.discretization = "fdm";
    testState.multilayerLayoutStatus = status;
    testState.multilayerLayoutData = targetOnlyLayout;
    testState.multilayerLayoutError = status === "error" ? new Error("layout read failed") : null;

    const html = renderToStaticMarkup(
      <AirboxOverviewLanePanel selection={canonicalAirboxSelection} />,
    );

    expect(html).toContain("data-fdm-airbox-grid-source=\"layout.airbox\"");
    expect(html).toContain(expectedMessage);
    expect(html).not.toContain("Airbox · FDM structured universe");
    expect(html).not.toContain("[2, 1, 1]");
    expect(html).not.toContain("[240, 240, 26]");
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

  it("shows published FEM mesh facts before solver-lane resolution", () => {
    testState.discretization = "fem";
    testState.authoringMethod = "fem";
    testState.publishedFemMesh = true;
    testState.publishedTopology = true;
    testState.executionState = "running";
    const html = renderToStaticMarkup(<AirboxMeshStatisticsLanePanel selection={selection} />);
    expect(html).toContain("FEM Airbox child");
    expect(html).toContain("runtime lane unresolved");
    expect(html).toContain("FEM topology (read-only)");
    expect(html).toContain(">running<");
    expect(html).not.toContain("execution unresolved");
    expect(html).toContain("mesh published");
  });

  it.each(["airbox.multilayer.target", "mesh.grid.universe-outside-support"])(
    "rejects stale FDM selection %s against a prepared FEM mesh",
    (kind) => {
      testState.discretization = "fem";
      testState.authoringMethod = "fem";
      testState.publishedFemMesh = true;
      const html = renderToStaticMarkup(<AirboxOverviewLanePanel selection={{
        ...explicitFdmSelection, kind,
      }} />);
      expect(html).toContain("Airbox selection does not match the runtime lane");
      expect(html).not.toContain("FEM Airbox child");
      expect(html).not.toContain("mesh published");
    },
  );

  it.each(["airbox.multilayer.target", "mesh.grid.universe-outside-support"])(
    "rejects FDM-only selection %s from authored FEM before topology publication",
    (kind) => {
      testState.discretization = null;
      testState.authoringMethod = "fem";

      const html = renderToStaticMarkup(<AirboxOverviewLanePanel selection={{
        ...explicitFdmSelection, kind,
      }} />);

      expect(html).toContain("Airbox selection does not match the runtime lane");
      expect(html).toContain("runtime lane conflict");
      expect(html).not.toContain("FEM Airbox child");
      expect(html).not.toContain("FEM topology (read-only)");
      expect(html).not.toContain("mesh published");
      expect(testState.calls).toEqual([false, false]);
    },
  );

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
