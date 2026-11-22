import {
  mountWave5TestDom,
  type MountedWave5TestDom,
} from "../mesh-details/wave5TestDomSetup.test-support";

import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DATA_DOMAIN_META_PATH,
  DATA_FIELDS_PATH,
} from "@/kernel/api/apiPaths";
import type {
  DomainMetaResource,
  FdmMultilayerLayoutResource,
  FdmRegionMembershipResource,
  RegionDiagnosticsResource,
  RegionListResource,
  SceneResource,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import type { DecodedFdmRegionMembership } from "@/kernel/api/codecs/fdmRegionMembershipCodec";
import {
  findElement,
  findElements,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type {
  FdmCellPhysicsSnapshot,
  FdmCellPhysicsTarget,
} from "@/kernel/resources/fdmCellPhysicsResources";
import { InspectorEditSessionProvider } from "@/modules/inspector/InspectorEditSession";
import { FMRM_INACTIVE_REGION_ID } from "@/shared/domain/mesh/domainPresentation";

const mocks = vi.hoisted(() => {
  const regionIds = new Uint32Array(200);
  regionIds.fill(0xffffffff); // FMRM_INACTIVE_REGION_ID by default
  // Cell 17 -> (7, 1, 0) in [10, 10, 2]: active region 1 ("core")
  regionIds[17] = 1;
  // Neighbor +X -> cell 18 -> (8, 1, 0): active region 2 ("cladding")
  regionIds[18] = 2;
  // Neighbor -Y -> cell 7 -> (7, 0, 0): active unassigned (0)
  regionIds[7] = 0;

  return {
    binaryData: null as DecodedFdmRegionMembership | null,
    binaryStatus: "ready" as "ready" | "loading" | "error",
    cellPhysicsError: null as Error | null,
    cellPhysicsRefetch: vi.fn(),
    cellPhysicsSnapshot: null as FdmCellPhysicsSnapshot | null,
    cellPhysicsStatus: "ready" as "ready" | "loading" | "stale" | "error" | "idle",
    clearTarget: vi.fn(),
    domainMeta: null as DomainMetaResource | null,
    domainStatus: "ready" as "ready" | "loading" | "stale" | "error",
    executeCommand: vi.fn().mockResolvedValue({
      message: "FDM grid refresh completed.",
      status: "completed",
    }),
    invalidate: vi.fn(),
    lastCellPhysicsTarget: undefined as FdmCellPhysicsTarget | null | undefined,
    membership: null as (FdmRegionMembershipResource & {
      layer_summaries?: readonly Record<string, unknown>[];
    }) | null,
    membershipStatus: "ready" as "ready" | "loading" | "stale" | "error",
    multilayer: null as FdmMultilayerLayoutResource | null,
    multilayerStatus: "ready" as "ready" | "loading" | "error",
    patchTargetPending: vi.fn(),
    patchViewportPreferences: vi.fn(),
    queuePatch: vi.fn().mockReturnValue({ transactionId: "tx-viz-1" }),
    regionDiagnostics: null as RegionDiagnosticsResource | null,
    regions: null as RegionListResource | null,
    scene: null as SceneResource | null,
    selectSet: vi.fn(),
    templateRegionIds: regionIds,
    visualizationState: null as VisualizationStateResource | null,
    vizSnapshot: {
      defaults: {},
      overrides: {},
      pendingOverrides: {},
      version: 1,
      viewportPreferences: {},
    },
  };
});

vi.mock("@/kernel/KernelContext", async () => {
  const { createContext } = await import("react");
  const controller = {
    clearTarget: mocks.clearTarget,
    getSnapshot: () => mocks.vizSnapshot,
    patchTargetPending: mocks.patchTargetPending,
    patchViewportPreferences: mocks.patchViewportPreferences,
    subscribe: () => () => undefined,
  };
  const kernelValue = {
    api: {
      meshing: {},
      model: {},
      visualization: {},
    },
    bus: { emit: vi.fn(), on: () => () => undefined },
    commands: { execute: mocks.executeCommand },
    diagnosticRecorder: { record: vi.fn() },
    layout: { setPanelVisible: vi.fn() },
    resources: {
      get: () => null,
      getRevision: () => 1,
      invalidate: mocks.invalidate,
      subscribe: () => () => undefined,
    },
    selection: { set: mocks.selectSet },
    visualization: controller,
    visualizationSync: {
      queuePatch: mocks.queuePatch,
    },
  };
  return {
    KernelContext: createContext<unknown>(kernelValue),
    useKernel: () => kernelValue,
  };
});

vi.mock("@/kernel/resources/fdmCellPhysicsResources", () => ({
  fdmCellCenter: (
    origin: readonly number[],
    spacing: readonly number[],
    ijk: readonly number[],
  ) => [
    (origin[0] ?? 0) + ((ijk[0] ?? 0) + 0.5) * (spacing[0] ?? 0),
    (origin[1] ?? 0) + ((ijk[1] ?? 0) + 0.5) * (spacing[1] ?? 0),
    (origin[2] ?? 0) + ((ijk[2] ?? 0) + 0.5) * (spacing[2] ?? 0),
  ],
  useFdmCellPhysicsResource: (target: FdmCellPhysicsTarget | null) => {
    mocks.lastCellPhysicsTarget = target;
    return {
      data: mocks.cellPhysicsSnapshot,
      error: mocks.cellPhysicsError,
      refetch: mocks.cellPhysicsRefetch,
      status: mocks.cellPhysicsStatus,
    };
  },
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useDomainMetaResource: () => ({
    data: mocks.domainMeta,
    error: null,
    refetch: vi.fn(),
    revision: 1,
    status: mocks.domainStatus,
  }),
  useFdmMultilayerLayerActiveMasksResource: () => ({
    data: { incompatibleLayerIds: [], masks: new Map() },
    error: null,
    refetch: vi.fn(),
    revision: 1,
    status: "ready" as const,
  }),
  useFdmMultilayerLayoutResource: () => ({
    data: mocks.multilayer,
    error: null,
    refetch: vi.fn(),
    revision: 1,
    status: mocks.multilayerStatus,
  }),
  useFdmRegionMembershipBinaryResource: () => ({
    availability: {
      generationId: "gen-fdm-1",
      gridFingerprint: "fp-grid-1",
      legendFingerprint: "fp-leg-1",
      status: "ready" as const,
    },
    data: mocks.binaryData,
    error: null,
    refetch: vi.fn(),
    revision: 1,
    status: mocks.binaryStatus,
  }),
  useFdmRegionMembershipResource: () => ({
    availability: {
      generationId: "gen-fdm-1",
      gridFingerprint: "fp-grid-1",
      legendFingerprint: "fp-leg-1",
      status: "ready" as const,
    },
    data: mocks.membership,
    error: null,
    refetch: vi.fn(),
    revision: 1,
    status: mocks.membershipStatus,
  }),
  useModelRegionDiagnosticsResource: () => ({
    data: mocks.regionDiagnostics,
    error: null,
    refetch: vi.fn(),
    revision: 1,
    status: "ready" as const,
  }),
  useModelRegionsResource: () => ({
    data: mocks.regions,
    error: null,
    refetch: vi.fn(),
    revision: 1,
    status: "ready" as const,
  }),
  useSceneResource: () => ({
    data: mocks.scene,
    error: null,
    refetch: vi.fn(),
    revision: 1,
    sessionScopeKey: "sess-1",
    status: "ready" as const,
  }),
  useVisualizationStateResource: () => ({
    data: mocks.visualizationState,
    error: null,
    optimisticData: mocks.visualizationState,
    rawData: mocks.visualizationState,
    refetch: vi.fn(),
    revision: 3,
    status: "ready" as const,
  }),
}));

import {
  FdmCellInspectorSpecPanel,
  FdmGridInspectorSpecPanel,
  FdmGridLayerInspectorSpecPanel,
} from "../../inspectors/mesh/fdm";

function resetDefaultFixtures(): void {
  mocks.executeCommand.mockClear();
  mocks.invalidate.mockClear();
  mocks.selectSet.mockClear();
  mocks.queuePatch.mockClear();
  mocks.patchTargetPending.mockClear();
  mocks.patchViewportPreferences.mockClear();
  mocks.clearTarget.mockClear();
  mocks.cellPhysicsRefetch.mockClear();
  mocks.lastCellPhysicsTarget = undefined;

  mocks.domainStatus = "ready";
  mocks.membershipStatus = "ready";
  mocks.multilayerStatus = "ready";
  mocks.binaryStatus = "ready";
  mocks.cellPhysicsStatus = "ready";
  mocks.cellPhysicsError = null;

  mocks.domainMeta = {
    bounds: { max: [20e-9, 20e-9, 4e-9], min: [0, 0, 0] },
    discretization: "fdm",
    domain_id: "dom-fdm-1",
    generation_id: "gen-fdm-1",
    grid: {
      origin: [0, 0, 0],
      shape: [10, 10, 2],
      spacing: [2e-9, 2e-9, 2e-9],
    },
    units: { length: "m" },
  };

  mocks.membership = {
    cell_count: 200,
    cell_m: [2e-9, 2e-9, 2e-9],
    counts: [10, 10, 2],
    domain_generation_id: "gen-fdm-1",
    encoding: "fmrm_uint32_le_v2",
    freshness: "current",
    grid_fingerprint: "fp-grid-1",
    layer_summaries: [
      {
        active_cell_count: 48000,
        dominant_object_id: "obj-bottom",
        inactive_cell_count: 17536,
        layer_id: "bottom_fm",
      },
    ],
    magnetic_support: {
      active_cell_count: 140,
      active_unassigned_cell_count: 12,
      bounds_max_m: [18e-9, 18e-9, 4e-9],
      bounds_min_m: [2e-9, 2e-9, 0],
      grid_fingerprint: "fp-grid-1",
      inactive_cell_count: 60,
      semantic_role: "magnetic-support",
    },
    mesh_revision: 2,
    object_ids: ["obj-wg"],
    origin_m: [0, 0, 0],
    region_legend: [
      {
        numeric_id: 1,
        object_id: "obj-wg",
        priority: 10,
        region_id: "core",
      },
      {
        numeric_id: 2,
        object_id: "obj-wg",
        priority: 5,
        region_id: "cladding",
      },
    ],
    region_legend_fingerprint: "fp-leg-1",
    region_membership_revision: 5,
    schema_version: 2,
  };

  const regionIds = new Uint32Array(mocks.templateRegionIds);
  regionIds[0] = FMRM_INACTIVE_REGION_ID;
  mocks.binaryData = {
    cellCount: 200,
    counts: [10, 10, 2],
    gridFingerprint: "fp-grid-1",
    legendFingerprint: "fp-leg-1",
    regionIds,
    semanticStatus: "canonical",
    version: 2,
  };

  mocks.multilayer = {
    airbox: {
      carrier_available: false,
      h_demag_available: false,
      h_eff_available: false,
      target_only: true,
    },
    available: false,
    common_transform_layout: {
      cell_size: [2e-9, 2e-9, 2.5e-9],
      fft_shape: [512, 256, 16],
      is_physical_mesh: false,
      origin: [-2.56e-7, -1.28e-7, -1e-8],
      provenance: "fft_zero_padded_dipole_kernel",
      shape: [256, 128, 8],
    },
    domain_generation_id: "gen-fdm-1",
    layers: [
      {
        active_cell_count: 45000,
        active_mask_present: true,
        convolution_cell_size: [2e-9, 2e-9, 2e-9],
        convolution_grid: [512, 512, 1],
        inactive_cell_count: 20536,
        layer_id: "bottom_fm",
        magnet_name: "Bottom Ferromagnet",
        mask_provenance: "explicit_geometry_clip_v2",
        native_cell_size: [2e-9, 2e-9, 2e-9],
        native_grid: [256, 256, 1],
        native_grid_fingerprint: "fp-layer-bottom",
        native_origin: [-2.56e-7, -2.56e-7, 0],
        object_id: "obj-bottom",
        transfer_kind: "dipole_fft",
      },
    ],
    layout_fingerprint: "fp-ml-layout-7",
    layout_revision: 7,
    observation_revision: 3,
  };

  mocks.scene = {
    objects: [
      {
        id: "obj-wg",
        material_ref: "mat_cobalt",
        name: "Free Waveguide",
      },
      {
        id: "obj-bottom",
        material_ref: "mat_cofeb",
        name: "Bottom Ferromagnet",
      },
    ],
    revision: 4,
  } as unknown as SceneResource;

  mocks.regions = {
    geometry_realization_revision: 2,
    regions: [
      {
        bounds_max: [16e-9, 16e-9, 4e-9],
        bounds_min: [2e-9, 2e-9, 0],
        enabled: true,
        interaction_refs: [],
        material_overrides: [{ parameter: "alpha", value: 0.01 }],
        material_ref: "mat_permalloy",
        mesh_part_ids: [],
        name: "Core Track",
        owner_object_id: "obj-wg",
        priority: 10,
        region_id: "core",
        source: "authored_subregion",
        source_body_ids: [],
        source_object_ids: ["obj-wg"],
      },
    ],
    scene_revision: 4,
  } as unknown as RegionListResource;

  mocks.regionDiagnostics = {
    diagnostics: [
      {
        code: "REGION_CLIPPED_TO_SUPPORT",
        diagnostic_id: "diag-1",
        message: "Region clipped to parent waveguide support",
        owner_object_id: "obj-wg",
        region_id: "core",
        severity: "info",
      },
    ],
    scene_revision: 4,
  };

  mocks.visualizationState = {
    clip: { axis: "z", enabled: false, flipped: false, position_percent: 50 },
    layers: {
      airbox: {
        bounds: { opacity: 1, visible: true },
        points: { opacity: 1, visible: false },
        vectors: { visible: false },
        visible: true,
        wireframe: { opacity: 0.55, visible: true },
      },
      magnet: {
        bounds: { opacity: 1, visible: false },
        points: { opacity: 1, visible: false },
        shader: { mode: "orientation", visible: true },
        vectors: { visible: false },
        visible: true,
        wireframe: { opacity: 1, visible: false },
      },
    },
    overrides: [],
    quantity: { active_quantity_id: "m", colormap: "viridis" },
    revision: 3,
    slice: {
      axis: "z",
      mesh_color_scale: "viridis",
      mesh_filter_expression: "",
      mesh_quality_metric: "gamma",
      mesh_shrink_factor: 1,
      position_percent: 50,
      show_mesh: false,
    },
  };

  mocks.cellPhysicsSnapshot = {
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
        group: "material",
        id: "mat_aex",
        label: "Exchange stiffness",
        reason: "DMI/exchange coefficient not published for this run.",
        scalar: null,
        sourceStep: null,
        sourceTimeSeconds: null,
        status: "unavailable",
        unit: "J/m",
        vector: null,
      },
      {
        group: "magnetization",
        id: "m",
        label: "Magnetization",
        reason: null,
        scalar: 1,
        sourceStep: 42,
        sourceTimeSeconds: 1.25e-10,
        status: "ready",
        unit: "1",
        vector: [0.8, 0.6, 0],
      },
      {
        group: "energy",
        id: "eden_ex",
        label: "Exchange energy density",
        reason: null,
        scalar: 1500,
        sourceStep: 42,
        sourceTimeSeconds: 1.25e-10,
        status: "ready",
        unit: "J/m³",
        vector: null,
      },
      {
        group: "energy",
        id: "eden_dmi",
        label: "DMI energy density",
        reason: null,
        scalar: 25,
        sourceStep: 42,
        sourceTimeSeconds: 1.25e-10,
        status: "ready",
        unit: "kJ/m³",
        vector: null,
      },
    ],
    runId: "run-fdm-99",
    volumeM3: 8e-27,
  };
}

function assertCleanInspectorDomContract(root: MountedWave5TestDom["container"]): void {
  const rawSelects = findElements(root, (el) => el.tagName === "SELECT");
  const rawTextareas = findElements(root, (el) => el.tagName === "TEXTAREA");
  const rawImages = findElements(
    root,
    (el) => el.tagName === "IMG" || el.tagName === "CANVAS",
  );
  const titleElements = findElements(root, (el) => el.getAttribute("title") !== null);
  expect(rawSelects).toHaveLength(0);
  expect(rawTextareas).toHaveLength(0);
  expect(rawImages).toHaveLength(0);
  expect(titleElements).toHaveLength(0);

  const text = root.textContent ?? "";
  expect(text).not.toMatch(/\bunknown\b/i);
  expect(text).not.toMatch(/\bunavailable\b/i);
  expect(text).not.toMatch(/\bn\/a\b/i);
}

describe("Wave 5 Slice 2 — FDM Grid, Native Layer, and Cell Parity & Design Contract", () => {
  let harness: MountedWave5TestDom;

  beforeEach(() => {
    resetDefaultFixtures();
    harness = mountWave5TestDom();
  });

  afterEach(() => {
    harness.unmount();
  });

  it("fdm.cell resolves canonical string ref.cellOrdinal, decodes binary FMRM provenance, renders per-field sourceStep/sourceTimeSeconds and reasons, and emits canonical neighbor SelectionRef", async () => {
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(FdmCellInspectorSpecPanel, {
            selection: {
              kind: "fdm.cell",
              label: "FDM Voxel (7, 1, 0)",
              moduleSource: "viewport-3d",
              nodeId: "model:mesh:grid",
              objectId: null,
              ref: {
                cellOrdinal: "17",
                gridFingerprint: "fp-grid-1",
                ijk: [7, 1, 0],
                kind: "fdm.cell",
                maskState: "region",
                membershipRevision: "2:5",
                nodeId: "model:mesh:grid",
                numericRegionId: 1,
                regionId: "core",
                type: "fdm-cell",
                visualizationTargetId: "fdm-domain",
              },
            },
          }),
        ),
      );
    });

    // Must inspect picked cell 17 (never falling back to voxel 0!)
    expect(mocks.lastCellPhysicsTarget?.ordinal).toBe(17);

    const text = harness.container.textContent ?? "";
    expect(text).toContain("Active region (region)");
    expect(text).toContain("core");
    expect(text).toContain("2:5");
    expect(text).toContain("authored_subregion");
    expect(text).toContain("Free Waveguide (obj-wg) / core (priority 10)");
    expect(text).toContain("mat_permalloy (1 override(s))");
    expect(text).toContain("Region interface (cladding, unassigned support)");
    expect(text).toContain("Support–vacuum boundary");
    expect(text).toContain("cladding (priority 5) — resolved by priority 10");
    expect(text).toContain("Region clipped to parent waveguide support");
    expect(text).toContain("gen-fdm-1 · fp-grid-1 · rev 2:5");

    // Per-field sourceStep / sourceTimeSeconds and unmaterialized reasons
    expect(text).toContain("step 0 · t = 0 s");
    expect(text).toContain("step 42 · t = 1.250e-10 s");
    expect(text).toContain("DMI/exchange coefficient not published for this run.");
    expect(text).toContain("Cannot interpret kJ/m³ as energy density in J/m³.");

    assertCleanInspectorDomContract(harness.container);

    // Switch to Grid & 6-Neighbors tab and click +X neighbor (ordinal 18 -> cladding)
    const neighborTab = findElement(
      harness.container,
      (el) =>
        el.getAttribute("role") === "tab" &&
        Boolean(el.textContent?.includes("Grid & 6-Neighbors")),
    );
    expect(neighborTab).not.toBeNull();
    await act(async () => {
      neighborTab!.click();
    });

    const plusXBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("+X")) &&
        Boolean(el.textContent?.includes("(8, 1, 0)")),
    );
    expect(plusXBtn).not.toBeNull();
    await act(async () => {
      plusXBtn!.click();
    });

    expect(mocks.selectSet).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "fdm.cell",
        ref: expect.objectContaining({
          cellOrdinal: "18",
          ijk: [8, 1, 0],
          maskState: "region",
          numericRegionId: 2,
          regionId: "cladding",
          type: "fdm-cell",
        }),
      }),
      "inspector",
    );
  });

  it("fdm.cell enforces vacuum, multilayer, and stale-revision guards and wires 'Retry cell physics read'", async () => {
    // 1. Vacuum / inactive cell guard (cellOrdinal "0")
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(FdmCellInspectorSpecPanel, {
            selection: {
              kind: "fdm.cell",
              label: "FDM Voxel (0, 0, 0)",
              moduleSource: "viewport-3d",
              nodeId: "model:mesh:grid",
              objectId: null,
              ref: {
                cellOrdinal: "0",
                gridFingerprint: "fp-grid-1",
                ijk: [0, 0, 0],
                kind: "fdm.cell",
                maskState: "inactive",
                membershipRevision: "2:5",
                nodeId: "model:mesh:grid",
                numericRegionId: null,
                regionId: null,
                type: "fdm-cell",
                visualizationTargetId: "fdm-domain",
              },
            },
          }),
        ),
      );
    });
    expect(mocks.lastCellPhysicsTarget).toBeNull();
    expect(harness.container.textContent).toContain(
      "This cell is outside the magnetic support.",
    );
    expect(harness.container.textContent).toContain("Vacuum (μ₀)");

    // 2. Multilayer guard
    mocks.multilayer = { ...mocks.multilayer!, available: true };
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(FdmCellInspectorSpecPanel, {
            selection: {
              kind: "fdm.cell",
              label: "FDM Voxel (7, 1, 0)",
              moduleSource: "viewport-3d",
              nodeId: "model:mesh:grid",
              objectId: null,
              ref: {
                cellOrdinal: "17",
                gridFingerprint: "fp-grid-1",
                ijk: [7, 1, 0],
                kind: "fdm.cell",
                maskState: "region",
                membershipRevision: "2:5",
                nodeId: "model:mesh:grid",
                numericRegionId: 1,
                regionId: "core",
                type: "fdm-cell",
                visualizationTargetId: "fdm-domain",
              },
            },
          }),
        ),
      );
    });
    expect(mocks.lastCellPhysicsTarget).toBeNull();
    expect(harness.container.textContent).toContain(
      "Cell physics requires a physical single-grid FDM cell; the common multilayer grid is not a material carrier.",
    );

    // 3. Stale revision guard
    mocks.multilayer = { ...mocks.multilayer!, available: false };
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(FdmCellInspectorSpecPanel, {
            selection: {
              kind: "fdm.cell",
              label: "FDM Voxel (7, 1, 0)",
              moduleSource: "viewport-3d",
              nodeId: "model:mesh:grid",
              objectId: null,
              ref: {
                cellOrdinal: "17",
                gridFingerprint: "fp-grid-1",
                ijk: [7, 1, 0],
                kind: "fdm.cell",
                maskState: "region",
                membershipRevision: "1:1",
                nodeId: "model:mesh:grid",
                numericRegionId: 1,
                regionId: "core",
                type: "fdm-cell",
                visualizationTargetId: "fdm-domain",
              },
            },
          }),
        ),
      );
    });
    expect(mocks.lastCellPhysicsTarget).toBeNull();
    expect(harness.container.textContent).toContain(
      "The selected FDM cell identity does not match the current grid or membership resource.",
    );

    // 4. Read error -> Retry cell physics read invalidates DATA_FIELDS_PATH and refetches
    mocks.cellPhysicsStatus = "error";
    mocks.cellPhysicsError = new Error("Point sample request timed out.");

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(FdmCellInspectorSpecPanel, {
            selection: {
              kind: "fdm.cell",
              label: "FDM Voxel (7, 1, 0)",
              moduleSource: "viewport-3d",
              nodeId: "model:mesh:grid",
              objectId: null,
              ref: {
                cellOrdinal: "17",
                gridFingerprint: "fp-grid-1",
                ijk: [7, 1, 0],
                kind: "fdm.cell",
                maskState: "region",
                membershipRevision: "2:5",
                nodeId: "model:mesh:grid",
                numericRegionId: 1,
                regionId: "core",
                type: "fdm-cell",
                visualizationTargetId: "fdm-domain",
              },
            },
          }),
        ),
      );
    });

    expect(harness.container.textContent).toContain(
      "Point sample request timed out.",
    );
    const retryBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Retry cell physics read")),
    );
    expect(retryBtn).not.toBeNull();
    await act(async () => {
      retryBtn!.click();
    });

    expect(mocks.invalidate).toHaveBeenCalledWith(
      DATA_FIELDS_PATH,
      expect.any(Number),
    );
    expect(mocks.cellPhysicsRefetch).toHaveBeenCalledTimes(1);
    assertCleanInspectorDomContract(harness.container);
  });

  it("mesh.grid reads membership.magnetic_support, resolveFdmDisplaySampling, membershipCompatible, and executes 'grid.build-fdm'", async () => {
    mocks.domainMeta = {
      ...mocks.domainMeta!,
      grid: {
        origin: [0, 0, 0],
        shape: [100, 100, 20],
        spacing: [2e-9, 2e-9, 2e-9],
      },
    };
    mocks.membership = {
      ...mocks.membership!,
      cell_count: 200000,
      counts: [100, 100, 20],
      magnetic_support: {
        active_cell_count: 140000,
        active_unassigned_cell_count: 12000,
        bounds_max_m: [1.8e-7, 1.8e-7, 4e-8],
        bounds_min_m: [2e-8, 2e-8, 0],
        grid_fingerprint: "fp-grid-1",
        inactive_cell_count: 60000,
        semantic_role: "magnetic-support",
      },
    };

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

    const text = harness.container.textContent ?? "";
    // Real magnetic_support counts: active=140,000, assigned=128,000, unassigned=12,000, inactive=60,000
    expect(text).toContain("140,000");
    expect(text).toContain("128,000");
    expect(text).toContain("12,000");
    expect(text).toContain("60,000");
    expect(text).toContain("(20, 20, 0) nm");
    expect(text).toContain("(180, 180, 40) nm");

    // resolveFdmDisplaySampling(200_000): samples=150,000, stride=2, budget=150,000
    expect(text).toContain("150,000");
    expect(text).toContain("Display stride");

    // Click Build FDM Grid -> executes "grid.build-fdm" with DATA_DOMAIN_META_PATH in resourceData
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

    expect(mocks.executeCommand).toHaveBeenCalledWith(
      "grid.build-fdm",
      expect.objectContaining({
        resourceData: expect.objectContaining({
          [DATA_DOMAIN_META_PATH]: mocks.domainMeta,
        }),
        source: "inspector",
        sourceDetail: "mesh.grid",
      }),
    );

    assertCleanInspectorDomContract(harness.container);

    // Incompatible membership counts -> Stale pill + warning notice + withheld support counts
    mocks.membership = {
      ...mocks.membership!,
      counts: [64, 64, 1],
    };
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

    expect(harness.container.textContent).toContain(
      "FDM region membership is stale or no longer matches the structured grid.",
    );
  });

  it("mesh.grid handles redirected universe-outside-support live 3D Airbox visualization + reset, common FFT grid fields, and selected region lookup", async () => {
    // 1. Redirected mesh.grid.universe-outside-support -> real Airbox visualization sync & reset
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(FdmGridInspectorSpecPanel, {
            selection: {
              kind: "mesh.grid",
              label: "Airbox Visualization",
              moduleSource: "explorer",
              nodeId: "model:mesh:grid:universe-outside-support",
              objectId: null,
              ref: {
                kind: "mesh.grid.universe-outside-support",
                nodeId: "model:mesh:grid:universe-outside-support",
                scope: "universe-outside-support",
                type: "fdm-domain",
                visualizationTargetId: "fdm-universe-outside-support",
              },
            },
          }),
        ),
      );
    });

    const switches = findElements(
      harness.container,
      (el) => el.getAttribute("role") === "switch",
    );
    expect(switches.length).toBeGreaterThanOrEqual(2);

    await act(async () => {
      switches[0]!.click();
    });

    expect(mocks.queuePatch).toHaveBeenCalledWith(
      expect.objectContaining({
        layers: expect.objectContaining({
          airbox: expect.objectContaining({ visible: false }),
        }),
      }),
      ["airbox"],
    );
    expect(mocks.patchTargetPending).toHaveBeenCalled();

    const resetBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Reset display")),
    );
    expect(resetBtn).not.toBeNull();
    await act(async () => {
      resetBtn!.click();
    });
    expect(mocks.clearTarget).toHaveBeenCalledWith(
      expect.objectContaining({ id: "airbox", kind: "airbox" }),
    );

    // 2. Redirected mesh.grid.common -> FFT scratch layout fields + readOnly commitBar
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(FdmGridInspectorSpecPanel, {
            selection: {
              kind: "mesh.grid",
              label: "Common Grid",
              moduleSource: "explorer",
              nodeId: "model:mesh:grid:common",
              objectId: null,
              ref: {
                kind: "mesh.grid.common",
                nodeId: "model:mesh:grid:common",
                scope: "common",
                type: "fdm-domain",
                visualizationTargetId: "fdm-domain",
              },
            },
          }),
        ),
      );
    });

    const commonText = harness.container.textContent ?? "";
    expect(commonText).toContain("512 × 256 × 16");
    expect(commonText).toContain("No (FFT scratch layout)");
    expect(commonText).toContain("fft_zero_padded_dipole_kernel");

    // 3. Redirected mesh.grid.region -> selected region lookup
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(FdmGridInspectorSpecPanel, {
            selection: {
              kind: "mesh.grid",
              label: "core",
              moduleSource: "explorer",
              nodeId: "model:mesh:grid:region:core",
              objectId: "obj-wg",
              ref: {
                kind: "mesh.grid.region",
                nodeId: "model:mesh:grid:region:core",
                objectId: "obj-wg",
                regionId: "core",
                scope: "region",
                type: "fdm-domain",
                visualizationTargetId: "region:obj-wg:core",
              },
            },
          }),
        ),
      );
    });

    const regionText = harness.container.textContent ?? "";
    expect(regionText).toContain("Selected FDM region");
    expect(regionText).toContain("core");
    expect(regionText).toContain("#1");
    expect(regionText).toContain("obj-wg");
    assertCleanInspectorDomContract(harness.container);
  });

  it("mesh.grid.layer wires real fdm-native-layer:<layerId> 3D visualization + reset and renders layer_summaries, mask_provenance, convolution_grid, convolution_cell_size, and layout_revision", async () => {
    mocks.multilayer = { ...mocks.multilayer!, available: true };

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(FdmGridLayerInspectorSpecPanel, {
            selection: {
              kind: "mesh.grid.layer",
              label: "Bottom Ferromagnet",
              moduleSource: "explorer",
              nodeId: "model:mesh:grid:layer:bottom_fm",
              objectId: "obj-bottom",
              ref: {
                kind: "mesh.grid.layer",
                layerId: "bottom_fm",
                nodeId: "model:mesh:grid:layer:bottom_fm",
                objectId: "obj-bottom",
                scope: "layer",
                type: "fdm-domain",
                visualizationTargetId: "fdm-native-layer:bottom_fm",
              },
            },
          }),
        ),
      );
    });

    const text = harness.container.textContent ?? "";
    expect(text).toContain("Bottom Ferromagnet (obj-bottom)");
    expect(text).toContain("48,000");
    expect(text).toContain("17,536");
    expect(text).toContain("explicit_geometry_clip_v2");
    expect(text).toContain("512 × 512 × 1");
    expect(text).toContain("2 × 2 × 2 nm");
    expect(text).toContain("fp-ml-layout-7");
    expect(text).toContain("7");

    assertCleanInspectorDomContract(harness.container);

    // Toggle "Show layer bounds" switch -> queues override for fdm-native-layer:bottom_fm
    const layerSwitches = findElements(
      harness.container,
      (el) => el.getAttribute("role") === "switch",
    );
    expect(layerSwitches.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      layerSwitches[1]!.click();
    });

    expect(mocks.queuePatch).toHaveBeenCalledWith(
      expect.objectContaining({
        overrides: expect.arrayContaining([
          expect.objectContaining({
            display: expect.objectContaining({
              bounds: { visible: true },
            }),
            scope: "fdm_native_layer",
            scope_id: "fdm-native-layer:bottom_fm",
          }),
        ]),
      }),
      ["fdm-native-layer:bottom_fm"],
    );
    expect(mocks.patchTargetPending).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "fdm-native-layer:bottom_fm",
        kind: "fdm-native-layer",
      }),
      expect.objectContaining({ boundsVisible: true }),
      3,
      "tx-viz-1",
    );

    // Click "Reset display" -> clears target override
    const resetBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Reset display")),
    );
    expect(resetBtn).not.toBeNull();
    await act(async () => {
      resetBtn!.click();
    });

    expect(mocks.clearTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "fdm-native-layer:bottom_fm",
        kind: "fdm-native-layer",
      }),
    );
  });
});
