import { act, createContext, useContext } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StageExecutionResource } from "@/kernel/api/apiTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { LayoutController } from "@/kernel/layout/LayoutController";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { KernelApi } from "@/kernel/types";

import FooterModule from "./FooterModule";
import type { FooterTelemetryStatus } from "./FooterTelemetry";

const observation = vi.hoisted(() => ({
  status: null as FooterTelemetryStatus | null,
  execution: null as StageExecutionResource | null,
  stageOptions: [] as { enabled: boolean }[],
  realTabs: false,
}));

vi.mock("@/kernel/resources/useSessionStatus", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/kernel/resources/useSessionStatus")>(),
  useSessionStatusSelector: () => observation.status,
}));
vi.mock("@/kernel/resources/studyRuntimeResources", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/kernel/resources/studyRuntimeResources")>(),
  useStageExecutionResource: (options: { enabled: boolean }) => {
    observation.stageOptions.push(options);
    return { data: observation.execution, status: "ready" };
  },
}));
vi.mock("./FooterTelemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./FooterTelemetry")>();
  return {
    ...actual,
    FooterTelemetry: ({ view, stageExecution }: {
      view: string; stageExecution: { data: StageExecutionResource | null };
    }) => <div data-telemetry-view={view}>{view} {stageExecution.data?.stages[0]?.status}</div>,
  };
});
vi.mock("@/shared/analysis-charts/QuickChartResourceView", () => ({
  QuickChartResourceView: () => <div>Quick chart</div>,
}));
vi.mock("@/shared/ui/Tabs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/ui/Tabs")>();
  const Context = createContext({ value: "", onValueChange: (_value: string) => {} });
  return {
    Tabs: ({ value, onValueChange, children }: {
      value: string; onValueChange: (value: string) => void; children?: ReactNode;
    }) => observation.realTabs
      ? <actual.Tabs value={value} onValueChange={onValueChange}>{children}</actual.Tabs>
      : <Context.Provider value={{ value, onValueChange }}><div data-tab-value={value}>{children}</div></Context.Provider>,
    TabsContent: ({ value, children }: { value: string; children?: ReactNode }) => {
      const context = useContext(Context);
      return observation.realTabs
        ? <actual.TabsContent value={value}>{children}</actual.TabsContent>
        : context.value === value ? <div role="tabpanel">{children}</div> : null;
    },
    TabsList: ({ children, ...props }: { children?: ReactNode }) => observation.realTabs
      ? <actual.TabsList {...props}>{children}</actual.TabsList>
      : <div {...props}>{children}</div>,
    TabsTrigger: ({ value, children }: { value: string; children?: ReactNode }) => {
      const context = useContext(Context);
      return observation.realTabs
        ? <actual.TabsTrigger value={value}>{children}</actual.TabsTrigger>
        : <button role="tab" aria-selected={context.value === value} onClick={() => context.onValueChange(value)}>{children}</button>;
    },
  };
});

function status(session = "session", run = "run"): FooterTelemetryStatus {
  return {
    sessionId: session, sessionEpoch: session + "@1", requestScopeEpoch: session + ":scope",
    run: { run_id: run }, solver: { state: "running" },
  } as FooterTelemetryStatus;
}

function execution(stage = "authored-step", state = "running"): StageExecutionResource {
  return {
    session_id: observation.status!.sessionId,
    session_epoch: observation.status!.sessionEpoch,
    request_scope_epoch: observation.status!.requestScopeEpoch,
    run_id: observation.status!.run!.run_id,
    runtime_state: state, active_stage_index: 0,
    stages: [{
      index: 0, stage_id: stage, antenna_solve_stage_id: "solve-loop", status: state,
      antenna_progress: {
        phase: "evaluating_field", completed_targets: 10, total_targets: 20,
        source_cells: 1_856, elapsed_seconds: 5,
      },
    }],
  } as StageExecutionResource;
}

function makeKernel() {
  const bus = new EventBus<KernelEventMap>();
  const layout = new LayoutController(bus);
  layout.setBottomPanelTab("logs");
  return {
    bus, layout,
    diagnostics: { clear: vi.fn(), getVersion: () => 0, listNewestFirst: () => [], subscribe: () => () => {} },
    commandDiagnostics: { clear: vi.fn(), getVersion: () => 0, listNewestFirst: () => [], subscribe: () => () => {} },
  } as unknown as KernelApi;
}

function footer(kernel: KernelApi) {
  return <KernelContext.Provider value={kernel}>
    <FooterModule config={{}} kernel={kernel} moduleId="transport-footer" setConfig={() => {}} slotId="panel-bottom" />
  </KernelContext.Provider>;
}

describe("Footer Telemetry/Antenna navigation", () => {
  beforeEach(() => {
    observation.status = status();
    observation.execution = execution();
    observation.stageOptions = [];
    observation.realTabs = false;
  });

  it("auto-opens once per new running stage and preserves manual navigation through progress and terminal updates", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const kernel = makeKernel();
    const open = vi.spyOn(kernel.layout, "openBottomPanel");
    const root = createRoot(container as unknown as Element);
    const render = () => act(async () => root.render(footer(kernel)));
    const click = async (label: string) => {
      const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
        .find((node) => node.textContent === label);
      expect(button).toBeDefined();
      await act(async () => button?.click());
    };
    try {
      await render();
      expect(kernel.layout.get().activeBottomPanelTab).toBe("telemetry");
      expect(container.querySelector("[data-telemetry-view]")?.getAttribute("data-telemetry-view")).toBe("antenna");
      expect(open).toHaveBeenCalledTimes(1);

      await click("Overview");
      observation.execution = execution();
      observation.execution.stages[0].antenna_progress!.completed_targets = 15;
      await render();
      expect(container.querySelector("[data-telemetry-view]")?.getAttribute("data-telemetry-view")).toBe("overview");
      expect(open).toHaveBeenCalledTimes(1);
      await click("Logs");
      await render();
      expect(kernel.layout.get().activeBottomPanelTab).toBe("logs");
      expect(open).toHaveBeenCalledTimes(1);

      observation.execution = execution("second-stage");
      await render();
      expect(open).toHaveBeenCalledTimes(2);
      expect(container.querySelector("[data-telemetry-view]")?.getAttribute("data-telemetry-view")).toBe("antenna");
      observation.execution = execution("second-stage", "failed");
      await render();
      expect(open).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain("antenna failed");

      observation.status = status("next-session", "new-run");
      observation.execution = null;
      await render();
      expect(container.querySelector("[data-telemetry-view]")?.getAttribute("data-telemetry-view")).toBe("overview");
      observation.execution = execution();
      await render();
      expect(open).toHaveBeenCalledTimes(3);
      expect(container.querySelector("[data-telemetry-view]")?.getAttribute("data-telemetry-view")).toBe("antenna");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it.each(["session_id", "session_epoch", "request_scope_epoch", "run_id"] as const)(
    "does not auto-select a foreign %s", async (key) => {
      observation.execution![key] = "foreign";
      const dom = installSimulationPreparationTestDom();
      const container = dom.document.createElement("div");
      dom.document.body.appendChild(container);
      const kernel = makeKernel();
      const root = createRoot(container as unknown as Element);
      try {
        await act(async () => root.render(footer(kernel)));
        expect(kernel.layout.get().activeBottomPanelTab).toBe("logs");
        expect(container.querySelector("[data-telemetry-view]")).toBeNull();
      } finally {
        await act(async () => root.unmount());
        dom.restore();
      }
    },
  );

  it("renders genuine accessible nested Radix tabs with stable SSR before automatic client navigation", () => {
    observation.realTabs = true;
    const kernel = makeKernel();
    kernel.layout.setBottomPanelTab("telemetry");
    const open = vi.spyOn(kernel.layout, "openBottomPanel");
    const first = renderToStaticMarkup(footer(kernel));
    const second = renderToStaticMarkup(footer(kernel));
    expect(first).toBe(second);
    expect(first).toContain('aria-label="Telemetry views"');
    expect(first).toContain('role="tablist"');
    expect(first).toContain('role="tabpanel"');
    expect(first).toContain(">Overview</button>");
    expect(first).toContain(">Antenna</button>");
    expect(first).toContain('data-telemetry-view="overview"');
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps SSR stable without activating navigation or adding a second stage owner", () => {
    const kernel = makeKernel();
    const open = vi.spyOn(kernel.layout, "openBottomPanel");
    const first = renderToStaticMarkup(footer(kernel));
    const second = renderToStaticMarkup(footer(kernel));
    expect(first).toBe(second);
    expect(open).not.toHaveBeenCalled();
    expect(kernel.layout.get().activeBottomPanelTab).toBe("logs");
    expect(observation.stageOptions).toEqual([{ enabled: true }, { enabled: true }]);
  });
});
