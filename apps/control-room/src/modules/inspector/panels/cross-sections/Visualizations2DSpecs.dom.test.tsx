import {
  mountWave5TestDom,
  setTestInputValue,
  type MountedWave5TestDom,
} from "../mesh-details/wave5TestDomSetup.test-support";

import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findElement,
  findElements,
  type TestElement,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { MODEL_PLANAR_MONITORS_PATH } from "@/kernel/api/apiPaths";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  beginCrossSectionDraft,
  commitCrossSectionDraft,
  crossSectionWorkspaceStore,
  planarMonitorValidationErrors,
  resetCrossSectionWorkspaceForTests,
  updateCrossSectionDraft,
} from "@/kernel/workspace/crossSectionWorkspace";
import { planarMonitorFramePreviewStore } from "@/kernel/workspace/planarMonitorFramePreview";
import { InspectorEditSessionProvider } from "@/modules/inspector/InspectorEditSession";

import {
  buildPlanarMonitorCreatePayload,
  QUALITY_METRIC_OPTIONS,
  resetCompanionSliceMetaForTests,
  setCompanionSliceMeta,
  SLICE_COLORMAP_OPTIONS,
  SLICE_FIELD_COMPONENT_OPTIONS,
} from "./visualizations2DModel";

const mocks = vi.hoisted(() => ({
  capturedChartOptions: [] as unknown[],
  crossSectionQualityEnabled: [] as boolean[],
  crossSectionResourceState: {
    data: {
      bounds: { uMax: 4e-8, uMin: 0, vMax: 2e-8, vMin: 0 },
      intersectionEdgeNodeIds: new Uint32Array(16),
      intersectionEdgeT: new Float32Array(8),
      intersectionKinds: new Uint32Array([0, 1, 0, 1, 0, 0, 1, 0]),
      intersectionWorld: new Float32Array(24),
      parentElementIds: new Uint32Array([7, 8, 12]),
      polygonCount: 3,
      polygonOffsets: new Uint32Array([0, 4, 8, 11]),
      segmentCount: 0,
      segments: new Float32Array(),
      vertexCount: 11,
      vertices: new Float32Array([
        0, 0, 2e-8, 0, 2e-8, 2e-8, 0, 2e-8,
        2e-8, 0, 4e-8, 0, 4e-8, 2e-8, 2e-8, 2e-8,
        0, 2e-8, 2e-8, 2e-8, 1e-8, 4e-8,
      ]),
    } as unknown,
    error: null as unknown,
    refetch: vi.fn(),
    revision: "etag-cs-1",
    status: "ready" as "ready" | "error" | "loading",
  },
  crossSectionQualityState: {
    data: {
      perElementQuality: new Float32Array([0.05, 0.55, 0.85]),
      range: { max: 0.85, min: 0.05 },
    } as unknown,
    error: null as unknown,
    refetch: vi.fn(),
    revision: "etag-csq-1",
    status: "ready" as "ready" | "error" | "loading",
  },
  domainMeta: vi.fn(),
  flushNow: vi.fn().mockResolvedValue(undefined),
  historyRecord: vi.fn(),
  invalidate: vi.fn(),
  monitorsCreate: vi.fn(),
  monitorsList: vi.fn(),
  monitorsPatch: vi.fn(),
  monitorsRefetch: vi.fn(),
  monitorsRemove: vi.fn(),
  monitorsState: {
    monitors: [] as Array<{
      id: string;
      name: string;
      target: { kind: "domain" };
      frame: {
        origin_m: [number, number, number];
        u_axis: [number, number, number];
        v_axis: [number, number, number];
        normal: [number, number, number];
        preset: "xy" | "xz" | "yz" | null;
        normalization_version: "planar_frame_v1";
        extent: { kind: "universe"; padding_m: number };
      };
      operator: { kind: "plane_sample" };
    }>,
    scene_revision: 7,
  },
  queuePatch: vi.fn(),
  sceneGet: vi.fn(),
  selectSet: vi.fn(),
  sessionScopeKey: "session=session-cs&epoch=1&request_scope_epoch=1" as string | null,
  setActiveViewportMainModule: vi.fn(),
  setFocusedSlot: vi.fn(),
  setPanelVisible: vi.fn(),
  vizStateData: {
    clip: { axis: "z" as const, enabled: false, flipped: false, position_percent: 50 },
    planar: {
      colormap: "viridis",
      component: "magnitude",
      default_slice: { plane: "xy", position_fraction: 0.5 },
      interaction: { pan_u: 0, pan_v: 0, zoom: 1 },
      layers: {
        boundaries: false,
        bounds: false,
        contours: false,
        mesh: true,
        points: false,
        probes: true,
        raster: true,
        streamlines: false,
        vectors: false,
      },
      point_style: { color: "#ffffff", opacity: 0.8, size_px: 3 },
      quality: "balanced",
      quantity_id: "m",
      range: { max: null, min: null, mode: "auto" },
      resolution: { height: 512, vector_budget: 2000, width: 512 },
      source: { kind: "default" as const },
      vector_style: {
        color_mode: "orientation",
        length_mode: "uniform",
        monochrome_color: "#ffffff",
        opacity: 1,
        scale: 1,
        thickness: 1,
      },
      view_scope: { kind: "monitor_target" },
      viewport_colorbar_visible: true,
      visible: true,
      wireframe_style: { color: "#94a3b8", opacity: 0.45 },
    },
    slice: {
      axis: "z" as const,
      mesh_color_scale: "viridis" as const,
      mesh_filter_expression: "",
      mesh_quality_metric: "skewness" as const,
      mesh_shrink_factor: 1,
      position_percent: 50,
      show_mesh: true,
    },
  },
}));

vi.mock("@/shared/charts/ScientificEChart", () => ({
  ScientificEChart: ({
    ariaLabel,
    emptyMessage,
    optionBuilder,
  }: {
    ariaLabel: string;
    emptyMessage?: string;
    optionBuilder: (palette: Record<string, unknown>) => unknown;
  }) => {
    const built = optionBuilder({
      accent: "#3b82f6",
      borderSubtle: "#334155",
      fontSize: 12,
      textMuted: "#94a3b8",
    });
    mocks.capturedChartOptions.push(built);
    return createElement(
      "div",
      {
        "aria-label": ariaLabel,
        "data-slot": "scientific-echart",
      },
      emptyMessage ? createElement("span", { role: "status" }, emptyMessage) : null,
    );
  },
}));

vi.mock("@/kernel/KernelContext", async () => {
  const { createContext } = await import("react");
  const kernelValue = {
    api: {
      data: {
        domain: {
          meta: (...args: unknown[]) => mocks.domainMeta(...args),
        },
      },
      meshing: {
        sharedDomain: {
          crossSection: vi.fn(),
          crossSectionQuality: vi.fn(),
        },
      },
      model: {
        planarMonitors: {
          create: (...args: unknown[]) => mocks.monitorsCreate(...args),
          list: (...args: unknown[]) => mocks.monitorsList(...args),
          patch: (...args: unknown[]) => mocks.monitorsPatch(...args),
          remove: (...args: unknown[]) => mocks.monitorsRemove(...args),
        },
        scene: (...args: unknown[]) => mocks.sceneGet(...args),
      },
    },
    authoringHistory: {
      getGeneration: () => 1,
      record: (...args: unknown[]) => mocks.historyRecord(...args),
    },
    bus: { emit: vi.fn(), on: () => () => undefined },
    commands: {
      execute: vi.fn().mockResolvedValue({ status: "completed" }),
      getSessionScopeKey: () => mocks.sessionScopeKey,
    },
    diagnosticRecorder: { record: vi.fn() },
    layout: {
      setActiveViewportMainModule: mocks.setActiveViewportMainModule,
      setFocusedSlot: mocks.setFocusedSlot,
      setPanelVisible: mocks.setPanelVisible,
    },
    resources: {
      get: () => null,
      getRevision: () => 1,
      invalidate: mocks.invalidate,
      subscribe: () => () => undefined,
    },
    selection: {
      get: () => null,
      set: mocks.selectSet,
    },
    visualizationSync: {
      flushNow: mocks.flushNow,
      queuePatch: mocks.queuePatch,
    },
  };
  return {
    KernelContext: createContext<unknown>(kernelValue),
    useKernel: () => kernelValue,
  };
});

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () =>
    mocks.sessionScopeKey === "session=session-cs&epoch=1&request_scope_epoch=1"
      ? {
          requestScopeEpoch: "1",
          sessionEpoch: "1",
          sessionId: "session-cs",
        }
      : mocks.sessionScopeKey
        ? {
            requestScopeEpoch: "1",
            sessionEpoch: "2",
            sessionId: "session-other",
          }
        : null,
}));

vi.mock("@/kernel/resources/planarMonitorResources", () => ({
  usePlanarMonitorsResource: () => ({
    data: mocks.monitorsState,
    error: null,
    refetch: mocks.monitorsRefetch,
    revision: mocks.monitorsState.scene_revision,
    status: "ready" as const,
  }),
}));

vi.mock("@/kernel/resources/crossSectionResources", () => ({
  useCrossSectionResource: () => mocks.crossSectionResourceState,
  useCrossSectionQualityResource: (
    _query: unknown,
    options?: { enabled?: boolean },
  ) => {
    mocks.crossSectionQualityEnabled.push(options?.enabled ?? true);
    return mocks.crossSectionQualityState;
  },
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
    useDomainMetaResource: () =>
      ready({
        bounds: { max: [100e-9, 50e-9, 20e-9], min: [-100e-9, -50e-9, -20e-9] },
        generation_id: "gen-cs-1",
      }),
    useSceneResource: () =>
      ready({
        objects: [{ id: "wg-1", name: "Waveguide" }],
        revision: 7,
        scene_revision: 7,
      }),
    useVisualizationStateResource: () => ready(mocks.vizStateData),
  };
});

import { Visualizations2DDraftInspectorSpecPanel } from "../../inspectors/visualizations/Visualizations2DDraftSpec";
import { Visualizations2DPlotInspectorSpecPanel } from "../../inspectors/visualizations/Visualizations2DPlotSpec";
import { Visualizations2DRootInspectorSpecPanel } from "../../inspectors/visualizations/Visualizations2DRootSpec";

function findButtonByText(root: TestElement, text: string): TestElement | null {
  return findElement(
    root,
    (el) =>
      el.tagName.toLowerCase() === "button" &&
      Boolean(el.textContent?.includes(text)),
  );
}

describe("Wave 5 Slice 4 — Visualizations 2D / Cross-Sections Parity", () => {
  let harness: MountedWave5TestDom;
  let currentSceneRev = 7;

  beforeEach(() => {
    harness = mountWave5TestDom();
    resetCrossSectionWorkspaceForTests();
    resetCompanionSliceMetaForTests();
    planarMonitorFramePreviewStore.clear();
    mocks.capturedChartOptions.length = 0;
    mocks.crossSectionQualityEnabled.length = 0;
    mocks.sessionScopeKey = "session=session-cs&epoch=1&request_scope_epoch=1";
    currentSceneRev = 7;
    mocks.monitorsState = { monitors: [], scene_revision: 7 };

    mocks.crossSectionResourceState = {
      data: {
        bounds: { uMax: 4e-8, uMin: 0, vMax: 2e-8, vMin: 0 },
        intersectionEdgeNodeIds: new Uint32Array(16),
        intersectionEdgeT: new Float32Array(8),
        intersectionKinds: new Uint32Array([0, 1, 0, 1, 0, 0, 1, 0]),
        intersectionWorld: new Float32Array(24),
        parentElementIds: new Uint32Array([7, 8, 12]),
        polygonCount: 3,
        polygonOffsets: new Uint32Array([0, 4, 8, 11]),
        segmentCount: 0,
        segments: new Float32Array(),
        vertexCount: 11,
        vertices: new Float32Array([
          0, 0, 2e-8, 0, 2e-8, 2e-8, 0, 2e-8,
          2e-8, 0, 4e-8, 0, 4e-8, 2e-8, 2e-8, 2e-8,
          0, 2e-8, 2e-8, 2e-8, 1e-8, 4e-8,
        ]),
      },
      error: null,
      refetch: vi.fn(),
      revision: "etag-cs-1",
      status: "ready",
    };
    mocks.crossSectionQualityState = {
      data: {
        perElementQuality: new Float32Array([0.05, 0.55, 0.85]),
        range: { max: 0.85, min: 0.05 },
      },
      error: null,
      refetch: vi.fn(),
      revision: "etag-csq-1",
      status: "ready",
    };

    vi.clearAllMocks();

    mocks.sceneGet.mockImplementation(async () => ({
      objects: [{ id: "wg-1", name: "Waveguide" }],
      revision: currentSceneRev,
      scene_revision: currentSceneRev,
    }));
    mocks.domainMeta.mockResolvedValue({
      bounds: { max: [100e-9, 50e-9, 20e-9], min: [-100e-9, -50e-9, -20e-9] },
    });
    mocks.monitorsCreate.mockImplementation(
      async (req: { monitor: { id: string; name: string } }) => {
        currentSceneRev += 1;
        return {
          monitor: req.monitor,
          scene_revision: currentSceneRev,
        };
      },
    );
    mocks.monitorsRemove.mockImplementation(async () => {
      currentSceneRev += 1;
      return {
        monitors: [],
        scene_revision: currentSceneRev,
      };
    });
    mocks.monitorsPatch.mockImplementation(
      async (_id: string, req: { monitor: unknown }) => {
        currentSceneRev += 1;
        return {
          monitor: req.monitor,
          scene_revision: currentSceneRev,
        };
      },
    );
  });

  afterEach(() => {
    harness.unmount();
    resetCrossSectionWorkspaceForTests();
    resetCompanionSliceMetaForTests();
    planarMonitorFramePreviewStore.clear();
  });

  it("wires real 3D gizmo visibility, Reset display, New 2D Visualization, and Remove with planarMonitors.remove + history on visualizations-2d.root", async () => {
    beginCrossSectionDraft();
    updateCrossSectionDraft({ name: "Active Slice 1", plane: "xy", positionPercent: 50 });
    const plot = commitCrossSectionDraft()!;
    mocks.monitorsState = {
      monitors: [
        {
          frame: {
            extent: { kind: "universe", padding_m: 0 },
            normal: [0, 0, 1],
            normalization_version: "planar_frame_v1",
            origin_m: [0, 0, 0],
            preset: "xy",
            u_axis: [1, 0, 0],
            v_axis: [0, 1, 0],
          },
          id: "active_slice_1_8",
          name: "Active Slice 1",
          operator: { kind: "plane_sample" },
          target: { kind: "domain" },
        },
      ],
      scene_revision: 7,
    };
    setCompanionSliceMeta(plot.id, {
      colormap: "viridis",
      customNormal: [0, 0, 1],
      fieldComponent: "|m|",
      linkedMonitorId: "active_slice_1_8",
      normalMode: "xy",
      quantity: "m",
      rangeMax: 1,
      rangeMin: -1,
      rangeMode: "auto",
      sampleGrid: "512",
      target: "domain",
    });

    const selection: Selection = {
      kind: "visualizations-2d.root",
      label: "Visualizations 2D",
      moduleSource: "explorer",
      nodeId: "model:visualizations-2d",
      objectId: null,
      ref: null,
    };

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(Visualizations2DRootInspectorSpecPanel, { selection }),
        ),
      );
    });

    expect(harness.container.textContent).toContain("Show 3D slice gizmo");
    expect(harness.container.textContent).toContain("Active Slice 1");

    // Toggle real 3D slice gizmo switch -> queues real clip patch & triggers Reset display bar
    const switches = findElements(
      harness.container,
      (el) => el.getAttribute("role") === "switch",
    );
    expect(switches.length).toBeGreaterThanOrEqual(3);
    await act(async () => {
      switches[0]!.click();
    });
    expect(mocks.queuePatch).toHaveBeenCalledWith({ clip: { enabled: true } });

    const resetBtn = findButtonByText(harness.container, "Reset display");
    expect(resetBtn).not.toBeNull();
    await act(async () => {
      resetBtn!.click();
    });
    expect(mocks.queuePatch).toHaveBeenCalledWith(
      expect.objectContaining({
        clip: { enabled: false },
        slice: { show_mesh: true },
      }),
    );

    // Click Remove on saved plot/monitor row -> deletes backend planar monitor with history & removes plot
    const removeBtn = findElement(
      harness.container,
      (el) => el.getAttribute("aria-label") === "Remove Active Slice 1",
    );
    expect(removeBtn).not.toBeNull();
    await act(async () => {
      removeBtn!.click();
    });

    expect(mocks.monitorsRemove).toHaveBeenCalledWith(
      "active_slice_1_8",
      { expected_scene_revision: 7 },
      { sessionScopeKey: "session=session-cs&epoch=1&request_scope_epoch=1" },
    );
    expect(mocks.historyRecord).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate).toHaveBeenCalledWith(MODEL_PLANAR_MONITORS_PATH, 8);
    expect(crossSectionWorkspaceStore.getSnapshot().plots).toHaveLength(0);

    // Click New 2D Visualization -> starts draft & navigates to visualizations-2d.draft
    const newBtn = findButtonByText(harness.container, "New 2D Visualization");
    expect(newBtn).not.toBeNull();
    await act(async () => {
      newBtn!.click();
    });
    expect(crossSectionWorkspaceStore.getSnapshot().draft).not.toBeNull();
    expect(mocks.selectSet).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "visualizations-2d.draft",
        nodeId: "model:visualizations-2d:draft",
      }),
      "inspector",
    );
  });

  it("renders Selected Element on redirected mesh.cross-section selection", async () => {
    const selection: Selection = {
      kind: "visualizations-2d.root",
      label: "Cross-section parent tet 8",
      moduleSource: "cross-section-image",
      nodeId: "model:mesh:quality:cross-section:8",
      objectId: null,
      ref: {
        centroid: [0, 0, 0],
        elementIndex: 8,
        kind: "mesh.quality.element",
        metric: "gamma",
        nodeId: "model:mesh:quality:cross-section:8",
        type: "mesh-quality-element",
        visualizationTargetId: "mesh:quality:element:8",
      },
    };

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(Visualizations2DRootInspectorSpecPanel, { selection }),
        ),
      );
    });

    expect(harness.container.textContent).toContain("Selected Element");
    expect(harness.container.textContent).toContain("Parent tet");
    expect(harness.container.textContent).toContain("8");
    expect(harness.container.textContent).toContain("0.550");
  });

  it("persists visualizations-2d.draft via domain.meta + planarMonitors.create + queuePatch + commitCrossSectionDraft, syncs 3D gizmo live, and handles 409 conflict", async () => {
    beginCrossSectionDraft();
    updateCrossSectionDraft({ name: "Midplane Z", plane: "xy", positionPercent: 50 });

    const selection: Selection = {
      kind: "visualizations-2d.draft",
      label: "Midplane Z",
      moduleSource: "explorer",
      nodeId: "model:visualizations-2d:draft",
      objectId: null,
      ref: {
        draftId: "draft",
        kind: "visualizations-2d.draft",
        nodeId: "model:visualizations-2d:draft",
        type: "cross-section-draft",
        visualizationTargetId: "cross-section:draft",
      },
    };

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(Visualizations2DDraftInspectorSpecPanel, { selection }),
        ),
      );
    });

    const text = harness.container.textContent ?? "";
    expect(text).toContain("Target");
    expect(text).toContain("Normal");
    expect(text).toContain("Position");
    expect(text).toContain("Quantity");
    expect(text).toContain("Component");
    expect(text).toContain("Quality metric");
    expect(text).toContain("Colormap");
    expect(text).toContain("Value range");
    expect(text).toContain("Sample grid");
    expect(text).toContain("Show mesh edges");
    expect(text).toContain("Edge width");

    // Verify zero invalid "area" metric in Quality metric options
    expect(QUALITY_METRIC_OPTIONS.map((o) => o.value)).toEqual([
      "skewness",
      "gamma",
      "sicn",
      "volume",
      "aspect_ratio",
      "max_angle",
      "min_edge",
    ]);
    expect(SLICE_FIELD_COMPONENT_OPTIONS.map((o) => o.value)).toEqual(
      expect.arrayContaining([
        "m_x",
        "m_y",
        "m_z",
        "|m|",
        "B_x",
        "B_y",
        "B_z",
        "|B|",
        "H_eff",
        "E_ex",
        "E_demag",
      ]),
    );
    expect(SLICE_COLORMAP_OPTIONS.map((o) => o.value)).toEqual(
      expect.arrayContaining(["viridis", "rdbu", "coolwarm", "turbo", "grayscale", "jet", "hot"]),
    );

    // Edit Name input -> live syncs crossSectionWorkspaceStore & planarMonitorFramePreviewStore
    const nameInput = findElement(
      harness.container,
      (el) => el.tagName.toLowerCase() === "input" && el.value === "Midplane Z",
    );
    expect(nameInput).not.toBeNull();
    await setTestInputValue(nameInput!, "Waveguide Cut");
    expect(crossSectionWorkspaceStore.getSnapshot().draft?.name).toBe("Waveguide Cut");
    expect(planarMonitorFramePreviewStore.getSnapshot()?.isDraft).toBe(true);

    // First test 409 scene_revision_conflict -> surfaces Reload current monitors action
    mocks.monitorsCreate.mockRejectedValueOnce({
      code: "scene_revision_conflict",
      message: "stale revision",
      status: 409,
    });

    const applyBtn = findButtonByText(harness.container, "Apply monitor");
    expect(applyBtn).not.toBeNull();
    await act(async () => {
      applyBtn!.click();
    });

    expect(harness.container.textContent).toContain(
      "The scene changed while this monitor draft was open.",
    );
    const reloadBtn = findButtonByText(harness.container, "Reload current monitors");
    expect(reloadBtn).not.toBeNull();
    await act(async () => {
      reloadBtn!.click();
    });
    expect(mocks.monitorsRefetch).toHaveBeenCalledTimes(1);

    // Now succeed on Apply monitor
    const applyRetryBtn = findButtonByText(harness.container, "Apply monitor");
    await act(async () => {
      applyRetryBtn!.click();
    });

    expect(mocks.domainMeta).toHaveBeenCalledWith({
      sessionScopeKey: "session=session-cs&epoch=1&request_scope_epoch=1",
    });
    expect(mocks.monitorsCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expected_scene_revision: 7,
        monitor: expect.objectContaining({
          name: "Waveguide Cut",
        }),
      }),
      { sessionScopeKey: "session=session-cs&epoch=1&request_scope_epoch=1" },
    );
    expect(mocks.historyRecord).toHaveBeenCalledTimes(1);
    expect(mocks.queuePatch).toHaveBeenCalledWith({
      planar: expect.objectContaining({
        source: { kind: "monitor", monitor_id: "waveguide_cut_8" },
      }),
    });
    expect(mocks.invalidate).toHaveBeenCalledWith(MODEL_PLANAR_MONITORS_PATH, 8);
    expect(mocks.setActiveViewportMainModule).toHaveBeenCalledWith("field-map");
    expect(crossSectionWorkspaceStore.getSnapshot().plots).toHaveLength(1);
    expect(crossSectionWorkspaceStore.getSnapshot().draft).toBeNull();
  });

  it("constructs right-handed valid frames for custom normals and object targets", () => {
    const req = buildPlanarMonitorCreatePayload(
      {
        colormap: "rdbu",
        customNormal: [1, 1, 0],
        edgeWidth: 1.5,
        fieldComponent: "m_z",
        filterExpression: "",
        frameExtent: "object_bounds",
        includeWireframe: true,
        metric: "gamma",
        name: "Diagonal Cut",
        normalMode: "custom",
        plane: "yz",
        positionM: 0,
        positionPercent: 50,
        quantity: "m",
        rangeMax: 1,
        rangeMin: -1,
        rangeMode: "manual",
        rotationDegrees: 15,
        sampleGrid: "256",
        shrinkFactor: 1,
        target: "object:wg-1",
      },
      4,
      { max: [100e-9, 50e-9, 20e-9], min: [-100e-9, -50e-9, -20e-9] },
      [],
    );

    expect(req.expected_scene_revision).toBe(4);
    expect(req.monitor.target).toEqual({ kind: "object", object_id: "wg-1" });
    expect(req.monitor.frame.preset).toBeNull();
    expect(planarMonitorValidationErrors(req.monitor)).toEqual([]);
  });

  it("reads ref.plotId first (with ref.crossSectionPlotId fallback), renders real statistics & histogram without synthetic bars, and supports New Image & Remove on visualizations-2d.plot", async () => {
    beginCrossSectionDraft();
    updateCrossSectionDraft({ name: "First Slice", plane: "xy", positionPercent: 25 });
    const plot1 = commitCrossSectionDraft()!;

    beginCrossSectionDraft();
    updateCrossSectionDraft({
      metric: "gamma",
      name: "Second Slice",
      plane: "xz",
      positionPercent: 75,
    });
    const plot2 = commitCrossSectionDraft()!;

    // Select plot2 via canonical ref.plotId even when crossSectionPlotId is absent
    const selection: Selection = {
      kind: "visualizations-2d.plot",
      label: plot2.name,
      moduleSource: "explorer",
      nodeId: `model:visualizations-2d:${plot2.id}`,
      objectId: null,
      ref: {
        kind: "visualizations-2d.plot",
        nodeId: `model:visualizations-2d:${plot2.id}`,
        plotId: plot2.id,
        type: "cross-section-plot",
        visualizationTargetId: `cross-section:plot:${plot2.id}`,
      },
    };

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(Visualizations2DPlotInspectorSpecPanel, { selection }),
        ),
      );
    });

    expect(harness.container.textContent).toContain("Second Slice");
    expect(harness.container.textContent).not.toContain(plot1.name);

    // Switch to Slice Quality tab -> verify real statistics and real histogram bins
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

    const qualityText = harness.container.textContent ?? "";
    expect(qualityText).toContain("Intersected elements");
    expect(qualityText).toContain("Polygons");
    expect(qualityText).toContain("Triangles");
    expect(qualityText).toContain("Quads");
    expect(qualityText).toContain("Area");
    expect(qualityText).toContain("Min");
    expect(qualityText).toContain("Median");
    expect(qualityText).toContain("Mean");
    expect(qualityText).toContain("Std dev");
    expect(qualityText).toContain("Max");
    expect(qualityText).toContain("Selected Element");

    // 2 quads (20nm x 20nm = 400 nm^2 each) + 1 triangle (0.5 * 20nm * 20nm = 200 nm^2) = 1000.00 nm^2
    expect(qualityText).toContain("1000.00 nm²");
    // Quality samples [0.05, 0.55, 0.85] -> Min 0.050, Median 0.550, Max 0.850
    expect(qualityText).toContain("0.050");
    expect(qualityText).toContain("0.550");
    expect(qualityText).toContain("0.850");

    // Histogram series data comes strictly from real qualityStats.histogram (sum === 3 polygons)
    const latestOption = mocks.capturedChartOptions.at(-1) as {
      series: Array<{ data: number[] }>;
    };
    const barTotal = latestOption.series[0]!.data.reduce((a, b) => a + b, 0);
    expect(barTotal).toBe(3);

    // Test New Image header button -> duplicates plot2 into draft and selects visualizations-2d.draft
    const newImageBtn = findButtonByText(harness.container, "New Image");
    expect(newImageBtn).not.toBeNull();
    await act(async () => {
      newImageBtn!.click();
    });
    expect(crossSectionWorkspaceStore.getSnapshot().draft?.plane).toBe("xz");
    expect(crossSectionWorkspaceStore.getSnapshot().draft?.positionPercent).toBe(75);
    expect(mocks.selectSet).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "visualizations-2d.draft",
        nodeId: "model:visualizations-2d:draft",
      }),
      "inspector",
    );
  });

  it("renders mixed_topology_not_supported warning notice without enabling quality fetch", async () => {
    beginCrossSectionDraft();
    const plot = commitCrossSectionDraft()!;

    mocks.crossSectionResourceState = {
      data: null,
      error: {
        code: "mixed_topology_not_supported",
        message: "cross-section slicing is tet4-only",
      },
      refetch: vi.fn(),
      revision: null,
      status: "error",
    };

    const selection: Selection = {
      kind: "visualizations-2d.plot",
      label: plot.name,
      moduleSource: "explorer",
      nodeId: `model:visualizations-2d:${plot.id}`,
      objectId: null,
      ref: {
        crossSectionPlotId: plot.id,
        kind: "visualizations-2d.plot",
        nodeId: `model:visualizations-2d:${plot.id}`,
        type: "explorer-node",
        visualizationTargetId: null,
      },
    };

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(Visualizations2DPlotInspectorSpecPanel, { selection }),
        ),
      );
    });

    expect(harness.container.textContent).toContain(
      "Mixed topology cross-sections are not supported yet.",
    );
    expect(harness.container.textContent).not.toContain(
      "cross-section slicing is tet4-only",
    );
    expect(mocks.crossSectionQualityEnabled).toContain(false);

    const qualityTab = findElement(
      harness.container,
      (el) =>
        el.getAttribute("role") === "tab" &&
        Boolean(el.textContent?.includes("Slice Quality")),
    );
    await act(async () => {
      qualityTab!.click();
    });
    expect(harness.container.textContent).toContain("tet4-only");
    expect(harness.container.textContent).toContain("mixed prism / pyramid / tet");
  });

  it("aborts draft commit side effects when session scope changes mid-flight", async () => {
    beginCrossSectionDraft();
    let resolveDomain!: (val: { bounds: { min: number[]; max: number[] } }) => void;
    mocks.domainMeta.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDomain = resolve;
      }),
    );

    const selection: Selection = {
      kind: "visualizations-2d.draft",
      label: "Draft",
      moduleSource: "explorer",
      nodeId: "model:visualizations-2d:draft",
      objectId: null,
      ref: null,
    };

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(Visualizations2DDraftInspectorSpecPanel, { selection }),
        ),
      );
    });

    const applyBtn = findButtonByText(harness.container, "Apply monitor");
    await act(async () => {
      applyBtn!.click();
    });

    mocks.sessionScopeKey = "session=session-other&epoch=2&request_scope_epoch=1";
    await act(async () => {
      resolveDomain({ bounds: { max: [1, 1, 1], min: [0, 0, 0] } });
    });

    expect(mocks.monitorsCreate).not.toHaveBeenCalled();
    expect(mocks.queuePatch).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.selectSet).not.toHaveBeenCalled();
  });

  it("patches linked planar monitor on Apply and removes plot + monitor via Remove confirmation on visualizations-2d.plot", async () => {
    beginCrossSectionDraft();
    updateCrossSectionDraft({ name: "Committed Cut", plane: "xy", positionPercent: 50 });
    const plot = commitCrossSectionDraft()!;

    mocks.monitorsState = {
      monitors: [
        {
          frame: {
            extent: { kind: "universe", padding_m: 0 },
            normal: [0, 0, 1],
            normalization_version: "planar_frame_v1",
            origin_m: [0, 0, 0],
            preset: "xy",
            u_axis: [1, 0, 0],
            v_axis: [0, 1, 0],
          },
          id: "committed_cut_8",
          name: "Committed Cut",
          operator: { kind: "plane_sample" },
          target: { kind: "domain" },
        },
      ],
      scene_revision: 7,
    };
    setCompanionSliceMeta(plot.id, {
      colormap: "viridis",
      customNormal: [0, 0, 1],
      fieldComponent: "|m|",
      linkedMonitorId: "committed_cut_8",
      normalMode: "xy",
      quantity: "mesh",
      rangeMax: 1,
      rangeMin: -1,
      rangeMode: "auto",
      sampleGrid: "512",
      target: "domain",
    });

    const selection: Selection = {
      kind: "visualizations-2d.plot",
      label: plot.name,
      moduleSource: "explorer",
      nodeId: `model:visualizations-2d:${plot.id}`,
      objectId: null,
      ref: {
        kind: "visualizations-2d.plot",
        nodeId: `model:visualizations-2d:${plot.id}`,
        plotId: plot.id,
        type: "cross-section-plot",
        visualizationTargetId: `cross-section:plot:${plot.id}`,
      },
    };

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(Visualizations2DPlotInspectorSpecPanel, { selection }),
        ),
      );
    });

    const nameInput = findElement(
      harness.container,
      (el) => el.tagName.toLowerCase() === "input" && el.value === "Committed Cut",
    );
    expect(nameInput).not.toBeNull();
    await setTestInputValue(nameInput!, "Renamed Cut");

    const applyBtn = findButtonByText(harness.container, "Apply");
    expect(applyBtn).not.toBeNull();
    await act(async () => {
      applyBtn!.click();
    });

    expect(mocks.monitorsPatch).toHaveBeenCalledWith(
      "committed_cut_8",
      expect.objectContaining({
        expected_scene_revision: 7,
        monitor: expect.objectContaining({ name: "Renamed Cut" }),
      }),
      { sessionScopeKey: "session=session-cs&epoch=1&request_scope_epoch=1" },
    );
    expect(crossSectionWorkspaceStore.getSnapshot().plots[0]?.name).toBe("Renamed Cut");

    // Trigger Remove menu item -> AlertDialog confirmation -> deletes monitor & plot
    const removeMenuBtn = findElement(
      harness.container,
      (el) =>
        el.getAttribute("role") === "menuitem" &&
        Boolean(el.textContent?.includes("Remove")),
    );
    expect(removeMenuBtn).not.toBeNull();
    await act(async () => {
      removeMenuBtn!.click();
    });

    const dialogContent = findElement(
      harness.container,
      (el) => el.getAttribute("data-slot") === "alert-dialog-content",
    );
    expect(dialogContent).not.toBeNull();
    const dialogConfirmBtn = findButtonByText(dialogContent!, "Remove");
    expect(dialogConfirmBtn).not.toBeNull();
    await act(async () => {
      dialogConfirmBtn!.click();
    });

    expect(mocks.monitorsRemove).toHaveBeenCalledWith(
      "committed_cut_8",
      { expected_scene_revision: 8 },
      { sessionScopeKey: "session=session-cs&epoch=1&request_scope_epoch=1" },
    );
    expect(crossSectionWorkspaceStore.getSnapshot().plots).toHaveLength(0);
  });
});
