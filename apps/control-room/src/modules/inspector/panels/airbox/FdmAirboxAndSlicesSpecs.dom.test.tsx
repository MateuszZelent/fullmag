import {
  mountWave5TestDom,
  type MountedWave5TestDom,
} from "../mesh-details/wave5TestDomSetup.test-support";

import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findElement,
  findElements,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { buildFdmAirboxNode } from "@/modules/explorer/builders/airboxExplorerNodes";
import { buildCrossSectionNodes } from "@/modules/explorer/builders/crossSectionExplorerNodes";
import { InspectorEditSessionProvider } from "@/modules/inspector/InspectorEditSession";
import {
  beginCrossSectionDraft,
  commitCrossSectionDraft,
  resetCrossSectionWorkspaceForTests,
} from "@/kernel/workspace/crossSectionWorkspace";

const LONG_PROVENANCE_NOTE =
  "Multilayer dipole-convolution stray-field observation carrier verified across full lateral footprint without 512-byte truncation: " +
  "layer_alpha_ferromagnet_bottom -> spacer_ruthenium_rkky -> layer_beta_ferromagnet_top -> cap_tantalum_oxide_passivation :: ".repeat(
    5,
  ) +
  "END_OF_UNTRUNCATED_PROVENANCE_MARKER";

vi.mock("@/shared/charts/ScientificEChart", () => ({
  ScientificEChart: ({ ariaLabel }: { ariaLabel: string }) =>
    createElement("div", {
      "aria-label": ariaLabel,
      "data-slot": "scientific-echart",
    }),
  minMaxFinite: (values: ArrayLike<number>) => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < values.length; i += 1) {
      const v = values[i]!;
      if (Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    return min <= max ? { min, max } : null;
  },
}));

vi.mock("@/kernel/KernelContext", async () => {
  const { createContext } = await import("react");
  const kernelValue = {
    api: {
      meshing: {
        replaceUniversePolicy: vi.fn().mockResolvedValue({}),
      },
      model: {
        commitTransaction: vi.fn().mockResolvedValue({}),
        updateUniverse: vi.fn().mockResolvedValue({}),
      },
    },
    bus: { emit: vi.fn(), on: () => () => undefined },
    commands: { execute: vi.fn().mockResolvedValue(undefined) },
    diagnosticRecorder: { record: vi.fn() },
    layout: { setPanelVisible: vi.fn() },
    resources: {
      get: () => null,
      getRevision: () => 1,
      invalidate: vi.fn(),
      subscribe: () => () => undefined,
    },
    selection: { set: vi.fn() },
  };
  return {
    KernelContext: createContext<unknown>(kernelValue),
    useKernel: () => kernelValue,
  };
});

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => ({
    requestScopeEpoch: "1",
    sessionEpoch: "1",
    sessionId: "session-fdm-airbox",
  }),
  useSessionStatusSelector: (selector: (value: never) => unknown) =>
    selector({
      data: {
        domain: {
          cell_count: 32768,
          discretization: "fdm",
          generation_id: "gen-fdm-ml",
        },
        resources: {
          mesh_build_revision: 1,
          mesh_revision: 1,
          region_membership_revision: 1,
          scene_revision: 4,
        },
      },
    } as never),
}));

vi.mock("@/kernel/resources/fdmCellPhysicsResources", () => ({
  fdmCellCenter: (
    origin: readonly number[],
    spacing: readonly number[],
    ijk: readonly number[],
  ) => [
    origin[0]! + (ijk[0]! + 0.5) * spacing[0]!,
    origin[1]! + (ijk[1]! + 0.5) * spacing[1]!,
    origin[2]! + (ijk[2]! + 0.5) * spacing[2]!,
  ],
  useFdmCellPhysicsResource: () => ({
    data: {
      rows: [
        {
          group: "material",
          id: "mat_ms",
          label: "Saturation magnetization",
          reason: null,
          scalar: 8e5,
          sourceStep: 0,
          sourceTimeSeconds: 0,
          status: "ready",
          unit: "A/m",
          vector: null,
        },
        {
          group: "magnetization",
          id: "m",
          label: "Magnetization",
          reason: null,
          scalar: 1,
          sourceStep: 10,
          sourceTimeSeconds: 1e-10,
          status: "ready",
          unit: "1",
          vector: [0.8, 0.6, 0.0],
        },
        {
          group: "energy",
          id: "eden_ex",
          label: "Exchange energy density",
          reason: null,
          scalar: 1250,
          sourceStep: 10,
          sourceTimeSeconds: 1e-10,
          status: "ready",
          unit: "J/m³",
          vector: null,
        },
        {
          group: "energy",
          id: "eden_total",
          label: "Total energy density",
          reason: null,
          scalar: 3400,
          sourceStep: 10,
          sourceTimeSeconds: 1e-10,
          status: "ready",
          unit: "J/m³",
          vector: null,
        },
      ],
      runId: "run-42",
      volumeM3: 3.2e-26,
    },
    error: null,
    refetch: vi.fn(),
    status: "ready" as const,
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => {
  const ready = <T,>(data: T) => ({
    data,
    error: null,
    refetch: vi.fn(),
    revision: 1,
    status: "ready" as const,
  });
  return {
    MESH_UNIVERSE_POLICY_RESOURCE_KEY: "/meshing/policies/universe",
    SCENE_RESOURCE_KEY: "/model/scene",
    useDomainMetaResource: () =>
      ready({
        bounds: { max: [2.56e-7, 2.56e-7, 1e-8], min: [-2.56e-7, -2.56e-7, -1e-8] },
        generation_id: "gen-fdm-ml",
        grid: {
          origin: [-2.56e-7, -2.56e-7, -1e-8],
          shape: [256, 256, 8],
          spacing: [2e-9, 2e-9, 2.5e-9],
        },
      }),
    useFdmMultilayerLayoutResource: () =>
      ready({
        airbox: {
          carrier_fingerprint: LONG_PROVENANCE_NOTE,
          cell_size: [2e-9, 2e-9, 2.5e-9],
          cells: [256, 256, 8],
          h_demag_available: true,
          h_eff_available: false,
          origin: [-2.56e-7, -2.56e-7, -1e-8],
          source_policy: LONG_PROVENANCE_NOTE,
        },
        available: true,
        common_transform_layout: {
          cell_size: [2e-9, 2e-9, 2.5e-9],
          origin: [-2.56e-7, -2.56e-7, -1e-8],
          shape: [256, 256, 8],
        },
        layers: [
          {
            active_cell_count: 65536,
            active_mask_present: true,
            inactive_cell_count: 0,
            layer_id: "free_layer",
            magnet_name: "Free Layer",
            native_cell_size: [2e-9, 2e-9, 2e-9],
            native_grid: [256, 256, 1],
            native_grid_fingerprint: "fp-free",
            native_origin: [-2.56e-7, -2.56e-7, 2e-9],
            object_id: "obj-free",
            transfer_kind: "dipole_fft",
          },
        ],
        layout_fingerprint: "fp-ml-layout",
        layout_revision: 3,
      }),
    useFdmRegionMembershipResource: () => ({
      availability: {
        generationId: "gen-fdm-ml",
        gridFingerprint: "fp-grid-1",
        legendFingerprint: "fp-leg-1",
        status: "ready" as const,
      },
      data: {
        active_assigned_cells: 60000,
        active_unassigned_cells: 0,
        domain_generation_id: "gen-fdm-ml",
        encoding: "rle_v1",
        freshness: "current",
        grid_fingerprint: "fp-grid-1",
        inactive_cells: 5536,
        region_legend: [
          {
            numeric_id: 1,
            object_id: "obj-free",
            priority: 10,
            region_id: "core",
          },
        ],
      },
      error: null,
      refetch: vi.fn(),
      revision: 1,
      status: "ready" as const,
    }),
    useGeometryDiagnosticsResource: () => ready({ issues: [] }),
    useMeshBuildHistoryResource: () => ready({ entries: [] }),
    useMeshSharedDomainManifestResource: () => ready(null),
    useMeshSummaryResource: () => ready({ revision: 1 }),
    useMeshUniverseQualityResource: () => ready(null),
    useMeshUniverseReportResource: () => ready(null),
    useSceneResource: () => ready({ objects: [], revision: 4 }),
    useUniverseMeshPolicyResource: () =>
      ready({
        config: { mode: "auto", padding: [8e-8, 8e-8, 1.2e-7] },
        effective_config: { mode: "auto", padding: [8e-8, 8e-8, 1.2e-7] },
        revision: 2,
      }),
    useVisualizationStateResource: () =>
      ready({
        clip: { axis: "z", enabled: false, flipped: false, position_percent: 50 },
        slice: {
          axis: "z",
          mesh_color_scale: "viridis",
          mesh_filter_expression: "",
          mesh_quality_metric: "skewness",
          mesh_shrink_factor: 1,
          position_percent: 50,
          show_mesh: true,
        },
      }),
  };
});

import {
  AirboxMultilayerTargetInspectorSpecPanel,
} from "./AirboxAndBoundarySpecs";
import {
  FdmCellInspectorSpecPanel,
  FdmGridInspectorSpecPanel,
} from "../fdm-grid/FdmGridAndCellSpecs";
import {
  Visualizations2DPlotInspectorSpecPanel,
} from "../cross-sections/Visualizations2DSpecs";

describe("Task 19 Consolidated FDM Grid & Cell, Airbox & Boundary Faces, and 2D Cross-Sections", () => {
  let harness: MountedWave5TestDom;

  beforeEach(() => {
    harness = mountWave5TestDom();
    resetCrossSectionWorkspaceForTests();
  });

  afterEach(() => {
    harness.unmount();
    resetCrossSectionWorkspaceForTests();
  });

  it("hides all 6 FEM airbox.mesh* nodes in FDM Multilayer and renders >512-byte descriptions without truncation", async () => {
    const fdmAirboxNode = buildFdmAirboxNode(
      {
        discretization: "fdm",
        fdmGrid: {
          descriptor: { origin: [0, 0, 0], shape: [256, 256, 8], spacing: [2e-9, 2e-9, 2.5e-9] },
          gridFingerprint: "fp-1",
          membership: null,
          membershipStatus: "realized",
          origin: [0, 0, 0],
          shape: [256, 256, 8],
          spacing: [2e-9, 2e-9, 2.5e-9],
          totalCells: 524288,
        },
        generationId: "gen-1",
        resourceStatus: "realized",
        universeOutsideMagneticSupport: true,
      } as never,
      "ready",
      {
        airbox: {
          carrier_available: true,
          carrier_fingerprint:
            "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          cell_size_m: [2e-9, 2e-9, 2.5e-9],
          cells: [256, 256, 8],
          h_demag_available: true,
          h_eff_available: false,
          origin_m: [-2.56e-7, -2.56e-7, -1e-8],
          sample_count: 524288,
          target_only: true,
          value_count: 524288 * 3,
        },
        available: true,
        domain_generation_id: "gen-1",
        layers: [],
        layout_revision: 3,
      } as never,
      "ready",
    );

    expect(fdmAirboxNode).not.toBeNull();
    const walk = (n: NonNullable<typeof fdmAirboxNode>): NonNullable<typeof fdmAirboxNode>[] => [
      n,
      ...(n.children ?? []).flatMap(walk),
    ];
    const kinds = walk(fdmAirboxNode!).map((n) => n.kind);
    expect(kinds.filter((k) => k.startsWith("airbox.mesh"))).toHaveLength(0);
    expect(kinds).toContain("airbox.multilayer.target");
    expect(kinds).toContain("airbox.visualization");

    expect(LONG_PROVENANCE_NOTE.length).toBeGreaterThan(512);
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(AirboxMultilayerTargetInspectorSpecPanel, {
            selection: {
              kind: "airbox.multilayer.target",
              label: "Multilayer Target",
              moduleSource: "explorer",
              nodeId: "model:airbox:multilayer-target",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });

    expect(harness.container.textContent).toContain("END_OF_UNTRUNCATED_PROVENANCE_MARKER");
  });

  it("renders fdm.cell inside <aside class='fm-inspector'> with 2 modeTabs, single-column energy readout, and .fm-fdm-neighbor-grid, plus 5 sections in mesh.grid", async () => {
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(FdmCellInspectorSpecPanel, {
            selection: {
              kind: "fdm.cell",
              label: "FDM Voxel (12, 8, 0)",
              moduleSource: "viewport-3d",
              nodeId: "fdm:cell:2060",
              objectId: null,
              ref: {
                cellSizeM: [2e-9, 2e-9, 2.5e-9],
                centerM: [0, 0, 0],
                generationId: "gen-fdm-ml",
                gridFingerprint: "fp-grid-1",
                ijk: [12, 8, 0],
                kind: "fdm.cell",
                membershipRevision: "1:1",
                meshRevision: 1,
                nodeId: "fdm:cell:2060",
                ordinal: 2060,
                type: "fdm-cell",
              } as never,
            },
          }),
        ),
      );
    });

    const aside = findElement(
      harness.container,
      (el) => el.tagName === "ASIDE" && el.className.includes("fm-inspector"),
    );
    expect(aside).not.toBeNull();

    const tabs = findElements(harness.container, (el) => el.getAttribute("role") === "tab");
    expect(tabs).toHaveLength(2);
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Physics",
      "Grid & 6-Neighbors",
    ]);

    await act(async () => {
      tabs[1]!.click();
    });

    const neighborGrid = findElement(harness.container, (el) =>
      el.className.includes("fm-fdm-neighbor-grid"),
    );
    expect(neighborGrid).not.toBeNull();

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(FdmGridInspectorSpecPanel, {
            selection: {
              kind: "mesh.grid",
              label: "Structured Grid",
              moduleSource: "explorer",
              nodeId: "model:mesh:grid",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });

    const sections = findElements(
      harness.container,
      (el) => el.getAttribute("data-slot") === "inspector-section",
    );
    expect(sections).toHaveLength(5);
  });

  it("removes 4 synthetic visualizations-2d.parameter children, unlocks visualizations-2d.root, and renders ScientificEChart in visualizations-2d.plot", async () => {
    beginCrossSectionDraft();
    const plot = commitCrossSectionDraft()!;

    const treeNode = buildCrossSectionNodes({
      draft: null,
      plots: [
        {
          colorScale: plot.renderOptions.colorScale,
          filterExpression: plot.renderOptions.filterExpression,
          frameExtent: plot.frameExtent,
          id: plot.id,
          metric: plot.metric,
          name: plot.name,
          plane: plot.plane,
          positionPercent: plot.positionPercent,
          rotationDegrees: plot.rotationDegrees,
          shrinkFactor: plot.renderOptions.shrinkFactor,
          wireframeVisible: plot.renderOptions.wireframeVisible,
        },
      ],
    });

    expect(treeNode).not.toBeNull();
    expect(treeNode?.selectable).toBe(true);
    const walk = (n: NonNullable<typeof treeNode>): NonNullable<typeof treeNode>[] => [
      n,
      ...(n.children ?? []).flatMap(walk),
    ];
    expect(walk(treeNode!).filter((n) => n.kind === "visualizations-2d.parameter")).toHaveLength(
      0,
    );

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(Visualizations2DPlotInspectorSpecPanel, {
            selection: {
              kind: "visualizations-2d.plot",
              label: plot.name,
              moduleSource: "explorer",
              nodeId: `model:visualizations-2d:${plot.id}`,
              objectId: null,
              ref: {
                crossSectionPlotId: plot.id,
                kind: "visualizations-2d.plot",
                nodeId: `model:visualizations-2d:${plot.id}`,
                type: "cross-section-plot",
              } as never,
            },
          }),
        ),
      );
    });

    // On the default 'Cut Plane & Display' tab, the Slice Quality chart is not leaked
    const leakedCharts = findElements(
      harness.container,
      (el) => el.getAttribute("data-slot") === "scientific-echart",
    );
    expect(leakedCharts).toHaveLength(0);

    // Switching to 'Slice Quality' renders the 2D slice ScientificEChart distribution
    const qualityTab = findElement(
      harness.container,
      (el) =>
        el.getAttribute("role") === "tab" &&
        Boolean(el.textContent?.includes("Slice Quality")),
    );
    expect(qualityTab).not.toBeNull();
    await act(async () => {
      qualityTab!.click();
    });

    const chart = findElement(
      harness.container,
      (el) => el.getAttribute("data-slot") === "scientific-echart",
    );
    expect(chart).not.toBeNull();
  });
});
