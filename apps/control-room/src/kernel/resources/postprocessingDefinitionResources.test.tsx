import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ANALYSIS_POSTPROCESSING_DEFINITIONS_PATH,
  SESSIONS_PATH,
} from "@/kernel/api/apiPaths";
import type {
  LiveStatusResource,
  PostprocessingDefinitionCollectionResource,
  SessionListResource,
} from "@/kernel/api/apiTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { updateRealtimeCommunicationPolicy } from "@/kernel/realtime/communicationPolicy";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { resetSharedResourceRuntimeStoreForTests } from "@/kernel/resources/ResourceRuntimeStore";
import type { KernelApi } from "@/kernel/types";

import { usePostprocessingDefinitionsResource } from "./postprocessingDefinitionResources";
import { SESSION_STATUS_RESOURCE_KEY } from "./useSessionStatus";

interface SessionIdentityFixture {
  requestScopeEpoch: string;
  sessionEpoch: string;
  sessionId: string;
}

interface DefinitionsLoadOptions {
  sessionScopeKey?: string;
  signal?: AbortSignal;
}

type DefinitionsLoader = (
  options: DefinitionsLoadOptions,
) => Promise<PostprocessingDefinitionCollectionResource>;
type SessionListLoader = () => Promise<SessionListResource>;
type SessionStatusLoader = () => Promise<LiveStatusResource>;

const SESSION_A: SessionIdentityFixture = {
  requestScopeEpoch: "api-instance:a",
  sessionEpoch: "session-a@1",
  sessionId: "session-a",
};

const SESSION_B: SessionIdentityFixture = {
  requestScopeEpoch: "api-instance:b",
  sessionEpoch: "session-b@2",
  sessionId: "session-b",
};

afterEach(() => {
  updateRealtimeCommunicationPolicy({});
  resetSharedResourceRuntimeStoreForTests();
  vi.useRealTimers();
});

function deferred<TData>() {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: TData) => void;
  const promise = new Promise<TData>((promiseResolve, promiseReject) => {
    reject = promiseReject;
    resolve = promiseResolve;
  });
  return { promise, reject, resolve };
}

function sessionListFixture(session: SessionIdentityFixture): SessionListResource {
  return {
    schema_version: "2.0.0",
    sessions: [
      {
        current: true,
        name: session.sessionId,
        session_id: session.sessionId,
        status: "running",
      },
    ],
  } as SessionListResource;
}

function statusFixture(session: SessionIdentityFixture): LiveStatusResource {
  return {
    resources: {
      scene_revision: session.sessionId === SESSION_A.sessionId ? 1 : 2,
    },
    session: {
      session_epoch: session.sessionEpoch,
      session_id: session.sessionId,
      request_scope_epoch: session.requestScopeEpoch,
    },
    solver: { state: "awaiting_command" },
  } as LiveStatusResource;
}

function definitionsFixture(
  sceneRevision: number,
  definitionId: string,
): PostprocessingDefinitionCollectionResource {
  return {
    definitions: [{ definition_id: definitionId }],
    scene_revision: sceneRevision,
  } as PostprocessingDefinitionCollectionResource;
}

function makeKernel(
  getSession: () => SessionIdentityFixture,
  listDefinitions: DefinitionsLoader,
) {
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  const listSessions = vi.fn<SessionListLoader>(async () =>
    sessionListFixture(getSession()),
  );
  const loadSessionStatus = vi.fn<SessionStatusLoader>(async () =>
    statusFixture(getSession()),
  );
  const kernel = {
    api: {
      sessions: {
        list: listSessions,
        current: {
          status: loadSessionStatus,
        },
      },
      analysis: {
        postprocessing: {
          definitions: { list: listDefinitions },
        },
      },
    },
    bus,
    diagnosticRecorder: new DiagnosticRecorderController({
      config: { enabled: false },
    }),
    resources,
  } as unknown as KernelApi;
  return { kernel, listSessions, loadSessionStatus, resources };
}

interface MockCallTracker {
  mock: { calls: unknown[] };
}

async function waitForSessionAdmission(
  loaders: {
    definitions: MockCallTracker;
    sessionList: MockCallTracker;
    sessionStatus: MockCallTracker;
  },
  expectedCalls: {
    definitions: number;
    sessionList: number;
    sessionStatus: number;
  },
): Promise<void> {
  for (
    let pass = 0;
    pass < 25 &&
    loaders.definitions.mock.calls.length < expectedCalls.definitions;
    pass += 1
  ) {
    // Session collection, status, and the scoped resource each start in a
    // later React commit, so give each effect a positive timer tick to run.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }

  // One tuple-scoped recovery may reconcile collection/status after a session change.
  for (const [loader, expected] of [
    [loaders.sessionList, expectedCalls.sessionList],
    [loaders.sessionStatus, expectedCalls.sessionStatus],
  ] as const) {
    expect(loader.mock.calls.length).toBeGreaterThanOrEqual(expected);
    expect(loader.mock.calls.length).toBeLessThanOrEqual(expected + 1);
  }
  expect(loaders.definitions.mock.calls).toHaveLength(expectedCalls.definitions);
  const settledCalls = [loaders.sessionList, loaders.sessionStatus, loaders.definitions]
    .map(loader => loader.mock.calls.length);
  await act(async () => { await vi.advanceTimersByTimeAsync(6); });
  expect([loaders.sessionList, loaders.sessionStatus, loaders.definitions]
    .map(loader => loader.mock.calls.length)).toEqual(settledCalls);
}

function Probe() {
  const resource = usePostprocessingDefinitionsResource();
  const definitionId = resource.data?.definitions[0]?.definition_id ?? "none";
  return (
    <div data-resource>
      {resource.status + ":" + definitionId + ":" + String(resource.revision ?? "none")}
    </div>
  );
}

function mountProbe(kernel: KernelApi) {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  return {
    container,
    dom,
    render: () =>
      root.render(
        <KernelContext.Provider value={kernel}>
          <Probe />
        </KernelContext.Provider>,
      ),
    root,
  };
}

async function flushResourceWork(advanceMs = 1): Promise<void> {
  for (let pass = 0; pass < 6; pass += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(advanceMs);
    });
  }
}

describe("postprocessing definitions resource revisions", () => {
  it("retains the last-good definitions during revision refresh and after refresh failure", async () => {
    vi.useFakeTimers();
    const revision12 = deferred<PostprocessingDefinitionCollectionResource>();
    const revision13 = deferred<PostprocessingDefinitionCollectionResource>();
    const listDefinitions = vi
      .fn<DefinitionsLoader>()
      .mockResolvedValueOnce(definitionsFixture(11, "definitions-revision-11"))
      .mockReturnValueOnce(revision12.promise)
      .mockReturnValueOnce(revision13.promise);
    const { kernel, listSessions, loadSessionStatus, resources } = makeKernel(
      () => SESSION_A,
      listDefinitions,
    );
    const mounted = mountProbe(kernel);

    try {
      await act(async () => mounted.render());
      await waitForSessionAdmission(
        {
          definitions: listDefinitions,
          sessionList: listSessions,
          sessionStatus: loadSessionStatus,
        },
        { definitions: 1, sessionList: 1, sessionStatus: 1 },
      );
      await flushResourceWork();

      expect(listDefinitions).toHaveBeenCalledTimes(1);
      expect(listDefinitions.mock.calls[0]?.[0].sessionScopeKey).toContain(
        "session=session-a",
      );
      expect(mounted.container.textContent).toContain("definitions-revision-11");

      await act(async () => {
        resources.invalidate(ANALYSIS_POSTPROCESSING_DEFINITIONS_PATH, 12);
      });
      await flushResourceWork();

      expect(listDefinitions).toHaveBeenCalledTimes(2);
      expect(mounted.container.textContent).toContain("definitions-revision-11");
      expect(mounted.container.textContent).not.toContain("definitions-revision-12");

      await act(async () => {
        revision12.resolve(definitionsFixture(12, "definitions-revision-12"));
        await revision12.promise;
      });

      expect(mounted.container.textContent).toContain("definitions-revision-12");
      expect(mounted.container.textContent).not.toContain("definitions-revision-11");
      expect(mounted.container.textContent).toContain("definitions-revision-12:12");

      await act(async () => {
        resources.invalidate(ANALYSIS_POSTPROCESSING_DEFINITIONS_PATH, 13);
      });
      await flushResourceWork();

      expect(listDefinitions).toHaveBeenCalledTimes(3);
      expect(mounted.container.textContent).toContain("definitions-revision-12");

      await act(async () => {
        revision13.reject(new Error("definitions refresh failed"));
        await revision13.promise.catch(() => undefined);
      });

      expect(mounted.container.textContent).toContain("definitions-revision-12");
      expect(mounted.container.textContent).not.toContain("definitions-revision-13");
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.dom.restore();
    }
  });

  it("does not expose a previous session's definitions while the new session loads", async () => {
    updateRealtimeCommunicationPolicy({ status_refresh_ms: 1 });
    vi.useFakeTimers();
    const sessionBDefinitions = deferred<PostprocessingDefinitionCollectionResource>();
    let currentSession = SESSION_A;
    const listDefinitions = vi.fn<DefinitionsLoader>((options) =>
      options.sessionScopeKey?.includes("session=session-b")
        ? sessionBDefinitions.promise
        : Promise.resolve(definitionsFixture(11, "definitions-session-a")),
    );
    const { kernel, listSessions, loadSessionStatus, resources } = makeKernel(
      () => currentSession,
      listDefinitions,
    );
    const mounted = mountProbe(kernel);

    try {
      await act(async () => mounted.render());
      await waitForSessionAdmission(
        {
          definitions: listDefinitions,
          sessionList: listSessions,
          sessionStatus: loadSessionStatus,
        },
        { definitions: 1, sessionList: 1, sessionStatus: 1 },
      );
      await flushResourceWork();

      expect(listDefinitions).toHaveBeenCalledTimes(1);
      expect(listDefinitions.mock.calls[0]?.[0].sessionScopeKey).toContain(
        "session=session-a",
      );
      expect(mounted.container.textContent).toContain("definitions-session-a");

      currentSession = SESSION_B;
      const expectedSessionListCalls = listSessions.mock.calls.length + 1;
      const expectedSessionStatusCalls = loadSessionStatus.mock.calls.length + 1;
      await act(async () => {
        resources.invalidate(SESSIONS_PATH, 2);
        resources.invalidate(SESSION_STATUS_RESOURCE_KEY, 2);
      });
      await waitForSessionAdmission(
        {
          definitions: listDefinitions,
          sessionList: listSessions,
          sessionStatus: loadSessionStatus,
        },
        {
          definitions: 2,
          sessionList: expectedSessionListCalls,
          sessionStatus: expectedSessionStatusCalls,
        },
      );
      await flushResourceWork();

      expect(listDefinitions).toHaveBeenCalledTimes(2);
      expect(listDefinitions.mock.calls[1]?.[0].sessionScopeKey).toContain(
        "session=session-b",
      );
      expect(mounted.container.textContent).not.toContain("definitions-session-a");

      await act(async () => {
        sessionBDefinitions.resolve(
          definitionsFixture(2, "definitions-session-b"),
        );
        await sessionBDefinitions.promise;
      });

      expect(mounted.container.textContent).toContain("definitions-session-b");
      expect(mounted.container.textContent).not.toContain("definitions-session-a");
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.dom.restore();
    }
  });
});
