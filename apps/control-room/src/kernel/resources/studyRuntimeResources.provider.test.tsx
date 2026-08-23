import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MODEL_READINESS_PATH } from "@/kernel/api/apiPaths";
import { KernelContext } from "@/kernel/KernelContext";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { resetSharedResourceRuntimeStoreForTests } from "@/kernel/resources/ResourceRuntimeStore";
import type { KernelApi } from "@/kernel/types";

import { useRuntimeCommandControlResourceData } from "./studyRuntimeResources";

describe("production runtime command resource provider", () => {
  afterEach(() => {
    resetSharedResourceRuntimeStoreForTests();
  });

  it("publishes server-owned model readiness without manual command resource injection", async () => {
    const readiness = {
      blockers: [],
      capabilities: {
        move: { available: true, reason: null },
        rotate: { available: false, reason: "unsupported" },
        scale: { available: false, reason: "unsupported" },
      },
      checks: [],
      ready_to_export: true,
      ready_to_run: true,
      scene_revision: 7,
    };
    const readinessLoad = vi.fn(async () => readiness);
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const kernel = {
      api: {
        model: {
          geometry: {
            validation: async () => ({ diagnostics: [], revision: 7 }),
          },
          readiness: readinessLoad,
        },
        sessions: { current: { status: async () => null } },
        simulation: { solver: { status: async () => null } },
      },
      bus,
      diagnosticRecorder: new DiagnosticRecorderController({
        config: { enabled: false },
      }),
      resources,
    } as unknown as KernelApi;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    function Harness() {
      const resourceData = useRuntimeCommandControlResourceData({
        includeSharedDomainReadiness: false,
        includeStageExecution: false,
      });
      const value = resourceData[MODEL_READINESS_PATH] as
        | typeof readiness
        | null;
      return <div>{value?.scene_revision ?? "unavailable"}</div>;
    }

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <Harness />
          </KernelContext.Provider>,
        );
      });
      await act(async () => {});

      expect(readinessLoad).toHaveBeenCalledTimes(1);
      expect(container.textContent).toBe("7");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
