import {
  act,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SIMULATION_PREPARATION_PATH,
} from "../api/apiPaths";
import { ControlRoomApiError } from "../api/ControlRoomApi";
import { RequestDiagnosticsController } from "../api/RequestDiagnosticsController";
import type {
  LiveStatusResource,
  SimulationPreparationResource,
} from "../api/apiTypes";
import { CommandDiagnosticsController } from "../commands/CommandDiagnosticsController";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { KernelContext } from "../KernelContext";
import { ModuleRegistry } from "../module/ModuleRegistry";
import { DiagnosticRecorderController } from "../performance/diagnostic-recorder/DiagnosticRecorderController";
import {
  realtimeCommunicationPolicy,
  updateRealtimeCommunicationPolicy,
} from "../realtime/communicationPolicy";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import { RealtimeConnectionController } from "../realtime/RealtimeConnectionController";
import { sessionScopedResourceKey } from "../resources/sessionResourceIdentity";
import {
  resetSharedResourceRuntimeStoreForTests,
  sharedResourceRuntimeStore,
} from "../resources/ResourceRuntimeStore";
import type { ResourceResult } from "../resources/resourceTypes";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";
import type { KernelApi } from "../types";
import { LayoutController } from "./LayoutController";
import { SimulationPreparationLog } from "./SimulationPreparationLog";
import { simulationPreparationWindow } from "./simulationPreparationWindow";
import {
  SimulationStartupOverlay,
  SimulationStartupOverlayView,
  type SimulationStartupOverlayState,
} from "./SimulationStartupOverlay";
import {
  resolveSimulationPreparationViewModel,
  type SimulationPreparationLogEntryView,
} from "./simulationPreparationModel";
import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
} from "./simulationPreparationTestDom.test-support";
import { footerManifest } from "../../modules/footer/manifest";
import { SlotHost } from "./SlotHost";
import { DraggablePanel } from "@/shared/ui/DraggablePanel";

vi.mock("@/shared/ui/Dialog", async () => {
  const React = await import("react");
  const DialogContext = React.createContext<{
    onOpenChange: (open: boolean) => void;
    open: boolean;
  }>({
    onOpenChange: (_open: boolean) => undefined,
    open: false,
  });

  return {
    Dialog: ({
      children,
      onOpenChange,
      open,
    }: {
      children: ReactNode;
      onOpenChange: (open: boolean) => void;
      open: boolean;
    }) => (
      <DialogContext.Provider value={{ onOpenChange, open }}>
        {children}
      </DialogContext.Provider>
    ),
    DialogClose: ({
      asChild: _asChild,
      children,
    }: {
      asChild?: boolean;
      children: ReactElement<{ onClick?: () => void }>;
    }) => {
      const context = React.useContext(DialogContext);
      return React.cloneElement(children, {
        onClick: () => {
          children.props.onClick?.();
          context.onOpenChange(false);
        },
      });
    },
    DialogContent: ({
      children,
      ...props
    }: ComponentProps<"section">) => {
      const context = React.useContext(DialogContext);
      return context.open ? (
        <section role="dialog" {...props}>
          {children}
        </section>
      ) : null;
    },
    DialogDescription: (props: ComponentProps<"p">) => <p {...props} />,
    DialogFooter: (props: ComponentProps<"div">) => <div {...props} />,
    DialogHeader: (props: ComponentProps<"div">) => <div {...props} />,
    DialogTitle: (props: ComponentProps<"h2">) => <h2 {...props} />,
  };
});

const SIMULATION_PREPARATION_TEST_RESOURCE_KEY = sessionScopedResourceKey(
  {
    requestScopeEpoch: "api-instance:preparation-test",
    sessionEpoch: "session-preparation-test@1700000000000",
    sessionId: "session-preparation-test",
  },
  SIMULATION_PREPARATION_PATH,
);

interface Deferred<TData> {
  readonly promise: Promise<TData>;
  readonly resolve: (value: TData) => void;
}

afterEach(() => {
  updateRealtimeCommunicationPolicy({});
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSharedResourceRuntimeStoreForTests();
  simulationPreparationWindow.resetForTests();
});

describe("mounted simulation preparation UI", () => {
  it("reflects draggable panel data attributes through the test DOM dataset", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        <DraggablePanel
          open
          maximizable
          onOpenChange={vi.fn()}
          title="Layout probe"
        >
          Probe
        </DraggablePanel>,
      );
    });
    const panel = findElement(
      container,
      (element) => hasClass(element, "fm-draggable-panel"),
      "draggable panel",
    );
    expect(panel.dataset.maximized).toBe("false");

    await act(async () => findButton(container, "Maximize window").click());
    expect(panel.dataset.maximized).toBe("true");

    await act(async () => root.unmount());
    dom.restore();
  });

  it("mounts the editable workspace while the first preparation resources are loading", async () => {
    const dom = installSimulationPreparationTestDom();
    const pendingStatus = deferred<LiveStatusResource>();
    const pendingPreparation = deferred<SimulationPreparationResource>();
    const { kernel } = makeKernel({
      loadPreparation: () => pendingPreparation.promise,
      loadStatus: () => pendingStatus.promise,
    });
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <MountedWorkspace />
        </KernelContext.Provider>,
      );
    });

    const workspace = findElement(
      container,
      (element) => element.getAttribute("data-slot-id") === "viewport-main",
      "initial workspace viewport",
    );
    const status = findElement(
      container,
      (element) => hasClass(element, "fm-simulation-startup"),
      "initial preparation status",
    );
    expect(container.textContent).toContain("Viewport module");
    expect(status.getAttribute("data-state")).toBe("connecting");
    expect(workspace.hasAttribute("inert")).toBe(false);
    expect(workspace.hasAttribute("aria-hidden")).toBe(false);

    await act(async () => root.unmount());
    dom.restore();
  });

  it("releases a ready restored session with revision zero and a missing preparation route", async () => {
    vi.useFakeTimers();
    const dom = installSimulationPreparationTestDom();
    const { kernel, resources } = makeKernel({
      loadPreparation: async () => {
        throw new ControlRoomApiError("preparation not found", 404);
      },
      loadStatus: async () =>
        statusFixture({ preparationRevision: 0, solverState: "awaiting_command" }),
    });
    resources.invalidate(SESSION_STATUS_RESOURCE_KEY, 0);
    resources.invalidate(SIMULATION_PREPARATION_PATH, 0);
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <MountedWorkspace />
        </KernelContext.Provider>,
      );
    });
    await settleLoads();

    expect(container.textContent).toContain("Viewport module");
    expect(container.textContent).not.toContain("Preparing simulation");

    await act(async () => root.unmount());
    dom.restore();
  });

  it("preserves the editable workspace through pending, reconnecting, and failure states", async () => {
    const dom = installSimulationPreparationTestDom();
    const { kernel } = makeKernel({
      loadPreparation: async () => preparationFixture(),
      loadStatus: async () => statusFixture(),
    });
    const readyPreparation: SimulationPreparationResource = {
      ...preparationFixture(),
      active_stage_id: null,
      completed_at_unix_ms: 20_000,
      status: "ready",
    };
    const readyState = resolveSimulationPreparationViewModel(
      resource(readyPreparation),
      resource(statusFixture({ solverState: "awaiting_command" })),
      20_000,
    );
    const pendingState = resolveSimulationPreparationViewModel(
      resource(preparationFixture()),
      resource(statusFixture()),
      20_000,
    );
    const reconnectingState = resolveSimulationPreparationViewModel(
      { ...resource(preparationFixture()), status: "stale" },
      { ...resource(statusFixture()), status: "stale" },
      20_000,
      true,
    );
    const failedState = resolveSimulationPreparationViewModel(
      resource(failedPreparationFixture()),
      resource(statusFixture({ solverState: "failed" })),
      20_000,
    );
    expect(readyState.isVisible).toBe(false);
    expect(pendingState.isVisible).toBe(true);
    expect(reconnectingState.kind).toBe("stale");
    expect(failedState.kind).toBe("failed");

    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <TransitionWorkspace state={readyState} />
        </KernelContext.Provider>,
      );
    });
    const mountedProbe = findElement(
      container,
      (element) => element.getAttribute("data-workspace-probe") === "mounted",
      "mounted workspace probe",
    );
    const draft = findElement(
      mountedProbe,
      (element) => element.tagName === "INPUT",
      "workspace draft input",
    );
    draft.value = "unsaved inspector draft";
    draft.focus();

    for (const [state, label] of [
      [pendingState, "pending preparation"],
      [reconnectingState, "reconnecting preparation"],
      [failedState, "failed preparation"],
      [readyState, "ready preparation recovery"],
    ] as const) {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <TransitionWorkspace state={state} />
          </KernelContext.Provider>,
        );
      });
      expect(
        findElement(
          container,
          (element) =>
            element.getAttribute("data-workspace-probe") === "mounted",
          `${label} workspace probe`,
        ),
      ).toBe(mountedProbe);
      expect(draft.value).toBe("unsaved inspector draft");
      expect(dom.document.activeElement).toBe(draft);
      if (state.kind === "failed") {
        expect(
          findElement(
            container,
            (element) => hasClass(element, "fm-simulation-startup"),
            "failure status during workspace preservation",
          ).getAttribute("data-state"),
        ).toBe("failed");
      }
    }

    await act(async () => root.unmount());
    dom.restore();
  });

  it("closes on completion and reopens the finished preparation from the status bar store", async () => {
    const dom = installSimulationPreparationTestDom();
    const { kernel } = makeKernel({
      loadPreparation: async () => preparationFixture(),
      loadStatus: async () => statusFixture(),
    });
    const readyPreparation: SimulationPreparationResource = {
      ...preparationFixture(),
      active_stage_id: null,
      completed_at_unix_ms: 20_000,
      status: "ready",
    };
    const pendingState = resolveSimulationPreparationViewModel(
      resource(preparationFixture()),
      resource(statusFixture()),
      20_000,
    );
    const readyState = resolveSimulationPreparationViewModel(
      resource(readyPreparation),
      resource(statusFixture({ solverState: "awaiting_command" })),
      20_000,
    );
    const disruptedReadyState = resolveSimulationPreparationViewModel(
      { ...resource(readyPreparation), status: "stale" },
      { ...resource(statusFixture({ solverState: "awaiting_command" })), status: "stale" },
      20_000,
      true,
    );
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const render = async (state: SimulationStartupOverlayState) => {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <TransitionWorkspace state={state} />
          </KernelContext.Provider>,
        );
      });
    };
    const windowHidden = () =>
      findElement(
        container,
        (element) => element.getAttribute("aria-label") === "Simulation preparation window",
        "preparation window",
      ).hasAttribute("hidden");
    const restoreButtons = () =>
      findElements(container, (element) => element.hasAttribute("data-preparation-restore"));

    await render(pendingState);
    expect(windowHidden()).toBe(false);
    expect(simulationPreparationWindow.getSnapshot().summary?.tone).toBe("running");

    // Minimizing records a user mode; completion still closes the window.
    await act(async () => {
      findElement(
        container,
        (element) => element.getAttribute("aria-label") === "Minimize simulation preparation",
        "minimize button",
      ).click();
    });
    expect(restoreButtons()).toHaveLength(1);
    await render(readyState);
    expect(windowHidden()).toBe(true);
    expect(restoreButtons()).toHaveLength(0);
    expect(simulationPreparationWindow.getSnapshot().summary).toMatchObject({
      label: "Ready",
      tone: "ready",
    });

    await render(disruptedReadyState);
    expect(windowHidden()).toBe(true);

    await act(async () => simulationPreparationWindow.open());
    expect(windowHidden()).toBe(false);
    expect(container.textContent).toContain("Simulation ready");
    await render(readyState);
    expect(windowHidden()).toBe(false);

    await act(async () => root.unmount());
    expect(simulationPreparationWindow.getSnapshot().summary).toBeNull();
    dom.restore();
  });

  it("keeps a no-data preparation facade error visible and actionable", async () => {
    vi.useFakeTimers();
    const dom = installSimulationPreparationTestDom();
    const { kernel, resources } = makeKernel({
      loadPreparation: async () => {
        throw new ControlRoomApiError("private path /private/model.py failed", 500);
      },
      loadStatus: async () =>
        statusFixture({ preparationRevision: 1, solverState: "awaiting_command" }),
    });
    resources.invalidate(SESSION_STATUS_RESOURCE_KEY, 1);
    resources.invalidate(SIMULATION_PREPARATION_PATH, 1);
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <MountedWorkspace />
        </KernelContext.Provider>,
      );
    });
    await settleLoads();

    expect(container.textContent).toContain("Preparation status unavailable");
    expect(container.textContent).toContain(
      "The local runtime could not provide simulation preparation status.",
    );
    expect(container.textContent).not.toContain("/private/model.py");
    expect(container.textContent).toContain("Viewport module");
    await act(async () => findButton(container, "View failure details").click());
    expect(findButton(container, "Open full diagnostics")).toBeTruthy();

    await act(async () => root.unmount());
    dom.restore();
  });

  it("preserves scrolled-up logs, follows the live tail, and returns by control click", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const first = logEntries(2);

    await act(async () => {
      root.render(<SimulationPreparationLog entries={first} />);
    });
    const viewport = findElement(
      container,
      (element) => hasClass(element, "fm-scroll-area__viewport"),
      "preparation log viewport",
    );
    viewport.clientHeight = 100;
    viewport.scrollHeight = 300;
    viewport.scrollTop = 200;
    await act(async () => {
      viewport.dispatchEvent(new TestEvent("scroll"));
    });

    viewport.scrollHeight = 360;
    await act(async () => {
      root.render(<SimulationPreparationLog entries={logEntries(3)} />);
    });
    expect(viewport.scrollTop).toBe(360);

    viewport.scrollTop = 120;
    await act(async () => {
      viewport.dispatchEvent(new TestEvent("scroll"));
    });
    viewport.scrollHeight = 420;
    await act(async () => {
      root.render(<SimulationPreparationLog entries={logEntries(4)} />);
    });
    expect(viewport.scrollTop).toBe(120);

    const returnToTail = findButton(container, "New entries");
    await act(async () => returnToTail.click());
    expect(viewport.scrollTop).toBe(420);
    expect(container.textContent).not.toContain("New entries");

    await act(async () => root.unmount());
    dom.restore();
  });

  it("copies the bounded projection and navigates through the real kernel event bus", async () => {
    const clipboardWrite = vi.fn<(text: string) => Promise<void>>();
    clipboardWrite.mockResolvedValue(undefined);
    const dom = installSimulationPreparationTestDom({
      clipboard: { writeText: clipboardWrite },
    });
    const { kernel, bus, layout } = makeKernel({
      loadPreparation: async () => preparationFixture(),
      loadStatus: async () => statusFixture(),
    });
    const events: KernelEventMap["footer:tab-requested"][] = [];
    const unsubscribe = bus.on("footer:tab-requested", (event) => {
      events.push(event);
    });
    const unsafe = {
      ...failedPreparationFixture(),
      host_path: "/private/model.py",
      secret: "secret-token",
      log_tail: Array.from({ length: 205 }, (_, index) => ({
        level: "info" as const,
        message: `safe entry ${index}`,
        stage_id: "meshing" as const,
        timestamp_unix_ms: index,
      })),
    };
    const model = resolveSimulationPreparationViewModel(
      resource(unsafe),
      resource(statusFixture()),
      20_000,
    );
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <SimulationStartupOverlayView state={model} />
        </KernelContext.Provider>,
      );
    });
    await act(async () => findButton(container, "View failure details").click());
    expect(findButton(container, "View error details")).toBeTruthy();

    await act(async () => {
      findButton(container, "Copy diagnostics").click();
      await Promise.resolve();
    });
    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    const copied = clipboardWrite.mock.calls[0]?.[0] ?? "";
    const projection = JSON.parse(copied) as { log_tail: unknown[] };
    expect(projection.log_tail).toHaveLength(200);
    expect(copied).not.toContain("secret-token");
    expect(copied).not.toContain("/private/model.py");

    await act(async () => findButton(container, "Open full diagnostics").click());
    expect(events).toEqual([
      { reason: "simulation-preparation", tab: "diagnostics" },
    ]);
    expect(layout.get().panelVisible.bottom).toBe(true);
    expect(layout.get().focusedSlot).toBe("panel-bottom");

    unsubscribe();
    await act(async () => root.unmount());
    dom.restore();
  });

  it("opens failure details only after an explicit action and allows manual reopen", async () => {
    const clipboardWrite = vi.fn<(text: string) => Promise<void>>();
    clipboardWrite.mockResolvedValue(undefined);
    const dom = installSimulationPreparationTestDom({
      clipboard: { writeText: clipboardWrite },
    });
    const { kernel } = makeKernel({
      loadPreparation: async () => preparationFixture(),
      loadStatus: async () => statusFixture(),
    });
    const unsafe = {
      ...failedPreparationFixture(),
      host_path: "/private/modal.py",
      log_tail: Array.from({ length: 205 }, (_, index) => ({
        level: "info" as const,
        message: `modal log entry ${index}`,
        stage_id: "meshing" as const,
        timestamp_unix_ms: index,
      })),
      secret: "modal-secret-token",
    };
    const model = resolveSimulationPreparationViewModel(
      resource(unsafe),
      resource(statusFixture()),
      20_000,
    );
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <SimulationStartupOverlayView state={model} />
        </KernelContext.Provider>,
      );
      await Promise.resolve();
    });
    await settleDialog();

    expect(findDialogs(dom.document.body)).toHaveLength(0);
    expect(container.textContent).toContain("Simulation preparation failed");

    await act(async () => findButton(container, "View failure details").click());
    await act(async () => findButton(container, "View error details").click());
    const dialogs = findDialogs(dom.document.body);
    expect(dialogs).toHaveLength(1);
    expect(dom.document.body.textContent).toContain(
      "What happened",
    );
    expect(dom.document.body.textContent).toContain("How to fix");
    expect(dom.document.body.textContent).toContain("Technical diagnostics");
    expect(dom.document.body.textContent).toContain("gpu_dmi_kernel_not_mixed_p1");
    expect(dom.document.body.textContent).toContain("FEM CPU");
    expect(dom.document.body.textContent).toContain("mesh_generation_failed");
    expect(dom.document.body.textContent).toContain("diag-42");
    expect(dom.document.body.textContent).toContain("16.2s");
    expect(dom.document.body.textContent).toContain(
      "Predicate analysis was truncated. See the collapsed Full diagnostic report for complete details.",
    );
    expect(dom.document.body.textContent).not.toContain(
      "additional predicate(s) are omitted",
    );
    expect(dom.document.body.textContent).toContain("Requested execution");
    expect(dom.document.body.textContent).toContain(
      "fem · gpu · double · strict · mfem",
    );
    expect(dom.document.body.textContent).toContain("Resolved execution");
    expect(dom.document.body.textContent).toContain(
      "fem · cpu · double · strict · mfem",
    );
    expect(findButton(dom.document.body, "Copy full diagnostic report")).toBeTruthy();
    const fullReport = findElement(
      dom.document.body,
      (element) =>
        element.tagName === "DETAILS" &&
        element.textContent.includes("Full diagnostic report"),
      "full diagnostic report",
    );
    expect(fullReport.hasAttribute("open")).toBe(false);
    expect(fullReport.textContent).toContain("Full diagnostic report");
    const fullReportSummary = findElement(
      fullReport,
      (element) => element.tagName === "SUMMARY",
      "full diagnostic report summary",
    );
    await act(async () => fullReportSummary.click());
    expect(fullReport.hasAttribute("open")).toBe(true);

    await act(async () => findButton(dom.document.body, "Close").click());
    expect(findDialogs(dom.document.body)).toHaveLength(0);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <SimulationStartupOverlayView state={model} />
        </KernelContext.Provider>,
      );
      await Promise.resolve();
    });
    expect(findDialogs(dom.document.body)).toHaveLength(0);

    await act(async () => findButton(container, "View error details").click());
    expect(findDialogs(dom.document.body)).toHaveLength(1);

    await act(async () => {
      findButton(dom.document.body, "Copy full diagnostic report").click();
      await Promise.resolve();
    });
    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    const copied = clipboardWrite.mock.calls[0]?.[0] ?? "";
    const report = JSON.parse(copied) as {
      failure: { diagnostics_correlation_id: string | null } | null;
      log_tail: unknown[];
      requested_execution: Record<string, unknown>;
      resolved_execution: Record<string, unknown> | null;
      stages: unknown[];
    };
    expect(report.failure?.diagnostics_correlation_id).toBe("diag-42");
    expect(report.stages).toHaveLength(9);
    expect(report.log_tail).toHaveLength(200);
    expect(report.requested_execution).toMatchObject({
      backend: "fem",
      device: "gpu",
      precision: "double",
    });
    expect(report.resolved_execution).toMatchObject({
      backend: "fem",
      device: "cpu",
      precision: "double",
    });
    expect(copied).not.toContain("/private/modal.py");
    expect(copied).not.toContain("modal-secret-token");
    expect(dom.document.body.textContent).toContain(
      "Diagnostic report copied to clipboard.",
    );
    expect(findButton(dom.document.body, "Copy again")).toBeTruthy();

    await act(async () => findButton(dom.document.body, "Close").click());
    const nextFailure = {
      ...failedPreparationFixture(),
      revision: 9,
    };
    const nextModel = resolveSimulationPreparationViewModel(
      resource(nextFailure),
      resource(statusFixture({ preparationRevision: 9 })),
      21_000,
    );
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <SimulationStartupOverlayView state={nextModel} />
        </KernelContext.Provider>,
      );
    });
    expect(findDialogs(dom.document.body)).toHaveLength(0);
    await act(async () => findButton(container, "View error details").click());
    expect(findDialogs(dom.document.body)).toHaveLength(1);

    await act(async () => root.unmount());
    dom.restore();
  });

  it("reports the exact omitted predicate count without a second truncation message", async () => {
    const dom = installSimulationPreparationTestDom();
    const { kernel } = makeKernel({
      loadPreparation: async () => preparationFixture(),
      loadStatus: async () => statusFixture(),
    });
    const snapshot = failedPreparationFixture();
    const model = resolveSimulationPreparationViewModel(
      resource({
        ...snapshot,
        failure: {
          ...snapshot.failure!,
          detail: predicateDetail(34),
        },
      }),
      resource(statusFixture()),
      20_000,
    );
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <SimulationStartupOverlayView state={model} />
        </KernelContext.Provider>,
      );
      await Promise.resolve();
    });
    await settleDialog();

    await act(async () => findButton(container, "View failure details").click());
    await act(async () => findButton(container, "View error details").click());
    await settleDialog();

    const countMessage =
      "2 predicate(s) were omitted from the analysis. See the collapsed Full diagnostic report for complete details.";
    expect(dom.document.body.textContent).toContain(countMessage);
    expect(dom.document.body.textContent.split(countMessage)).toHaveLength(2);
    expect(dom.document.body.textContent).not.toContain(
      "Predicate analysis was truncated.",
    );

    await act(async () => root.unmount());
    dom.restore();
  });

  it("reports clipboard failure accessibly and keeps copy retryable", async () => {
    const clipboardWrite = vi.fn<(text: string) => Promise<void>>();
    clipboardWrite.mockRejectedValue(new Error("clipboard unavailable"));
    const dom = installSimulationPreparationTestDom({
      clipboard: { writeText: clipboardWrite },
    });
    const { kernel } = makeKernel({
      loadPreparation: async () => preparationFixture(),
      loadStatus: async () => statusFixture(),
    });
    const model = resolveSimulationPreparationViewModel(
      resource(failedPreparationFixture()),
      resource(statusFixture()),
      20_000,
    );
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <SimulationStartupOverlayView state={model} />
        </KernelContext.Provider>,
      );
      await Promise.resolve();
    });
    await settleDialog();
    await act(async () => findButton(container, "View failure details").click());
    await act(async () => findButton(container, "View error details").click());
    await settleDialog();
    await act(async () => {
      findButton(container, "Copy full diagnostic report").click();
      await Promise.resolve();
    });

    expect(dom.document.body.textContent).toContain(
      "Could not copy diagnostic report. Try again.",
    );
    await act(async () => {
      findButton(dom.document.body, "Retry copy").click();
      await Promise.resolve();
    });
    expect(clipboardWrite).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
    dom.restore();
  });

  it("opens the mounted production diagnostics consumer beside the workspace", async () => {
    const dom = installSimulationPreparationTestDom();
    const { kernel } = makeKernel({
      loadPreparation: async () => preparationFixture(),
      loadStatus: async () => statusFixture(),
    });
    const model = resolveSimulationPreparationViewModel(
      resource(failedPreparationFixture()),
      resource(statusFixture()),
      20_000,
    );
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <>
            <div data-slot-id="viewport-main">Viewport module</div>
            <SimulationStartupOverlayView state={model} />
            <SlotHost slotId="panel-bottom" />
          </>
        </KernelContext.Provider>,
      );
    });
    expect(container.textContent).not.toContain("Recording");
    await act(async () => findButton(container, "View failure details").click());
    await act(async () => findButton(container, "Open full diagnostics").click());
    expect(kernel.layout.get().activeBottomPanelTab).toBe("diagnostics");
    await settleMountedModule();

    expect(container.textContent).toContain("Simulation preparation failed");
    expect(container.textContent).toContain("Recording");
    expect(container.textContent).not.toContain("failed to mount");
    expect(
      findElement(
        container,
        (element) => element.getAttribute("aria-label") === "Bottom diagnostics",
        "Bottom diagnostics tabs",
      ),
    ).toBeTruthy();
    expect(container.textContent).toContain("Viewport module");

    await act(async () => root.unmount());
    dom.restore();
  }, 15_000);

  it("keeps routine polling quiet and follows an advanced status pointer through HTTP", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    expect(realtimeCommunicationPolicy().statusRefreshMs).toBe(5_000);
    const dom = installSimulationPreparationTestDom();
    const pendingStatus = deferred<LiveStatusResource>();
    const pendingPreparation = deferred<SimulationPreparationResource>();
    const loadStatus = vi
      .fn()
      .mockResolvedValueOnce(statusFixture())
      .mockImplementation(() => pendingStatus.promise);
    const loadPreparation = vi
      .fn()
      .mockResolvedValueOnce(preparationFixture())
      .mockImplementation(() => pendingPreparation.promise);
    const { kernel, resources } = makeKernel({ loadPreparation, loadStatus });
    resources.invalidate(SESSION_STATUS_RESOURCE_KEY, 7);
    resources.invalidate(SIMULATION_PREPARATION_PATH, 7);
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <SimulationStartupOverlay />
        </KernelContext.Provider>,
      );
    });
    await settleLoads();
    expect(container.textContent).toContain("meshing");
    expect(container.textContent).not.toContain("Reconnecting…");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await settleLoads();
    expect(loadStatus).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Reconnecting…");

    await act(async () => {
      pendingStatus.resolve(statusFixture({ preparationRevision: 8 }));
      await pendingStatus.promise;
      await vi.advanceTimersByTimeAsync(0);
    });
    await settleLoads();
    expect(loadPreparation).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Reconnecting…");
    expect(container.textContent).toContain("Optimizing element quality");

    await act(async () => root.unmount());
    dom.restore();
  });

  it("marks retained preparation stale through an actual connection disruption", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const dom = installSimulationPreparationTestDom();
    const { kernel, realtimeConnection, resources } = makeKernel({
      loadPreparation: async () => preparationFixture(),
      loadStatus: async () => statusFixture(),
    });
    resources.invalidate(SESSION_STATUS_RESOURCE_KEY, 7);
    resources.invalidate(SIMULATION_PREPARATION_PATH, 7);
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <SimulationStartupOverlay />
        </KernelContext.Provider>,
      );
    });
    await settleLoads();
    expect(container.textContent).not.toContain("Reconnecting…");

    await act(async () => realtimeConnection.update("connected"));
    expect(container.textContent).not.toContain("Reconnecting…");

    await act(async () => realtimeConnection.update("disconnected"));
    expect(container.textContent).toContain("Reconnecting…");
    expect(container.textContent).toContain(
      "Displayed progress may be out of date.",
    );
    expect(container.textContent).toContain("Optimizing element quality");

    await act(async () => realtimeConnection.update("connecting"));
    expect(container.textContent).toContain("Reconnecting…");

    await act(async () => realtimeConnection.update("connected"));
    expect(container.textContent).not.toContain("Reconnecting…");

    await act(async () => root.unmount());
    dom.restore();
  });

  it("keeps the polite summary stable and stops display ticks at terminal state and unmount", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const dom = installSimulationPreparationTestDom();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const { kernel, resources } = makeKernel({
      loadPreparation: async () => preparationFixture(),
      loadStatus: async () => statusFixture(),
    });
    resources.invalidate(SESSION_STATUS_RESOURCE_KEY, 7);
    resources.invalidate(SIMULATION_PREPARATION_PATH, 7);
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <SimulationStartupOverlay />
        </KernelContext.Provider>,
      );
    });
    await settleLoads();
    const liveBefore = findLiveSummary(container).textContent;
    expect(displayTimeoutCalls(setTimeoutSpy)).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(findLiveSummary(container).textContent).toBe(liveBefore);
    const displayTimerBeforeTerminal = latestDisplayTimer(setTimeoutSpy);
    const callsBeforeTerminal = displayTimeoutCalls(setTimeoutSpy);

    await act(async () => {
      sharedResourceRuntimeStore.updateData(
        SIMULATION_PREPARATION_TEST_RESOURCE_KEY,
        failedPreparationFixture(),
        8,
      );
    });
    expect(container.textContent).toContain("Simulation preparation failed");
    expect(clearTimeoutSpy).toHaveBeenCalledWith(displayTimerBeforeTerminal);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(displayTimeoutCalls(setTimeoutSpy)).toBe(callsBeforeTerminal);

    await act(async () => {
      sharedResourceRuntimeStore.updateData(
        SIMULATION_PREPARATION_TEST_RESOURCE_KEY,
        { ...preparationFixture(), revision: 9 },
        9,
      );
    });
    expect(displayTimeoutCalls(setTimeoutSpy)).toBeGreaterThan(
      callsBeforeTerminal,
    );
    const displayTimerBeforeUnmount = latestDisplayTimer(setTimeoutSpy);
    await act(async () => root.unmount());
    expect(clearTimeoutSpy).toHaveBeenCalledWith(displayTimerBeforeUnmount);
    dom.restore();
  });

  it("keeps retry identity across indeterminate heartbeat refreshes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const dom = installSimulationPreparationTestDom();
    const { kernel, resources } = makeKernel({
      loadPreparation: async () => preparationFixture(),
      loadStatus: async () => statusFixture(),
    });
    resources.invalidate(SESSION_STATUS_RESOURCE_KEY, 7);
    resources.invalidate(SIMULATION_PREPARATION_PATH, 7);
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <SimulationStartupOverlay />
        </KernelContext.Provider>,
      );
    });
    await settleLoads();
    expect(container.textContent).toContain("63%");

    await act(async () => {
      sharedResourceRuntimeStore.updateData(
        SIMULATION_PREPARATION_TEST_RESOURCE_KEY,
        attemptPreparationFixture(8, "Attempt 2 — HXT — progress indeterminate", 20_000),
        8,
      );
    });
    expect(container.textContent).toContain("Attempt 2 — HXT — progress indeterminate");
    expect(container.textContent).not.toContain("63%");
    expect(
      findElement(
        container,
        (element) => element.getAttribute("data-kind") === "indeterminate",
        "Indeterminate mesh progress",
      ).getAttribute("aria-valuenow"),
    ).toBeNull();

    await act(async () => {
      sharedResourceRuntimeStore.updateData(
        SIMULATION_PREPARATION_TEST_RESOURCE_KEY,
        attemptPreparationFixture(9, "Attempt 2 — HXT — progress indeterminate", 35_000),
        9,
      );
    });
    expect(container.textContent).toContain("Attempt 2 — HXT — progress indeterminate");

    await act(async () => {
      sharedResourceRuntimeStore.updateData(
        SIMULATION_PREPARATION_TEST_RESOURCE_KEY,
        attemptPreparationFixture(
          10,
          "Attempt 3 — Frontal — progress indeterminate",
          50_000,
        ),
        10,
      );
    });
    expect(container.textContent).toContain("Attempt 3 — Frontal — progress indeterminate");
    expect(container.textContent).not.toContain("Attempt 2 — HXT — progress indeterminate");
    expect(container.textContent).not.toContain("63%");

    await act(async () => root.unmount());
    dom.restore();
  });
});

function resource<TData>(data: TData): ResourceResult<TData> {
  return {
    data,
    error: null,
    refetch: vi.fn(),
    revision: 7,
    status: "ready",
  };
}

function preparationFixture(): SimulationPreparationResource {
  const ids = [
    "runtime_startup",
    "script_materialization",
    "validation",
    "planning",
    "domain_preparation",
    "meshing",
    "mesh_postprocessing",
    "solver_initialization",
    "ready",
  ] as const;
  return {
    active_stage_id: "meshing",
    completed_at_unix_ms: null,
    failure: null,
    log_tail: [
      {
        level: "info",
        message: "Optimizing element quality",
        stage_id: "meshing",
        timestamp_unix_ms: 19_500,
      },
    ],
    preparation_id: "prep-7",
    requested_execution: {
      backend: "fem",
      device: "gpu",
      engine_id: "mfem",
      mode: "strict",
      precision: "double",
      runtime_family: "managed",
      worker: "gpu-worker",
    },
    resolved_execution: {
      backend: "fem",
      device: "cpu",
      engine_id: "mfem",
      mode: "strict",
      precision: "double",
      runtime_family: "managed",
      worker: "cpu-worker",
    },
    revision: 7,
    stages: ids.map((id, index) => ({
      completed_at_unix_ms: index < 5 ? 2_500 : null,
      detail: id === "meshing" ? "Optimizing element quality" : "",
      duration_ms: index < 5 ? 500 : id === "meshing" ? 16_200 : null,
      id,
      label: id.replaceAll("_", " "),
      progress_label: id === "meshing" ? "63 / 100 elements" : null,
      progress_percent: id === "meshing" ? 63 : null,
      started_at_unix_ms: id === "meshing" ? 3_800 : null,
      status:
        index < 5 ? "completed" : id === "meshing" ? "active" : "pending",
    })),
    started_at_unix_ms: 1_000,
    status: "running",
  };
}

function failedPreparationFixture(): SimulationPreparationResource {
  const snapshot = preparationFixture();
  return {
    ...snapshot,
    active_stage_id: null,
    failure: {
      diagnostics_correlation_id: "diag-42",
      detail: `failed_predicates=[gpu_dmi_kernel_not_mixed_p1, ${"long_unknown_predicate_".repeat(12)}]`,
      error_code: "mesh_generation_failed",
      stage_id: "meshing",
      summary: "Mesh generation did not converge.",
    },
    revision: 8,
    stages: snapshot.stages.map((stage) =>
      stage.id === "meshing"
        ? { ...stage, progress_percent: null, status: "failed" }
        : stage,
    ),
    status: "failed",
  };
}

function predicateDetail(count: number): string {
  return `failed_predicates=[${Array.from(
    { length: count },
    (_, index) =>
      index === 0 ? "gpu_dmi_kernel_not_mixed_p1" : `unknown_predicate_${index}`,
  ).join(", ")}]`;
}

function attemptPreparationFixture(
  revision: number,
  progressLabel: string,
  durationMs: number,
): SimulationPreparationResource {
  const snapshot = preparationFixture();
  return {
    ...snapshot,
    revision,
    stages: snapshot.stages.map((stage) =>
      stage.id === "meshing"
        ? {
            ...stage,
            duration_ms: durationMs,
            progress_label: progressLabel,
            progress_percent: null,
          }
        : stage,
    ),
  };
}

function statusFixture(
  patch: {
    preparationRevision?: number;
    solverState?: string;
  } = {},
): LiveStatusResource {
  return {
    domain: {
      cell_count: 0,
      discretization: "fem",
      generation_id: "fem:unmaterialized",
    },
    resources: {
      simulation_preparation_revision: patch.preparationRevision ?? 7,
    },
    session: {
      name: "permalloy-relaxation",
      session_id: "session-preparation-test",
      session_epoch: "session-preparation-test@1700000000000",
      request_scope_epoch: "api-instance:preparation-test",
    },
    lifecycle: {
      commandability: "allowed",
      connectivity: "connected",
      session_resource: "active",
      solver: "idle",
    },
    metrics: { steps_per_second: 0, total_steps: 0 },
    solver: { state: patch.solverState ?? "bootstrapping" },
  } as LiveStatusResource;
}

function MountedWorkspace() {
  return (
    <>
      <div data-slot-id="viewport-main">Viewport module</div>
      <SimulationStartupOverlay />
    </>
  );
}

function TransitionWorkspace({
  state,
}: {
  readonly state: SimulationStartupOverlayState;
}) {
  return (
    <>
      <div data-workspace-probe="mounted">
        <input aria-label="Workspace draft" />
        Workspace module
      </div>
      <SimulationStartupOverlayView state={state} />
    </>
  );
}

function logEntries(count: number): SimulationPreparationLogEntryView[] {
  return Array.from({ length: count }, (_, index) => ({
    level: "info" as const,
    message: `entry ${index + 1}`,
    stageLabel: "Meshing",
    timestampLabel: `00:00:${String(index + 1).padStart(2, "0")}.000`,
  }));
}

function makeKernel({
  loadPreparation,
  loadStatus,
}: {
  loadPreparation: () => Promise<SimulationPreparationResource>;
  loadStatus: () => Promise<LiveStatusResource>;
}): {
  bus: EventBus<KernelEventMap>;
  kernel: KernelApi;
  layout: LayoutController;
  resources: ResourceInvalidationController;
  realtimeConnection: RealtimeConnectionController;
} {
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  const layout = new LayoutController(bus);
  const realtimeConnection = new RealtimeConnectionController();
  const modules = new ModuleRegistry();
  modules.register(footerManifest);
  const kernel = {
    api: {
      sessions: {
        current: { status: loadStatus },
        // Session identity is confirmed against the session collection.
        list: vi.fn(async () => ({
          schema_version: "2.0.0",
          sessions: [
            {
              current: true,
              name: "preparation test",
              session_id: "session-preparation-test",
              status: "running",
            },
          ],
        })),
      },
      simulation: { preparation: loadPreparation },
    },
    bus,
    commandDiagnostics: new CommandDiagnosticsController(),
    diagnostics: new RequestDiagnosticsController(),
    diagnosticRecorder: new DiagnosticRecorderController({
      config: { enabled: false },
    }),
    layout,
    modules,
    realtimeConnection,
    resources,
  } as unknown as KernelApi;
  return { bus, kernel, layout, realtimeConnection, resources };
}

async function settleDialog(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function settleMountedModule(): Promise<void> {
  await act(async () => {
    await footerManifest.component();
  });
  for (let index = 0; index < 8; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function deferred<TData>(): Deferred<TData> {
  let resolve!: (value: TData) => void;
  const promise = new Promise<TData>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function settleLoads(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });
  }
  await act(async () => {
    // Status identity enables scoped hooks in a later React commit; advance the
    // fake clock once so their zero-delay load runs at the browser timer floor.
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
  });
}

function hasClass(element: TestElement, className: string): boolean {
  return (element.getAttribute("class") ?? "").split(/\s+/).includes(className);
}

function findButton(container: TestElement, name: string): TestElement {
  return findElement(
    container,
    (element) =>
      element.tagName === "BUTTON" &&
      (element.getAttribute("aria-label") === name ||
        element.textContent.includes(name)),
    `Button ${name}`,
  );
}

function findDialogs(container: TestElement): TestElement[] {
  return findElements(
    container,
    (element) => element.getAttribute("role") === "dialog",
  );
}

function findLiveSummary(container: TestElement): TestElement {
  return findElement(
    container,
    (element) => element.getAttribute("aria-live") === "polite",
    "polite preparation summary",
  );
}

interface TimeoutSpyView {
  readonly mock: {
    readonly calls: readonly (readonly unknown[])[];
    readonly results: readonly { readonly value: unknown }[];
  };
}

function displayTimeoutCalls(spy: TimeoutSpyView): number {
  return spy.mock.calls.filter((call) => call[1] === 1_000).length;
}

function latestDisplayTimer(spy: TimeoutSpyView): unknown {
  const displayCallIndexes = spy.mock.calls
    .map((call, index) => (call[1] === 1_000 ? index : -1))
    .filter((index) => index >= 0);
  const latestIndex = displayCallIndexes.at(-1);
  if (latestIndex === undefined) {
    throw new Error("Display timer was not scheduled.");
  }
  return spy.mock.results[latestIndex]?.value;
}
