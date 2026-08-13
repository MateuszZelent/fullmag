import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
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
});
