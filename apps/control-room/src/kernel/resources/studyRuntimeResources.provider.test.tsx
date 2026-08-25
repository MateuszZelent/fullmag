import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MODEL_READINESS_PATH, MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import type { CommandContext } from "@/kernel/commands/commandTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { resetSharedResourceRuntimeStoreForTests } from "@/kernel/resources/ResourceRuntimeStore";
import {
  resetRealtimeCommunicationPolicyForTests,
  updateRealtimeCommunicationPolicy,
} from "@/kernel/realtime/communicationPolicy";
import { STUDY_RUNTIME_COMMANDS } from "@/kernel/runtime/studyRuntimeCommandContributions";
import { MAGNETIZATION_TEXTURE_COMMANDS } from "@/kernel/authoring/magnetization-texture/commands";
import type { KernelApi } from "@/kernel/types";

import {
  buildRuntimeCommandControlResourceData,
  runtimeCommandControlSessionStatusEquals,
  selectRuntimeCommandControlSessionStatus,
  useModelReadinessResource,
  useRuntimeCommandControlResourceData,
} from "./studyRuntimeResources";
import {
  SESSION_STATUS_RESOURCE_KEY,
  useSessionStatusSelector,
} from "./useSessionStatus";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function statusAt(sceneRevision: number) {
  return {
    capabilities: { binary_fields: true },
    domain: { discretization: "fdm" },
    resources: { scene_revision: sceneRevision },
    run: null,
    session: { session_id: "scratch-session" },
  };
}

function readinessAt(sceneRevision: number) {
  return {
    blockers: [],
    capabilities: {},
    checks: [],
    ready_to_export: true,
    ready_to_run: true,
    scene_revision: sceneRevision,
  };
}

describe("production runtime command resource provider", () => {
  afterEach(() => {
    resetSharedResourceRuntimeStoreForTests();
    resetRealtimeCommunicationPolicyForTests();
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

      await vi.waitFor(() => {
        expect(readinessLoad).toHaveBeenCalledTimes(1);
        expect(container.textContent).toBe("7");
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("refetches status and readiness from the final preset ACK before Run recovers without realtime", async () => {
    updateRealtimeCommunicationPolicy({ status_refresh_ms: 1 });
    const finalRevision = 7;
    const nextStatus = deferred<ReturnType<typeof statusAt>>();
    const nextReadiness = deferred<ReturnType<typeof readinessAt>>();
    const statusLoad = vi
      .fn()
      .mockResolvedValueOnce(statusAt(5))
      .mockImplementationOnce(() => nextStatus.promise);
    const readinessLoad = vi
      .fn()
      .mockResolvedValueOnce(readinessAt(5))
      .mockImplementationOnce(() => nextReadiness.promise);
    const patchMagnetizationAsset = vi.fn(async () => ({
      asset: { id: "mag:body:region:body:uniform" },
      scene_revision: 6,
    }));
    const patchRegion = vi.fn(async () => ({ revision: finalRevision }));
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const invalidations: Array<{ resourceKey: string; revision: unknown }> = [];
    bus.on("resource:invalidated", ({ resourceKey, revision }) => {
      invalidations.push({ resourceKey, revision });
    });
    const api = {
      model: {
        geometry: {
          validation: async () => ({ diagnostics: [], revision: finalRevision }),
        },
        patchMagnetizationAsset,
        patchRegion,
        readiness: readinessLoad,
      },
      sessions: { current: { status: statusLoad } },
    };
    const kernel = {
      api,
      bus,
      diagnosticRecorder: new DiagnosticRecorderController({
        config: { enabled: false },
      }),
      resources,
    } as unknown as KernelApi;
    const registry = new CommandRegistry();
    for (const command of STUDY_RUNTIME_COMMANDS) registry.register(command);
    const presetCommand = MAGNETIZATION_TEXTURE_COMMANDS.find(
      (command) => command.id === "magnetization-texture.assign-uniform",
    );
    let latestResourceData: Readonly<Record<string, unknown>> = {};
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    function Harness() {
      const status = useSessionStatusSelector(
        selectRuntimeCommandControlSessionStatus,
        { isEqual: runtimeCommandControlSessionStatusEquals },
      );
      const readiness = useModelReadinessResource();
      latestResourceData = buildRuntimeCommandControlResourceData({
        commandQueue: { commands: [] },
        geometryValidation: { diagnostics: [] },
        meshBuildCurrent: null,
        meshManifest: null,
        modelReadinessData: readiness.data,
        modelReadinessStatus: readiness.status,
        sessionStatus: status,
        solverStatus: { runtime_state: "idle" },
        stageExecution: {
          active_stage_index: null,
          revision: finalRevision,
          runtime_state: "idle",
          stages: [],
        },
      });
      const context = {
        api: {} as never,
        resourceData: latestResourceData,
        source: "test" as const,
      };
      const reason = registry.get("study.run")?.disabledReason?.(context);
      return <div>{registry.isEnabled("study.run", context) ? "enabled" : reason}</div>;
    }

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <Harness />
          </KernelContext.Provider>,
        );
      });
      await vi.waitFor(() => expect(container.textContent).toBe("enabled"));

      const mutationContext = {
        api,
        resourceData: {
          ...latestResourceData,
          [MODEL_SCENE_PATH]: { revision: 5 },
        },
        resources,
        selection: {
          get: () => ({
            kind: "object.region-magnetic-texture",
            objectId: "body",
            ref: {
              kind: "object.region-magnetic-texture",
              objectId: "body",
              regionId: "region:body",
              type: "scene-object",
            },
          }),
        },
        source: "test" as const,
      } as unknown as CommandContext;
      await act(async () => {
        await presetCommand?.run(mutationContext);
        await vi.waitFor(() => {
          expect(statusLoad).toHaveBeenCalledTimes(2);
          expect(readinessLoad).toHaveBeenCalledTimes(2);
        });
      });

      await act(async () => {
        nextReadiness.resolve(readinessAt(finalRevision));
        await nextReadiness.promise;
        await vi.waitFor(() =>
          expect(container.textContent).toBe(
            "Model readiness is stale for the current scene.",
          ),
        );
      });

      await act(async () => {
        nextStatus.resolve(statusAt(finalRevision));
        await nextStatus.promise;
        await vi.waitFor(() => expect(container.textContent).toBe("enabled"));
      });

      expect(
        invalidations.filter(
          ({ resourceKey, revision }) =>
            resourceKey === MODEL_READINESS_PATH && revision === finalRevision,
        ),
      ).toHaveLength(1);
      expect(
        invalidations.filter(
          ({ resourceKey, revision }) =>
            resourceKey === SESSION_STATUS_RESOURCE_KEY && revision === finalRevision,
        ),
      ).toHaveLength(1);
      expect(patchMagnetizationAsset).toHaveBeenCalledTimes(1);
      expect(patchRegion).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
