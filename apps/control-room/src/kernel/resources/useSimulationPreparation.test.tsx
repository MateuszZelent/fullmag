import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SESSIONS_PATH, SIMULATION_PREPARATION_PATH } from "../api/apiPaths";
import type {
  LiveStatusResource,
  SessionListResource,
  SimulationPreparationResource,
} from "../api/apiTypes";
import { ControlRoomApiError } from "../api/ControlRoomApi";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { KernelContext } from "../KernelContext";
import { DiagnosticRecorderController } from "../performance/diagnostic-recorder/DiagnosticRecorderController";
import { updateRealtimeCommunicationPolicy } from "../realtime/communicationPolicy";
import type { ResourceResult } from "./resourceTypes";
import { ResourceInvalidationController } from "./ResourceInvalidationController";
import { resetSharedResourceRuntimeStoreForTests } from "./ResourceRuntimeStore";
import { sessionScopedResourceKey } from "./sessionResourceIdentity";
import { useSimulationPreparation } from "./useSimulationPreparation";
import { SESSION_STATUS_RESOURCE_KEY } from "./useSessionStatus";
import {
  preparationMinimumRevision,
  preparationPublicationState,
  preparationRetryKey,
} from "./simulationPreparationPublication";

interface Deferred<TData> {
  promise: Promise<TData>;
  reject: (reason?: unknown) => void;
  resolve: (value: TData) => void;
}

type PreparationResult = ResourceResult<SimulationPreparationResource>;

afterEach(() => {
  updateRealtimeCommunicationPolicy({});
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSharedResourceRuntimeStoreForTests();
});

function deferred<TData>(): Deferred<TData> {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: TData) => void;
  const promise = new Promise<TData>((promiseResolve, promiseReject) => {
    reject = promiseReject;
    resolve = promiseResolve;
  });
  return { promise, reject, resolve };
}

function preparationFixture(revision: number): SimulationPreparationResource {
  return {
    active_stage_id: "planning",
    completed_at_unix_ms: null,
    failure: null,
    log_tail: [],
    preparation_id: "prep-1",
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
    revision,
    stages: [],
    started_at_unix_ms: 1_000,
    status: "running",
  };
}

function statusFixture(): LiveStatusResource {
  return {
    resources: { simulation_preparation_revision: 0 },
    session: {
      session_epoch: "session-1@1700000000000",
      session_id: "session-1",
      request_scope_epoch: "api-instance:1",
    },
    solver: { state: "awaiting_command" },
  } as LiveStatusResource;
}

function makeKernel(
  preparation: (options?: { signal?: AbortSignal }) => Promise<SimulationPreparationResource>,
  publishedPreparationRevision: number | (() => Promise<LiveStatusResource>) = 0,
  currentSessionId: () => string = () => "session-1",
) {
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  return {
    kernel: {
      api: {
        sessions: {
          current: { status: typeof publishedPreparationRevision === "function"
            ? publishedPreparationRevision
            : async () => ({
                ...statusFixture(),
                resources: { simulation_preparation_revision: publishedPreparationRevision },
              }) },
          // Session identity is confirmed against the session collection.
          list: async () => ({
            schema_version: "2.0.0",
            sessions: [
              {
                current: true,
                name: "session-1",
                session_id: currentSessionId(),
                status: "running",
              },
            ],
          }),
        },
        simulation: { preparation },
      },
      bus,
      diagnosticRecorder: new DiagnosticRecorderController({
        config: { enabled: false },
      }),
      resources,
    } as NonNullable<React.ComponentProps<typeof KernelContext.Provider>["value"]>,
    bus,
    resources,
  };
}

function Probe({
  enabled = true,
  observations,
  requiredRevision,
}: {
  enabled?: boolean;
  observations: PreparationResult[];
  requiredRevision?: number | null;
}) {
  observations.push(useSimulationPreparation({ enabled, requiredRevision }));
  return null;
}

function resultSnapshot(result: PreparationResult) {
  return {
    data: result.data,
    error: result.error,
    revision: result.revision,
    status: result.status,
  };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let index = 0; index < 25; index += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    });
  }
  throw new Error(message);
}

describe("useSimulationPreparation", () => {
  it.each([
    { publishedRevision: 0, requiredRevision: 7, status: 404, reports: true },
    { publishedRevision: 7, requiredRevision: null, status: 404, reports: true },
    { publishedRevision: 1, requiredRevision: null, status: 401, reports: true },
    { publishedRevision: 1, requiredRevision: null, status: 500, reports: true },
  ])("reports only unexpected initial failures: %j", async (testCase) => {
    const failure = new ControlRoomApiError("preparation unavailable", testCase.status);
    const load = vi.fn(() => Promise.reject(failure));
    const { bus, kernel } = makeKernel(load, testCase.publishedRevision);
    const failures: KernelEventMap["resource:load-failed"][] = [];
    const unsubscribe = bus.on("resource:load-failed", (event) => failures.push(event));
    const observations: PreparationResult[] = [];
    const dom = installTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <Probe observations={observations} requiredRevision={testCase.requiredRevision} />
          </KernelContext.Provider>,
        );
      });
      await waitFor(
        () => observations.some((observation) => observation.status === "error"),
        "preparation failure did not remain visible",
      );
      expect(observations.at(-1)).toMatchObject({ data: null, error: failure, status: "error" });
      expect(failures.some((event) => event.resourceKey.endsWith(SIMULATION_PREPARATION_PATH)))
        .toBe(testCase.reports);
    } finally {
      unsubscribe();
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("waits for unknown publication and loads only a published preparation", () => {
    expect(preparationPublicationState(undefined, null)).toBe("unknown");
    expect(preparationPublicationState(undefined, 7)).toBe("unknown");
    expect(preparationPublicationState(null, null)).toBe("absent");
    expect(preparationPublicationState(0, null)).toBe("absent");
    expect(preparationPublicationState(7, null)).toBe("published");
    expect(preparationPublicationState(0, 7)).toBe("published");
    expect(preparationMinimumRevision(8, null)).toBe(8);
    expect(preparationMinimumRevision(8, 9)).toBe(9);
    expect(preparationMinimumRevision(undefined, 9)).toBeNull();
    expect(preparationRetryKey("session=A&epoch=1&request_scope_epoch=X|preparation", 7))
      .not.toBe(preparationRetryKey("session=A&epoch=2&request_scope_epoch=X|preparation", 7));
  });

  it("keeps an unpublished scratch preparation idle without issuing a GET", async () => {
    const load = vi.fn(() => Promise.reject(new ControlRoomApiError("not found", 404)));
    const { bus, kernel } = makeKernel(load);
    const failures: KernelEventMap["resource:load-failed"][] = [];
    const unsubscribe = bus.on("resource:load-failed", (event) => failures.push(event));
    const observations: PreparationResult[] = [];
    const dom = installTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    try {
      await act(async () => {
        root.render(<KernelContext.Provider value={kernel}>
          <Probe observations={observations} />
        </KernelContext.Provider>);
      });
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      });
      expect(load).not.toHaveBeenCalled();
      expect(observations.at(-1)).toMatchObject({ data: null, error: null, status: "idle" });
      await act(async () => observations.at(-1)!.refetch());
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      });
      expect(load).not.toHaveBeenCalled();
      expect(failures).toEqual([]);
    } finally {
      unsubscribe();
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not probe absence during a status refresh and starts after positive publication", async () => {
    updateRealtimeCommunicationPolicy({ status_refresh_ms: 1 });
    const refresh = deferred<LiveStatusResource>();
    const statusLoad = vi.fn()
      .mockResolvedValueOnce(statusFixture())
      .mockImplementationOnce(() => refresh.promise)
      .mockResolvedValue({
        ...statusFixture(), resources: { simulation_preparation_revision: 7 },
      });
    const load = vi.fn(() => Promise.resolve(preparationFixture(7)));
    const { kernel, resources } = makeKernel(load, statusLoad);
    const observations: PreparationResult[] = [];
    const dom = installTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    try {
      await act(async () => {
        root.render(<KernelContext.Provider value={kernel}>
          <Probe observations={observations} />
        </KernelContext.Provider>);
      });
      await waitFor(() => statusLoad.mock.calls.length === 1, "initial status did not load");
      await act(async () => {
        resources.invalidate(SESSION_STATUS_RESOURCE_KEY, "transport:1");
        resources.invalidate(SIMULATION_PREPARATION_PATH, "transport:1");
      });
      await waitFor(() => statusLoad.mock.calls.length === 2, "status refresh did not load");
      await act(async () => observations.at(-1)!.refetch());
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      });
      expect(load).not.toHaveBeenCalled();
      await act(async () => {
        refresh.resolve(statusFixture());
        await refresh.promise;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      });
      expect(load).not.toHaveBeenCalled();
      expect(observations.at(-1)).toMatchObject({ data: null, status: "idle" });
      await act(async () => resources.invalidate(SESSION_STATUS_RESOURCE_KEY, "transport:2"));
      await waitFor(() => load.mock.calls.length === 1, "published preparation did not load");
      await waitFor(() => observations.at(-1)?.status === "ready", "published preparation was not ready");
      expect(observations.at(-1)?.data?.revision).toBe(7);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("refreshes a new canonical minimum without explicit requiredRevision or preparation invalidation", async () => {
    updateRealtimeCommunicationPolicy({ status_refresh_ms: 1 });
    let revision = 7;
    const statusLoad = vi.fn(async () => ({
      ...statusFixture(),
      resources: { ...statusFixture().resources, simulation_preparation_revision: revision },
    }));
    const load = vi.fn(async () => preparationFixture(revision));
    const { kernel, resources } = makeKernel(load, statusLoad);
    const observations: PreparationResult[] = [];
    const dom = installTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    try {
      await act(async () => root.render(<KernelContext.Provider value={kernel}>
        <Probe observations={observations} />
      </KernelContext.Provider>));
      await waitFor(() => observations.at(-1)?.data?.revision === 7, "initial publication did not load");
      // A higher transport pointer must not stand in for a preparation revision.
      await act(async () => resources.invalidate(SIMULATION_PREPARATION_PATH, 100));
      await waitFor(() => load.mock.calls.length === 2, "transport refresh did not load");
      await waitFor(() => observations.at(-1)?.status === "ready", "transport refresh did not settle");
      revision = 8;
      await act(async () => resources.invalidate(SESSION_STATUS_RESOURCE_KEY, "status:next"));
      await waitFor(() => observations.at(-1)?.data?.revision === 8, "canonical minimum did not refresh");
      expect(load).toHaveBeenCalledTimes(3);
      await act(async () => observations.at(-1)!.refetch());
      await waitFor(() => load.mock.calls.length === 4, "published manual refresh was blocked");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("retries the same revision separately for different confirmed sessions", async () => {
    vi.useFakeTimers();
    updateRealtimeCommunicationPolicy({ status_refresh_ms: 1, error_retry_ms: 10 });
    let sessionId = "session-1";
    const statusLoad = vi.fn(async (): Promise<LiveStatusResource> => ({
      ...statusFixture(),
      resources: { ...statusFixture().resources, simulation_preparation_revision: 7 },
      session: {
        ...statusFixture().session,
        session_id: sessionId,
        session_epoch: `${sessionId}@1700000000000`,
      },
    }));
    const load = vi.fn()
      .mockRejectedValueOnce(new ControlRoomApiError("upstream unavailable", 502))
      .mockResolvedValueOnce(preparationFixture(7))
      .mockRejectedValueOnce(new ControlRoomApiError("upstream unavailable", 502))
      .mockResolvedValueOnce(preparationFixture(7));
    const { kernel, resources } = makeKernel(load, statusLoad, () => sessionId);
    const observations: PreparationResult[] = [];
    const dom = installTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    try {
      await act(async () => root.render(<KernelContext.Provider value={kernel}>
        <Probe observations={observations} />
      </KernelContext.Provider>));
      await waitForPhase(() => load.mock.calls.length === 1 && observations.at(-1)?.status === "error", "session A initial failure");
      expect(load).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(11));
      await waitForPhase(() => observations.at(-1)?.status === "ready", "session A retry completion");
      expect(load).toHaveBeenCalledTimes(2);
      const nextStatus = deferred<LiveStatusResource>();
      const nextCollection = deferred<SessionListResource>();
      statusLoad.mockImplementationOnce(() => nextStatus.promise);
      const collectionLoad = vi.spyOn(kernel.api.sessions, "list")
        .mockImplementationOnce(() => nextCollection.promise);
      sessionId = "session-2";
      await act(async () => {
        resources.invalidate(SESSIONS_PATH, "session:next");
        resources.invalidate(SESSION_STATUS_RESOURCE_KEY, "session:next");
      });
      await waitForPhase(() => collectionLoad.mock.calls.length === 1 && statusLoad.mock.calls.length === 2, "session B identity requests");
      expect(load).toHaveBeenCalledTimes(2);
      await act(async () => {
        nextStatus.resolve({
          ...statusFixture(),
          resources: { ...statusFixture().resources, simulation_preparation_revision: 7 },
          session: { ...statusFixture().session, session_id: sessionId, session_epoch: `${sessionId}@1700000000000` },
        });
        await nextStatus.promise;
        await vi.advanceTimersByTimeAsync(1);
      });
      // Status B cannot authorize preparation while the collection still names A.
      expect(load).toHaveBeenCalledTimes(2);
      await act(async () => {
        nextCollection.resolve({
          schema_version: "2.0.0",
          sessions: [{ current: true, name: sessionId, session_id: sessionId, status: "running" }],
        });
        await nextCollection.promise;
      });
      await waitForPhase(() => load.mock.calls.length === 3 && observations.at(-1)?.status === "error", "confirmed session B initial failure");
      expect(load).toHaveBeenCalledTimes(3);
      await act(async () => vi.advanceTimersByTimeAsync(11));
      await waitForPhase(() => observations.at(-1)?.status === "ready", "session B retry completion");
      expect(load).toHaveBeenCalledTimes(4);
      expect(load.mock.calls.map(([options]) => options.sessionScopeKey)).toEqual([
        "session=session-1&epoch=session-1%401700000000000&request_scope_epoch=api-instance%3A1",
        "session=session-1&epoch=session-1%401700000000000&request_scope_epoch=api-instance%3A1",
        "session=session-2&epoch=session-2%401700000000000&request_scope_epoch=api-instance%3A1",
        "session=session-2&epoch=session-2%401700000000000&request_scope_epoch=api-instance%3A1",
      ]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }

    async function waitForPhase(predicate: () => boolean, phase: string): Promise<void> {
      for (let tick = 0; tick < 6; tick += 1) {
        if (predicate()) return;
        await act(async () => vi.advanceTimersByTimeAsync(1));
      }
      expect(predicate(), `${phase}: ${JSON.stringify({
        loadScopes: load.mock.calls.map(([options]) => options.sessionScopeKey),
        observations: observations.slice(-6).map(resultSnapshot),
        statusRequests: statusLoad.mock.calls.length,
      })}`).toBe(true);
    }
  });

  it("retries a failed load while the status advertises an unread preparation revision", async () => {
    vi.useFakeTimers();
    updateRealtimeCommunicationPolicy({ error_retry_ms: 10 });
    const load = vi
      .fn()
      .mockRejectedValueOnce(new ControlRoomApiError("upstream unavailable", 502))
      .mockResolvedValueOnce(preparationFixture(8));
    const { kernel, resources } = makeKernel(load);
    const observations: PreparationResult[] = [];
    const dom = installTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    resources.invalidate(SIMULATION_PREPARATION_PATH, 8);

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <Probe observations={observations} requiredRevision={8} />
          </KernelContext.Provider>,
        );
      });
      // Session identity (status + session collection) enables the scoped
      // hook in a later React commit; advance the fake clock past each hop.
      for (let index = 0; index < 4; index += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
        });
      }

      expect(load).toHaveBeenCalledTimes(1);
      expect(resultSnapshot(observations.at(-1)!)).toMatchObject({
        data: null,
        revision: 8,
        status: "error",
      });

      await act(async () => {
        await Promise.resolve();
      });
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      expect(load).toHaveBeenCalledTimes(2);
      expect(resultSnapshot(observations.at(-1)!)).toMatchObject({
        data: { revision: 8 },
        revision: 8,
        status: "ready",
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it.each([
    new ControlRoomApiError("authorization token secret-token rejected", 401),
    new ControlRoomApiError(
      "API contract version mismatch: expected 1.0.0, got 0.9.0",
      0,
    ),
    new ControlRoomApiError("internal path /private/model.py failed", 500),
  ])("keeps an initial non-transient facade failure visible", async (failure) => {
    const load = vi.fn(() => Promise.reject(failure));
    const { kernel, resources } = makeKernel(load);
    const observations: PreparationResult[] = [];
    const dom = installTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    resources.invalidate(SIMULATION_PREPARATION_PATH, 1);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <Probe observations={observations} requiredRevision={1} />
        </KernelContext.Provider>,
      );
    });
    let latest: ReturnType<typeof resultSnapshot> | null = null;
    try {
      await waitFor(
        () => observations.some((observation) => observation.status === "error"),
        "initial preparation failure was normalized away",
      );
      latest = resultSnapshot(observations.at(-1)!);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }

    expect(latest).toEqual({
      data: null,
      error: failure,
      revision: 1,
      status: "error",
    });
  });

  it("retains stale revision 7 while 8 loads, adopts 8, and keeps it when refresh fails", async () => {
    updateRealtimeCommunicationPolicy({ status_refresh_ms: 1 });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const revision7 = deferred<SimulationPreparationResource>();
    const revision8 = deferred<SimulationPreparationResource>();
    const revision9 = deferred<SimulationPreparationResource>();
    const load = vi
      .fn()
      .mockImplementationOnce(() => revision7.promise)
      .mockImplementationOnce(() => revision8.promise)
      .mockImplementation(() => revision9.promise);
    const { bus, kernel, resources } = makeKernel(load);
    const observations: PreparationResult[] = [];
    const dom = installTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    resources.invalidate(SIMULATION_PREPARATION_PATH, 7);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
        <Probe observations={observations} requiredRevision={7} />
        </KernelContext.Provider>,
      );
    });

    expect(resultSnapshot(observations[0]!)).toMatchObject({
      data: null,
      revision: 7,
      status: "idle",
    });
    await waitFor(() => load.mock.calls.length === 1, "revision 7 did not load");
    expect(
      observations.some((observation) => observation.status === "loading"),
    ).toBe(true);
    await act(async () => {
      revision7.resolve(preparationFixture(7));
      await revision7.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(resultSnapshot(observations.at(-1)!)).toMatchObject({
      data: { revision: 7 },
      revision: 7,
      status: "ready",
    });

    now.mockReturnValue(2_000);
    await act(async () => {
      resources.invalidate(SIMULATION_PREPARATION_PATH, 8);
    });
    const staleRevision8 = resultSnapshot(observations.at(-1)!);
    await waitFor(() => load.mock.calls.length === 2, "revision 8 did not load");
    await act(async () => {
      revision8.resolve(preparationFixture(8));
      await revision8.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(resultSnapshot(observations.at(-1)!)).toMatchObject({
      data: { revision: 8 },
      revision: 8,
      status: "ready",
    });

    const failure = new Error("preparation unavailable");
    now.mockReturnValue(3_000);
    const failures: KernelEventMap["resource:load-failed"][] = [];
    const unsubscribeFailure = bus.on("resource:load-failed", (event) => {
      failures.push(event);
    });
    await act(async () => {
      resources.invalidate(SIMULATION_PREPARATION_PATH, 9);
    });
    const staleRevision9 = resultSnapshot(observations.at(-1)!);
    await waitFor(() => load.mock.calls.length === 3, "revision 9 did not load");
    await act(async () => {
      revision9.reject(failure);
      await revision9.promise.catch(() => undefined);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    const failedRevision9 = resultSnapshot(observations.at(-1)!);

    unsubscribeFailure();
    await act(async () => root.unmount());
    dom.restore();
    expect(staleRevision8).toMatchObject({
      data: { revision: 7 },
      revision: 8,
      status: "stale",
    });
    expect(staleRevision9).toMatchObject({
      data: { revision: 8 },
      revision: 9,
      status: "stale",
    });
    expect(failedRevision9).toEqual({
      data: preparationFixture(8),
      error: null,
      revision: 9,
      status: "stale",
    });
    expect(failures).toEqual([
      {
        cause: "preparation unavailable",
        errorName: "Error",
        resourceKey: sessionScopedResourceKey(
          {
            requestScopeEpoch: "api-instance:1",
            sessionEpoch: "session-1@1700000000000",
            sessionId: "session-1",
          },
          SIMULATION_PREPARATION_PATH,
        ),
        revision: 9,
        situation: "Loading runtime resource through the v2 resource hook",
        source: "resource-hook",
        status: null,
      },
    ]);
  });

  it("keeps disabled hooks idle without issuing a request", async () => {
    const load = vi.fn(() => Promise.resolve(preparationFixture(1)));
    const { kernel } = makeKernel(load);
    const observations: PreparationResult[] = [];
    const dom = installTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <Probe enabled={false} observations={observations} />
        </KernelContext.Provider>,
      );
    });

    expect(resultSnapshot(observations.at(-1)!)).toMatchObject({
      data: null,
      revision: null,
      status: "idle",
    });
    expect(load).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    dom.restore();
  });

  it("uses the deterministic server snapshot and client revision before aborting", async () => {
    const pending = deferred<SimulationPreparationResource>();
    let signal: AbortSignal | undefined;
    const load = vi.fn((options?: { signal?: AbortSignal }) => {
      signal = options?.signal;
      return pending.promise;
    });
    const { kernel, resources } = makeKernel(load, 11);
    resources.invalidate(SIMULATION_PREPARATION_PATH, 11);
    const serverObservations: PreparationResult[] = [];
    renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <Probe observations={serverObservations} />
      </KernelContext.Provider>,
    );

    const clientObservations: PreparationResult[] = [];
    const dom = installTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
          <Probe observations={clientObservations} requiredRevision={11} />
          </KernelContext.Provider>,
        );
      });

      expect(resultSnapshot(serverObservations[0]!)).toEqual({
        data: null,
        error: null,
        revision: null,
        status: "idle",
      });
      expect(resultSnapshot(clientObservations[0]!)).toEqual({
        data: null,
        error: null,
        revision: 11,
        status: "idle",
      });
      await waitFor(() => load.mock.calls.length === 1, "request did not start");
      expect(signal?.aborted).toBe(false);
    } finally {
      await act(async () => root.unmount());
      expect(signal?.aborted).toBe(true);
      dom.restore();
    }
  });
});

class TestNode {
  readonly childNodes: TestNode[] = [];
  ownerDocument: TestDocument;
  parentNode: TestNode | null = null;
  readonly nodeType: number;
  readonly nodeName: string;
  nodeValue: string | null = null;

  constructor(ownerDocument: TestDocument, nodeType: number, nodeName: string) {
    this.ownerDocument = ownerDocument;
    this.nodeType = nodeType;
    this.nodeName = nodeName;
  }

  get firstChild(): TestNode | null {
    return this.childNodes[0] ?? null;
  }

  appendChild<T extends TestNode>(child: T): T {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore<T extends TestNode>(child: T, before: TestNode | null): T {
    if (!before) return this.appendChild(child);
    const index = this.childNodes.indexOf(before);
    child.parentNode = this;
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child);
    return child;
  }

  removeChild<T extends TestNode>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

class TestElement extends TestNode {
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly tagName: string;

  constructor(ownerDocument: TestDocument, tagName: string) {
    super(ownerDocument, 1, tagName.toUpperCase());
    this.tagName = tagName.toUpperCase();
  }
}

class TestDocument extends TestNode {
  readonly body: TestElement;
  readonly documentElement: TestElement;
  defaultView: Record<string, unknown> | null = null;

  constructor() {
    super(null as unknown as TestDocument, 9, "#document");
    this.ownerDocument = this;
    this.documentElement = new TestElement(this, "html");
    this.body = new TestElement(this, "body");
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
  }

  createComment(value: string): TestNode {
    const node = new TestNode(this, 8, "#comment");
    node.nodeValue = value;
    return node;
  }

  createElement(tagName: string): TestElement {
    return new TestElement(this, tagName);
  }

  createElementNS(_namespace: string, tagName: string): TestElement {
    return this.createElement(tagName);
  }

  createTextNode(value: string): TestNode {
    const node = new TestNode(this, 3, "#text");
    node.nodeValue = value;
    return node;
  }
}

function installTestDom(): {
  document: TestDocument;
  restore: () => void;
} {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const document = new TestDocument();
  class TestHtmlIFrameElement extends TestElement {}
  const window = {
    document,
    Element: TestElement,
    HTMLElement: TestElement,
    HTMLIFrameElement: TestHtmlIFrameElement,
    Node: TestNode,
    addEventListener() {},
    removeEventListener() {},
  };
  document.defaultView = window;
  for (const [key, value] of Object.entries({
    document,
    Element: TestElement,
    HTMLElement: TestElement,
    Node: TestNode,
    window,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  return {
    document,
    restore: () => {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
