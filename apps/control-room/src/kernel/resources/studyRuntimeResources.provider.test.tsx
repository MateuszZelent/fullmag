import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MESHING_PERIODIC_PAIRS_PATH,
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
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
import type { StageExecutionResource } from "@/kernel/api/apiTypes";
import type { KernelApi } from "@/kernel/types";

import {
  buildRuntimeCommandControlResourceData,
  runtimeCommandControlSessionStatusEquals,
  selectRuntimeCommandControlSessionStatus,
  useCurrentRunResource,
  useMeshPeriodicPairsResource,
  useModelReadinessResource,
  useRuntimeCommandControlResourceData,
  useStageExecutionResource,
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

const SCRATCH_SESSION_SCOPE_KEY =
  "session=scratch-session&epoch=scratch-session%401700000000000&request_scope_epoch=api-instance%3Ascratch";

function statusAt(
  sceneRevision: number,
  run: { run_id: string } | null = null,
) {
  return {
    capabilities: { binary_fields: true },
    domain: { discretization: "fdm" },
    resources: { scene_revision: sceneRevision },
    run,
    session: {
      request_scope_epoch: "api-instance:scratch",
      session_epoch: "scratch-session@1700000000000",
      session_id: "scratch-session",
    },
  };
}

// Session identity is confirmed against the session collection before any
// session-scoped resource hook is enabled.
const sessionsApi = {
  list: async () => ({
    schema_version: "2.0.0",
    sessions: [
      {
        current: true,
        name: "scratch",
        session_id: "scratch-session",
        status: "running",
      },
    ],
  }),
};

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

function stageExecutionAt(
  runId: string,
  revision: number,
): StageExecutionResource {
  return {
    active_stage_index: null,
    active_stage_kind: null,
    completed_stage_indexes: [],
    revision,
    run_id: runId,
    runtime_state: "running",
    session_epoch: "scratch-session@1700000000000",
    session_id: "scratch-session",
    stage_statuses: [],
    stages: [],
    total_stages: 0,
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
        sessions: {
          ...sessionsApi,
          current: { status: async () => statusAt(7) },
        },
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

  it("coalesces stage execution loads across consumers and retries an old-run response after run change", async () => {
    const nextRunStatus = deferred<ReturnType<typeof statusAt>>();
    const runAExecution = deferred<StageExecutionResource>();
    const staleRunExecution = deferred<StageExecutionResource>();
    const runBExecution = deferred<StageExecutionResource>();
    const statusLoad = vi.fn()
      .mockResolvedValueOnce(statusAt(1, { run_id: "run-a" }))
      .mockImplementationOnce(() => nextRunStatus.promise);
    const requestSignals: AbortSignal[] = [];
    const stageExecutionLoad = vi.fn(
      ({ signal }: { signal: AbortSignal }) => {
        requestSignals.push(signal);
        return requestSignals.length === 1
          ? runAExecution.promise
          : requestSignals.length === 2
            ? staleRunExecution.promise
            : runBExecution.promise;
      },
    );
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const kernel = {
      api: {
        sessions: {
          ...sessionsApi,
          current: { status: statusLoad },
        },
        simulation: {
          stages: { execution: stageExecutionLoad },
        },
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
    let firstStageExecution: ReturnType<typeof useStageExecutionResource> | null =
      null;
    let secondStageExecution: ReturnType<typeof useStageExecutionResource> | null =
      null;
    let refetchStatus: () => void = () => undefined;

    function Harness() {
      refetchStatus = useSessionStatusSelector(
        (status) => status.refetch,
      );
      firstStageExecution = useStageExecutionResource();
      secondStageExecution = useStageExecutionResource();
      const firstRunId = firstStageExecution?.data?.run_id ?? "no first run";
      const secondRunId =
        secondStageExecution?.data?.run_id ?? "no second run";
      return <div>{firstRunId}|{secondRunId}</div>;
    }

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <Harness />
          </KernelContext.Provider>,
        );
      });
      await vi.waitFor(() => {
        expect(stageExecutionLoad).toHaveBeenCalledTimes(1);
        expect(requestSignals).toHaveLength(1);
        expect(requestSignals[0]?.aborted).toBe(false);
      });

      await act(async () => {
        runAExecution.resolve(stageExecutionAt("run-a", 1));
        await runAExecution.promise;
      });
      await vi.waitFor(() => {
        expect(container.textContent).toBe("run-a|run-a");
      });

      await act(async () => refetchStatus());
      await vi.waitFor(() => expect(statusLoad).toHaveBeenCalledTimes(2));
      await act(async () => {
        nextRunStatus.resolve(statusAt(2, { run_id: "run-b" }));
        await nextRunStatus.promise;
      });
      await vi.waitFor(() => {
        expect(stageExecutionLoad).toHaveBeenCalledTimes(2);
        expect(firstStageExecution?.data).toBeNull();
        expect(secondStageExecution?.data).toBeNull();
        expect(container.textContent).toBe("no first run|no second run");
      });
      expect(requestSignals).toHaveLength(2);
      expect(requestSignals[0]?.aborted).toBe(false);
      expect(requestSignals[1]?.aborted).toBe(false);

      await act(async () => {
        staleRunExecution.resolve(stageExecutionAt("run-a", 1));
        await staleRunExecution.promise;
      });
      await vi.waitFor(() => {
        expect(stageExecutionLoad).toHaveBeenCalledTimes(3);
        expect(firstStageExecution?.data).toBeNull();
        expect(secondStageExecution?.data).toBeNull();
      }, { timeout: 3_000 });
      expect(requestSignals).toHaveLength(3);
      expect(requestSignals[2]?.aborted).toBe(false);

      await act(async () => {
        runBExecution.resolve(stageExecutionAt("run-b", 2));
        await runBExecution.promise;
      });
      await vi.waitFor(() => {
        expect(firstStageExecution?.data?.run_id).toBe("run-b");
        expect(secondStageExecution?.data?.run_id).toBe("run-b");
        expect(container.textContent).toBe("run-b|run-b");
      });
      expect(stageExecutionLoad).toHaveBeenCalledTimes(3);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("retains same-run stage execution through status refresh failure and clears it on run change", async () => {
    const statusFailure = new Error("status refresh temporarily failed");
    const nextRunStatus = deferred<ReturnType<typeof statusAt>>();
    const nextRunExecution = deferred<StageExecutionResource>();
    const statusLoad = vi.fn()
      .mockResolvedValueOnce(statusAt(1, { run_id: "run-a" }))
      .mockRejectedValueOnce(statusFailure)
      .mockImplementationOnce(() => nextRunStatus.promise);
    const stageExecutionLoad = vi.fn()
      .mockResolvedValueOnce(stageExecutionAt("run-a", 1))
      .mockImplementationOnce(() => nextRunExecution.promise);
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const kernel = {
      api: {
        sessions: {
          ...sessionsApi,
          current: { status: statusLoad },
        },
        simulation: {
          stages: { execution: stageExecutionLoad },
        },
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
    let latestStageExecution: ReturnType<typeof useStageExecutionResource> | null =
      null;
    let latestStatusRefreshError: Error | null = null;
    let latestStatusRunId: string | null = null;
    let latestStatusState = "loading";
    let refetchStatus: () => void = () => undefined;

    function Harness() {
      const status = useSessionStatusSelector(
        (resource) => ({
          data: resource.data,
          refetch: resource.refetch,
          refreshError: resource.refreshError ?? resource.error,
          status: resource.status,
        }),
        {
          isEqual: (previous, next) =>
            previous.data === next.data &&
            previous.refreshError === next.refreshError &&
            previous.status === next.status,
        },
      );
      refetchStatus = status.refetch;
      latestStatusRefreshError = status.refreshError ?? null;
      latestStatusRunId = status.data?.run?.run_id ?? null;
      latestStatusState = status.status;
      latestStageExecution = useStageExecutionResource();
      return <div>{latestStageExecution?.data?.run_id ?? "no stage run"}</div>;
    }

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <Harness />
          </KernelContext.Provider>,
        );
      });
      await vi.waitFor(() => {
        expect(statusLoad).toHaveBeenCalledTimes(1);
        expect(stageExecutionLoad).toHaveBeenCalledTimes(1);
        expect(latestStageExecution?.data?.run_id).toBe("run-a");
      });

      await act(async () => refetchStatus());
      await vi.waitFor(() => expect(statusLoad).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => {
        expect(latestStatusState).toBe("stale");
        expect(latestStatusRefreshError).toBe(statusFailure);
        expect(latestStageExecution?.data?.run_id).toBe("run-a");
        expect(container.textContent).toBe("run-a");
      });

      await act(async () => refetchStatus());
      await vi.waitFor(() => expect(statusLoad).toHaveBeenCalledTimes(3));
      await act(async () => {
        nextRunStatus.resolve(statusAt(2, { run_id: "run-b" }));
        await nextRunStatus.promise;
      });
      await vi.waitFor(() => {
        expect(latestStatusRunId).toBe("run-b");
        expect(stageExecutionLoad).toHaveBeenCalledTimes(2);
        expect(latestStageExecution?.data).toBeNull();
        expect(container.textContent).toBe("no stage run");
      });

      await act(async () => {
        nextRunExecution.resolve(stageExecutionAt("run-b", 2));
        await nextRunExecution.promise;
      });
      await vi.waitFor(() => {
        expect(latestStageExecution?.status).toBe("ready");
        expect(latestStageExecution?.data?.run_id).toBe("run-b");
        expect(container.textContent).toBe("run-b");
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("treats an absent current run as an empty resource without emitting a load failure", async () => {
    const currentRunLoad = vi.fn(
      (_options?: { sessionScopeKey?: string; signal?: AbortSignal }) =>
        Promise.reject(new ControlRoomApiError("no active run", 404)),
    );
    const bus = new EventBus<KernelEventMap>();
    const failures: KernelEventMap["resource:load-failed"][] = [];
    bus.on("resource:load-failed", (event) => {
      failures.push(event);
    });
    const resources = new ResourceInvalidationController(bus);
    const kernel = {
      api: {
        sessions: {
          ...sessionsApi,
          current: {
            status: async () => statusAt(0, { run_id: "run-1" }),
          },
        },
        simulation: { currentRun: currentRunLoad },
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
    const latest: { current: ReturnType<typeof useCurrentRunResource> | null } = { current: null };

    function Harness() {
      latest.current = useCurrentRunResource();
      return null;
    }

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <Harness />
          </KernelContext.Provider>,
        );
      });
      await vi.waitFor(() => {
        expect(currentRunLoad).toHaveBeenCalledTimes(1);
        expect(latest.current?.status).toBe("ready");
      });
      expect(currentRunLoad).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionScopeKey: SCRATCH_SESSION_SCOPE_KEY,
        }),
      );
      expect(latest.current?.data).toBeNull();
      expect(latest.current?.error).toBeNull();
      expect(failures).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it.each([
    { label: "timeout", errorName: "TimeoutError", notify: false },
    { label: "non-timeout failure", errorName: "Error", notify: true },
  ])(
    "keeps periodic-pair $label state and applies its notification policy",
    async ({ errorName, notify }) => {
      const failure = new Error("periodic-pair load failed");
      failure.name = errorName;
      const periodicPairsLoad = vi.fn(
        (_options?: { sessionScopeKey?: string; signal?: AbortSignal }) =>
          Promise.reject(failure),
      );
      const bus = new EventBus<KernelEventMap>();
      const failures: KernelEventMap["resource:load-failed"][] = [];
      const unsubscribeFailure = bus.on("resource:load-failed", (event) => {
        failures.push(event);
      });
      const resources = new ResourceInvalidationController(bus);
      const kernel = {
        api: {
          meshing: { periodicPairs: periodicPairsLoad },
          sessions: {
            ...sessionsApi,
            current: { status: async () => statusAt(0) },
          },
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
      const latest: {
        current: ReturnType<typeof useMeshPeriodicPairsResource> | null;
      } = { current: null };

      function Harness() {
        latest.current = useMeshPeriodicPairsResource();
        return null;
      }

      try {
        await act(async () => {
          root.render(
            <KernelContext.Provider value={kernel}>
              <Harness />
            </KernelContext.Provider>,
          );
        });
        await vi.waitFor(() => {
          expect(periodicPairsLoad).toHaveBeenCalledTimes(1);
          expect(latest.current?.status).toBe("error");
        });

        expect(periodicPairsLoad).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionScopeKey: SCRATCH_SESSION_SCOPE_KEY,
          }),
        );
        expect(latest.current?.error).toBe(failure);
        const expectedResourceKey =
          `${SCRATCH_SESSION_SCOPE_KEY}|${MESHING_PERIODIC_PAIRS_PATH}`;
        if (notify) {
          expect(failures).toEqual([
            expect.objectContaining({
              resourceKey: expectedResourceKey,
            }),
          ]);
        } else {
          expect(failures).toEqual([]);
        }
      } finally {
        unsubscribeFailure();
        await act(async () => root.unmount());
        dom.restore();
      }
    },
  );

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
      sessions: { ...sessionsApi, current: { status: statusLoad } },
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
