import { act, type ComponentProps, type ReactNode } from "react";
import { hydrateRoot, createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  LiveStatusResource,
  SimulationPreparationResource,
} from "../api/apiTypes";
import { SESSIONS_PATH } from "../api/apiPaths";
import { CommandRegistry } from "../commands/CommandRegistry";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { KernelContext } from "../KernelContext";
import { ModuleRegistry } from "../module/ModuleRegistry";
import { DiagnosticRecorderController } from "../performance/diagnostic-recorder/DiagnosticRecorderController";
import { RealtimeConnectionController } from "../realtime/RealtimeConnectionController";
import { statusRefreshIntervalMs } from "../realtime/communicationPolicy";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";
import {
  resetSharedResourceRuntimeStoreForTests,
} from "../resources/ResourceRuntimeStore";
import type { KernelApi } from "../types";

import { LayoutController } from "./LayoutController";
import { SHELL_COMMANDS } from "./shellCommands";
import {
  findElements,
  installSimulationPreparationTestDom,
  type TestElement,
} from "./simulationPreparationTestDom.test-support";
import { WorkspaceShellClient } from "./WorkspaceShellClient";
import { startScreenManifest } from "@/modules/start/manifest";
import { startScreenStore } from "@/modules/start/model/startScreenState";
import { StartScreen } from "@/modules/start/StartScreen";

const LAUNCH_TILE_NAMES = ["FDM simulation", "FEM simulation", "From template", "Import"];

// This custom DOM checks shell lifetime; browser layout and gestures need a browser.
vi.mock("@/shared/ui/Resizable", () => {
  const Container = ({ children, className, id, inert }: {
    children?: ReactNode;
    className?: string;
    id?: string;
    inert?: boolean;
  }) => <div className={className} id={id} inert={inert}>{children}</div>;
  return {
    ResizablePanelGroup: Container,
    ResizablePanel: Container,
    ResizableHandle: () => <div data-testid="resize-handle" />,
  };
});

vi.mock("@/shared/ui/Sortable", () => ({
  SortableList: ({ children }: { children: ReactNode }) => <>{children}</>,
  SortableItem: ({ children }: ComponentProps<typeof import("@/shared/ui/Sortable").SortableItem>) => children({
    attributes: {
      role: "button",
      tabIndex: 0,
      "aria-disabled": false,
      "aria-pressed": undefined,
      "aria-roledescription": "sortable item",
      "aria-describedby": "",
    },
    isDragging: false,
    listeners: undefined,
    setNodeRef: () => undefined,
    style: {},
  }),
}));

afterEach(() => {
  resetSharedResourceRuntimeStoreForTests();
  startScreenStore.resetForTests();
  vi.restoreAllMocks();
});

describe("WorkspaceShellClient session collection gate", () => {
  it("keeps the AppMenu slot and mounts the start screen after a confirmed empty response", async () => {
    const list = vi.fn(async () => ({ schema_version: "2.0.0", sessions: [] }));
    const currentStatus = vi.fn();
    const { container, dispose } = await mountWorkspace(makeKernel(list, currentStatus));

    try {
      await settle();
      expect(findByAttribute(container, "data-slot-id", "app-menu")).toBeTruthy();
      expect(findByAttribute(container, "data-slot-id", "start-screen")).toBeTruthy();
      expect(container.textContent).toContain("Welcome to Fullmag");
      expect(findByAttribute(container, "data-state", "no-session")).toBeTruthy();
      for (const name of LAUNCH_TILE_NAMES) expect(container.textContent).toContain(name);
      expect(launchTile(container, "start.new-fdm")?.getAttribute("disabled")).toBeNull();
      expect(container.textContent).not.toContain("Save project");
      expect(currentStatus).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });

  it("renders loading separately and mounts no current-session subscriptions", async () => {
    const pending = deferred<{ schema_version: string; sessions: never[] }>();
    const currentStatus = vi.fn();
    const { container, dispose } = await mountWorkspace(
      makeKernel(vi.fn(() => pending.promise), currentStatus),
    );

    try {
      expect(findByAttribute(container, "data-state", "session-loading")).toBeTruthy();
      expect(container.textContent).toContain("Checking for sessions");
      expect(container.textContent).not.toContain("Welcome to Fullmag");
      expect(currentStatus).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });

  it("keeps the production workspace and editable viewport mounted during first preparation", async () => {
    const pendingPreparation = deferred<SimulationPreparationResource>();
    const currentStatus = vi.fn(async () => ({
      resources: { simulation_preparation_revision: 7 },
      session: {
        name: "workspace-shell-test",
        request_scope_epoch: "api-instance:workspace-shell-test",
        session_epoch: "workspace-shell-session@1700000000000",
        session_id: "workspace-shell-session",
      },
      solver: { state: "bootstrapping" },
    }) as LiveStatusResource);
    const list = vi.fn(async () => ({
      schema_version: "2.0.0",
      sessions: [{
        current: true,
        name: "workspace-shell-test",
        session_id: "workspace-shell-session",
        status: "running",
      }],
    }));
    const { container, dispose } = await mountWorkspace(
      makeKernel(list, currentStatus, () => pendingPreparation.promise),
    );

    try {
      await settle();

      const workspaceBody = findElements(
        container,
        (element) =>
          element
            .getAttribute("class")
            ?.split(/\s+/)
            .includes("fm-workspace-body") === true,
      )[0];
      const viewportDraft = findByAttribute(
        container,
        "aria-label",
        "Workspace draft",
      );
      const preparationStatus = findElements(
        container,
        (element) =>
          element.getAttribute("class") === "fm-simulation-startup",
      )[0];

      expect(list).toHaveBeenCalled();
      expect(currentStatus).toHaveBeenCalled();
      expect(workspaceBody).toBeTruthy();
      expect(workspaceBody.hasAttribute("inert")).toBe(false);
      expect(workspaceBody.hasAttribute("aria-hidden")).toBe(false);
      expect(
        findByAttribute(container, "data-slot-id", "viewport-main"),
      ).toBeTruthy();
      expect(viewportDraft).toBeTruthy();
      expect(preparationStatus?.getAttribute("data-state")).toBe("connecting");
      expect(findByAttribute(container, "aria-modal", "true")).toBeNull();
    } finally {
      await dispose();
    }
  });

  it("retains the focused workspace draft when session and status refreshes fail", async () => {
    const sessionList = {
      schema_version: "2.0.0",
      sessions: [{
        current: true,
        name: "workspace-shell-test",
        session_id: "workspace-shell-session",
        status: "running",
      }],
    };
    const list = vi.fn(async () => sessionList)
      .mockResolvedValueOnce(sessionList)
      .mockRejectedValueOnce(new Error("session list transport unavailable"));

    const liveStatus = {
      resources: { simulation_preparation_revision: 7 },
      session: {
        name: "workspace-shell-test",
        request_scope_epoch: "api-instance:workspace-shell-test",
        session_epoch: "workspace-shell-session@1700000000000",
        session_id: "workspace-shell-session",
      },
      solver: { state: "bootstrapping" },
    } as LiveStatusResource;
    const currentStatus = vi.fn(async () => liveStatus)
      .mockResolvedValueOnce(liveStatus)
      .mockRejectedValueOnce(new Error("current status transport unavailable"));

    const preparation = vi.fn(async () => ({
      active_stage_id: "planning",
      completed_at_unix_ms: null,
      failure: null,
      log_tail: [],
      preparation_id: "workspace-shell-preparation",
      requested_execution: {
        backend: "fdm",
        device: "gpu",
        engine_id: null,
        mode: "strict",
        precision: "double",
        runtime_family: null,
        worker: null,
      },
      resolved_execution: null,
      revision: 7,
      stages: [],
      started_at_unix_ms: 1_000,
      status: "running",
    } satisfies SimulationPreparationResource));
    const kernel = makeKernel(list, currentStatus, preparation);
    const { container, dispose } = await mountWorkspace(kernel);

    try {
      await settle();

      const workspaceBody = findElements(
        container,
        (element) =>
          element
            .getAttribute("class")
            ?.split(/\s+/)
            .includes("fm-workspace-body") === true,
      )[0];
      const draft = findByAttribute(container, "aria-label", "Workspace draft");
      const preparationStatus = findElements(
        container,
        (element) => element.getAttribute("class") === "fm-simulation-startup",
      )[0];
      expect(workspaceBody).toBeTruthy();
      expect(draft).toBeTruthy();
      expect(preparation).toHaveBeenCalledTimes(1);
      draft!.value = "Unsaved workspace draft";
      draft!.focus();

      // Invalidate after the real status throttle, without waiting on wall time.
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + statusRefreshIntervalMs() + 1);
      await act(async () => {
        kernel.resources.invalidate(SESSIONS_PATH, "transport-refresh:1");
        kernel.resources.invalidate(SESSION_STATUS_RESOURCE_KEY, "transport-refresh:1");
        kernel.realtimeConnection.update("disconnected");
      });
      await settle();

      expect(list).toHaveBeenCalledTimes(2);
      expect(currentStatus).toHaveBeenCalledTimes(2);
      expect(findByAttribute(container, "aria-label", "Workspace draft")).toBe(draft);
      expect(draft!.value).toBe("Unsaved workspace draft");
      expect(draft!.ownerDocument.activeElement).toBe(draft);
      expect(
        findElements(
          container,
          (element) =>
            element
              .getAttribute("class")
              ?.split(/\s+/)
              .includes("fm-workspace-body") === true,
        )[0],
      ).toBe(workspaceBody);
      expect(workspaceBody!.hasAttribute("inert")).toBe(false);
      expect(workspaceBody!.hasAttribute("aria-hidden")).toBe(false);
      expect(findByAttribute(container, "data-state", "session-error")).toBeNull();
      expect(findByAttribute(container, "data-state", "session-loading")).toBeNull();
      expect(findByAttribute(container, "data-slot-id", "start-screen")).toBeNull();
      expect(preparationStatus?.getAttribute("data-state")).toBe("stale");
      expect(container.textContent).toContain("Reconnecting…");
      expect(findByAttribute(container, "aria-modal", "true")).toBeNull();
    } finally {
      await dispose();
    }
  });

  it("renders transport failure separately from confirmed absence, with the launcher below it", async () => {
    const currentStatus = vi.fn();
    const { container, dispose } = await mountWorkspace(
      makeKernel(vi.fn(async () => { throw new Error("network unavailable"); }), currentStatus),
    );

    try {
      await settle();
      expect(findByAttribute(container, "data-state", "session-error")).toBeTruthy();
      expect(container.textContent).toContain("Session list unavailable");
      expect(container.textContent).toContain("Project files remain available independently");
      expect(findByAttribute(container, "data-slot-id", "start-screen")).toBeTruthy();
      for (const name of LAUNCH_TILE_NAMES) expect(container.textContent).toContain(name);
      // Creating a problem needs confirmed absence of a session; the tile says why.
      expect(launchTile(container, "start.new-fdm")?.getAttribute("disabled")).not.toBeNull();
      expect(container.textContent).toContain("could not confirm that no session is running");
      expect(launchTile(container, "start.templates")?.getAttribute("disabled")).toBeNull();
      expect(launchTile(container, "start.import")?.getAttribute("disabled")).toBeNull();
      expect(container.textContent).toContain("Browse…");
      expect(currentStatus).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });

  it("hydrates the loading server snapshot before adopting confirmed absence", async () => {
    const kernel = makeKernel(
      vi.fn(async () => ({ schema_version: "2.0.0", sessions: [] })),
      vi.fn(),
    );
    const serverHtml = renderToString(
      <KernelContext.Provider value={kernel}>
        <WorkspaceShellClient />
      </KernelContext.Provider>,
    );
    expect(serverHtml).toContain('data-state="session-loading"');

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    container.innerHTML = serverHtml;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(
          container as unknown as Element,
          <KernelContext.Provider value={kernel}>
            <WorkspaceShellClient />
          </KernelContext.Provider>,
        );
        await Promise.resolve();
      });
      await settle();

      expect(consoleError).not.toHaveBeenCalled();
      expect(findByAttribute(container, "data-state", "no-session")).toBeTruthy();
    } finally {
      await act(async () => root?.unmount());
      consoleError.mockRestore();
      dom.restore();
    }
  });
});

function makeKernel(
  list: () => Promise<{ schema_version: string; sessions: readonly unknown[] }>,
  currentStatus: () => Promise<unknown>,
  preparation: () => Promise<SimulationPreparationResource> = async () => {
    throw new Error("simulation preparation is not served in this test");
  },
): KernelApi {
  const bus = new EventBus<KernelEventMap>();
  const commands = new CommandRegistry();
  const modules = new ModuleRegistry();
  modules.register({ ...startScreenManifest, component: async () => ({ default: StartScreen }) });
  modules.register({
    id: "workspace-shell-test-viewport",
    title: "Workspace shell test viewport",
    version: "0.1.0",
    slots: ["viewport-main"],
    component: async () => ({
      default: () => <input aria-label="Workspace draft" />,
    }),
  });
  for (const command of SHELL_COMMANDS) commands.register(command);
  for (const command of startScreenManifest.contributes?.commands ?? []) commands.register(command);
  return {
    api: {
      diagnostics: {
        cpuTelemetry: async () => { throw new Error("telemetry is not served in this test"); },
        gpuTelemetry: async () => { throw new Error("telemetry is not served in this test"); },
      },
      platform: {
        capabilities: async () => { throw new Error("capabilities are not served in this test"); },
        computeNodes: async () => ({
          nodes: [],
          schema_version: "compute_nodes.v1",
          stale_after_seconds: 30,
          state: "not_probed",
        }),
      },
      workspace: {
        item: async () => { throw new Error("the workspace database is not served in this test"); },
        items: async () => { throw new Error("the workspace database is not served in this test"); },
        thumbnailUrl: (id: string) => `/thumbnail/${id}`,
      },
      sessions: { list, current: { status: currentStatus } },
      simulation: { preparation },
    },
    bus,
    commands,
    diagnosticRecorder: new DiagnosticRecorderController({ config: { enabled: false } }),
    realtimeConnection: new RealtimeConnectionController(),
    layout: new LayoutController(bus),
    modules,
    resources: new ResourceInvalidationController(bus),
  } as unknown as KernelApi;
}

async function mountWorkspace(kernel: KernelApi): Promise<{
  container: TestElement;
  dispose: () => Promise<void>;
}> {
  const dom = installSimulationPreparationTestDom();
  const storage = new Map<string, string>();
  Object.defineProperty(dom.document.defaultView!, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => { storage.delete(key); },
      setItem: (key: string, value: string) => { storage.set(key, value); },
    },
  });
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(
      <KernelContext.Provider value={kernel}>
        <WorkspaceShellClient />
      </KernelContext.Provider>,
    );
  });
  return {
    container,
    dispose: async () => {
      await act(async () => root.unmount());
      dom.restore();
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function findByAttribute(
  container: TestElement,
  name: string,
  value: string,
): TestElement | null {
  return findElements(
    container,
    (element) => element.getAttribute(name) === value,
  )[0] ?? null;
}

function launchTile(container: TestElement, commandId: string): TestElement | null {
  return findByAttribute(container, "data-command-id", commandId);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
