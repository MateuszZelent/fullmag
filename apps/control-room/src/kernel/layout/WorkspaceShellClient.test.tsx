import { act } from "react";
import { hydrateRoot, createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "../commands/CommandRegistry";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { KernelContext } from "../KernelContext";
import { ModuleRegistry } from "../module/ModuleRegistry";
import { DiagnosticRecorderController } from "../performance/diagnostic-recorder/DiagnosticRecorderController";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import {
  resetSharedResourceRuntimeStoreForTests,
} from "../resources/ResourceRuntimeStore";
import type { KernelApi } from "../types";

import {
  findElements,
  installSimulationPreparationTestDom,
  type TestElement,
} from "./simulationPreparationTestDom.test-support";
import { WorkspaceShellClient } from "./WorkspaceShellClient";

afterEach(() => {
  resetSharedResourceRuntimeStoreForTests();
  vi.restoreAllMocks();
});

describe("WorkspaceShellClient session collection gate", () => {
  it("keeps the AppMenu slot and EmptyWorkspace after a confirmed empty response", async () => {
    const list = vi.fn(async () => ({ schema_version: "2.0.0", sessions: [] }));
    const currentStatus = vi.fn();
    const { container, dispose } = await mountWorkspace(makeKernel(list, currentStatus));

    try {
      await settle();
      expect(findByAttribute(container, "data-slot-id", "app-menu")).toBeTruthy();
      expect(container.textContent).toContain("Create a simulation");
      expect(findByAttribute(container, "data-state", "no-session")).toBeTruthy();
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
      expect(container.textContent).not.toContain("Create a simulation");
      expect(currentStatus).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });

  it("renders transport failure separately from confirmed absence", async () => {
    const currentStatus = vi.fn();
    const { container, dispose } = await mountWorkspace(
      makeKernel(vi.fn(async () => { throw new Error("network unavailable"); }), currentStatus),
    );

    try {
      await settle();
      expect(findByAttribute(container, "data-state", "session-error")).toBeTruthy();
      expect(container.textContent).toContain("Session list unavailable");
      expect(container.textContent).not.toContain("Create a simulation");
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
): KernelApi {
  const bus = new EventBus<KernelEventMap>();
  return {
    api: { sessions: { list, current: { status: currentStatus } } },
    bus,
    commands: new CommandRegistry(),
    diagnosticRecorder: new DiagnosticRecorderController({ config: { enabled: false } }),
    modules: new ModuleRegistry(),
    resources: new ResourceInvalidationController(bus),
  } as unknown as KernelApi;
}

async function mountWorkspace(kernel: KernelApi): Promise<{
  container: TestElement;
  dispose: () => Promise<void>;
}> {
  const dom = installSimulationPreparationTestDom();
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
