import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  type TestElement,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import {
  analysisWorkspaceStore,
  resetAnalysisWorkspaceForTests,
} from "@/kernel/workspace/analysisWorkspace";
import {
  beginPlanarMonitorDraft,
  crossSectionWorkspaceStore,
  resetCrossSectionWorkspaceForTests,
} from "@/kernel/workspace/crossSectionWorkspace";
import {
  liveChartPreferencesStore,
} from "@/kernel/workspace/liveChartPreferences";
import { planarMonitorFramePreviewStore } from "@/kernel/workspace/planarMonitorFramePreview";
import {
  quickChartWorkspaceStore,
  resetQuickChartWorkspaceForTests,
} from "@/kernel/workspace/quickChartWorkspace";
import { LIVE_CHART_PRESETS } from "@/shared/analysis-charts/liveChartPresets";

vi.mock("@radix-ui/react-tooltip", () => ({
  Provider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@radix-ui/react-hover-card", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@radix-ui/react-dropdown-menu", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Group: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Sub: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SubTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SubContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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

vi.mock("@radix-ui/react-dialog", () => ({
  Root: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Overlay: () => <div />,
  Content: ({ children }: { children?: ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  Title: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  Description: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  Close: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("@radix-ui/react-alert-dialog", () => ({
  Root: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Overlay: () => <div />,
  Content: ({ children }: { children?: ReactNode }) => (
    <div role="alertdialog">{children}</div>
  ),
  Title: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  Description: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  Action: ({
    children,
    onClick,
  }: {
    children?: ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Cancel: ({
    children,
    onClick,
  }: {
    children?: ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
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
        <div>{children}</div>
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
    Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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
          disabled={disabled}
          role="option"
          type="button"
          onClick={() => ctx.onValueChange?.(value)}
        >
          {children}
        </button>
      );
    },
    ItemText: ({ children }: { children?: ReactNode }) => (
      <span>{children}</span>
    ),
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

const parityMocks = vi.hoisted(() => ({
  planarMonitors: {
    scene_revision: 7,
    monitors: [] as unknown[],
  },
  planarMonitor: null as unknown,
  planarMonitorStatus: "ready" as "ready" | "error" | "loading",
  sceneRevision: 7,
  refetchMonitor: vi.fn(),
  refetchMonitors: vi.fn(),
  setDescriptorPreference: vi.fn(),
  descriptorPreferences: {} as Record<
    string,
    {
      displayUnits: Record<string, string>;
      range: { fromSI: number; toSI: number } | null;
      selectedSeriesIds: string[];
    }
  >,
  planarVizRendered: vi.fn(),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useSceneResource: () => ({
    data: { revision: 7, objects: [{ id: "film" }] },
    status: "ready",
  }),
  useModelRegionsResource: () => ({
    data: { regions: [{ owner_object_id: "film", region_id: "core" }] },
    status: "ready",
  }),
  useFdmRegionMembershipResource: () => ({
    availability: { status: "ready" },
    data: {
      object_ids: ["film"],
      region_legend: [{ object_id: "film", region_id: "core" }],
    },
  }),
  useMeshSharedDomainManifestResource: () => ({ data: null, status: "idle" }),
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  SESSION_STATUS_RESOURCE_KEY: "/api/v2/session/status",
  useSessionResourceIdentity: () => ({
    requestScopeEpoch: "1",
    sessionEpoch: "1",
    sessionId: "sess-parity",
  }),
  useSessionStatusSelector: (selector: (s: { data: unknown }) => unknown) =>
    selector({ data: { domain: { discretization: "fdm" } } }),
}));

vi.mock("@/kernel/resources/planarMonitorResources", () => ({
  usePlanarMonitorsResource: () => ({
    data: parityMocks.planarMonitors,
    refetch: parityMocks.refetchMonitors,
    status: "ready",
  }),
  usePlanarMonitorResource: () => ({
    data:
      parityMocks.planarMonitor === null
        ? null
        : {
            monitor: parityMocks.planarMonitor,
            scene_revision: parityMocks.sceneRevision,
          },
    refetch: parityMocks.refetchMonitor,
    status: parityMocks.planarMonitorStatus,
  }),
}));

vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: () => ({
    data: {
      planar: {
        source: { kind: "monitor", monitor_id: "plane-1" },
        colormap: "vik",
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
      },
    },
    optimisticData: null,
    status: "ready",
  }),
}));

vi.mock("../visualization/PlanarVisualizationSection", () => ({
  PlanarVisualizationSection: ({ selection }: { selection: Selection }) => {
    parityMocks.planarVizRendered(selection.kind);
    return (
      <div data-slot="mock-planar-visualization-section">
        Full PlanarVisualizationSection ({selection.kind})
      </div>
    );
  },
}));

vi.mock("@/kernel/workspace/useAnalysisViewPreferencesHydration", () => ({
  useAnalysisViewPreferencesHydration: () => ({
    preferences: { descriptorPreferences: parityMocks.descriptorPreferences },
    setDescriptorPreference: parityMocks.setDescriptorPreference,
  }),
}));

import {
  AnalysisChartPointTemplatePanel,
  AnalysisChartTemplatePanel,
} from "../inspectors/visualizations/AnalysisChartSpecs";
import {
  LiveChartPointTemplatePanel,
  LiveChartTemplatePanel,
} from "../inspectors/visualizations/LiveChartSpecs";
import { QuickChartTemplatePanel } from "../inspectors/visualizations/QuickChartSpec";
import {
  PlanarMonitorDraftTemplatePanel,
  PlanarMonitorsOverviewTemplatePanel,
  PlanarMonitorTemplatePanel,
} from "../inspectors/definitions";

const COMMITTED_MONITOR = {
  id: "plane-1",
  name: "Mid-plane",
  target: { kind: "object" as const, object_id: "film" },
  operator: { kind: "slab_average" as const, thickness_m: 4e-9 },
  frame: {
    normalization_version: "planar_frame_v1",
    preset: "xy" as const,
    normal: [0, 0, 1] as [number, number, number],
    u_axis: [1, 0, 0] as [number, number, number],
    v_axis: [0, 1, 0] as [number, number, number],
    origin_m: [0, 0, 2e-9] as [number, number, number],
    extent: { kind: "target_bounds" as const, padding_m: 1e-9 },
  },
};

function createFullMockKernel() {
  const create = vi.fn().mockResolvedValue({
    monitor: { ...COMMITTED_MONITOR, id: "created-1", name: "Created plane" },
    scene_revision: 8,
  });
  const patch = vi.fn().mockResolvedValue({
    monitor: { ...COMMITTED_MONITOR, name: "Updated plane" },
    scene_revision: 8,
  });
  const execute = vi.fn().mockResolvedValue({ status: "completed" });
  const selectSet = vi.fn();
  const selectClear = vi.fn();
  const queuePatch = vi.fn();
  const queuePlanarFieldOverlayPatch = vi.fn();
  const invalidate = vi.fn();

  const kernel = {
    api: {
      model: {
        planarMonitors: { create, patch },
        scene: vi.fn().mockResolvedValue({ revision: 7, objects: [] }),
      },
    },
    commands: {
      execute,
      getSessionScopeKey: () => "session=sess-parity&epoch=1&request_scope_epoch=1",
    },
    layout: {
      setActiveViewportMainModule: vi.fn(),
      setFocusedSlot: vi.fn(),
      setPanelVisible: vi.fn(),
    },
    resources: {
      invalidate,
      subscribe: () => () => undefined,
    },
    selection: {
      clear: selectClear,
      get: () => null,
      set: selectSet,
    },
    visualizationSync: {
      flushNow: vi.fn(),
      queuePatch,
      queuePlanarFieldOverlayPatch,
    },
  } as unknown as KernelApi;

  return {
    create,
    execute,
    invalidate,
    kernel,
    patch,
    queuePatch,
    selectClear,
    selectSet,
  };
}

let cleanup: (() => void) | null = null;

function mountPanel(node: ReactNode, kernel: KernelApi) {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <KernelContext.Provider value={kernel}>{node}</KernelContext.Provider>,
    );
  });
  const rerender = (next: ReactNode) =>
    act(() => {
      root.render(
        <KernelContext.Provider value={kernel}>{next}</KernelContext.Provider>,
      );
    });
  cleanup = () => {
    act(() => root.unmount());
    dom.restore();
  };
  return { container, dom, rerender };
}

type TestInputCompat = TestElement & {
  _onPropertyChange?: (event: {
    propertyName: string;
    target: TestElement;
    srcElement: TestElement;
  }) => void;
  _valueTracker?: { setValue: (value: string) => void };
  attachEvent?: (
    name: string,
    listener: (event: {
      propertyName: string;
      target: TestElement;
      srcElement: TestElement;
    }) => void,
  ) => void;
  detachEvent?: (name: string) => void;
};

function setInputValue(input: TestElement, value: string): void {
  const compat = input as TestInputCompat;
  if (!compat.attachEvent) {
    compat.attachEvent = (_name, listener) => {
      compat._onPropertyChange = listener;
    };
    compat.detachEvent = () => {
      compat._onPropertyChange = undefined;
    };
  }
  input.focus();
  input.dispatchEvent(new TestEvent("focusin", { bubbles: true }));
  const previous = input.value;
  input.value = value;
  compat._valueTracker?.setValue(previous);
  if (compat._onPropertyChange) {
    compat._onPropertyChange({
      propertyName: "value",
      target: input,
      srcElement: input,
    });
    return;
  }
  input.dispatchEvent(new TestEvent("input", { bubbles: true }));
  input.dispatchEvent(new TestEvent("change", { bubbles: true }));
}

describe("Planar Monitors & Charts full master feature parity inside InspectorTemplate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    planarMonitorFramePreviewStore.clearDraft();
    planarMonitorFramePreviewStore.setPickFaceArmed(false);
    resetCrossSectionWorkspaceForTests();
    resetAnalysisWorkspaceForTests();
    resetQuickChartWorkspaceForTests();
    liveChartPreferencesStore.reset();
    parityMocks.planarMonitor = structuredClone(COMMITTED_MONITOR);
    parityMocks.planarMonitorStatus = "ready";
    parityMocks.sceneRevision = 7;
    parityMocks.planarMonitors = {
      scene_revision: 7,
      monitors: [structuredClone(COMMITTED_MONITOR)],
    };
    parityMocks.descriptorPreferences = {};
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("hosts 100% of PlanarMonitorDefinitionEditor, 3D gizmo registerDraftEditor, Pick face in 3D, conflict detection, and isolated 2D Display PlanarVisualizationSection", async () => {
    const { execute, kernel, patch } = createFullMockKernel();
    const selection: Selection = {
      kind: "model.planar.monitor",
      label: "Mid-plane",
      moduleSource: "explorer",
      nodeId: "model:definitions:planar-monitors:plane-1",
      objectId: null,
      ref: {
        kind: "model.planar.monitor",
        monitorId: "plane-1",
        nodeId: "model:definitions:planar-monitors:plane-1",
        type: "planar-monitor",
        visualizationTargetId: "planar-monitor:plane-1",
      },
    };

    const { container, rerender } = mountPanel(
      <PlanarMonitorTemplatePanel selection={selection} />,
      kernel,
    );

    // Full PlanarMonitorDefinitionEditor groups & fields rendered inside InspectorTemplate
    const text = container.textContent ?? "";
    for (const group of ["Identity", "Target", "Frame", "Extent", "Operator"]) {
      expect(text).toContain(group);
    }
    expect(
      findElement(container, (el) => el.getAttribute("aria-label") === "Origin Z"),
    ).not.toBeNull();
    expect(
      findElement(container, (el) => el.getAttribute("aria-label") === "Normal Z"),
    ).not.toBeNull();
    expect(
      findElement(container, (el) => el.getAttribute("aria-label") === "u axis X"),
    ).not.toBeNull();
    expect(
      findElement(container, (el) => el.getAttribute("aria-label") === "v axis Y"),
    ).not.toBeNull();
    expect(
      findElement(
        container,
        (el) => el.getAttribute("aria-label") === "Slab thickness",
      ),
    ).not.toBeNull();

    // Pick face in 3D arms planarMonitorFramePreviewStore
    const pickFaceBtn = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Pick face in 3D")),
    );
    expect(pickFaceBtn).not.toBeNull();
    act(() => {
      pickFaceBtn!.click();
    });
    expect(planarMonitorFramePreviewStore.getPickFaceArmed()).toBe(true);

    // 3D normal handle gizmo updates draft live via registerDraftEditor!
    act(() => {
      const updated = planarMonitorFramePreviewStore.proposeDraftFrame("plane-1", {
        normal: [0, -1, 0],
        origin_m: [0, 5e-9, 0],
        u_axis: [1, 0, 0],
        v_axis: [0, 0, 1],
      });
      expect(updated).toBe(true);
    });
    expect(planarMonitorFramePreviewStore.getDraftSnapshot()?.monitor.frame.normal).toEqual([
      0, -1, 0,
    ]);

    // Switch to 2D Display -> mounts full PlanarVisualizationSection & switches CommitBar to liveViewport without losing staged draft!
    const displayTab = findElement(
      container,
      (el) =>
        el.getAttribute("role") === "tab" &&
        Boolean(el.textContent?.includes("2D Display")),
    );
    act(() => {
      displayTab!.click();
    });
    expect(parityMocks.planarVizRendered).toHaveBeenCalledWith(
      "model.planar.monitor",
    );
    expect(
      findElement(
        container,
        (el) => el.getAttribute("data-slot") === "inspector-commit-bar",
      )?.getAttribute("data-mode"),
    ).toBe("liveViewport");

    // Switch back to Definition -> staged draft still dirty and ready to Apply!
    const defTab = findElement(
      container,
      (el) =>
        el.getAttribute("role") === "tab" &&
        Boolean(el.textContent?.includes("Definition")),
    );
    act(() => {
      defTab!.click();
    });
    const applyBtn = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    await act(async () => {
      applyBtn!.click();
    });
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.[0]).toBe("plane-1");

    // Open 2D View action dispatches field-map.select-monitor
    const open2dBtn = findElements(
      container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Open 2D View")),
    )[0];
    act(() => {
      open2dBtn!.click();
    });
    expect(execute).toHaveBeenCalledWith(
      "field-map.select-monitor",
      expect.anything(),
      { monitorId: "plane-1" },
    );

    // External revision conflict detection while dirty
    const xzPreset = findElements(
      container,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.includes("XZ (+y)")),
    )[0];
    act(() => {
      xzPreset!.click();
    });
    parityMocks.planarMonitor = {
      ...COMMITTED_MONITOR,
      name: "Externally renamed",
    };
    parityMocks.sceneRevision = 12;
    rerender(<PlanarMonitorTemplatePanel selection={selection} />);
    expect(container.textContent).toContain("Conflict");
    expect(container.textContent).toContain("Reload current monitor");
  });

  it("hosts PlanarMonitorsOverviewTemplatePanel (active draft + monitor list) and PlanarMonitorDraftTemplatePanel (Create Monitor + Discard Draft)", async () => {
    const { create, execute, kernel, selectSet } = createFullMockKernel();
    beginPlanarMonitorDraft();

    const overviewMount = mountPanel(
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
    expect(overviewMount.container.textContent).toContain("Draft active");
    expect(overviewMount.container.textContent).toContain("Mid-plane");

    const open2dBtn = findElements(
      overviewMount.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Open 2D View")),
    )[0];
    act(() => {
      open2dBtn!.click();
    });
    expect(execute).toHaveBeenCalledWith(
      "field-map.select-monitor",
      expect.anything(),
      { monitorId: "plane-1" },
    );
    cleanup?.();
    cleanup = null;

    // Draft panel workflow
    beginPlanarMonitorDraft();
    const draftMount = mountPanel(
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
    expect(draftMount.container.textContent).toContain("Create Monitor");
    expect(draftMount.container.textContent).toContain("Discard Draft");

    const createBtn = findElement(
      draftMount.container,
      (el) =>
        el.tagName === "BUTTON" &&
        el.textContent?.trim() === "Create Monitor",
    );
    await act(async () => {
      createBtn!.click();
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(crossSectionWorkspaceStore.getSnapshot().planarMonitorDraft).toBeNull();
    expect(selectSet).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "model.planar.monitor" }),
      "inspector",
    );
  });

  it("preserves 100% of LiveChart, Point SI readouts + Clear point selection, AnalysisChart, and QuickChart controls", () => {
    const { execute, kernel, selectSet } = createFullMockKernel();

    // 1. LiveChartTemplatePanel with Energy preset -> all 6 energy series + range inputs
    const baseHydration = liveChartPreferencesStore.getServerHydrationSnapshot();
    const hydrationSpy = vi
      .spyOn(liveChartPreferencesStore, "getHydrationSnapshot")
      .mockReturnValue({
        ...baseHydration,
        isHydrated: true,
        preferences: {
          ...baseHydration.preferences,
          descriptors: {
            ...baseHydration.preferences.descriptors,
            energy: {
              displayUnits: {},
              liveMode: "following",
              range: { mode: "fixed", fromSI: 1e-10, toSI: 5e-10 },
              selectedSeriesIds: [...LIVE_CHART_PRESETS.energy.defaultSeriesIds],
              targetPoints: 800,
              xAxisId: "t",
            },
          },
        },
      });

    const liveMount = mountPanel(
      <LiveChartTemplatePanel
        selection={{
          kind: "live.chart",
          label: "Energy Live Chart",
          moduleSource: "live-charts" as never,
          nodeId: "live:chart:energy",
          objectId: null,
          ref: {
            descriptorId: "energy",
            kind: "live.chart",
            nodeId: "live:chart:energy",
            type: "live-chart",
          },
        }}
      />,
      kernel,
    );

    for (const energyName of [
      "exchange",
      "demag",
      "zeeman",
      "anisotropy",
      "dmi",
      "total",
    ]) {
      expect(
        findElement(
          liveMount.container,
          (el) => el.getAttribute("aria-label") === `Show ${energyName}`,
        ),
      ).not.toBeNull();
    }

    const startInput = findElement(
      liveMount.container,
      (el) => el.getAttribute("aria-label") === "Range start (t)",
    );
    const endInput = findElement(
      liveMount.container,
      (el) => el.getAttribute("aria-label") === "Range end (t)",
    );
    act(() => {
      setInputValue(startInput!, "2e-10");
      setInputValue(endInput!, "8e-10");
    });
    const applyRangeBtn = findElement(
      liveMount.container,
      (el) =>
        el.tagName === "BUTTON" && el.textContent?.trim() === "Apply range",
    );
    act(() => {
      applyRangeBtn!.click();
    });
    expect(execute).toHaveBeenCalledWith(
      "live-charts.set-range",
      expect.anything(),
      {
        descriptorId: "energy",
        range: { mode: "fixed", fromSI: 2e-10, toSI: 8e-10 },
      },
    );

    const clearRangeBtn = findElement(
      liveMount.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Clear range")),
    );
    act(() => {
      clearRangeBtn!.click();
    });
    expect(execute).toHaveBeenCalledWith(
      "live-charts.set-range",
      expect.anything(),
      { descriptorId: "energy", range: { mode: "follow" } },
    );
    hydrationSpy.mockRestore();
    cleanup?.();
    cleanup = null;

    // 2. AnalysisChartPointTemplatePanel & LiveChartPointTemplatePanel Clear point selection
    const ptMount = mountPanel(
      <AnalysisChartPointTemplatePanel
        selection={{
          kind: "analysis.chart-point",
          label: "E_total -1.2e-17",
          moduleSource: "analysis-plots",
          nodeId: "analysis:pt:12",
          objectId: null,
          ref: {
            chartId: "dynamics:tbl_1",
            kind: "analysis.chart-point",
            nodeId: "analysis:pt:12",
            quantity: "E_total",
            rowIndex: 12,
            seriesId: "data.table:tbl_1:t:E_total",
            tableId: "tbl_1",
            type: "analysis-chart-point",
            x: 3.2e-9,
            y: -1.25e-17,
          },
        }}
      />,
      kernel,
    );
    expect(ptMount.container.textContent).toContain("3.2");
    expect(ptMount.container.textContent).toContain("-1.25000e-17");
    expect(ptMount.container.textContent).toContain("J");
    expect(ptMount.container.textContent).toContain("Analysis Chart");
    expect(ptMount.container.textContent).toContain("Clear selected series");
    const clearPtBtn = findElement(
      ptMount.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Clear point selection")),
    );
    act(() => {
      clearPtBtn!.click();
    });
    expect(selectSet).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "analysis.chart" }),
      "inspector",
    );
    cleanup?.();
    cleanup = null;

    const livePtMount = mountPanel(
      <LiveChartPointTemplatePanel
        selection={{
          kind: "live.chart-point",
          label: "mx 0.5",
          moduleSource: "live-charts" as never,
          nodeId: "live:chart:magnetization:pt:5",
          objectId: null,
          ref: {
            descriptorId: "magnetization",
            kind: "live.chart-point",
            nodeId: "live:chart:magnetization:pt:5",
            pointIndex: 5,
            revision: 3,
            seriesId: "mx",
            type: "live-chart-point",
          },
        }}
      />,
      kernel,
    );
    // LiveChartPointTemplatePanel preserves interactive Display controls (Preset, Live updates, Window, Signals)
    expect(
      findElement(
        livePtMount.container,
        (el) => el.getAttribute("aria-label") === "Live Chart preset",
      ),
    ).not.toBeNull();
    expect(
      findElement(
        livePtMount.container,
        (el) => el.getAttribute("aria-label") === "Live Chart window",
      ),
    ).not.toBeNull();
    const pointFollowSwitch = findElement(
      livePtMount.container,
      (el) => el.getAttribute("aria-label") === "Follow live chart updates",
    );
    act(() => {
      pointFollowSwitch!.click();
    });
    expect(execute).toHaveBeenCalledWith(
      "live-charts.set-live-mode",
      expect.anything(),
      { descriptorId: "magnetization", liveMode: "paused" },
    );
    const clearLivePtBtn = findElement(
      livePtMount.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Clear point selection")),
    );
    act(() => {
      clearLivePtBtn!.click();
    });
    expect(selectSet).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "live.chart" }),
      "inspector",
    );
    cleanup?.();
    cleanup = null;

    // 3. AnalysisChartTemplatePanel: series list, axis scale, reference curves, clear series
    parityMocks.descriptorPreferences = {
      "comparison:tbl_a:tbl_b": {
        displayUnits: { mx: "1" },
        range: { fromSI: 0, toSI: 5e-9 },
        selectedSeriesIds: ["data.table:tbl_a:t:mx"],
      },
    };
    analysisWorkspaceStore.setActiveSurface("comparison");
    analysisWorkspaceStore.setSelectedDatasetRef("tbl_a");
    analysisWorkspaceStore.setComparisonDatasetRef("tbl_b");
    analysisWorkspaceStore.setComparisonSelection(["mx|1"]);
    analysisWorkspaceStore.setActiveDescriptorId("comparison:tbl_a:tbl_b");
    analysisWorkspaceStore.setActiveDescriptorSelection(
      "comparison:tbl_a:tbl_b",
      ["data.table:tbl_a:t:mx"],
    );

    const analysisMount = mountPanel(
      <AnalysisChartTemplatePanel
        selection={{
          kind: "analysis.chart",
          label: "Comparison Plot",
          moduleSource: "analysis-plots",
          nodeId: "analysis:chart",
          objectId: null,
          ref: null,
        }}
      />,
      kernel,
    );
    expect(analysisMount.container.textContent).toContain("tbl_b");
    expect(analysisMount.container.textContent).toContain("mx|1");
    expect(analysisMount.container.textContent).toContain("Logarithmic");

    const clearSeriesBtn = findElement(
      analysisMount.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Clear selected series")),
    );
    act(() => {
      clearSeriesBtn!.click();
    });
    expect(parityMocks.setDescriptorPreference).toHaveBeenCalledWith(
      "comparison:tbl_a:tbl_b",
      expect.objectContaining({ selectedSeriesIds: [] }),
    );
    cleanup?.();
    cleanup = null;

    // 4. QuickChartTemplatePanel: pinned details, Open in Analysis, Unpin Quick Chart
    quickChartWorkspaceStore.pin({
      chartId: "dynamics:tbl_quick",
      displayUnits: { my: "1" },
      range: { fromSI: 0, toSI: 2e-9 },
      selectedSeriesIds: ["data.table:tbl_quick:t:my"],
      tableId: "tbl_quick",
      xAxisId: "t",
    });

    const quickNoTableKernel = {
      ...kernel,
      resources: { invalidate: vi.fn() },
    } as unknown as KernelApi;
    const quickMount = mountPanel(
      <QuickChartTemplatePanel
        selection={{
          kind: "results.quick_chart",
          label: "Quick Chart",
          moduleSource: "explorer",
          nodeId: "results:quick-chart",
          objectId: null,
          ref: null,
        }}
      />,
      quickNoTableKernel,
    );
    expect(quickMount.container.textContent).toContain("tbl_quick");
    expect(quickMount.container.textContent).toContain("my");

    const openInAnalysisBtn = findElements(
      quickMount.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Open in Analysis")),
    )[0];
    act(() => {
      openInAnalysisBtn!.click();
    });
    expect(execute).toHaveBeenCalledWith(
      "analysis-plots.open",
      expect.anything(),
      {
        datasetRef: "table:tbl_quick",
        surface: "dynamics",
        tableId: "tbl_quick",
      },
    );

    const unpinBtn = findElements(
      quickMount.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Unpin Quick Chart")),
    )[0];
    act(() => {
      unpinBtn!.click();
    });
    expect(quickChartWorkspaceStore.getSnapshot().pinned).toBeNull();
  });

  it("renders kernel === null fallbacks for all 8 planar & chart panels and honest 'Load failed' pill on monitor resource error", () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);
    cleanup = () => {
      act(() => root.unmount());
      dom.restore();
    };

    const nullKernelCases: readonly { kind: string; node: ReactNode }[] = [
      {
        kind: "model.planar.monitors",
        node: (
          <PlanarMonitorsOverviewTemplatePanel
            selection={{
              kind: "model.planar.monitors",
              label: "Planar Monitors",
              moduleSource: "explorer",
              nodeId: "model:definitions:planar-monitors",
              objectId: null,
              ref: null,
            }}
          />
        ),
      },
      {
        kind: "model.planar.monitor.draft",
        node: (
          <PlanarMonitorDraftTemplatePanel
            selection={{
              kind: "model.planar.monitor.draft",
              label: "New Planar Monitor",
              moduleSource: "explorer",
              nodeId: "model:definitions:planar-monitors:draft",
              objectId: null,
              ref: null,
            }}
          />
        ),
      },
      {
        kind: "model.planar.monitor",
        node: (
          <PlanarMonitorTemplatePanel
            selection={{
              kind: "model.planar.monitor",
              label: "xy_midplane",
              moduleSource: "explorer",
              nodeId: "model:definitions:planar-monitors:xy_midplane",
              objectId: null,
              ref: null,
            }}
          />
        ),
      },
      {
        kind: "live.chart",
        node: (
          <LiveChartTemplatePanel
            selection={{
              kind: "live.chart",
              label: "Live Chart",
              moduleSource: "live-charts" as never,
              nodeId: "live:chart:magnetization",
              objectId: null,
              ref: null,
            }}
          />
        ),
      },
      {
        kind: "live.chart-point",
        node: (
          <LiveChartPointTemplatePanel
            selection={{
              kind: "live.chart-point",
              label: "mx 0.25",
              moduleSource: "live-charts" as never,
              nodeId: "live:chart:magnetization:pt:2",
              objectId: null,
              ref: null,
            }}
          />
        ),
      },
      {
        kind: "analysis.chart",
        node: (
          <AnalysisChartTemplatePanel
            selection={{
              kind: "analysis.chart",
              label: "Analysis Plot",
              moduleSource: "analysis-plots",
              nodeId: "analysis:chart",
              objectId: null,
              ref: null,
            }}
          />
        ),
      },
      {
        kind: "analysis.chart-point",
        node: (
          <AnalysisChartPointTemplatePanel
            selection={{
              kind: "analysis.chart-point",
              label: "Point",
              moduleSource: "analysis-plots",
              nodeId: "analysis:pt:1",
              objectId: null,
              ref: null,
            }}
          />
        ),
      },
      {
        kind: "results.quick_chart",
        node: (
          <QuickChartTemplatePanel
            selection={{
              kind: "results.quick_chart",
              label: "Quick Chart",
              moduleSource: "explorer",
              nodeId: "results:quick-chart",
              objectId: null,
              ref: null,
            }}
          />
        ),
      },
    ];

    for (const entry of nullKernelCases) {
      act(() => {
        root.render(
          <KernelContext.Provider value={null}>{entry.node}</KernelContext.Provider>,
        );
      });
      expect(
        findElement(
          container,
          (el) => el.getAttribute("data-slot") === "inspector-root",
        ),
        entry.kind,
      ).not.toBeNull();
    }

    // Connected error state shows "Load failed" instead of banned "Unavailable"
    const { kernel } = createFullMockKernel();
    parityMocks.planarMonitor = null;
    parityMocks.planarMonitorStatus = "error";
    act(() => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <PlanarMonitorTemplatePanel
            selection={{
              kind: "model.planar.monitor",
              label: "plane-1",
              moduleSource: "explorer",
              nodeId: "model:definitions:planar-monitors:plane-1",
              objectId: null,
              ref: {
                kind: "model.planar.monitor",
                monitorId: "plane-1",
                nodeId: "model:definitions:planar-monitors:plane-1",
                type: "planar-monitor",
                visualizationTargetId: "planar-monitor:plane-1",
              },
            }}
          />
        </KernelContext.Provider>,
      );
    });
    expect(container.textContent).toContain("Load failed");
    expect(container.textContent).not.toContain("Unavailable");
  });

  it("ignores stale PATCH ACK after session closes (getSessionScopeKey() returns null)", async () => {
    const { invalidate, kernel, patch } = createFullMockKernel();
    let activeScope: string | null = "session=sess-parity&epoch=1&request_scope_epoch=1";
    (kernel.commands as { getSessionScopeKey: () => string | null }).getSessionScopeKey = () =>
      activeScope;

    let resolvePatch: ((value: unknown) => void) | null = null;
    patch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePatch = resolve;
        }),
    );

    const selection: Selection = {
      kind: "model.planar.monitor",
      label: "Mid-plane",
      moduleSource: "explorer",
      nodeId: "model:definitions:planar-monitors:plane-1",
      objectId: null,
      ref: {
        kind: "model.planar.monitor",
        monitorId: "plane-1",
        nodeId: "model:definitions:planar-monitors:plane-1",
        type: "planar-monitor",
        visualizationTargetId: "planar-monitor:plane-1",
      },
    };

    const { container } = mountPanel(
      <PlanarMonitorTemplatePanel selection={selection} />,
      kernel,
    );

    act(() => {
      planarMonitorFramePreviewStore.proposeDraftFrame("plane-1", {
        normal: [0, -1, 0],
        origin_m: [0, 5e-9, 0],
        u_axis: [1, 0, 0],
        v_axis: [0, 0, 1],
      });
    });

    const applyBtn = findElement(
      container,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    expect(applyBtn).not.toBeNull();
    await act(async () => {
      applyBtn!.click();
    });
    expect(patch).toHaveBeenCalledTimes(1);

    // Session closes while PATCH is in flight!
    activeScope = null;
    invalidate.mockClear();

    await act(async () => {
      resolvePatch?.({
        monitor: {
          ...COMMITTED_MONITOR,
          name: "Stale-Committed-Name",
        },
        scene_revision: 8,
      });
    });

    expect(invalidate).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Applied");
  });

  it("enforces hygiene across owned planar & chart files: 0 raw <input>/<select>/<textarea>, 0 #hex, 0 <12px classes", () => {
    const appRoot = join(import.meta.dirname, "../../../..");
    const files = [
      "src/modules/inspector/inspectors/definitions/PlanarMonitorsOverviewSpec.tsx",
      "src/modules/inspector/inspectors/definitions/PlanarMonitorDraftSpec.tsx",
      "src/modules/inspector/inspectors/definitions/PlanarMonitorSpec.tsx",
      "src/modules/inspector/panels/PlanarMonitorDefinitionEditor.tsx",
      "src/modules/inspector/visualization/PlanarVisualizationSection.tsx",
      "src/modules/inspector/visualization/PlanarTargetFieldSection.tsx",
      "src/modules/inspector/visualization/PlanarSectionPlaneSection.tsx",
      "src/modules/inspector/visualization/PlanarCropViewSection.tsx",
      "src/modules/inspector/visualization/PlanarFieldLayerList.tsx",
      "src/modules/inspector/visualization/PlanarPresentationSections.tsx",
      "src/modules/inspector/inspectors/visualizations/LiveChartSpecs.tsx",
      "src/modules/inspector/inspectors/visualizations/AnalysisChartSpecs.tsx",
      "src/modules/inspector/inspectors/visualizations/QuickChartSpec.tsx",
    ];

    for (const relPath of files) {
      const src = readFileSync(join(appRoot, relPath), "utf8");
      expect(src, relPath).not.toMatch(/<(?:input|select|textarea)\b/);
      expect(src, relPath).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src, relPath).not.toMatch(/\btext-\[(?:9|10|11)px\]|\btext-2xs\b/);
    }
    for (const specPath of [
      "src/modules/inspector/inspectors/definitions/PlanarMonitorsOverviewSpec.tsx",
      "src/modules/inspector/inspectors/definitions/PlanarMonitorDraftSpec.tsx",
      "src/modules/inspector/inspectors/definitions/PlanarMonitorSpec.tsx",
      "src/modules/inspector/inspectors/visualizations/LiveChartSpecs.tsx",
      "src/modules/inspector/inspectors/visualizations/AnalysisChartSpecs.tsx",
      "src/modules/inspector/inspectors/visualizations/QuickChartSpec.tsx",
    ]) {
      const src = readFileSync(join(appRoot, specPath), "utf8");
      expect(src, specPath).not.toMatch(/<button\b/);
      expect(src, specPath).not.toMatch(/\btitle=/);
    }
  });
});
