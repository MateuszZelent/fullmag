import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MODEL_PLANAR_MONITORS_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import { KernelContext } from "@/kernel/KernelContext";
import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import { crossSectionWorkspaceStore } from "@/kernel/workspace/crossSectionWorkspace";

vi.mock("@radix-ui/react-tooltip", () => ({
  Provider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => (
    <span data-slot="mock-tooltip-content">{children}</span>
  ),
}));

vi.mock("@radix-ui/react-hover-card", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => (
    <div data-slot="mock-hover-card">{children}</div>
  ),
}));

vi.mock("@radix-ui/react-dropdown-menu", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Group: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Sub: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SubTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SubContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Content: ({ children }: { children?: ReactNode }) => (
    <div data-slot="mock-dropdown-menu-content">{children}</div>
  ),
  Item: ({
    children,
    disabled,
    onSelect,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onSelect?: (event: Event) => void;
  }) => (
    <button
      disabled={disabled}
      role="menuitem"
      type="button"
      onClick={() => onSelect?.(new Event("select"))}
    >
      {children}
    </button>
  ),
  CheckboxItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Separator: () => <hr />,
  ItemIndicator: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@radix-ui/react-tabs", async () => {
  const React = await import("react");
  const TabsCtx = React.createContext<{
    value?: string;
    onValueChange?: (next: string) => void;
  }>({});
  return {
    Root: ({
      children,
      value,
      onValueChange,
    }: {
      children?: ReactNode;
      value?: string;
      onValueChange?: (next: string) => void;
    }) => (
      <TabsCtx.Provider value={{ value, onValueChange }}>
        <div>{children}</div>
      </TabsCtx.Provider>
    ),
    List: ({ children }: { children?: ReactNode }) => (
      <div role="tablist">{children}</div>
    ),
    Trigger: ({ children, value }: { children?: ReactNode; value: string }) => {
      const ctx = React.useContext(TabsCtx);
      return (
        <button
          aria-selected={ctx.value === value}
          role="tab"
          type="button"
          onClick={() => ctx.onValueChange?.(value)}
        >
          {children}
        </button>
      );
    },
    Content: ({ children, value }: { children?: ReactNode; value: string }) => {
      const ctx = React.useContext(TabsCtx);
      return ctx.value === value ? <div role="tabpanel">{children}</div> : null;
    },
  };
});

vi.mock("@radix-ui/react-collapsible", async () => {
  const React = await import("react");
  const Ctx = React.createContext<{
    open?: boolean;
    onOpenChange?: (next: boolean) => void;
  }>({});
  return {
    Root: ({
      children,
      open = true,
      onOpenChange,
      ...rest
    }: {
      children?: ReactNode;
      open?: boolean;
      onOpenChange?: (next: boolean) => void;
    }) => (
      <Ctx.Provider value={{ open, onOpenChange }}>
        <div data-open={String(open)} {...rest}>
          {children}
        </div>
      </Ctx.Provider>
    ),
    Trigger: ({ children, ...rest }: { children?: ReactNode }) => {
      const ctx = React.useContext(Ctx);
      return (
        <button
          type="button"
          onClick={() => ctx.onOpenChange?.(!ctx.open)}
          {...rest}
        >
          {children}
        </button>
      );
    },
    Content: ({ children }: { children?: ReactNode }) => {
      const ctx = React.useContext(Ctx);
      return ctx.open ? <div>{children}</div> : null;
    },
  };
});

vi.mock("@radix-ui/react-select", async () => {
  const React = await import("react");
  const Ctx = React.createContext<{
    value?: string;
    onValueChange?: (next: string) => void;
  }>({});
  return {
    Root: ({
      children,
      value,
      onValueChange,
    }: {
      children?: ReactNode;
      value?: string;
      onValueChange?: (next: string) => void;
    }) => (
      <Ctx.Provider value={{ value, onValueChange }}>
        <div data-slot="mock-select-root">{children}</div>
      </Ctx.Provider>
    ),
    Group: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Value: ({ placeholder }: { placeholder?: string }) => {
      const ctx = React.useContext(Ctx);
      return <span>{ctx.value || placeholder || ""}</span>;
    },
    Trigger: ({ children, ...rest }: { children?: ReactNode }) => (
      <button type="button" {...rest}>
        {children}
      </button>
    ),
    Icon: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Content: ({ children }: { children?: ReactNode }) => (
      <div data-slot="mock-select-content">{children}</div>
    ),
    Viewport: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Item: ({
      children,
      value,
      disabled,
    }: {
      children?: ReactNode;
      value: string;
      disabled?: boolean;
    }) => {
      const ctx = React.useContext(Ctx);
      return (
        <button
          aria-selected={false}
          data-select-value={value}
          disabled={disabled}
          role="option"
          type="button"
          onClick={() => ctx.onValueChange?.(value)}
        >
          {children}
        </button>
      );
    },
    ItemText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Separator: () => <hr />,
    ScrollUpButton: () => null,
    ScrollDownButton: () => null,
  };
});

vi.mock("@radix-ui/react-switch", () => ({
  Root: ({
    checked,
    disabled,
    onCheckedChange,
    ...rest
  }: {
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (next: boolean) => void;
  }) => (
    <button
      aria-checked={Boolean(checked)}
      disabled={disabled}
      role="switch"
      type="button"
      onClick={() => onCheckedChange?.(!checked)}
      {...rest}
    />
  ),
  Thumb: () => <span />,
}));

vi.mock("@radix-ui/react-slider", () => ({
  Root: ({
    children,
    value,
    onValueChange,
    ...rest
  }: {
    children?: ReactNode;
    value?: number[];
    onValueChange?: (next: number[]) => void;
  }) => (
    <div
      data-value={String(value?.[0] ?? 0)}
      role="slider"
      aria-valuenow={value?.[0] ?? 0}
      onClick={() => onValueChange?.([(value?.[0] ?? 0) + 5])}
      {...rest}
    >
      {children}
    </div>
  ),
  Track: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Range: () => <div />,
  Thumb: () => <span />,
}));

const resourceMocks = vi.hoisted(() => ({
  scene: null as unknown,
  sessionStatus: null as unknown,
  planarMonitors: null as unknown,
  planarMonitor: null as unknown,
  visualizationState: null as unknown,
  meshManifest: null as unknown,
  objectVisController: {
    clearTarget: vi.fn(),
    patchTargetPending: vi.fn(),
    patchViewportPreferences: vi.fn(),
  },
  objectVisSnapshot: {
    artifactFieldSelection: null,
    defaults: {},
    overrides: {},
    pendingOverrides: {},
    version: 1,
    viewportPreferences: {},
  },
}));

vi.mock(
  "@/kernel/resources/geometryLifecycleResources",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/kernel/resources/geometryLifecycleResources")
      >();
    return {
      ...actual,
      useSceneResource: () => ({ data: resourceMocks.scene, status: "ready" }),
      useMeshSharedDomainManifestResource: () => ({
        data: resourceMocks.meshManifest,
        status: "ready",
      }),
      useModelRegionsResource: () => ({ data: null, status: "idle" }),
      useDomainMetaResource: () => ({ data: null, status: "idle" }),
      useFdmMultilayerLayoutResource: () => ({ data: null, status: "idle" }),
      useFdmRegionMembershipResource: () => ({ data: null, status: "idle" }),
      useMeshRegionMembershipResource: () => ({ data: null, status: "idle" }),
    };
  },
);

vi.mock("@/kernel/resources/useSessionStatus", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/kernel/resources/useSessionStatus")>();
  return {
    ...actual,
    SESSION_STATUS_RESOURCE_KEY: "/api/v2/session/status",
    useSessionResourceIdentity: () => ({
      sessionEpoch: "epoch-1",
      sessionId: "sess-1",
    }),
    useSessionStatusSelector: (selector: (s: { data: unknown }) => unknown) =>
      selector({ data: resourceMocks.sessionStatus }),
  };
});

vi.mock(
  "@/kernel/resources/planarMonitorResources",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/kernel/resources/planarMonitorResources")
      >();
    return {
      ...actual,
      usePlanarMonitorsResource: () => ({
        data: resourceMocks.planarMonitors,
        status: "ready",
      }),
      usePlanarMonitorResource: () => ({
        data: resourceMocks.planarMonitor,
        refetch: vi.fn(),
        status: "ready",
      }),
    };
  },
);

vi.mock(
  "@/kernel/visualization/useVisualizationStateResource",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/kernel/visualization/useVisualizationStateResource")
      >();
    return {
      ...actual,
      useVisualizationStateResource: () => ({
        data: resourceMocks.visualizationState,
        optimisticData: null,
        rawData: resourceMocks.visualizationState,
        status: "ready",
      }),
    };
  },
);

vi.mock(
  "@/kernel/visualization/useObjectVisualization",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/kernel/visualization/useObjectVisualization")
      >();
    return {
      ...actual,
      useObjectVisualizationController: () => resourceMocks.objectVisController,
      useObjectVisualizationSelector: (selector: (s: unknown) => unknown) =>
        selector(resourceMocks.objectVisSnapshot),
    };
  },
);

import {
  AnalysisChartPointTemplatePanel,
  LiveChartTemplatePanel,
} from "../ChartInspectorSpecs";
import {
  PlanarMonitorDraftTemplatePanel,
  PlanarMonitorsOverviewTemplatePanel,
  PlanarMonitorTemplatePanel,
} from "../PlanarMonitorSpecs";
import {
  createDefaultStudyStageDraft,
  studyStageDraftToSceneStage,
} from "../StudyStageAuthoringModel";
import { HysteresisStageInspectorPanel } from "../stages/HysteresisStageSpec";
import { RelaxStageInspectorPanel } from "../stages/TimeAndZeroDurationStageSpecs";
import { ObjectVisualizationTemplatePanel } from "../visualization/TargetVisualizationSpecs";
import {
  StudyExecutionInspectorPanel,
  StudyRootInspectorPanel,
  StudyStagesInspectorPanel,
} from "./StudyBranchSpecs";

let activeCleanup: (() => void) | null = null;

function mountWithKernel(element: ReactNode, kernel: KernelApi) {
  const dom = installSimulationPreparationTestDom();
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <KernelContext.Provider value={kernel}>{element}</KernelContext.Provider>,
    );
  });
  activeCleanup = () => {
    act(() => root.unmount());
    dom.restore();
  };
  return { dom, host };
}

function createMockKernel() {
  const commitTransaction = vi.fn().mockResolvedValue({
    committed_scene: { revision: 8 },
    scene_revision: 8,
  });
  const createMonitor = vi.fn().mockResolvedValue({
    monitor: {
      id: "xy_slice",
      name: "xy_slice",
      target: { kind: "magnetic_domain" },
      operator: { kind: "plane_sample" },
      frame: {
        normalization_version: "planar_frame_v1",
        preset: "xy",
        normal: [0, 0, 1],
        u_axis: [1, 0, 0],
        v_axis: [0, 1, 0],
        origin_m: [0, 0, 0],
        extent: { kind: "magnetic_domain", padding_m: 0 },
      },
    },
    scene_revision: 9,
  });
  const patchMonitor = vi.fn().mockResolvedValue({
    monitor: {
      id: "mon_1",
      name: "mon_1",
      target: { kind: "magnetic_domain" },
      operator: { kind: "plane_sample" },
      frame: {
        normalization_version: "planar_frame_v1",
        preset: "xz",
        normal: [0, -1, 0],
        u_axis: [1, 0, 0],
        v_axis: [0, 0, 1],
        origin_m: [0, 0, 0],
        extent: { kind: "magnetic_domain", padding_m: 0 },
      },
    },
    scene_revision: 10,
  });
  const invalidate = vi.fn();
  const queuePatch = vi.fn().mockReturnValue({ transactionId: "tx-1" });
  const executeCommand = vi.fn().mockResolvedValue({ status: "completed" });
  const selectSet = vi.fn();

  const kernel = {
    api: {
      model: {
        commitTransaction,
        planarMonitors: {
          create: createMonitor,
          patch: patchMonitor,
        },
      },
    },
    bus: {
      emit: vi.fn(),
      on: vi.fn(() => () => undefined),
    },
    commands: {
      execute: executeCommand,
      getSessionScopeKey: () => "sess-1:epoch-1",
    },
    diagnosticRecorder: { record: vi.fn() },
    layout: {
      setActiveViewportMainModule: vi.fn(),
      setFocusedSlot: vi.fn(),
      setPanelVisible: vi.fn(),
    },
    resources: {
      getRevision: () => 0,
      invalidate,
      invalidatePrefix: vi.fn(),
      subscribe: () => () => undefined,
    },
    selection: {
      clear: vi.fn(),
      get: () => ({
        kind: "study.execution",
        label: "Execution",
        moduleSource: "explorer",
        nodeId: "model:study:execution",
        objectId: null,
        ref: null,
      }),
      set: selectSet,
      subscribe: () => () => undefined,
    },
    visualizationSync: {
      queuePatch,
    },
  } as unknown as KernelApi;

  return {
    commitTransaction,
    createMonitor,
    executeCommand,
    invalidate,
    kernel,
    patchMonitor,
    queuePatch,
    selectSet,
  };
}

describe("Wave 6 connected production wiring (Study, Stages, PlanarMonitor, Viz, Charts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resourceMocks.scene = {
      revision: 7,
      objects: [{ id: "disk", role: "magnet" }],
      study: {
        requested_backend: "fdm",
        requested_device: "auto",
        requested_precision: "double",
        requested_mode: "strict",
        exchange_enabled: true,
        demag_enabled: true,
        fdm: {
          default_cell: [5e-9, 5e-9, 5e-9],
        },
        stages: [
          {
            kind: "relax",
            stage_id: "relax_1",
            algorithm: "projected_gradient_bb",
            torque_tolerance: 100,
            max_steps: 50000,
          },
          {
            ...studyStageDraftToSceneStage({
              ...createDefaultStudyStageDraft("hysteresis", 1),
              stageId: "hyst_1",
            }),
            stage_id: "hyst_1",
          },
        ],
      },
    };
    resourceMocks.sessionStatus = {
      capabilities: {
        cuda_available: true,
        algorithms_available: [
          "projected_gradient_bb",
          "nonlinear_cg",
          "llg_overdamped",
        ],
      },
      discretization: "fdm",
    };
    resourceMocks.planarMonitors = {
      scene_revision: 7,
      monitors: [
        {
          id: "mon_1",
          name: "Midplane XY",
          target: { kind: "magnetic_domain" },
          operator: { kind: "plane_sample" },
          frame: {
            normalization_version: "planar_frame_v1",
            preset: "xy",
            normal: [0, 0, 1],
            u_axis: [1, 0, 0],
            v_axis: [0, 1, 0],
            origin_m: [0, 0, 0],
            extent: { kind: "magnetic_domain", padding_m: 0 },
          },
        },
      ],
    };
    resourceMocks.planarMonitor = {
      scene_revision: 7,
      monitor: resourceMocks.planarMonitors
        ? (
            resourceMocks.planarMonitors as {
              monitors: unknown[];
            }
          ).monitors[0]
        : null,
    };
    resourceMocks.visualizationState = {
      revision: 3,
      overrides: [],
      planar: {
        source: { kind: "monitor", monitor_id: "mon_1" },
        colormap: "vik",
        layers: {
          bounds: false,
          raster: true,
          contours: false,
          mesh: false,
          boundaries: false,
          points: false,
          vectors: false,
          probes: true,
          streamlines: false,
        },
      },
    };
    resourceMocks.meshManifest = {
      regions: [{ id: "reg-top", object_id: "disk" }],
      mesh_parts: [
        {
          id: "part-top",
          label: "Top cap",
          object_id: "disk",
          carrier_kind: "surface",
        },
        {
          id: "part-bot",
          label: "Bottom cap",
          object_id: "disk",
          carrier_kind: "surface",
        },
      ],
    };
  });

  afterEach(() => {
    activeCleanup?.();
    activeCleanup = null;
    crossSectionWorkspaceStore.getSnapshot();
  });

  it("hydrates StudyExecutionInspectorPanel from useSceneResource and commits merge_patch via commitTransaction", async () => {
    const { commitTransaction, invalidate, kernel } = createMockKernel();
    const selection: Selection = {
      kind: "study.execution",
      label: "Execution",
      moduleSource: "explorer",
      nodeId: "model:study:execution",
      objectId: null,
      ref: { kind: "study.execution", nodeId: "model:study:execution", type: "study" },
    };

    const { host } = mountWithKernel(
      <StudyExecutionInspectorPanel selection={selection} />,
      kernel,
    );

    const cpuRadio = findElements(
      host,
      (el) => el.tagName === "BUTTON" && el.textContent?.trim() === "CPU",
    )[0];
    expect(cpuRadio).toBeDefined();
    act(() => {
      cpuRadio!.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    const applyBtn = findElement(
      host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    expect(applyBtn).toBeDefined();
    await act(async () => {
      applyBtn!.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(commitTransaction).toHaveBeenCalledTimes(1);
    expect(commitTransaction.mock.calls[0]?.[0]).toMatchObject({
      base_revision: 7,
      kind: "merge_patch",
      merge_patch: {
        study: expect.objectContaining({
          requested_device: "cpu",
        }),
      },
    });
    expect(invalidate).toHaveBeenCalledWith(MODEL_SCENE_PATH, 8);
  });

  it("hydrates RelaxStageInspectorPanel and HysteresisStageInspectorPanel from scene.study and commits via commitTransaction", async () => {
    const { commitTransaction, invalidate, kernel } = createMockKernel();
    const relaxSelection: Selection = {
      kind: "study.stage.relax",
      label: "Relax 1",
      moduleSource: "explorer",
      nodeId: "model:study:stages:stage:relax_1",
      objectId: null,
      ref: {
        kind: "study.stage.action",
        nodeId: "model:study:stages:stage:relax_1",
        stageId: "relax_1",
        stageIndex: 0,
        type: "study-stage",
      },
    };

    const { host } = mountWithKernel(
      <RelaxStageInspectorPanel selection={relaxSelection} />,
      kernel,
    );

    const relaxSwitch = findElement(
      host,
      (el) => el.getAttribute("role") === "switch",
    );
    expect(relaxSwitch).toBeDefined();
    act(() => {
      relaxSwitch.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    const applyBtn = findElement(
      host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    await act(async () => {
      applyBtn!.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(commitTransaction).toHaveBeenCalledTimes(1);
    expect(commitTransaction.mock.calls[0]?.[0]).toMatchObject({
      base_revision: 7,
      kind: "merge_patch",
    });
    expect(invalidate).toHaveBeenCalledWith(MODEL_SCENE_PATH, 8);

    activeCleanup?.();
    activeCleanup = null;

    // Now verify HysteresisStageInspectorPanel without initialDraft (production path)
    commitTransaction.mockClear();
    const hystSelection: Selection = {
      kind: "study.stage.hysteresis",
      label: "Hysteresis 2",
      moduleSource: "explorer",
      nodeId: "model:study:stages:stage:hyst_1",
      objectId: null,
      ref: {
        kind: "study.stage.action",
        nodeId: "model:study:stages:stage:hyst_1",
        stageId: "hyst_1",
        stageIndex: 1,
        type: "study-stage",
      },
    };
    const hystMount = mountWithKernel(
      <HysteresisStageInspectorPanel selection={hystSelection} />,
      kernel,
    );
    const includeSwitch = findElement(
      hystMount.host,
      (el) => el.getAttribute("role") === "switch",
    );
    expect(includeSwitch).toBeDefined();
    act(() => {
      includeSwitch!.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const hystApply = findElement(
      hystMount.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    await act(async () => {
      hystApply!.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("wires PlanarMonitor overview, draft create, committed patch, and 2D Display visualizationSync", async () => {
    const {
      createMonitor,
      executeCommand,
      invalidate,
      kernel,
      patchMonitor,
      queuePatch,
    } = createMockKernel();

    // 1. Overview lists Midplane XY and executes planar-monitor.create
    const overviewMount = mountWithKernel(
      <PlanarMonitorsOverviewTemplatePanel
        selection={{
          kind: "model.planar.monitors",
          label: "Planar Monitors",
          moduleSource: "explorer",
          nodeId: "model:definitions:planar-monitors",
          objectId: null,
          ref: null,
        }}
      />,
      kernel,
    );
    expect(overviewMount.host.textContent).toContain("Midplane XY");
    const addBtn = findElement(
      overviewMount.host,
      (el) =>
        el.tagName === "BUTTON" &&
        el.textContent?.includes("Add Planar Monitor"),
    );
    await act(async () => {
      addBtn!.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(executeCommand).toHaveBeenCalledWith(
      "planar-monitor.create",
      expect.anything(),
      { intent: { source: "inspector" } },
    );
    activeCleanup?.();
    activeCleanup = null;

    // 2. Draft panel calls planarMonitors.create + visualizationSync.queuePatch
    const draftMount = mountWithKernel(
      <PlanarMonitorDraftTemplatePanel
        selection={{
          kind: "model.planar.monitor.draft",
          label: "New Planar Monitor",
          moduleSource: "explorer",
          nodeId: "model:definitions:planar-monitors:draft",
          objectId: null,
          ref: null,
        }}
      />,
      kernel,
    );
    const xzRadio = findElements(
      draftMount.host,
      (el) => el.tagName === "BUTTON" && el.textContent?.includes("XZ (+y)"),
    )[0];
    act(() => {
      xzRadio!.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const draftApply = findElement(
      draftMount.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    await act(async () => {
      draftApply!.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(createMonitor).toHaveBeenCalledTimes(1);
    expect(queuePatch).toHaveBeenCalledWith({
      planar: { source: { kind: "monitor", monitor_id: "xy_slice" } },
    });
    expect(invalidate).toHaveBeenCalledWith(MODEL_PLANAR_MONITORS_PATH, 9);
    activeCleanup?.();
    activeCleanup = null;

    // 3. Committed monitor calls planarMonitors.patch on Definition and queuePatch on 2D Display
    queuePatch.mockClear();
    const committedMount = mountWithKernel(
      <PlanarMonitorTemplatePanel
        selection={{
          kind: "model.planar.monitor",
          label: "Midplane XY",
          moduleSource: "explorer",
          nodeId: "model:definitions:planar-monitors:mon_1",
          objectId: null,
          ref: {
            kind: "model.planar.monitor",
            monitorId: "mon_1",
            nodeId: "model:definitions:planar-monitors:mon_1",
            type: "planar-monitor",
            visualizationTargetId: "planar-monitor:mon_1",
          },
        }}
      />,
      kernel,
    );
    const committedXz = findElements(
      committedMount.host,
      (el) => el.tagName === "BUTTON" && el.textContent?.includes("XZ (+y)"),
    )[0];
    act(() => {
      committedXz!.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const committedApply = findElement(
      committedMount.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    await act(async () => {
      committedApply!.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(patchMonitor).toHaveBeenCalledTimes(1);
    expect(patchMonitor.mock.calls[0]?.[0]).toBe("mon_1");

    // Switch to 2D Display tab and toggle vector arrows -> live queuePatch!
    const displayTab = findElements(
      committedMount.host,
      (el) =>
        el.getAttribute("role") === "tab" &&
        el.textContent?.includes("2D Display"),
    )[0];
    act(() => {
      displayTab!.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const arrowSwitch = findElement(
      committedMount.host,
      (el) => el.getAttribute("aria-label") === "Show 2D slice vector arrows",
    );
    act(() => {
      arrowSwitch!.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(queuePatch).toHaveBeenCalledTimes(1);
  });

  it("wires ObjectVisualizationTemplatePanel to ObjectVisualizationController and visualizationSync", () => {
    const { kernel, queuePatch } = createMockKernel();
    const selection: Selection = {
      kind: "object.visualization",
      label: "disk",
      moduleSource: "explorer",
      nodeId: "model:objects:disk:visualization",
      objectId: "disk",
      ref: {
        kind: "object.visualization",
        nodeId: "model:objects:disk:visualization",
        objectId: "disk",
        type: "scene-object",
        visualizationTargetId: "object:disk",
      } as never,
    };

    const { host } = mountWithKernel(
      <ObjectVisualizationTemplatePanel selection={selection} />,
      kernel,
    );

    const visibleSwitch = findElement(
      host,
      (el) => el.getAttribute("role") === "switch",
    );
    expect(visibleSwitch).toBeDefined();
    act(() => {
      visibleSwitch!.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(queuePatch).toHaveBeenCalled();
    expect(resourceMocks.objectVisController.patchTargetPending).toHaveBeenCalled();
  });

  it("executes live-charts.set-live-mode on LiveChartTemplatePanel and reads (ref.x, ref.y) on AnalysisChartPointTemplatePanel", () => {
    const { executeCommand, kernel } = createMockKernel();
    const liveMount = mountWithKernel(
      <LiveChartTemplatePanel
        selection={{
          kind: "live.chart",
          label: "Live Chart",
          moduleSource: "live-charts" as never,
          nodeId: "live:chart:magnetization",
          objectId: null,
          ref: {
            descriptorId: "magnetization",
            kind: "live.chart",
            nodeId: "live:chart:magnetization",
            type: "live-chart",
          },
        }}
      />,
      kernel,
    );

    const followSwitch = findElement(
      liveMount.host,
      (el) => el.getAttribute("role") === "switch",
    );
    expect(followSwitch).toBeDefined();
    act(() => {
      followSwitch!.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(executeCommand).toHaveBeenCalledWith(
      "live-charts.set-live-mode",
      expect.anything(),
      { descriptorId: "magnetization", liveMode: "paused" },
    );

    activeCleanup?.();
    activeCleanup = null;

    // AnalysisChartPointTemplatePanel without testPointValues reads ref.x & ref.y
    const pointMount = mountWithKernel(
      <AnalysisChartPointTemplatePanel
        selection={{
          kind: "analysis.chart-point",
          label: "Point",
          moduleSource: "analysis" as never,
          nodeId: "analysis:pt:3",
          objectId: null,
          ref: {
            chartId: "dyn-1",
            kind: "analysis.chart-point",
            nodeId: "analysis:pt:3",
            quantity: "my",
            rowIndex: 3,
            seriesId: "my",
            type: "analysis-chart-point",
            x: 2.5e-9,
            y: -0.425,
          },
        }}
      />,
      kernel,
    );
    expect(pointMount.host.textContent).toContain("2.5");
    expect(pointMount.host.textContent).toContain("-0.425");
  });

  it("guards StudyRootInspectorPanel and StudyStagesInspectorPanel when scene.study.stages is missing or non-array (#155)", () => {
    const { kernel } = createMockKernel();
    resourceMocks.scene = {
      revision: 11,
      objects: [],
      study: {
        name: "Malformed stages check",
        stages: { unexpected_object: true },
      },
    };

    const rootMount = mountWithKernel(
      <StudyRootInspectorPanel
        selection={{
          kind: "study.root",
          label: "Study",
          moduleSource: "explorer",
          nodeId: "model:study",
          objectId: null,
          ref: { kind: "study.root", nodeId: "model:study", type: "study" },
        }}
      />,
      kernel,
    );
    expect(rootMount.host.textContent).toContain("rev 11");

    activeCleanup?.();
    activeCleanup = null;

    const stagesMount = mountWithKernel(
      <StudyStagesInspectorPanel
        selection={{
          kind: "study.stages",
          label: "Stages",
          moduleSource: "explorer",
          nodeId: "model:study:stages",
          objectId: null,
          ref: { kind: "study.stages", nodeId: "model:study:stages", type: "study" },
        }}
      />,
      kernel,
    );
    expect(stagesMount.host.textContent).toContain("Stages");
  });
});
