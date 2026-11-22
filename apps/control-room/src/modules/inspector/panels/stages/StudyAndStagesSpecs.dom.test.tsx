import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import { buildActionStageNode } from "@/modules/explorer/builders/study/actionStageNode";
import { buildEigenmodesStageNode } from "@/modules/explorer/builders/study/eigenmodesStageNode";
import { buildFrequencyResponseStageNode } from "@/modules/explorer/builders/study/frequencyResponseStageNode";
import { buildStudyNodes } from "@/modules/explorer/builders/study/studyExplorerNodes";

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
  ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Separator: () => <hr />,
}));

vi.mock("@radix-ui/react-context-menu", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Group: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Sub: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SubTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SubContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Item: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CheckboxItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Separator: () => <hr />,
}));

vi.mock("@radix-ui/react-dialog", () => ({
  Root: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div data-slot="mock-dialog-root">{children}</div> : null,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Overlay: () => <div data-slot="mock-dialog-overlay" />,
  Content: ({ children, role }: { children?: ReactNode; role?: string }) => (
    <div data-slot="mock-dialog-content" role={role ?? "dialog"}>
      {children}
    </div>
  ),
  Title: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  Description: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  Close: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("@radix-ui/react-alert-dialog", () => ({
  Root: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div data-slot="mock-alert-dialog-root">{children}</div> : null,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Overlay: () => <div data-slot="mock-alert-dialog-overlay" />,
  Content: ({ children }: { children?: ReactNode }) => (
    <div role="alertdialog">{children}</div>
  ),
  Title: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  Description: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  Action: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Cancel: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
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
          data-select-value={value}
          disabled={disabled}
          role="option" aria-selected={false}
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
  Root: ({ children }: { children?: ReactNode }) => (
    <div data-slot="mock-slider">{children}</div>
  ),
  Track: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Range: () => <div />,
  Thumb: () => <div role="slider" aria-valuenow={0} />,
}));

vi.mock("echarts", () => ({
  init: () => ({
    on: vi.fn(),
    off: vi.fn(),
    setOption: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
  }),
}));

const connectedMocks = vi.hoisted(() => ({
  scene: null as unknown,
  sessionStatus: null as unknown,
  periodicPairs: null as unknown,
  manifest: null as unknown,
  solverStatus: null as unknown,
  solverEnergyCurrent: null as unknown,
  solverEnergyHistory: null as unknown,
  checkpoints: null as unknown,
  hysteresisPoints: null as unknown,
  hysteresisProgress: null as unknown,
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
      useSceneResource: () => ({ data: connectedMocks.scene, status: "ready" }),
    };
  },
);

vi.mock(
  "@/kernel/resources/studyRuntimeResources",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/kernel/resources/studyRuntimeResources")
      >();
    return {
      ...actual,
      useFrequencyDomainManifestResource: () => ({
        data: connectedMocks.manifest,
        status: "ready",
      }),
      useMeshPeriodicPairsResource: () => ({
        data: connectedMocks.periodicPairs,
        status: "ready",
      }),
      useSolverStatusResource: () => ({
        data: connectedMocks.solverStatus,
        status: connectedMocks.solverStatus ? "ready" : "idle",
      }),
      useSolverEnergyCurrentResource: () => ({
        data: connectedMocks.solverEnergyCurrent,
        status: connectedMocks.solverEnergyCurrent ? "ready" : "idle",
      }),
      useSolverEnergyHistoryResource: () => ({
        data: connectedMocks.solverEnergyHistory,
        status: connectedMocks.solverEnergyHistory ? "ready" : "idle",
      }),
      useCheckpointCatalogResource: () => ({
        data: connectedMocks.checkpoints,
        status: connectedMocks.checkpoints ? "ready" : "idle",
      }),
      useHysteresisPointsResource: () => ({
        data: connectedMocks.hysteresisPoints,
        revision: 1,
        status: connectedMocks.hysteresisPoints ? "ready" : "idle",
      }),
      useHysteresisProgressResource: () => ({
        data: connectedMocks.hysteresisProgress,
        status: connectedMocks.hysteresisProgress ? "ready" : "idle",
      }),
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
      selector({ data: connectedMocks.sessionStatus }),
  };
});

import type { StudyStageModel } from "../StudyInspectorPanelModel";
import {
  StudyExecutionInspectorPanel,
  StudyRecoveryInspectorPanel,
  StudyRootInspectorPanel,
  StudyStagesInspectorPanel,
} from "../study/StudyBranchSpecs";
import {
  EigenmodesStageInspectorPanel,
  FrequencyResponseStageInspectorPanel,
  parseExplicitFrequencySweepHz,
  SUPPORTED_FREQUENCY_RESPONSE_SOLVER_METHODS,
} from "./SpectralStageSpecs";
import { HysteresisStageInspectorPanel } from "./HysteresisStageSpec";
import { StageLiveTelemetryPanel } from "./StageSharedControls";
import {
  ActionStageFallbackInspectorPanel,
  AddFieldDriveStageInspectorPanel,
  AntennaFieldSolveStageInspectorPanel,
  AutosaveStageInspectorPanel,
  ChangeDeviceStageInspectorPanel,
  FftResponseStageInspectorPanel,
  MaskFieldDriveStageInspectorPanel,
  RelaxStageInspectorPanel,
  RunStageInspectorPanel,
  SaveStateStageInspectorPanel,
  TableAutosaveStageInspectorPanel,
} from "./TimeAndZeroDurationStageSpecs";

let restoreDom: (() => void) | null = null;

afterEach(() => {
  restoreDom?.();
  restoreDom = null;
});

function makeSelection(kind: string, nodeId = `node:${kind}`): Selection {
  return {
    kind,
    label: kind,
    moduleSource: "explorer",
    nodeId,
    objectId: null,
    ref: {
      nodeId,
      stageId: "stage_1",
      stageIndex: 0,
      type: "study-stage",
    },
  };
}

describe("Task 22 — Study branches, spectral consolidation (24 -> 2), and 0 s stages", () => {
  it("enforces strict GPU contract without silent CPU fallback and splits 4 orthogonal Study branches", async () => {
    const dom = installSimulationPreparationTestDom();
    restoreDom = dom.restore;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);

    const studyTree = buildStudyNodes({ stages: [{ index: 0, kind: "relax", stageId: "relax_1" }] });
    const execNode = studyTree.children?.find((child) => child.kind === "study.execution");
    expect(execNode?.contextCommands).toContain("study.compute-observables");

    await act(async () => {
      root.render(
        <StudyExecutionInspectorPanel
          selection={makeSelection("study.execution", "model:study:execution")}
          testSnapshot={{
            cudaAvailable: false,
            discretization: "fdm",
            magneticObjectCount: 1,
            precision: "double",
            qualificationMode: "strict",
            requestedDevice: "gpu",
            resolvedDeviceLabel: "Blocked — CUDA device missing",
          }}
        />,
      );
    });

    const errorNotices = findElements(
      container,
      (el) =>
        el.getAttribute("data-slot") === "inspector-notice" &&
        el.getAttribute("data-tone") === "err",
    );
    expect(errorNotices.length).toBeGreaterThanOrEqual(1);
    const noticeText = container.textContent ?? "";
    expect(noticeText).toContain("never silently falls back to CPU");
    expect(noticeText).toContain("Switch to Auto");
    expect(noticeText).toContain("Switch to CPU");

    const switchToAutoBtn = findElement(
      container,
      (el) => el.tagName === "BUTTON" && (el.textContent ?? "").includes("Switch to Auto"),
    );
    expect(switchToAutoBtn).not.toBeNull();
    await act(async () => {
      switchToAutoBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(container.textContent ?? "").toContain("Auto → CPU");

    // Verify orthogonal Study root, stages, and recovery panels never embed child editors
    await act(async () => {
      root.render(
        <StudyRootInspectorPanel
          selection={makeSelection("study.root", "model:study")}
        />,
      );
    });
    expect(container.textContent ?? "").toContain("Compute Study");
    expect(container.textContent ?? "").not.toContain("Torque tolerance");

    await act(async () => {
      root.render(
        <StudyStagesInspectorPanel
          selection={makeSelection("study.stages", "model:study:stages")}
        />,
      );
    });
    expect(container.textContent ?? "").toContain("Stage sequence");
    expect(container.textContent ?? "").not.toContain("Max torque |m");

    await act(async () => {
      root.render(
        <StudyRecoveryInspectorPanel
          selection={makeSelection("study.recovery", "model:study:recovery")}
        />,
      );
    });
    expect(container.textContent ?? "").toContain("Saved checkpoints");
    expect((container.textContent ?? "").toLowerCase()).not.toContain("unknown");

    await act(async () => {
      root.unmount();
    });
  });

  it("consolidates 24 spectral stage sub-nodes into 2 single leaves, parses '10GHz' to 1e10 Hz, and exposes all 8 solver methods", async () => {
    const eigenNode = buildEigenmodesStageNode({
      boundaryCondition: "periodic",
      index: 0,
      kSamplingKind: "path",
      kind: "eigenmodes",
      stageId: "eigen_1",
    });
    const freqNode = buildFrequencyResponseStageNode({
      boundaryCondition: "periodic",
      calculationMode: "response_map",
      index: 1,
      kSamplingKind: "grid",
      kind: "frequency_response",
      stageId: "freq_1",
    });

    expect(eigenNode.kind).toBe("study.stage.eigenmodes");
    expect(eigenNode.children ?? []).toHaveLength(0);
    expect(freqNode.kind).toBe("study.stage.frequency_response");
    expect(freqNode.children ?? []).toHaveLength(0);

    // Explicit frequency list parser supports SI unit suffixes like "10GHz"
    const parsed = parseExplicitFrequencySweepHz("2.5GHz, 10GHz");
    expect(parsed.error).toBeNull();
    expect(parsed.frequenciesHz).toEqual([2.5e9, 1e10]);

    expect(SUPPORTED_FREQUENCY_RESPONSE_SOLVER_METHODS).toHaveLength(8);
    expect(SUPPORTED_FREQUENCY_RESPONSE_SOLVER_METHODS).toEqual([
      "auto",
      "dense_reference",
      "cpu_sparse_direct",
      "full_coupled_field_split",
      "schur_reduced",
      "modal_reduced",
      "gpu_operator_host_krylov",
      "gpu_device_krylov",
    ]);

    const dom = installSimulationPreparationTestDom();
    restoreDom = dom.restore;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <FrequencyResponseStageInspectorPanel
          selection={makeSelection("study.stage.frequency_response")}
          testSnapshot={{
            resolvedDeviceLabel: "Auto → GPU (CUDA)",
          }}
        />,
      );
    });

    const tabs = findElements(container, (el) => el.getAttribute("role") === "tab");
    expect(tabs.length).toBe(3);
    expect(container.textContent ?? "").toContain("Auto → GPU");
    expect(container.textContent ?? "").not.toContain("StudyIR::");

    // Switch to Solver & Outputs tab and verify all 8 solver methods are rendered as options
    const solverTab = tabs.find((tab) => (tab.textContent ?? "").includes("Solver"));
    await act(async () => {
      solverTab?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    for (const method of SUPPORTED_FREQUENCY_RESPONSE_SOLVER_METHODS) {
      const opt = findElement(
        container,
        (el) => el.getAttribute("data-select-value") === method,
      );
      expect(opt, `Expected solver method option ${method}`).not.toBeNull();
    }

    await act(async () => {
      root.render(
        <EigenmodesStageInspectorPanel
          selection={makeSelection("study.stage.eigenmodes")}
        />,
      );
    });
    const eigenTabs = findElements(container, (el) => el.getAttribute("role") === "tab");
    expect(eigenTabs.length).toBe(3);
    expect(container.textContent ?? "").not.toContain("StudyIR::");

    await act(async () => {
      root.unmount();
    });
  });

  it("routes mask_field_drive explicitly and renders 0 s instructions + Run Nyquist/Zarr plan without 'Run this stage' or raw inputs", async () => {
    expect(buildActionStageNode({ index: 0, kind: "add_mask_field_drive" }).kind).toBe(
      "study.stage.mask_field_drive",
    );
    expect(buildActionStageNode({ index: 1, kind: "update_mask_field_drive" }).kind).toBe(
      "study.stage.mask_field_drive",
    );
    expect(buildActionStageNode({ index: 2, kind: "remove_field_drive" }).kind).toBe(
      "study.stage.action",
    );

    const dom = installSimulationPreparationTestDom();
    restoreDom = dom.restore;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);

    // Run stage shows Setup first (above telemetry), Nyquist band f_Nyq, and Zarr estimate
    await act(async () => {
      root.render(
        <RunStageInspectorPanel
          selection={makeSelection("study.stage.run")}
        />,
      );
    });
    expect(container.textContent ?? "").toContain("Time & Integrator");
    expect(container.textContent ?? "").toContain("Field & Table Sampling Plan");
    expect(container.textContent ?? "").toContain("THz");

    await act(async () => {
      root.render(
        <RelaxStageInspectorPanel
          selection={makeSelection("study.stage.relax")}
        />,
      );
    });
    expect(container.textContent ?? "").toContain("Method & Stop Criteria");

    // Zero-duration instructions never render "Run this stage" or progress bars
    const zeroDurationPanels = [
      <AddFieldDriveStageInspectorPanel key="add" selection={makeSelection("study.stage.add_field_drive")} />,
      <MaskFieldDriveStageInspectorPanel key="mask" selection={makeSelection("study.stage.mask_field_drive")} />,
      <TableAutosaveStageInspectorPanel key="tbl" selection={makeSelection("study.stage.table_autosave")} />,
      <AutosaveStageInspectorPanel key="auto" selection={makeSelection("study.stage.autosave")} />,
      <FftResponseStageInspectorPanel key="fft" selection={makeSelection("study.stage.fft_response")} />,
      <SaveStateStageInspectorPanel key="save" selection={makeSelection("study.stage.save_state")} />,
      <ChangeDeviceStageInspectorPanel key="dev" selection={makeSelection("study.stage.change_device")} />,
    ];

    for (const panel of zeroDurationPanels) {
      await act(async () => {
        root.render(panel);
      });
      const text = container.textContent ?? "";
      expect(text).not.toContain("Run this stage");
      expect(text.toLowerCase()).not.toContain("unknown");
      expect(
        findElement(container, (el) => el.getAttribute("data-slot") === "inspector-root"),
      ).not.toBeNull();
    }

    // AddFieldDrive mounts ScientificEChart for SincPulsePreview
    await act(async () => {
      root.render(
        <AddFieldDriveStageInspectorPanel
          selection={makeSelection("study.stage.add_field_drive")}
        />,
      );
    });
    expect(
      findElement(container, (el) => el.getAttribute("data-slot") === "scientific-echart"),
    ).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});

function createConnectedStageKernel() {
  const commitTransaction = vi.fn().mockResolvedValue({
    committed_scene: { revision: 12 },
    scene_revision: 12,
  });
  const executeCommand = vi.fn().mockResolvedValue({ status: "completed" });
  const selectSet = vi.fn();
  const invalidate = vi.fn();

  const kernel = {
    api: {
      analysis: {
        frequencyDomain: {
          manifestV1: vi.fn(),
        },
      },
      meshing: {
        periodicPairs: vi.fn(),
      },
      model: {
        commitTransaction,
      },
    },
    commands: {
      execute: executeCommand,
      getSessionScopeKey: () => "sess-1:epoch-1",
    },
    layout: {
      get: () => ({ activeViewportMainModuleId: "viewport-3d" }),
      setActiveViewportMainModule: vi.fn(),
      setFocusedSlot: vi.fn(),
      setPanelVisible: vi.fn(),
    },
    diagnosticRecorder: { record: vi.fn() },
    bus: {
      emit: vi.fn(),
      on: () => () => undefined,
    },
    resources: {
      diagnosticRecorder: { record: vi.fn() },
      getRevision: () => 0,
      invalidate,
      invalidatePrefix: vi.fn(),
      subscribe: () => () => undefined,
    },
    selection: {
      clear: vi.fn(),
      get: () => null,
      set: selectSet,
      subscribe: () => () => undefined,
    },
    visualizationSync: {
      queuePatch: vi.fn(),
    },
  } as unknown as KernelApi;

  return { commitTransaction, executeCommand, invalidate, kernel, selectSet };
}

function makeStageSelection(
  kind: string,
  stageId: string,
  stageIndex: number,
  nodeId = `model:study:stages:stage:${stageId}`,
): Selection {
  return {
    kind,
    label: stageId,
    moduleSource: "explorer",
    nodeId,
    objectId: null,
    ref: {
      kind: "study.stage.action",
      nodeId,
      stageId,
      stageIndex,
      type: "study-stage",
    },
  };
}

function makeSupportedActiveLane() {
  const supported = {
    state: "supported",
    reason_code: "ok",
    reason: "Supported",
    requires: [],
  };
  return {
    source: { kind: "planner" },
    resolved: { discretization: "fdm" },
    operations: {
      "study.relaxation": supported,
      "study.time_integration": supported,
      "study.eigenmodes": supported,
      "study.frequency_response": supported,
      "study.fft": supported,
    },
  };
}

describe("Wave 6 — Spectral, time-domain, and zero-duration stage parity", () => {
  afterEach(() => {
    connectedMocks.scene = null;
    connectedMocks.sessionStatus = null;
    connectedMocks.periodicPairs = null;
    connectedMocks.manifest = null;
    connectedMocks.solverStatus = null;
    connectedMocks.solverEnergyCurrent = null;
    connectedMocks.solverEnergyHistory = null;
    connectedMocks.checkpoints = null;
    connectedMocks.hysteresisPoints = null;
    connectedMocks.hysteresisProgress = null;
  });

  it("restores Eigenmodes & FrequencyResponse connected parity: study.run, FP64 global quick-fix, k-path/free_modes wavevectors, non-linear >16-pt sweep preservation, and response_map k-grid", async () => {
    const dom = installSimulationPreparationTestDom();
    restoreDom = dom.restore;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);

    const logSpacedFrequencies = Array.from({ length: 20 }, (_, idx) =>
      Math.round(1e9 * Math.pow(40, idx / 19)),
    );

    connectedMocks.sessionStatus = {
      capabilities: {
        active_lane: makeSupportedActiveLane(),
        cuda_available: true,
        algorithms_available: ["projected_gradient_bb", "llg_overdamped"],
      },
      discretization: "fdm",
    };
    connectedMocks.periodicPairs = {
      status: "valid",
      pairs: [{ axis: "x", plus_count: 32, minus_count: 32 }],
    };
    connectedMocks.scene = {
      revision: 11,
      objects: [{ id: "waveguide", role: "magnet" }],
      study: {
        requested_backend: "fdm",
        requested_device: "cpu",
        requested_precision: "single",
        requested_mode: "strict",
        exchange_enabled: true,
        demag_enabled: true,
        stages: [
          {
            kind: "relax",
            stage_id: "relax_1",
            algorithm: "projected_gradient_bb",
            torque_tolerance: 100,
            max_steps: 50000,
          },
          {
            kind: "eigenmodes",
            stage_id: "eigen_1",
            calculation_mode: "free_modes",
            equilibrium: { kind: "relax" },
            bc: "periodic_1d",
            k_path: "Gamma:0,0,0; X:2.5e7,0,0 | samples=31",
            count: 16,
          },
          {
            kind: "frequency_response",
            stage_id: "freq_1",
            calculation_mode: "response_map",
            equilibrium: { kind: "relax" },
            bc: "periodic_1d",
            excitation_field_au_per_m: [0, 0, 0],
            frequencies_hz: logSpacedFrequencies,
            k_vector: [1.2e7, 0, 0],
            k_sampling: { kind: "grid", nx: 48, k_max_rad_per_m: 3e7 },
            solver_method: "auto",
          },
        ],
      },
    };

    const { commitTransaction, executeCommand, kernel } =
      createConnectedStageKernel();

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <EigenmodesStageInspectorPanel
            selection={makeStageSelection("study.stage.eigenmodes", "eigen_1", 1)}
          />
        </KernelContext.Provider>,
      );
    });

    const eigenText = container.textContent ?? "";
    expect(eigenText).not.toContain("Arnoldi tolerance");
    expect(eigenText).not.toContain("Save spatial mode fields");
    expect(eigenText).not.toContain("StudyIR::");
    expect(eigenText.toLowerCase()).not.toContain("unknown");

    // Header primary action dispatches study.run on Eigenmodes (never study.execute-stage or study.run-stage)
    const runUpBtn = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" && (el.textContent ?? "").includes("Run up to here"),
    );
    expect(runUpBtn).not.toBeNull();
    await act(async () => {
      runUpBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(executeCommand).toHaveBeenCalledWith(
      "study.run",
      expect.anything(),
    );
    expect(
      executeCommand.mock.calls.some(
        (call) => call[0] === "study.execute-stage" || call[0] === "study.run-stage",
      ),
    ).toBe(false);

    // FP64 quick-fix commits global requested_precision: "double"
    const fp64Btn = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" &&
        (el.textContent ?? "").includes("Switch Study Precision to FP64"),
    );
    expect(fp64Btn).not.toBeNull();
    await act(async () => {
      fp64Btn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(commitTransaction).toHaveBeenCalledTimes(1);
    expect(commitTransaction.mock.calls[0]?.[0]).toMatchObject({
      base_revision: 11,
      kind: "merge_patch",
      merge_patch: {
        study: expect.objectContaining({
          requested_precision: "double",
        }),
      },
    });

    // Switch Study precision to double and verify free_modes wavevector mode clears stale k_path
    (
      connectedMocks.scene as {
        study: { requested_precision: string };
      }
    ).study.requested_precision = "double";
    commitTransaction.mockClear();

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <EigenmodesStageInspectorPanel
            selection={makeStageSelection(
              "study.stage.eigenmodes.k_path",
              "eigen_1",
              1,
            )}
          />
        </KernelContext.Provider>,
      );
    });

    expect(container.textContent ?? "").toContain("Wavevector Sampling");
    const singleKBtn = findElements(
      container,
      (el) => el.tagName === "BUTTON" && el.textContent?.trim() === "Single k",
    )[0];
    expect(singleKBtn).toBeDefined();
    await act(async () => {
      singleKBtn!.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const applyEigenBtn = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" && (el.textContent ?? "").includes("Apply"),
    );
    await act(async () => {
      applyEigenBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(commitTransaction).toHaveBeenCalledTimes(1);
    const committedEigenStages = (
      commitTransaction.mock.calls[0]?.[0] as {
        merge_patch: { study: { stages: Record<string, unknown>[] } };
      }
    ).merge_patch.study.stages;
    expect(committedEigenStages[1]?.k_path).toBeUndefined();
    expect(committedEigenStages[1]?.k_vector).toEqual([0, 0, 0]);

    // FrequencyResponse: zero-excitation notice + quick-fix, >16-pt non-linear sweep preserved, response_map k_sampling + k_vector serialized
    commitTransaction.mockClear();
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <FrequencyResponseStageInspectorPanel
            selection={makeStageSelection(
              "study.stage.frequency_response",
              "freq_1",
              2,
            )}
          />
        </KernelContext.Provider>,
      );
    });

    expect(container.textContent ?? "").toContain(
      "Harmonic RF excitation amplitude cannot be [0, 0, 0]",
    );
    expect(container.textContent ?? "").toContain("20 explicit pts");
    const fixExcitationBtn = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" &&
        (el.textContent ?? "").includes("Set 1 mT transverse RF drive"),
    );
    expect(fixExcitationBtn).not.toBeNull();
    await act(async () => {
      fixExcitationBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    const applyFreqBtn = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" && (el.textContent ?? "").includes("Apply"),
    );
    await act(async () => {
      applyFreqBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(commitTransaction).toHaveBeenCalledTimes(1);
    const committedFreqStage = (
      commitTransaction.mock.calls[0]?.[0] as {
        merge_patch: { study: { stages: Record<string, unknown>[] } };
      }
    ).merge_patch.study.stages[2];
    expect(committedFreqStage?.excitation_field_au_per_m).toEqual([
      0, 795.77, 0,
    ]);
    expect(committedFreqStage?.frequencies_hz).toEqual(logSpacedFrequencies);
    expect(committedFreqStage?.k_vector).toEqual([1.2e7, 0, 0]);
    expect(committedFreqStage?.k_sampling).toMatchObject({
      kind: "grid",
      nx: 48,
      k_max_rad_per_m: 3e7,
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("restores Relax, Run, and parallel worker telemetry parity without fake solver controls or disconnected checkpoint inputs", async () => {
    const dom = installSimulationPreparationTestDom();
    restoreDom = dom.restore;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);

    connectedMocks.sessionStatus = {
      capabilities: {
        active_lane: makeSupportedActiveLane(),
        cuda_available: true,
        algorithms_available: ["projected_gradient_bb", "llg_overdamped"],
      },
      discretization: "fdm",
    };
    connectedMocks.scene = {
      revision: 11,
      objects: [{ id: "disk", role: "magnet" }],
      study: {
        requested_backend: "fdm",
        requested_device: "cpu",
        requested_precision: "double",
        requested_mode: "strict",
        exchange_enabled: true,
        demag_enabled: true,
        stages: [
          {
            kind: "relax",
            stage_id: "relax_1",
            algorithm: "llg_overdamped",
            torque_tolerance: 100,
            max_steps: 50000,
            solver: "rk45",
            adaptive_timestep: {
              dt_min: 1e-15,
              dt_max: 1e-11,
              atol: 1e-7,
              rtol: 1e-5,
              safety: 0.9,
              growth_limit: 2,
              shrink_limit: 0.2,
            },
          },
          {
            kind: "run",
            stage_id: "run_1",
            until_seconds: 2e-9,
            fixed_timestep: 1e-13,
          },
        ],
      },
    };

    const { commitTransaction, executeCommand, kernel, selectSet } =
      createConnectedStageKernel();

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <RelaxStageInspectorPanel
            selection={makeStageSelection("study.stage.relax", "relax_1", 0)}
          />
        </KernelContext.Provider>,
      );
    });

    const relaxText = container.textContent ?? "";
    expect(relaxText).not.toContain("Pinned checkpoint ID");
    expect(relaxText).toContain("Max relaxation time");
    expect(relaxText).toContain("Max pseudotime");
    expect(relaxText).toContain("Max spin rotation");
    expect(relaxText).toContain("Norm tolerance");
    expect(relaxText).toContain("Inherit from Study");

    // Clean Relax stage dispatches study.execute-stage directly without committing
    const relaxRunBtn = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" && (el.textContent ?? "").includes("Run up to here"),
    );
    expect(relaxRunBtn).not.toBeNull();
    await act(async () => {
      relaxRunBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(commitTransaction).toHaveBeenCalledTimes(0);
    expect(executeCommand).toHaveBeenCalledWith(
      "study.execute-stage",
      expect.anything(),
      expect.objectContaining({ stageId: "relax_1" }),
    );
    executeCommand.mockClear();

    const relaxSwitch = findElement(
      container,
      (el) => el.getAttribute("role") === "switch",
    );
    await act(async () => {
      relaxSwitch?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    // Dirty Relax stage saves draft first before running study.execute-stage
    await act(async () => {
      relaxRunBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(commitTransaction).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith(
      "study.execute-stage",
      expect.anything(),
      expect.objectContaining({ stageId: "relax_1" }),
    );
    executeCommand.mockClear();

    // RunStageInspectorPanel: 0 fake per-stage solver controls + legacy fix_dt clear + Study Execution navigation
    commitTransaction.mockClear();
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <RunStageInspectorPanel
            selection={makeStageSelection("study.stage.run", "run_1", 1)}
          />
        </KernelContext.Provider>,
      );
    });

    const runText = container.textContent ?? "";
    expect(runText).not.toContain("Relative tolerance (rtol)");
    expect(runText).not.toContain("Absolute tolerance (atol)");
    expect(runText).toContain("fix_dt");

    const runExecBtn = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" &&
        (el.textContent ?? "").includes("Run up to here"),
    );
    await act(async () => {
      runExecBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(executeCommand).toHaveBeenCalledWith(
      "study.execute-stage",
      expect.anything(),
      expect.objectContaining({ stageId: "run_1" }),
    );

    const navExecBtn = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" &&
        (el.textContent ?? "").includes("Configure in Study Execution"),
    );
    await act(async () => {
      navExecBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(selectSet).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "study.execution" }),
      "inspector",
    );

    const clearLegacyBtn = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" &&
        (el.textContent ?? "").includes("Clear legacy fix_dt"),
    );
    expect(clearLegacyBtn).not.toBeNull();
    await act(async () => {
      clearLegacyBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const applyRun = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" && (el.textContent ?? "").includes("Apply"),
    );
    await act(async () => {
      applyRun?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(commitTransaction).toHaveBeenCalledTimes(1);
    const committedRunStage = (
      commitTransaction.mock.calls[0]?.[0] as {
        merge_patch: { study: { stages: Record<string, unknown>[] } };
      }
    ).merge_patch.study.stages[1];
    expect(committedRunStage?.fixed_timestep).toBeUndefined();

    // StageLiveTelemetryPanel renders parallel worker pool admission telemetry
    const mockTelemetryModel: StudyStageModel = {
      artifactRefs: ["art_1"],
      checkpointRef: "ckpt_1",
      converged: true,
      detail: "llg_overdamped",
      index: 0,
      kind: "relax",
      label: "Relax 1",
      nodeId: "model:study:stages:stage:relax_1",
      parallelExecution: {
        active_workers: 4,
        admission_desired_workers: 6,
        admission_reason: "cpu_target_exhausted",
        admission_worker_limit: 8,
        cpu_available_cores: 12,
        cpu_busy_percent: 72,
        cpu_target_kind: "soft_admission_target",
        cpu_target_percent: 75,
        memory_available_bytes: 8 * 1024 * 1024 * 1024,
        memory_limit_bytes: 16 * 1024 * 1024 * 1024,
        memory_reserve_bytes: 1024 * 1024 * 1024,
        memory_target_percent: 80,
        resolved_workers: 4,
        terminal: false,
      } as unknown as StudyStageModel["parallelExecution"],
      progressDetail: "Step 1200 / 50000",
      progressLabel: "24%",
      progressPercent: 24,
      runtimeMetric: { name: "max_torque", threshold: "100 A/m", value: "85 A/m" },
      stageId: "relax_1",
      status: "running",
      stopReason: null,
      transition: null,
    };
    await act(async () => {
      root.render(
        <StageLiveTelemetryPanel
          emptyDescription="Empty"
          stageModel={mockTelemetryModel}
        />,
      );
    });
    expect(container.textContent ?? "").toContain("4 active; admission 6; limit 8");
    expect(container.textContent ?? "").toContain("Waiting for CPU capacity");
    expect(container.textContent ?? "").toContain("12.00 cores");

    await act(async () => {
      root.unmount();
    });
  });

  it("restores AddFieldDrive, MaskFieldDrive, Autosave, FFT, SaveState, ChangeDevice, AntennaFieldSolve, and ActionFallback/Hysteresis sub-panel parity", async () => {
    const dom = installSimulationPreparationTestDom();
    restoreDom = dom.restore;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);

    connectedMocks.sessionStatus = {
      capabilities: {
        active_lane: makeSupportedActiveLane(),
        cuda_available: true,
      },
      discretization: "fdm",
    };
    connectedMocks.scene = {
      revision: 11,
      objects: [
        { id: "film_main", name: "Main Film", role: "magnet" },
        { id: "mask_pad", name: "Mask Pad", role: "non_magnetic" },
      ],
      antenna_port_modes: [
        {
          id: "port_valid",
          name: "Port Valid",
          source_object_id: "cpw_1",
          current_transport_id: "ct_1",
        },
      ],
      antenna_field_solve_stages: [
        {
          id: "ant_invalid",
          name: "Broken Antenna Solve",
          source_object_id: "cpw_1",
          current_transport_id: "ct_1",
          model: "magnetostatic_current",
          oersted_realization: "biot_savart",
          solver_policy: "auto",
          port_mode_ids: ["port_missing"],
          outputs: [],
        },
      ],
      study: {
        execution_profile: { preset: "cuda_workstation" },
        requested_backend: "fdm",
        requested_device: "gpu",
        requested_precision: "double",
        requested_mode: "strict",
        stages: [
          {
            kind: "add_field_drive",
            stage_id: "drive_stage_1",
            drive: {
              id: "drv_pwl",
              name: "Piecewise Masked Drive",
              enabled: true,
              b_tesla: 0.015,
              direction: [0, 1, 0],
              target: { kind: "object", object_id: "film_main" },
              spatial_profile: {
                kind: "geometry_mask",
                object_id: "mask_pad",
                envelope: {
                  kind: "sinc",
                  axis: [0, 1, 0],
                  period_m: 400e-9,
                  center_m: 50e-9,
                  width_m: 2e-6,
                  window: "blackman",
                },
              },
              waveform: {
                kind: "piecewise_linear",
                points: [
                  [0, 0],
                  [5e-10, 1],
                  [1.5e-9, -0.5],
                ],
              },
              activation: {
                kind: "stage_ids",
                stage_ids: ["run_target_1"],
              },
              time_origin: "absolute",
            },
          },
          {
            kind: "run",
            stage_id: "run_target_1",
            until_seconds: 2e-9,
          },
          {
            kind: "add_mask_field_drive",
            stage_id: "mask_add_1",
            drive: {
              id: "mask_drv_1",
              name: "CPW Dual Term",
              target: { kind: "global" },
              shape: { kind: "box", size: [1e-6, 2e-7, 1e-8] },
              frame: "local",
              time_origin: "stage_local",
              terms: [
                {
                  name: "Term 1",
                  mask: {
                    kind: "function",
                    function: {
                      name: "mask_x",
                      parameters: [{ name: "Bx_1", value: 0.01 }],
                      outputs: ["Bx_1 * x"],
                    },
                  },
                  time: {
                    name: "tone_1",
                    parameters: [{ name: "w", value: 6.28e9 }],
                    outputs: ["sin(w*t)"],
                  },
                },
                {
                  name: "Term 2",
                  mask: {
                    kind: "function",
                    function: {
                      name: "mask_y",
                      parameters: [{ name: "By_2", value: 0.02 }],
                      outputs: ["By_2 * y"],
                    },
                  },
                  time: {
                    name: "tone_2",
                    parameters: [{ name: "w", value: 6.28e9 }],
                    outputs: ["cos(w*t)"],
                  },
                },
              ],
            },
          },
          {
            kind: "update_mask_field_drive",
            stage_id: "mask_upd_1",
            drive_id: "mask_drv_1",
            term: 1,
            mask_parameters: { By_2: 0.04 },
            time_parameters: { w: 1.256e10 },
          },
          {
            kind: "fft_response",
            stage_id: "fft_1",
            enabled: true,
            request: {
              analysis: "gamma",
              response_component: "my",
              window: "hann",
              detrend: "mean",
              susceptibility_floor_fraction: 0.01,
            },
          },
          {
            kind: "save_state",
            stage_id: "save_blank",
            artifact_name: "mid_snap",
          },
          {
            kind: "change_device",
            stage_id: "dev_cuda_1",
            device: "cuda:1",
          },
          {
            kind: "antenna_field_solve",
            stage_id: "ant_unbound",
          },
          {
            kind: "antenna_field_solve",
            stage_id: "ant_invalid",
          },
          {
            kind: "remove_field_drive",
            stage_id: "act_remove_1",
            drive_id: "drv_pwl",
          },
          {
            kind: "table_autosave",
            stage_id: "tbl_custom_1",
            enabled: true,
            table_autosave: {
              kind: "table_autosave",
              quantities: ["mx", "E_demag_film_main"],
              sample_period_s: 5e-13,
            },
          },
          {
            kind: "autosave",
            stage_id: "auto_ro_1",
            enabled: true,
            quantity: "B_oersted_custom",
            output: {
              name: "B_oersted_custom",
              sample_period_policy: { kind: "custom_external_clock" },
            },
          },
        ],
      },
    };

    const { commitTransaction, kernel } = createConnectedStageKernel();

    // 1. AddFieldDrive preserves piecewise_linear, geometry_mask maskObjectId + blackman sinc envelope, and stage_ids
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <AddFieldDriveStageInspectorPanel
            selection={makeStageSelection(
              "study.stage.add_field_drive",
              "drive_stage_1",
              0,
            )}
          />
        </KernelContext.Provider>,
      );
    });
    expect(container.textContent ?? "").toContain("run_target_1");
    const blackmanBtn = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" &&
        el.textContent?.trim() === "Blackman" &&
        el.getAttribute("aria-checked") === "true",
    );
    expect(blackmanBtn).not.toBeNull();

    // Toggle driveEnabled and Apply
    const driveEnableSwitch = findElements(
      container,
      (el) => el.getAttribute("role") === "switch",
    )[0];
    await act(async () => {
      driveEnableSwitch?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const applyDrive = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" && (el.textContent ?? "").includes("Apply"),
    );
    await act(async () => {
      applyDrive?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(commitTransaction).toHaveBeenCalledTimes(1);
    const savedDriveStage = (
      commitTransaction.mock.calls[0]?.[0] as {
        merge_patch: { study: { stages: Record<string, unknown>[] } };
      }
    ).merge_patch.study.stages[0] as {
      drive: Record<string, unknown>;
    };
    expect(savedDriveStage.drive.enabled).toBe(false);
    expect(savedDriveStage.drive.activation).toEqual({
      kind: "stage_ids",
      stage_ids: ["run_target_1"],
    });
    expect(savedDriveStage.drive.spatial_profile).toMatchObject({
      kind: "geometry_mask",
      object_id: "mask_pad",
      envelope: expect.objectContaining({
        kind: "sinc",
        window: "blackman",
      }),
    });
    expect(savedDriveStage.drive.waveform).toEqual({
      kind: "piecewise_linear",
      points: [
        [0, 0],
        [5e-10, 1],
        [1.5e-9, -0.5],
      ],
    });

    // 2. MaskFieldDrive: multi-term add + update without fake expressions
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <MaskFieldDriveStageInspectorPanel
            selection={makeStageSelection(
              "study.stage.mask_field_drive",
              "mask_add_1",
              2,
            )}
          />
        </KernelContext.Provider>,
      );
    });
    expect(container.textContent ?? "").toContain("Term 1");
    expect(container.textContent ?? "").toContain("Term 2");
    expect(container.textContent ?? "").toContain("By_2 * y");

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <MaskFieldDriveStageInspectorPanel
            selection={makeStageSelection(
              "study.stage.mask_field_drive",
              "mask_upd_1",
              3,
            )}
          />
        </KernelContext.Provider>,
      );
    });
    expect(container.textContent ?? "").toContain("mask_drv_1");
    expect(container.textContent ?? "").toContain("By_2");
    expect(container.textContent ?? "").not.toContain("B0 * sin(k * x)");

    // 3. FftResponse: gamma mode restricts response_component to my | mz (omits mx)
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <FftResponseStageInspectorPanel
            selection={makeStageSelection("study.stage.fft_response", "fft_1", 4)}
          />
        </KernelContext.Provider>,
      );
    });
    expect(
      findElements(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent?.trim() === "mx",
      ),
    ).toHaveLength(0);
    expect(
      findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent?.trim() === "my",
      ),
    ).not.toBeNull();

    // 4. SaveState preserves blank format "" without coercing to "zarr"
    commitTransaction.mockClear();
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <SaveStateStageInspectorPanel
            selection={makeStageSelection(
              "study.stage.save_state",
              "save_blank",
              5,
            )}
          />
        </KernelContext.Provider>,
      );
    });
    expect(container.textContent ?? "").toContain("Session default");
    const npzPresetBtn = findElement(
      container,
      (el) => el.tagName === "BUTTON" && el.textContent?.trim() === "npz",
    );
    expect(npzPresetBtn).not.toBeNull();
    await act(async () => {
      npzPresetBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const applySave = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" && (el.textContent ?? "").includes("Apply"),
    );
    await act(async () => {
      applySave?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(commitTransaction).toHaveBeenCalledTimes(1);
    const savedSnapStage = (
      commitTransaction.mock.calls[0]?.[0] as {
        merge_patch: { study: { stages: Record<string, unknown>[] } };
      }
    ).merge_patch.study.stages[5];
    expect(savedSnapStage?.format).toBe("npz");

    // 5. ChangeDevice surfaces executionProfileBound conflict error & preserves cuda:1
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <ChangeDeviceStageInspectorPanel
            selection={makeStageSelection(
              "study.stage.change_device",
              "dev_cuda_1",
              6,
            )}
          />
        </KernelContext.Provider>,
      );
    });
    expect(container.textContent ?? "").toContain("cuda:1");
    expect(container.textContent ?? "").toContain("Profile bound");
    expect(container.textContent ?? "").toContain(
      "Stage-level Change Device instructions conflict with profile-managed device placement",
    );

    // 6. AntennaFieldSolve: honest Unbound and Invalid ref states instead of hardcoded Bound
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <AntennaFieldSolveStageInspectorPanel
            selection={makeStageSelection(
              "study.stage.antenna_field_solve",
              "ant_unbound",
              7,
            )}
          />
        </KernelContext.Provider>,
      );
    });
    expect(container.textContent ?? "").toContain("Unbound");
    expect(container.textContent ?? "").not.toContain("cpw_antenna");

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <AntennaFieldSolveStageInspectorPanel
            selection={makeStageSelection(
              "study.stage.antenna_field_solve",
              "ant_invalid",
              8,
            )}
          />
        </KernelContext.Provider>,
      );
    });
    expect(container.textContent ?? "").toContain("Invalid ref");
    expect(container.textContent ?? "").toContain("port_missing");

    // 7. ActionStageFallback: explicit Original kind + hysteresis execution-tree child routing
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <ActionStageFallbackInspectorPanel
            selection={makeStageSelection(
              "study.stage.action",
              "act_remove_1",
              9,
            )}
          />
        </KernelContext.Provider>,
      );
    });
    expect(container.textContent ?? "").toContain("Original kind");
    expect(container.textContent ?? "").toContain("remove_field_drive");

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <ActionStageFallbackInspectorPanel
            selection={{
              kind: "study.stage.action",
              label: "Point 3",
              moduleSource: "explorer",
              nodeId: "study:stage:0:field-point:3",
              objectId: null,
              ref: {
                kind: "study.stage.action",
                nodeId: "study:stage:0:field-point:3",
                stageId: "hyst_1",
                stageIndex: 0,
                type: "study-stage",
              },
            }}
          />
        </KernelContext.Provider>,
      );
    });
    expect(container.textContent ?? "").toContain("Hysteresis Execution Detail");
    expect(container.textContent ?? "").toContain("point detail");
    expect(
      findElements(
        container,
        (el) =>
          el.tagName === "INPUT" ||
          el.tagName === "SELECT" ||
          el.tagName === "TEXTAREA",
      ),
    ).toHaveLength(0);

    // 8. TableAutosave & Autosave: custom free-text quantities + readOnly imported policy preservation
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <TableAutosaveStageInspectorPanel
            selection={makeStageSelection(
              "study.stage.table_autosave",
              "tbl_custom_1",
              10,
            )}
          />
        </KernelContext.Provider>,
      );
    });
    expect(container.textContent ?? "").toContain("Stage ID");
    const tblInputs = findElements(
      container,
      (el) =>
        el.tagName === "INPUT" &&
        (el as unknown as { value?: string }).value?.includes(
          "E_demag_film_main",
        ) === true,
    );
    expect(tblInputs.length).toBeGreaterThanOrEqual(1);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <AutosaveStageInspectorPanel
            selection={makeStageSelection(
              "study.stage.autosave",
              "auto_ro_1",
              11,
            )}
          />
        </KernelContext.Provider>,
      );
    });
    expect(container.textContent ?? "").toContain("Read-only");

    await act(async () => {
      root.unmount();
    });
  });

  it("verifies Wave 6 Group C contracts: fresh status/readiness/scene sync on dirty run, OpenAPI telemetry fields, 0-stage connected study honesty, auto-discretization demag lane, and Hysteresis point commands", async () => {
    const dom = installSimulationPreparationTestDom();
    restoreDom = dom.restore;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);

    const activeLane = {
      ...makeSupportedActiveLane(),
      authored: {
        backend: "auto",
        device: "auto",
        discretization: "auto",
        mode: "strict",
        precision: "double",
      },
      requested: {
        backend: "auto",
        device: "cpu",
        discretization: "auto",
        mode: "strict",
        precision: "double",
      },
      resolved: {
        backend: "fdm",
        device: "cpu",
        discretization: "fdm",
        mode: "strict",
        precision: "double",
      },
    };

    connectedMocks.sessionStatus = {
      capabilities: {
        active_lane: activeLane,
        cuda_available: false,
        algorithms_available: ["projected_gradient_bb", "llg_overdamped"],
      },
      resources: {
        mesh_revision: 5,
        scene_revision: 20,
      },
      session: {
        session_epoch: "epoch-1",
        session_id: "sess-1",
      },
    };
    connectedMocks.solverStatus = {
      can_accept_commands: true,
      is_busy: false,
      max_rhs_norm_per_s: 1.25e8,
      max_torque_Apm: null,
      revision: 3,
      runtime_state: "paused",
      runtime_status_code: "ok",
      runtime_status_kind: "paused",
      session_status: "ready",
      sim_time_seconds: 2.5e-9,
      step_index: 420,
      warnings: [],
    };
    connectedMocks.solverEnergyCurrent = {
      anisotropy: 0,
      demag: 1e-18,
      dmi: 0,
      exchange: 2e-18,
      revision: 3,
      step: 420,
      time_seconds: 2.5e-9,
      total: 3e-18,
      zeeman: -1e-19,
    };
    connectedMocks.solverEnergyHistory = {
      returned_rows: 2,
      revision: 3,
      rows: [
        {
          anisotropy: 0,
          demag: 1e-18,
          dmi: 0,
          exchange: 2e-18,
          step: 410,
          time_seconds: 1.5e-9,
          total: 5e-18,
          zeeman: -1e-19,
        },
        {
          anisotropy: 0,
          demag: 1e-18,
          dmi: 0,
          exchange: 2e-18,
          step: 420,
          time_seconds: 2.5e-9,
          total: 3e-18,
          zeeman: -1e-19,
        },
      ],
      total_rows: 10,
    };
    connectedMocks.scene = {
      revision: 20,
      objects: [{ id: "film_1", role: "magnet" }],
      study: {
        requested_backend: "auto",
        requested_device: "cpu",
        requested_precision: "double",
        requested_mode: "strict",
        exchange_enabled: true,
        demag_enabled: true,
        fdm: {
          default_cell: [2e-9, 2e-9, 1e-9],
          demag: { strategy: "multilayer_convolution", mode: "auto", explain: true },
        },
        stages: [],
      },
    };

    const { commitTransaction, executeCommand, kernel } =
      createConnectedStageKernel();
    const hysteresisPointsMock = vi.fn().mockResolvedValue({
      points: [
        {
          branch_id: "major_down",
          field_value_mT: -50,
          m_avg: [0.1, 0, -0.9],
          m_ip: 0.1,
          m_oop: -0.9,
          m_parallel: -0.9,
          point_id: 7,
          snapshot_id: "snap_7",
          snapshot_json_artifact_ref: "hysteresis_snapshots/snap_7/m.json",
          status: "converged",
        },
      ],
      revision: 2,
    });
    const statusMock = vi.fn().mockResolvedValue({
      ...(connectedMocks.sessionStatus as Record<string, unknown>),
      resources: { mesh_revision: 5, scene_revision: 21 },
    });
    const readinessMock = vi.fn().mockResolvedValue({
      blockers: [],
      ready_to_run: true,
      scene_revision: 21,
    });
    const sceneMock = vi.fn().mockImplementation(async () => ({
      ...(connectedMocks.scene as Record<string, unknown>),
      revision: 21,
    }));
    commitTransaction.mockImplementation(async () => ({
      committed_scene: {
        ...(connectedMocks.scene as Record<string, unknown>),
        revision: 21,
      },
      scene_revision: 21,
    }));
    (kernel.api as unknown as Record<string, unknown>).sessions = {
      current: { status: statusMock },
    };
    (kernel.api.model as unknown as Record<string, unknown>).readiness =
      readinessMock;
    (kernel.api.model as unknown as Record<string, unknown>).scene = sceneMock;
    (kernel.api.analysis as unknown as Record<string, unknown>).hysteresis = {
      points: hysteresisPointsMock,
    };

    // 1. study.root: 0-step connected scene shows 0 active stages, sim_time_seconds, step_index, "—" maxTorque, and resolved laneSummary
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <StudyRootInspectorPanel
            selection={makeSelection("study.root", "model:study")}
          />
        </KernelContext.Provider>,
      );
    });
    const rootText = container.textContent ?? "";
    expect(rootText).toContain("0 active");
    expect(rootText).not.toContain("k0_sinc");
    expect(rootText).not.toContain("not loaded");
    expect(rootText).not.toContain("unavailable");
    expect(rootText).toContain("fdm · cpu (double)");
    expect(rootText).toContain("2.500e-9 s");
    expect(rootText).toContain("420");

    // 2. study.stages: 0-stage connected study omits fake k0_sinc summary and omits Mask Field Drive from Add Stage
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <StudyStagesInspectorPanel
            selection={makeSelection("study.stages", "model:study:stages")}
          />
        </KernelContext.Provider>,
      );
    });
    const stagesText = container.textContent ?? "";
    expect(stagesText).not.toContain("k0_sinc (sinc_pulse, fc = 40.0 GHz)");
    expect(stagesText).not.toContain("Mask Field Drive");

    // 3. study.execution: auto discretization + FDM session shows FDM demag realization (not FEM) and omits non-master FEM options
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <StudyExecutionInspectorPanel
            selection={makeSelection("study.execution", "model:study:execution")}
          />
        </KernelContext.Provider>,
      );
    });
    const physicsTab = findElements(
      container,
      (el) => el.getAttribute("role") === "tab",
    ).find((el) => (el.textContent ?? "").includes("Global Physics"));
    await act(async () => {
      physicsTab?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const execText = container.textContent ?? "";
    expect(execText).toContain("FDM demag realization");
    expect(execText).not.toContain("FEM demag realization");
    expect(execText).not.toContain("Truncated airbox potential");
    expect(execText).not.toContain("Kelvin / shell transformation");

    // 4. study.recovery: reads runtime_state=paused, step_index, returned_rows, finite-difference dE/dt, and max_rhs_norm_per_s
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <StudyRecoveryInspectorPanel
            selection={makeSelection("study.recovery", "model:study:recovery")}
          />
        </KernelContext.Provider>,
      );
    });
    // Open Energy Ledger section
    const ledgerBtn = findElements(
      container,
      (el) =>
        el.tagName === "BUTTON" &&
        (el.textContent ?? "").includes("Run History & Energy Ledger"),
    )[0];
    await act(async () => {
      ledgerBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const recText = container.textContent ?? "";
    expect(recText).toContain("Paused state held");
    expect(recText).toContain("2 of 10 rows");
    expect(recText).toContain("-2.000e-9 J/s");
    expect(recText).toContain("1.250e+8 1/s");

    // 5. HysteresisStageSpec: StageInitialStateRadixControl, api.analysis.hysteresis.points, dirty save + study.run, and point commands
    const hystPoint = {
      branch_id: "major_down",
      field_value_mT: -50,
      m_avg: [0.1, 0, -0.9],
      m_ip: 0.1,
      m_oop: -0.9,
      m_parallel: -0.9,
      point_id: 7,
      snapshot_id: "snap_7",
      snapshot_json_artifact_ref: "hysteresis_snapshots/snap_7/m.json",
      status: "converged",
    };
    connectedMocks.hysteresisPoints = { points: [hystPoint], revision: 2 };
    connectedMocks.scene = {
      ...(connectedMocks.scene as Record<string, unknown>),
      study: {
        ...((connectedMocks.scene as { study: Record<string, unknown> }).study),
        stages: [
          {
            kind: "hysteresis",
            stage_id: "hyst_1",
            field_min_mT: -200,
            field_max_mT: 200,
            field_step_mT: 10,
            settle_pipeline: {
              kind: "sequence",
              steps: [
                {
                  kind: "minimize",
                  method: "projected_gradient_bb",
                  max_steps: 2000,
                  torque_tolerance: 1e-4,
                  on_non_convergence: "continue_with_warning",
                },
              ],
            },
          },
        ],
      },
    };

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <HysteresisStageInspectorPanel
            selection={makeStageSelection("study.stage.hysteresis", "hyst_1", 0)}
          />
        </KernelContext.Provider>,
      );
    });
    expect(container.textContent ?? "").toContain("Initial magnetization");

    // Header menu opens diagnostic sheet via api.analysis.hysteresis.points before Live tab mounts
    const openSheetItem = findElement(
      container,
      (el) =>
        el.getAttribute("role") === "menuitem" &&
        (el.textContent ?? "").includes("Open Full 15-Column Diagnostic Sheet"),
    );
    expect(openSheetItem).not.toBeNull();
    await act(async () => {
      openSheetItem?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(hysteresisPointsMock).toHaveBeenCalledWith(
      "hyst_1",
      expect.anything(),
    );

    // Dirty edit + Run up to here saves draft first, fetches fresh status/readiness/scene, and executes study.run
    commitTransaction.mockClear();
    executeCommand.mockClear();
    const virginCurveOpt = findElement(
      container,
      (el) => el.getAttribute("data-select-value") === "virgin_curve",
    );
    expect(virginCurveOpt).not.toBeNull();
    await act(async () => {
      virginCurveOpt?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const hystRunBtn = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" && (el.textContent ?? "").includes("Run up to here"),
    );
    await act(async () => {
      hystRunBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(commitTransaction).toHaveBeenCalledTimes(1);
    expect(statusMock).toHaveBeenCalled();
    expect(readinessMock).toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledWith(
      "study.run",
      expect.objectContaining({
        resourceData: expect.objectContaining({
          "/api/v2/session/status": expect.objectContaining({
            resources: { mesh_revision: 5, scene_revision: 21 },
          }),
        }),
      }),
    );

    // Switch to Live & Results tab and verify compare-point, bookmark-point, and export-point-csv receive { point, stageId }
    const liveTab = findElements(
      container,
      (el) => el.getAttribute("role") === "tab",
    ).find((el) => (el.textContent ?? "").includes("Live & Results"));
    await act(async () => {
      liveTab?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    executeCommand.mockClear();

    const compareBtn = findElement(
      container,
      (el) => el.getAttribute("aria-label") === "Compare point 7",
    );
    const bookmarkBtn = findElement(
      container,
      (el) => el.getAttribute("aria-label") === "Bookmark point 7",
    );
    const exportPtBtn = findElement(
      container,
      (el) => el.getAttribute("aria-label") === "Export point 7 CSV",
    );
    expect(compareBtn).not.toBeNull();
    expect(bookmarkBtn).not.toBeNull();
    expect(exportPtBtn).not.toBeNull();

    await act(async () => {
      compareBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
      bookmarkBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
      exportPtBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(executeCommand).toHaveBeenCalledWith(
      "hysteresis.compare-point",
      expect.anything(),
      { point: hystPoint, stageId: "hyst_1" },
    );
    expect(executeCommand).toHaveBeenCalledWith(
      "hysteresis.bookmark-point",
      expect.anything(),
      { point: hystPoint, stageId: "hyst_1" },
    );
    expect(executeCommand).toHaveBeenCalledWith(
      "hysteresis.export-point-csv",
      expect.anything(),
      { point: hystPoint, stageId: "hyst_1" },
    );

    await act(async () => {
      root.unmount();
    });
  });
});
