import { act } from "react";
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
import { sharedResourceRuntimeStore } from "../resources/ResourceRuntimeStore";
import type { ResourceResult } from "../resources/resourceTypes";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";
import type { KernelApi } from "../types";
import { LayoutController } from "./LayoutController";
import { SimulationPreparationLog } from "./SimulationPreparationLog";
import {
  SimulationStartupOverlay,
  SimulationStartupOverlayView,
  WorkspaceStartupGateView,
  useSimulationStartupOverlayState,
} from "./SimulationStartupOverlay";
import {
  resolveSimulationPreparationViewModel,
  type SimulationPreparationLogEntryView,
} from "./simulationPreparationModel";
import {
  findElement,
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
} from "./simulationPreparationTestDom.test-support";
import { footerManifest } from "../../modules/footer/manifest";

interface Deferred<TData> {
  readonly promise: Promise<TData>;
  readonly resolve: (value: TData) => void;
}

afterEach(() => {
  updateRealtimeCommunicationPolicy({});
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("mounted simulation preparation UI", () => {
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
          <MountedWorkspaceGate />
        </KernelContext.Provider>,
      );
    });
    await settleLoads();

    expect(container.textContent).toContain("Viewport module");
    expect(container.textContent).not.toContain("Preparing simulation");

    await act(async () => root.unmount());
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
          <MountedWorkspaceGate />
        </KernelContext.Provider>,
      );
    });
    await settleLoads();

    expect(container.textContent).toContain("Preparation status unavailable");
    expect(container.textContent).toContain(
      "The local runtime could not provide simulation preparation status.",
    );
    expect(container.textContent).not.toContain("/private/model.py");
    expect(container.textContent).not.toContain("Viewport module");
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

  it("opens the mounted production diagnostics consumer without unmounting the failure gate", async () => {
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
          <WorkspaceStartupGateView state={model}>
            <div data-slot-id="viewport-main">Viewport module</div>
          </WorkspaceStartupGateView>
        </KernelContext.Provider>,
      );
    });
    expect(container.textContent).not.toContain("Recording");
    await act(async () => findButton(container, "Open full diagnostics").click());
    expect(kernel.layout.get().activeBottomPanelTab).toBe("diagnostics");
    await settleMountedModule();

    expect(container.textContent).toContain("Simulation preparation failed");
    expect(container.textContent).toContain("Recording");
    expect(
      findElement(
        container,
        (element) => element.getAttribute("aria-label") === "Bottom diagnostics",
        "Bottom diagnostics tabs",
      ),
    ).toBeTruthy();
    expect(container.textContent).not.toContain("Viewport module");

    await act(async () => root.unmount());
    dom.restore();
  });

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
    expect(container.textContent).toContain("Reconnecting…");
    expect(container.textContent).toContain(
      "Displayed progress may be out of date.",
    );

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
        SIMULATION_PREPARATION_PATH,
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
        SIMULATION_PREPARATION_PATH,
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
    requested_execution: {},
    resolved_execution: null,
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

function statusFixture(
  patch: {
    preparationRevision?: number;
    solverState?: string;
  } = {},
): LiveStatusResource {
  return {
    resources: {
      simulation_preparation_revision: patch.preparationRevision ?? 7,
    },
    session: { name: "permalloy-relaxation" },
    solver: { state: patch.solverState ?? "bootstrapping" },
  } as LiveStatusResource;
}

function MountedWorkspaceGate() {
  return (
    <WorkspaceStartupGateView state={useSimulationStartupOverlayState()}>
      <div data-slot-id="viewport-main">Viewport module</div>
    </WorkspaceStartupGateView>
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
      sessions: { current: { status: loadStatus } },
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

async function settleMountedModule(): Promise<void> {
  await act(async () => {
    await footerManifest.component();
  });
  for (let index = 0; index < 8; index += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
