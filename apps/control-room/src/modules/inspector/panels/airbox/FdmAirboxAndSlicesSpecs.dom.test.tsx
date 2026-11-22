import {
  mountWave5TestDom,
  type MountedWave5TestDom,
} from "../mesh-details/wave5TestDomSetup.test-support";

import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import type { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import {
  findElement,
  findElements,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { EMPTY_OBJECT_VISUALIZATION_SNAPSHOT } from "@/kernel/visualization/useObjectVisualization";
import {
  beginCrossSectionDraft,
  commitCrossSectionDraft,
  resetCrossSectionWorkspaceForTests,
} from "@/kernel/workspace/crossSectionWorkspace";
import { buildFdmAirboxNode } from "@/modules/explorer/builders/airboxExplorerNodes";
import { buildCrossSectionNodes } from "@/modules/explorer/builders/crossSectionExplorerNodes";
import { InspectorEditSessionProvider } from "@/modules/inspector/InspectorEditSession";

const LONG_PROVENANCE_NOTE =
  "Multilayer dipole-convolution stray-field observation carrier verified across full lateral footprint without 512-byte truncation: " +
  "layer_alpha_ferromagnet_bottom -> spacer_ruthenium_rkky -> layer_beta_ferromagnet_top -> cap_tantalum_oxide_passivation :: ".repeat(
    5,
  ) +
  "END_OF_UNTRUNCATED_PROVENANCE_MARKER";

// Mutable mock state shared by all tests in this file
const mockState = vi.hoisted(() => ({
  bDemagMeta: null as Record<string, unknown> | null,
  bDemagStatus: "idle" as "idle" | "loading" | "ready" | "error",
  buildCurrent: null as Record<string, unknown> | null,
  buildLatest: null as Record<string, unknown> | null,
  diagnostics: {
    diagnostics: [] as Array<Record<string, unknown>>,
    scene_revision: 4,
  },
  discretization: "fdm" as "fdm" | "fem",
  domainMeta: {
    bounds: {
      max: [2.56e-7, 2.56e-7, 1e-8],
      min: [-2.56e-7, -2.56e-7, -1e-8],
    },
    coordinate_system: "cartesian",
    counts: { cells: 524288 },
    discretization: "fdm",
    domain_id: "dom-fdm-1",
    generation_id: "gen-fdm-ml",
    grid: {
      origin: [-2.56e-7, -2.56e-7, -1e-8],
      shape: [256, 256, 8],
      spacing: [2e-9, 2e-9, 2.5e-9],
    },
    units: { length: "m" },
  } as Record<string, unknown> | null,
  fdmMembership: {
    cell_count: 524288,
    domain_generation_id: "gen-fdm-ml",
    encoding: "rle_v1",
    freshness: "current",
    grid_fingerprint: "fp-grid-1",
    magnetic_support: {
      active_cell_count: 65536,
      active_unassigned_cell_count: 0,
      bounds_max_m: [1.28e-7, 1.28e-7, 4e-9],
      bounds_min_m: [-1.28e-7, -1.28e-7, -4e-9],
      grid_fingerprint: "fp-grid-1",
      inactive_cell_count: 458752,
      semantic_role: "magnetic-support",
    },
    mesh_revision: 1,
    region_legend: [
      {
        numeric_id: 1,
        object_id: "obj-free",
        priority: 10,
        region_id: "core",
      },
    ],
    region_membership_revision: 2,
  } as Record<string, unknown> | null,
  manifest: null as Record<string, unknown> | null,
  multilayer: null as Record<string, unknown> | null,
  policy: {
    config: { mode: "auto", padding: [8e-8, 8e-8, 1.2e-7] } as Record<
      string,
      unknown
    > | null,
    effective_config: {
      airbox_curvature_factor: 0.3,
      airbox_grading: "geometric",
      airbox_growth_rate: 1.3,
      airbox_hmax: 4e-8,
      airbox_hmin: 5e-9,
      airbox_narrow_region_resolution: 2,
      mode: "auto",
      padding: [8e-8, 8e-8, 1.2e-7],
    } as Record<string, unknown> | null,
    revision: 2,
  },
  quality: null as Record<string, unknown> | null,
  qualityGatesShared: null as Record<string, unknown> | null,
  report: null as Record<string, unknown> | null,
  scene: {
    objects: [
      {
        geometry: {
          bounds_max: [2e-7, 1e-7, 2e-8],
          bounds_min: [-2e-7, -1e-7, -2e-8],
        },
        id: "obj-free",
        name: "Free Layer",
      },
    ],
    revision: 4,
    scene_revision: 4,
    study: {
      demag_realization: null,
      pbc: null,
    },
  } as Record<string, unknown>,
  summary: {
    effective_airbox_target: {
      growth_rate: 1.35,
      maximum_element_size: 4e-8,
      minimum_element_size: 5e-9,
    },
    revision: 1,
  } as Record<string, unknown> | null,
  vizOverrides: [] as Array<Record<string, unknown>>,
}));

const kernelSpies = vi.hoisted(() => ({
  clearTarget: vi.fn(),
  commandDetail: vi.fn(),
  commandList: vi.fn(),
  commandSubmit: vi.fn(),
  commitTransaction: vi.fn(),
  executeCommand: vi.fn(),
  historyRecord: vi.fn(),
  invalidateResource: vi.fn(),
  openBottomPanel: vi.fn(),
  patchTargetPending: vi.fn(),
  patchViewportPreferences: vi.fn(),
  queueVizPatch: vi.fn(),
  replaceUniversePolicy: vi.fn(),
  sceneFetch: vi.fn(),
  selectSet: vi.fn(),
  setActiveTab: vi.fn(),
  universePolicyFetch: vi.fn(),
}));

const busHolder = vi.hoisted(() => ({
  current: null as EventBus<KernelEventMap> | null,
}));

vi.mock("@/shared/charts/ScientificEChart", () => ({
  ScientificEChart: ({
    ariaLabel,
    optionBuilder,
  }: {
    ariaLabel: string;
    optionBuilder?: (palette: Record<string, unknown>) => unknown;
  }) => {
    const built = optionBuilder
      ? optionBuilder({
          accent: "var(--fm-accent)",
          borderSubtle: "var(--fm-border)",
          fontSize: 12,
          textMuted: "var(--fm-muted)",
          warning: "var(--fm-warning)",
        })
      : null;
    return createElement("div", {
      "aria-label": ariaLabel,
      "data-chart-json": built ? JSON.stringify(built) : "",
      "data-slot": "scientific-echart",
    });
  },
}));

vi.mock("@/kernel/KernelContext", async () => {
  const { createContext } = await import("react");
  const { EventBus: EventBusClass } = await import("@/kernel/events/EventBus");
  busHolder.current = new EventBusClass<KernelEventMap>();
  const getKernel = () => ({
    api: {
      commands: {
        detail: kernelSpies.commandDetail,
        list: kernelSpies.commandList,
        submit: kernelSpies.commandSubmit,
      },
      data: {
        fields: {
          meta: vi.fn().mockResolvedValue(mockState.bDemagMeta),
        },
      },
      meshing: {
        replaceUniversePolicy: kernelSpies.replaceUniversePolicy,
        universePolicy: kernelSpies.universePolicyFetch,
      },
      model: {
        commitTransaction: kernelSpies.commitTransaction,
        scene: kernelSpies.sceneFetch,
      },
      resourceCacheScope: "test-scope",
    },
    authoringHistory: {
      getGeneration: () => 1,
      record: kernelSpies.historyRecord,
    },
    bus: busHolder.current!,
    commands: {
      execute: kernelSpies.executeCommand,
      getSessionScopeKey: () =>
        "session=session-fdm-airbox&epoch=1&request_scope_epoch=1",
      isEnabled: () => true,
    },
    diagnosticRecorder: { record: vi.fn() },
    layout: {
      openBottomPanel: kernelSpies.openBottomPanel,
      setActiveTab: kernelSpies.setActiveTab,
      setPanelVisible: vi.fn(),
    },
    resources: {
      get: () => null,
      getRevision: () => 1,
      invalidate: kernelSpies.invalidateResource,
      subscribe: () => () => undefined,
    },
    selection: {
      get: () => null,
      set: kernelSpies.selectSet,
    },
    visualization: {
      clearTarget: kernelSpies.clearTarget,
      getSnapshot: () => EMPTY_OBJECT_VISUALIZATION_SNAPSHOT,
      patchTargetPending: kernelSpies.patchTargetPending,
      patchViewportPreferences: kernelSpies.patchViewportPreferences,
      subscribe: () => () => undefined,
    },
    visualizationSync: {
      queuePatch: kernelSpies.queueVizPatch,
    },
  });
  const proxy = new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      return (getKernel() as Record<string | symbol, unknown>)[prop];
    },
    has(_target, prop) {
      return prop in getKernel();
    },
  });
  return {
    KernelContext: createContext<unknown>(proxy),
    useKernel: () => proxy,
  };
});

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  SESSION_STATUS_RESOURCE_KEY: "/v2/sessions/current/status",
  useSessionResourceIdentity: () => ({
    requestScopeEpoch: "1",
    sessionEpoch: "1",
    sessionId: "session-fdm-airbox",
  }),
  useSessionStatusSelector: (selector: (value: never) => unknown) =>
    selector({
      data: {
        capabilities: {
          active_lane: {
            authored: {
              backend: mockState.discretization,
              discretization: mockState.discretization,
            },
            resolved: {
              backend: mockState.discretization,
              discretization: mockState.discretization,
            },
          },
        },
        domain: {
          cell_count: 524288,
          discretization: mockState.discretization,
          generation_id:
            mockState.discretization === "fem" ? "gen-fem-1" : "gen-fdm-ml",
        },
        execution_state: "idle",
        resources: {
          domain_generation_id:
            mockState.discretization === "fem" ? "gen-fem-1" : "gen-fdm-ml",
          mesh_build_revision: 1,
          mesh_revision: 1,
          region_membership_revision: 2,
          scene_revision: 4,
          topology_fingerprint: "fp-fem-1",
          topology_revision: 1,
        },
      },
    } as never),
}));

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  shouldLoadRuntimeMeshBuild: () => true,
  shouldLoadRuntimeMeshManifest: () => true,
  shouldLoadRuntimeMeshSummary: () => true,
  useFieldMetaResource: () => ({
    data: mockState.bDemagMeta,
    error: null,
    refetch: vi.fn(),
    refreshError: null,
    revision: mockState.bDemagMeta ? 1 : null,
    status: mockState.bDemagStatus,
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => {
  const ready = <T,>(data: T, rev = 1) => ({
    data,
    error: null,
    refetch: vi.fn(),
    refreshError: null,
    revision: rev,
    status: "ready" as const,
  });
  return {
    MESH_BUILD_CURRENT_RESOURCE_KEY: "/v2/sessions/current/meshing/builds/current",
    MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY:
      "/v2/sessions/current/meshing/builds/latest-successful",
    MESH_UNIVERSE_POLICY_RESOURCE_KEY:
      "/v2/sessions/current/meshing/policies/universe",
    SCENE_RESOURCE_KEY: "/v2/sessions/current/model/scene",
    invalidateFdmGridResources: vi.fn(),
    publishCommittedSceneResource: vi.fn(),
    useDomainMetaResource: () => ready(mockState.domainMeta),
    useFdmMultilayerLayoutResource: () => ready(mockState.multilayer),
    useFdmRegionMembershipResource: () => ready(mockState.fdmMembership),
    useGeometryDiagnosticsResource: () => ready(mockState.diagnostics),
    useMeshBuildCurrent: () => ready(mockState.buildCurrent),
    useMeshBuildHistoryResource: () => ready({ history: [], revision: 1 }),
    useMeshBuildLatestSuccessful: () => ready(mockState.buildLatest),
    useMeshSharedDomainManifestResource: () => ready(mockState.manifest),
    useMeshSharedDomainQualityGatesResource: () =>
      ready(mockState.qualityGatesShared),
    useMeshSharedDomainQualityResource: () => ready(mockState.quality),
    useMeshSummaryResource: () => ready(mockState.summary),
    useMeshUniverseQualityResource: () => ready(mockState.quality),
    useMeshUniverseReportResource: () => ready(mockState.report),
    useSceneResource: () => ready(mockState.scene, 4),
    useUniverseMeshPolicyResource: () =>
      ready(mockState.policy, mockState.policy.revision),
    useVisualizationStateResource: () =>
      ready({
        overrides: mockState.vizOverrides,
        revision: 1,
      }),
  };
});

import {
  AirboxMeshBuildInspectorSpecPanel,
  AirboxMeshInspectorSpecPanel,
  AirboxMeshParametersInspectorSpecPanel,
  AirboxMeshQualityGatesInspectorSpecPanel,
  AirboxMeshStatisticsInspectorSpecPanel,
  AirboxMeshTopologyInspectorSpecPanel,
  AirboxMultilayerTargetInspectorSpecPanel,
  AirboxRootInspectorSpecPanel,
  BoundaryFacesRootInspectorSpecPanel,
} from "./AirboxAndBoundarySpecs";

function assertCleanInspectorDom(container: HTMLElement): void {
  const rawControls = findElements(container, (el) => {
    const tag = el.tagName;
    if (tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") return false;
    // Shared UI inputs carry data-slot="input" / class fm-input / fm-inspector-input
    return (
      !el.getAttribute("data-slot") &&
      !el.className.includes("fm-")
    );
  });
  expect(rawControls).toHaveLength(0);

  const titled = findElements(container, (el) => el.hasAttribute("title"));
  expect(titled).toHaveLength(0);

  const media = findElements(
    container,
    (el) => el.tagName === "IMG" || el.tagName === "CANVAS",
  );
  expect(media).toHaveLength(0);

  const text = container.textContent ?? "";
  expect(text).not.toMatch(/\b(?:unknown|unavailable|n\/a|not available|unresolved)\b/i);
}

function defaultMultilayerResource() {
  return {
    airbox: {
      carrier_available: true,
      carrier_fingerprint:
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      carrier_revision: 5,
      cell_size_m: [2e-9, 2e-9, 2.5e-9],
      cells: [256, 256, 8],
      h_demag_available: true,
      h_eff_available: false,
      h_eff_unavailable_reason: "zeeman_stage_pending",
      origin_m: [-2.56e-7, -2.56e-7, -1e-8],
      sample_count: 524288,
      source_grid_fingerprints: ["fp-free-layer", "fp-pinned-layer"],
      source_policy: LONG_PROVENANCE_NOTE,
      source_runtime_identity: { backend: "cuda", kernel: "dipole_fft_v2" },
      target_only: true,
      value_count: 524288 * 3,
    },
    available: true,
    domain_generation_id: "gen-fdm-ml",
    layers: [
      {
        active_cell_count: 65536,
        active_mask_present: true,
        inactive_cell_count: 0,
        layer_id: "free_layer",
        magnet_name: "Free Layer",
        native_cell_size: [2e-9, 2e-9, 2e-9],
        native_grid: [256, 256, 1],
        native_grid_fingerprint: "fp-free-layer",
        native_origin: [-2.56e-7, -2.56e-7, 2e-9],
        object_id: "obj-free",
        transfer_kind: "dipole_fft",
      },
    ],
    layout_fingerprint: "fp-ml-layout",
    layout_revision: 3,
    observation_revision: 7,
  };
}

describe("Wave 5 Slice 3 — Airbox & Boundary Faces 100% Feature-Parity Suite", () => {
  let harness: MountedWave5TestDom;

  beforeEach(() => {
    vi.clearAllMocks();
    harness = mountWave5TestDom();
    resetCrossSectionWorkspaceForTests();

    mockState.discretization = "fdm";
    mockState.bDemagMeta = null;
    mockState.bDemagStatus = "idle";
    mockState.multilayer = defaultMultilayerResource();
    mockState.diagnostics = { diagnostics: [], scene_revision: 4 };
    mockState.policy = {
      config: { mode: "auto", padding: [8e-8, 8e-8, 1.2e-7] },
      effective_config: {
        airbox_curvature_factor: 0.3,
        airbox_grading: "geometric",
        airbox_growth_rate: 1.3,
        airbox_hmax: 4e-8,
        airbox_hmin: 5e-9,
        airbox_narrow_region_resolution: 2,
        mode: "auto",
        padding: [8e-8, 8e-8, 1.2e-7],
      },
      revision: 2,
    };
    mockState.manifest = null;
    mockState.quality = null;
    mockState.qualityGatesShared = null;
    mockState.report = null;
    mockState.buildCurrent = null;
    mockState.buildLatest = null;
    mockState.vizOverrides = [];
    mockState.scene = {
      objects: [
        {
          geometry: {
            bounds_max: [2e-7, 1e-7, 2e-8],
            bounds_min: [-2e-7, -1e-7, -2e-8],
          },
          id: "obj-free",
          name: "Free Layer",
        },
      ],
      revision: 4,
      scene_revision: 4,
      study: {
        demag_realization: null,
        pbc: null,
      },
    };

    kernelSpies.replaceUniversePolicy.mockImplementation(
      async (req: { config: Record<string, unknown>; expected_revision?: number | null }) => ({
        config: req.config,
        effective_config: { ...mockState.policy.effective_config, ...req.config },
        revision: (req.expected_revision ?? 2) + 1,
      }),
    );
    kernelSpies.universePolicyFetch.mockImplementation(async () => mockState.policy);
    kernelSpies.sceneFetch.mockImplementation(async () => ({
      ...mockState.scene,
      revision: 5,
      scene_revision: 5,
    }));
    kernelSpies.commitTransaction.mockImplementation(async () => ({
      committed_scene: { ...mockState.scene, revision: 5, scene_revision: 5 },
      revision: 5,
      scene_revision: 5,
    }));
    kernelSpies.commandSubmit.mockResolvedValue({
      command_id: "cmd-fdm-refresh-1",
      status: "completed",
    });
    kernelSpies.commandDetail.mockResolvedValue({
      command_id: "cmd-fdm-refresh-1",
      completion_status: "completed",
      kind: "fdm_grid_refresh",
      status: "completed",
    });
    kernelSpies.commandList.mockResolvedValue({ commands: [] });
    kernelSpies.executeCommand.mockResolvedValue({ status: "completed" });
    kernelSpies.queueVizPatch.mockReturnValue({ transactionId: "viz-tx-1" });
  });

  afterEach(() => {
    harness.unmount();
    resetCrossSectionWorkspaceForTests();
  });

  it("airbox.multilayer.target: hides FEM mesh nodes in FDM Multilayer, renders live b_demag + certified target provenance without 512B truncation, and triggers grid.build-fdm", async () => {
    const fdmAirboxNode = buildFdmAirboxNode(
      {
        discretization: "fdm",
        fdmGrid: {
          descriptor: {
            origin: [0, 0, 0],
            shape: [256, 256, 8],
            spacing: [2e-9, 2e-9, 2.5e-9],
          },
          gridFingerprint: "fp-1",
          membership: null,
          membershipStatus: "realized",
          origin: [0, 0, 0],
          shape: [256, 256, 8],
          spacing: [2e-9, 2e-9, 2.5e-9],
          totalCells: 524288,
        },
        generationId: "gen-fdm-ml",
        resourceStatus: "realized",
        universeOutsideMagneticSupport: true,
      } as never,
      "ready",
      mockState.multilayer as never,
      "ready",
    );

    expect(fdmAirboxNode).not.toBeNull();
    const walk = (
      n: NonNullable<typeof fdmAirboxNode>,
    ): NonNullable<typeof fdmAirboxNode>[] => [
      n,
      ...(n.children ?? []).flatMap(walk),
    ];
    const kinds = walk(fdmAirboxNode!).map((n) => n.kind);
    expect(kinds.filter((k) => k.startsWith("airbox.mesh"))).toHaveLength(0);
    expect(kinds).toContain("airbox.multilayer.target");

    // Also preserve cross-section tree structure smoke check
    beginCrossSectionDraft();
    const plot = commitCrossSectionDraft()!;
    const csTree = buildCrossSectionNodes({
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
    expect(csTree?.selectable).toBe(true);

    // 1) When b_demag is not materialized yet
    mockState.bDemagMeta = null;
    mockState.bDemagStatus = "idle";
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

    const text1 = harness.container.textContent ?? "";
    expect(text1).toContain("END_OF_UNTRUNCATED_PROVENANCE_MARKER");
    expect(text1).toContain("1,572,864"); // valueCount = 524,288 * 3
    expect(text1).toContain("zeeman_stage_pending");
    expect(text1).toContain("fp-free-layer, fp-pinned-layer");
    expect(text1).toContain("dipole_fft_v2");
    expect(text1).toContain("Airbox scope");
    expect(text1).toContain("Solver usage");
    expect(text1).not.toContain("Not defined in vacuum");
    assertCleanInspectorDom(harness.container);

    // Click Build FDM Grid button
    const buildBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Build FDM Grid")),
    );
    expect(buildBtn).not.toBeNull();
    await act(async () => {
      buildBtn!.click();
    });
    expect(kernelSpies.executeCommand).toHaveBeenCalledWith(
      "grid.build-fdm",
      expect.anything(),
    );

    // 2) When b_demag IS materialized and h_eff_available === true
    mockState.bDemagMeta = { quantity_id: "b_demag", sample_count: 524288 };
    mockState.bDemagStatus = "ready";
    (mockState.multilayer!.airbox as Record<string, unknown>).h_eff_available =
      true;
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
    expect(harness.container.textContent).toContain(
      "Ready (materialized field data)",
    );
    expect(harness.container.textContent).toContain(
      "Ready (H_demag + uniform fields)",
    );
  });

  it("airbox.root: sends canonical expected_revision policy (preserving padding in manual, clearing size/center in auto), refreshes FDM grid, and renders GEOMETRY_OBJECT_OUTSIDE_UNIVERSE recovery actions", async () => {
    mockState.discretization = "fdm";
    mockState.diagnostics = {
      diagnostics: [
        {
          blocks: ["mesh_build"],
          code: "GEOMETRY_OBJECT_OUTSIDE_UNIVERSE",
          id: "diag-outside-1",
          message: "Free Layer extends beyond manual Airbox X bounds.",
          object_id: "obj-free",
          severity: "warning",
        },
      ],
      scene_revision: 4,
    };

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(AirboxRootInspectorSpecPanel, {
            selection: {
              kind: "airbox.root",
              label: "Airbox",
              moduleSource: "explorer",
              nodeId: "model:airbox",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });

    const text = harness.container.textContent ?? "";
    expect(text).toContain("Free Layer extends beyond manual Airbox X bounds.");
    expect(text).toContain("Expand Padding to Fit Objects");
    expect(text).toContain("Select object to adjust placement");
    expect(text).toContain("Open diagnostics");
    expect(text).not.toContain("Shell / ∞");
    assertCleanInspectorDom(harness.container);

    // Switch to Manual Box mode -> verify Switch Extent Mode & Adjust manual bounds appear
    const manualSeg = findElement(
      harness.container,
      (el) =>
        el.getAttribute("data-slot") === "segmented-control-item" &&
        el.textContent?.trim() === "Manual Box",
    );
    expect(manualSeg).not.toBeNull();
    await act(async () => {
      manualSeg!.click();
    });

    expect(harness.container.textContent).toContain(
      "Switch Extent Mode to Auto Padding",
    );
    expect(harness.container.textContent).toContain("Adjust manual bounds");

    // Expand Padding to Fit Objects in manual mode
    const expandBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        el.textContent?.trim() === "Expand Padding to Fit Objects",
    );
    expect(expandBtn).not.toBeNull();
    await act(async () => {
      expandBtn!.click();
    });

    // Click Apply in CommitBar -> commits canonical policy + triggers FDM grid refresh
    const applyBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        el.className.includes("fm-inspector__commit-btn") &&
        Boolean(el.textContent?.includes("Apply")),
    );
    expect(applyBtn).not.toBeNull();
    await act(async () => {
      applyBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(kernelSpies.replaceUniversePolicy).toHaveBeenCalledTimes(1);
    const [sentReq, sentOpts] = kernelSpies.replaceUniversePolicy.mock.calls[0]!;
    expect(sentReq).toHaveProperty("expected_revision", 2);
    expect(sentReq).not.toHaveProperty("base_revision");
    expect(sentReq.config.mode).toBe("manual");
    // Padding is preserved in manual mode!
    expect(sentReq.config.padding).toEqual([8e-8, 8e-8, 1.2e-7]);
    // Expanded size encloses the [400nm, 200nm, 40nm] object envelope * 1.25
    expect(sentReq.config.size[0]).toBeCloseTo(5e-7, 12);
    expect(sentReq.config.center).toEqual([0, 0, 0]);
    expect(sentReq.config).not.toHaveProperty("outer_bc");
    expect(sentReq.config).not.toHaveProperty("padding_multiplier");
    expect(sentOpts).toEqual({
      sessionScopeKey: "session=session-fdm-airbox&epoch=1&request_scope_epoch=1",
    });

    // FDM grid refresh operation triggered after universe policy save!
    expect(kernelSpies.commandSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "fdm_grid_refresh",
        reason: "airbox_policy_commit",
      }),
      expect.anything(),
    );
  });

  it("airbox.mesh & airbox.mesh.parameters: restores effectiveAirboxTarget, all 5 sub-inspector chips, Load Effective Defaults, build-history restore bus, expected_revision rebase, and 409 conflict notice", async () => {
    mockState.discretization = "fem";
    mockState.manifest = {
      generation_id: "gen-fem-1",
      mesh_id: "study_domain",
      mesh_parts: [
        {
          boundary_face_count: 120,
          bounds_max: [5e-7, 5e-7, 5e-7],
          bounds_min: [-5e-7, -5e-7, -5e-7],
          element_count: 2400,
          id: "part_airbox",
          node_count: 680,
          node_indices: [1, 2, 3, 4],
          role: "airbox",
        },
      ],
      revision: 1,
      source_scene_revision: 4,
      topology_fingerprint: "fp-fem-1",
    };
    mockState.buildCurrent = {
      effective_airbox_target: {
        growth_rate: 1.4,
        maximum_element_size: 4.5e-8,
        minimum_element_size: 6e-9,
      },
      last_build_error: "Gmsh surface intersection warning on cavity 2",
      revision: 1,
      source_scene_revision: 4,
    };

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(AirboxMeshInspectorSpecPanel, {
            selection: {
              kind: "airbox.mesh",
              label: "Mesh",
              moduleSource: "explorer",
              nodeId: "model:airbox:mesh",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });

    const meshText = harness.container.textContent ?? "";
    expect(meshText).toContain("45 nm"); // effective target hmax = 4.5e-8 m
    expect(meshText).toContain("6 nm"); // effective target hmin = 6e-9 m
    expect(meshText).toContain("1.4"); // effective target growth_rate
    expect(meshText).toContain("Gmsh surface intersection warning on cavity 2");
    expect(meshText).toContain("Parameters");
    expect(meshText).toContain("Quality Gates");
    expect(meshText).toContain("Statistics");
    expect(meshText).toContain("Topology");
    expect(meshText).toContain("Build");
    assertCleanInspectorDom(harness.container);

    // Render airbox.mesh.parameters with unauthored config (null)
    mockState.policy = {
      config: null,
      effective_config: {
        airbox_curvature_factor: 0.35,
        airbox_grading: "geometric",
        airbox_growth_rate: 1.3,
        airbox_hmax: 5e-8,
        airbox_hmin: 8e-9,
        airbox_narrow_region_resolution: 3,
        mode: "auto",
        padding: [1e-7, 1e-7, 1e-7],
      },
      revision: 2,
    };

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(AirboxMeshParametersInspectorSpecPanel, {
            selection: {
              kind: "airbox.mesh.parameters",
              label: "Parameters",
              moduleSource: "explorer",
              nodeId: "model:airbox:mesh:parameters",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });

    expect(harness.container.textContent).toContain("Load Effective Defaults");
    expect(harness.container.textContent).toContain("Backend-effective Values");
    assertCleanInspectorDom(harness.container);

    // Emit build-history restore event over kernel bus
    await act(async () => {
      busHolder.current!.emit("mesh:build-history-restore-requested", {
        buildId: "build-99",
        entryId: "entry-99",
        meshTarget: "universe",
        snapshot: {
          universe: {
            airbox_curvature_factor: 0.25,
            airbox_grading: "linear",
            airbox_growth_rate: 1.25,
            airbox_hmax: 3e-8,
            airbox_hmin: 4e-9,
            airbox_narrow_region_resolution: 4,
            mode: "auto",
            padding: [6e-8, 6e-8, 6e-8],
          },
        },
      });
    });

    expect(harness.container.textContent).toContain(
      "Build build-99 restored into Airbox mesh draft",
    );

    // Simulate unrelated scene edit bumping policy.revision from 2 -> 7 while config stays null (rebase!)
    mockState.policy = {
      ...mockState.policy,
      revision: 7,
    };
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(AirboxMeshParametersInspectorSpecPanel, {
            selection: {
              kind: "airbox.mesh.parameters",
              label: "Parameters",
              moduleSource: "explorer",
              nodeId: "model:airbox:mesh:parameters",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });

    const applyPolicyBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Apply Policy")),
    );
    expect(applyPolicyBtn).not.toBeNull();
    await act(async () => {
      applyPolicyBtn!.click();
    });

    expect(kernelSpies.replaceUniversePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          airbox_curvature_factor: 0.25,
          airbox_grading: "linear",
          airbox_growth_rate: 1.25,
          airbox_hmax: 3e-8,
          airbox_hmin: 4e-9,
          airbox_narrow_region_resolution: 4,
          mode: "auto",
          padding: [6e-8, 6e-8, 6e-8],
        }),
        expected_revision: 7,
      }),
      { sessionScopeKey: "session=session-fdm-airbox&epoch=1&request_scope_epoch=1" },
    );

    // Verify 409 conflict surfaces recovery notice
    kernelSpies.replaceUniversePolicy.mockRejectedValueOnce(
      new ControlRoomApiError(
        "universe mesh policy changed since revision 7",
        409,
        "req-409",
        "universe_mesh_policy_stale_revision",
      ),
    );
    const loadDefaultsBtn = findElements(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        el.textContent?.trim() === "Load Effective Defaults",
    )[0]!;
    await act(async () => {
      loadDefaultsBtn.click();
    });
    const applyAgainBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Apply Policy")),
    )!;
    await act(async () => {
      applyAgainBtn.click();
    });
    expect(harness.container.textContent).toContain("HTTP 409");
  });

  it("airbox.mesh.quality-gates & airbox.mesh.statistics: zero fake pass rows or [6,24,52,18] bars; renders real checks, histograms, size-bin hover events, heatmap & refine actions", async () => {
    mockState.discretization = "fem";
    mockState.manifest = {
      generation_id: "gen-fem-1",
      mesh_id: "study_domain",
      mesh_parts: [
        {
          boundary_face_count: 80,
          element_count: 1500,
          id: "part_airbox",
          node_count: 420,
          node_indices: [10, 11, 12, 13, 14],
          role: "airbox",
        },
      ],
      revision: 1,
      source_scene_revision: 4,
      topology_fingerprint: "fp-fem-1",
    };

    // 1) Empty quality resource -> ZERO fake pass rows and ZERO fake chart
    mockState.quality = null;
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(AirboxMeshQualityGatesInspectorSpecPanel, {
            selection: {
              kind: "airbox.mesh.quality-gates",
              label: "Quality Gates",
              moduleSource: "explorer",
              nodeId: "model:airbox:mesh:quality-gates",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });
    expect(harness.container.textContent).not.toContain(
      "Positive Jacobian (det J > 0)",
    );
    expect(harness.container.textContent).not.toContain("Outer Shell Closure");
    assertCleanInspectorDom(harness.container);

    // 2) Real quality & report data -> real checks, refine button, heatmap, histogram, and hover events
    mockState.report = {
      report: {
        shared_interface_node_count: 96,
        status: "ok",
      },
      revision: 1,
    };
    mockState.quality = {
      quality: {
        airbox_quality_gates: {
          checks: [
            {
              comparison: ">=",
              id: "sicn_p05",
              status: "pass",
              threshold: 0.2,
              value: 0.44,
            },
          ],
          marker: 0,
          scope: "airbox",
          source: "gmsh_airbox_verifier",
          status: "pass",
        },
        global: {
          edge_length: {
            histogram: [
              { count: 400, hi: 15e-9, lo: 5e-9 },
              { count: 1100, hi: 40e-9, lo: 15e-9 },
            ],
            max: 38e-9,
            mean: 18e-9,
            min: 5.2e-9,
          },
          element_count: 1500,
          gamma: {
            below_threshold_count: 1,
            histogram: [
              { count: 1, hi: 0.1, lo: 0.0 },
              { count: 1499, hi: 1.0, lo: 0.1 },
            ],
            max: 0.96,
            mean: 0.78,
            min: 0.05,
            p05: 0.48,
            threshold: 0.08,
          },
          label: "Airbox marker 0",
          marker: 0,
          quality_by_family: {
            tet4: {
              cell_count: 1400,
              gamma: { max: 0.96, mean: 0.78, min: 0.05, p05: 0.48, status: "available" },
              mixed_topology_scaled_jacobian: {
                min: 0.41,
                p05: 0.52,
                status: "available",
              },
              sicn: { max: 0.98, mean: 0.81, min: 0.39, p05: 0.5, status: "available" },
            },
          },
          sicn: {
            below_threshold_count: 2,
            histogram: [
              { count: 12, hi: 0.5, lo: 0.2 },
              { count: 1488, hi: 1.0, lo: 0.5 },
            ],
            max: 0.98,
            mean: 0.81,
            min: 0.14,
            p05: 0.44,
            threshold: 0.2,
          },
          warnings: ["2 exterior elements below SICN target 0.20"],
        },
        worst_elements: [
          {
            centroid: [1e-8, 2e-8, 3e-8],
            element_index: 77,
            gamma: 0.05,
            scope_label: "airbox",
            sicn: 0.14,
          },
        ],
      },
      revision: 1,
    };

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(AirboxMeshQualityGatesInspectorSpecPanel, {
            selection: {
              kind: "airbox.mesh.quality-gates",
              label: "Quality Gates",
              moduleSource: "explorer",
              nodeId: "model:airbox:mesh:quality-gates",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });

    expect(harness.container.textContent).toContain("sicn_p05");
    expect(harness.container.textContent).toContain("0.44");

    const heatmapBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Show heatmap (SICN)")),
    )!;
    await act(async () => {
      heatmapBtn.click();
    });
    expect(kernelSpies.selectSet).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "mesh.quality",
        ref: expect.objectContaining({
          kind: "mesh.quality.metric",
          metric: "sicn",
        }),
      }),
      "mesh",
    );

    const refineBtn = findElements(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Refine worst region")),
    )[0]!;
    await act(async () => {
      refineBtn.click();
    });
    expect(kernelSpies.executeCommand).toHaveBeenCalledWith(
      "mesh.refine-worst-quality-element",
      expect.anything(),
      expect.objectContaining({ elementIndex: 77 }),
    );

    // Render Statistics panel
    const hoveredEvents: unknown[] = [];
    const offHover = busHolder.current!.on("viewport:mesh-size-bin-hovered", (ev) => {
      hoveredEvents.push(ev);
    });

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(AirboxMeshStatisticsInspectorSpecPanel, {
            selection: {
              kind: "airbox.mesh.statistics",
              label: "Statistics",
              moduleSource: "explorer",
              nodeId: "model:airbox:mesh:statistics",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });

    const statsText = harness.container.textContent ?? "";
    expect(statsText).toContain("96"); // shared_interface_node_count
    expect(statsText).toContain("tet4 (1,400)");
    expect(statsText).toContain("2 exterior elements below SICN target 0.20");
    assertCleanInspectorDom(harness.container);

    const chartEl = findElement(
      harness.container,
      (el) => el.getAttribute("data-slot") === "scientific-echart",
    )!;
    expect(chartEl.getAttribute("data-chart-json")).toContain("1488");
    expect(chartEl.getAttribute("data-chart-json")).not.toContain("[6,24,52,18]");

    // Click / focus a size-distribution bin button -> emits viewport:mesh-size-bin-hovered
    const binBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.includes(": 400")),
    );
    expect(binBtn).not.toBeNull();
    await act(async () => {
      binBtn!.click();
    });
    offHover();
    expect(hoveredEvents.length).toBeGreaterThan(0);
  });

  it("airbox.mesh.topology & airbox.mesh.build: reads real manifest carriers + live 3D Airbox display (zero Watertight stub) and active build progress + Cancel", async () => {
    mockState.discretization = "fem";
    mockState.manifest = {
      generation_id: "gen-fem-1",
      geometry_realization_revision: 3,
      mesh_id: "study_domain",
      mesh_parts: [
        {
          boundary_face_count: 92,
          bounds_max: [4e-7, 4e-7, 2e-7],
          bounds_min: [-4e-7, -4e-7, -2e-7],
          element_count: 1850,
          id: "carrier_airbox_0",
          node_count: 510,
          node_indices: [1, 2, 3, 4, 5],
          role: "airbox",
        },
      ],
      revision: 1,
      source_scene_revision: 4,
      topology_fingerprint: "fp-fem-1",
    };

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(AirboxMeshTopologyInspectorSpecPanel, {
            selection: {
              kind: "airbox.mesh.topology",
              label: "Topology",
              moduleSource: "explorer",
              nodeId: "model:airbox:mesh:topology",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });

    const topoText = harness.container.textContent ?? "";
    expect(topoText).toContain("carrier_airbox_0");
    expect(topoText).toContain("fp-fem-1");
    expect(topoText).not.toContain("Watertight");
    assertCleanInspectorDom(harness.container);

    // Toggle live wireframe switch -> calls real visualization controller
    const switches = findElements(
      harness.container,
      (el) => el.getAttribute("role") === "switch",
    );
    expect(switches.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      switches[1]!.click();
    });
    expect(kernelSpies.queueVizPatch).toHaveBeenCalled();

    // Render airbox.mesh.build with an active running build
    mockState.buildCurrent = {
      active_build: {
        command_id: "cmd-mesh-7",
        progress_label: "Gmsh 3D tetrahedralization",
        progress_percent: 62,
      },
      mesh_pipeline_status: [
        {
          duration_ms: 140,
          id: "geometry_realization",
          label: "Geometry Realization",
          status: "completed",
        },
        {
          id: "gmsh_meshing",
          label: "Gmsh Meshing",
          progress_percent: 62,
          status: "running",
        },
      ],
      provenance: {
        build_id: "build-fem-7",
        command_id: "cmd-mesh-7",
        duration_ms: 480,
        mesh_revision: 1,
        requested_policy_revision: 2,
        source_scene_revision: 4,
      },
      published_resources: {
        manifest: "/v2/sessions/current/meshing/shared-domain/manifest",
        mesh_build_revision: 1,
        mesh_revision: 1,
        quality: "/v2/sessions/current/meshing/shared-domain/quality",
        realized_size_fields:
          "/v2/sessions/current/meshing/shared-domain/realized-size-fields",
      },
      resolved_policy: {
        universe: {
          airbox_growth_rate: 1.3,
          airbox_hmax: 4e-8,
        },
      },
      revision: 1,
      shared_domain_build_report: {
        build_mode: "shared_domain_gmsh",
        fallbacks_triggered: ["frontal_2d_retry"],
        operation_statuses: [
          {
            kind: "boolean_fragments",
            reason: "Conforming cavities",
            scope: "study_domain",
            status: "completed",
          },
        ],
      },
      source_scene_revision: 4,
    };
    mockState.buildLatest = {
      effective_airbox_target: {
        growth_rate: 1.3,
        maximum_element_size: 4e-8,
        minimum_element_size: 5e-9,
      },
      last_success: {
        realization_revision: 3,
        source_scene_revision: 4,
      },
      revision: 1,
    };

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(AirboxMeshBuildInspectorSpecPanel, {
            selection: {
              kind: "airbox.mesh.build",
              label: "Build",
              moduleSource: "explorer",
              nodeId: "model:airbox:mesh:build",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });

    const buildText = harness.container.textContent ?? "";
    expect(buildText).toContain("Gmsh 3D tetrahedralization");
    expect(buildText).toContain("62%");
    expect(buildText).toContain("140 ms");
    expect(buildText).toContain("frontal_2d_retry");
    expect(buildText).toContain("boolean_fragments");
    assertCleanInspectorDom(harness.container);

    const progressBar = findElement(
      harness.container,
      (el) => el.getAttribute("role") === "progressbar",
    );
    expect(progressBar).not.toBeNull();
    expect(progressBar?.getAttribute("aria-valuenow")).toBe("62");

    const cancelBtn = findElements(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" && el.textContent?.trim() === "Cancel",
    )[0]!;
    await act(async () => {
      cancelBtn.click();
    });
    expect(kernelSpies.executeCommand).toHaveBeenCalledWith(
      "study.cancel-build-and-run",
      expect.anything(),
    );
  });

  it("boundary-faces.root: reads outer_boundary carriers, converts areaUnit in table, wires real 3D display, and commits canonical merge_patch on study", async () => {
    mockState.discretization = "fem";
    mockState.manifest = {
      generation_id: "gen-fem-1",
      mesh_id: "study_domain",
      mesh_parts: [
        {
          boundary_face_count: 340,
          element_count: 0,
          id: "outer_boundary_shell",
          node_count: 172,
          role: "outer_boundary",
        },
      ],
      revision: 1,
      source_scene_revision: 4,
      topology_fingerprint: "fp-fem-1",
    };

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(BoundaryFacesRootInspectorSpecPanel, {
            selection: {
              kind: "boundary-faces.root",
              label: "Boundary Faces",
              moduleSource: "explorer",
              nodeId: "model:boundary-faces",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });

    const initialText = harness.container.textContent ?? "";
    expect(initialText).toContain("Patch count: 6 box faces");
    expect(initialText).toContain("Airbox boundary mode:");
    expect(initialText).toContain("340 mesh facets");
    expect(initialText).toContain("outer_boundary");
    expect(initialText).toContain("µm²");
    assertCleanInspectorDom(harness.container);

    // Switch areaUnit segmented control to nm² -> table cells convert to nm²!
    const nm2Seg = findElement(
      harness.container,
      (el) =>
        el.getAttribute("data-slot") === "segmented-control-item" &&
        el.textContent?.trim() === "nm²",
    )!;
    await act(async () => {
      nm2Seg.click();
    });
    expect(harness.container.textContent).toContain("10240 nm²"); // ly * lz = 512nm * 20nm = 10,240 nm²

    // Toggle ±X Periodic axis and Apply -> commits canonical merge_patch on study.pbc!
    const pxToggle = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("±X Periodic")),
    )!;
    await act(async () => {
      pxToggle.click();
    });

    const applyBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        el.className.includes("fm-inspector__commit-btn") &&
        Boolean(el.textContent?.includes("Apply")),
    )!;
    await act(async () => {
      applyBtn.click();
    });

    expect(kernelSpies.commitTransaction).toHaveBeenCalledTimes(1);
    const [txPayload, txOpts] = kernelSpies.commitTransaction.mock.calls[0]!;
    expect(txPayload).toEqual({
      base_revision: 5,
      kind: "merge_patch",
      merge_patch: {
        study: {
          demag_realization: null,
          pbc: {
            axes: ["periodic", "open", "open"],
            demag: "open",
          },
        },
      },
    });
    expect(txPayload).not.toHaveProperty("patch");
    expect(txOpts).toEqual({
      sessionScopeKey: "session=session-fdm-airbox&epoch=1&request_scope_epoch=1",
    });
  });
});
