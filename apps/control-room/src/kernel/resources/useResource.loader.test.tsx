import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import {
  installSimulationPreparationTestDom,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import {
  ResourceInvalidationController,
} from "@/kernel/resources/ResourceInvalidationController";
import {
  resetSharedResourceRuntimeStoreForTests,
  sharedResourceRuntimeStore,
} from "@/kernel/resources/ResourceRuntimeStore";
import {
  useResource,
  useResourceSelector,
} from "@/kernel/resources/useResource";
import type { KernelApi } from "@/kernel/types";

const useResourceSource = readFileSync(
  join(process.cwd(), "src/kernel/resources/useResource.ts"),
  "utf8",
);

describe("useResource loader callback", () => {
  afterEach(() => {
    resetSharedResourceRuntimeStoreForTests();
    vi.useRealTimers();
  });

  it("uses an effect event instead of a passive loader ref", () => {
    expect(useResourceSource).toContain("useEffectEvent");
    expect(useResourceSource).not.toContain("loadRef");
  });

  it("uses deterministic empty server snapshots for external resources", () => {
    expect(useResourceSource).toContain("SERVER_RUNTIME_SNAPSHOT");
    expect(useResourceSource).toContain("getServerRevision");
    expect(useResourceSource).not.toContain(
      "subscribeStable,\n    getSnapshot,\n    getSnapshot",
    );
    expect(useResourceSource).not.toContain(
      "subscribeRuntime,\n    getRuntimeSnapshot,\n    getRuntimeSnapshot",
    );
  });

  it("does not expose a live runtime resource during server rendering", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const kernel = {
      api: {},
      bus,
      diagnosticRecorder: new DiagnosticRecorderController({ config: { enabled: false } }),
      resources,
    } as unknown as KernelApi;
    const resourceKey = "test:ssr-live-resource";
    const selectorResourceKey = "test:ssr-live-selector";
    sharedResourceRuntimeStore.updateData(resourceKey, { source: "live" }, 1);
    sharedResourceRuntimeStore.updateData(selectorResourceKey, { source: "live" }, 1);

    function Harness() {
      const resource = useResource({
        load: async () => ({ source: "network" }),
        resourceKey,
      });
      return <div data-resource>{`${resource.status}:${resource.data?.source ?? ""}`}</div>;
    }

    function SelectorHarness() {
      const status = useResourceSelector({
        load: async () => ({ source: "network" }),
        resourceKey: selectorResourceKey,
        selector: (resource) => `${resource.status}:${resource.data?.source ?? ""}`,
      });
      return <div data-selector>{status}</div>;
    }

    const html = renderToString(
      <KernelContext.Provider value={kernel}>
        <Harness />
        <SelectorHarness />
      </KernelContext.Provider>,
    );

    expect(html).toContain('data-resource="true">loading:</div>');
    expect(html).toContain('data-selector="true">loading:</div>');
  });

  it("hydrates against the server snapshot, adopts prefetched live data, and refetches after invalidation", async () => {
    vi.useFakeTimers();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const kernel = {
      api: {},
      bus,
      diagnosticRecorder: new DiagnosticRecorderController({ config: { enabled: false } }),
      resources,
    } as unknown as KernelApi;
    const resourceKey = "test:hydrated-live-resource";
    const selectorResourceKey = "test:hydrated-live-selector";
    const load = vi.fn(async () => ({ source: "network", revision: 8 }));
    const selectorLoad = vi.fn(async () => ({ source: "network-selector", revision: 8 }));
    sharedResourceRuntimeStore.updateData(resourceKey, { source: "live", revision: 7 }, 7);
    sharedResourceRuntimeStore.updateData(selectorResourceKey, { source: "live-selector", revision: 7 }, 7);
    resources.invalidate(resourceKey, 7);
    resources.invalidate(selectorResourceKey, 7);

    function Harness() {
      const resource = useResource({
        load,
        resolveRevision: (data) => data.revision,
        resourceKey,
      });
      const selected = useResourceSelector({
        load: selectorLoad,
        resolveRevision: (data) => data.revision,
        resourceKey: selectorResourceKey,
        selector: (resource) => `${resource.status}:${resource.data?.source ?? ""}`,
      });
      return <><div data-resource>{`${resource.status}:${resource.data?.source ?? ""}`}</div><div data-selector>{selected}</div></>;
    }

    const serverHtml = renderToString(
      <KernelContext.Provider value={kernel}>
        <Harness />
      </KernelContext.Provider>,
    );
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    (container as unknown as { innerHTML: string }).innerHTML = serverHtml;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(
          container as unknown as Element,
          <KernelContext.Provider value={kernel}>
            <Harness />
          </KernelContext.Provider>,
        );
        await Promise.resolve();
      });

      expect(serverHtml).toContain('data-resource="true">loading:</div>');
      expect(serverHtml).toContain('data-selector="true">loading:</div>');
      expect(consoleError).not.toHaveBeenCalled();
      expect(container.textContent).toContain("ready:live");
      expect(container.textContent).toContain("ready:live-selector");
      expect(load).not.toHaveBeenCalled();
      expect(selectorLoad).not.toHaveBeenCalled();

      await act(async () => {
        resources.invalidate(resourceKey, 8);
        resources.invalidate(selectorResourceKey, 8);
        await vi.runOnlyPendingTimersAsync();
      });

      expect(load).toHaveBeenCalledTimes(1);
      expect(selectorLoad).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("ready:network");
      expect(container.textContent).toContain("ready:network-selector");
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      await act(async () => root?.unmount());
      consoleError.mockRestore();
      dom.restore();
    }
  });

  it("uses the latest loader when a retry timer fires after a loader change", async () => {
    vi.useFakeTimers();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const kernel = {
      api: {},
      bus,
      diagnosticRecorder: new DiagnosticRecorderController({ config: { enabled: false } }),
      resources,
    } as unknown as KernelApi;
    const loadA = vi.fn(async () => {
      throw new Error("first loader failed");
    });
    const loadB = vi.fn(async () => ({ source: "latest" }));
    const selectorLoadA = vi.fn(async () => {
      throw new Error("first selector loader failed");
    });
    const selectorLoadB = vi.fn(async () => ({ source: "latest-selector" }));
    const resourceKey = "test:loader-latest";
    const selectorResourceKey = "test:selector-loader-latest";
    const root = createRoot(container as unknown as Element);

    type Loader = (context: { signal: AbortSignal }) => Promise<{ source: string }>;

    function Harness({ load }: { load: Loader }) {
      useResource({ load, resourceKey });
      return <div />;
    }

    function SelectorHarness({ load }: { load: Loader }) {
      useResourceSelector({
        load,
        resourceKey: selectorResourceKey,
        selector: (resource) => resource.status,
      });
      return <div />;
    }

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <Harness load={loadA} />
          <SelectorHarness load={selectorLoadA} />
        </KernelContext.Provider>,
      );
    });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(loadA).toHaveBeenCalledTimes(1);
    expect(selectorLoadA).toHaveBeenCalledTimes(1);

    await act(async () => {
      resources.invalidate(resourceKey, 1);
      resources.invalidate(selectorResourceKey, 1);
    });
    await act(async () => {
      setTimeout(() => {
        flushSync(() => {
          root.render(
            <KernelContext.Provider value={kernel}>
              <Harness load={loadB} />
              <SelectorHarness load={selectorLoadB} />
            </KernelContext.Provider>,
          );
        });
      }, 999);
      vi.advanceTimersByTime(1000);
    });
    expect(loadB).toHaveBeenCalledTimes(1);
    expect(selectorLoadB).toHaveBeenCalledTimes(1);
    await act(async () => {});

    await act(async () => {
      root.unmount();
    });
    dom.restore();
  });

  it("does not restart a failed load when the revision resolver changes on a runtime notification", async () => {
    vi.useFakeTimers();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const kernel = {
      api: {},
      bus,
      diagnosticRecorder: new DiagnosticRecorderController({ config: { enabled: false } }),
      resources,
    } as unknown as KernelApi;
    const load = vi
      .fn<() => Promise<{ source: string }>>()
      .mockRejectedValueOnce(new Error("resource unavailable"))
      .mockResolvedValue({ source: "latest" });
    const resourceKey = "test:resolver-stability";
    const root = createRoot(container as unknown as Element);

    function Harness() {
      const resource = useResource({
        load,
        resolveRevision: (data) => data.source,
        resourceKey,
      });
      return <div>{`${resource.status}:${resource.data?.source ?? ""}`}</div>;
    }

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <Harness />
        </KernelContext.Provider>,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => {
      resources.invalidate(resourceKey, 1);
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("ready:latest");

    await act(async () => {
      root.unmount();
    });
    dom.restore();
  });

  it("retries a failed resource without waiting for another invalidation", async () => {
    vi.useFakeTimers();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const kernel = {
      api: {},
      bus,
      diagnosticRecorder: new DiagnosticRecorderController({ config: { enabled: false } }),
      resources,
    } as unknown as KernelApi;
    const load = vi
      .fn<() => Promise<{ source: string }>>()
      .mockRejectedValueOnce(new Error("field is pending"))
      .mockResolvedValue({ source: "ready" });
    const root = createRoot(container as unknown as Element);

    function Harness() {
      const resource = useResource({
        load,
        resourceKey: "test:autonomous-retry",
      });
      return <div>{`${resource.status}:${resource.data?.source ?? ""}`}</div>;
    }

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <Harness />
          </KernelContext.Provider>,
        );
      });
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      expect(load).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(999);
      });
      expect(load).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(load).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain("ready:ready");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
