import { describe, expect, it } from "vitest";

import type { CommandQueueStatusResource } from "../api/apiTypes";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { sessionRequestScopeKey } from "../resources/sessionResourceIdentity";
import { CommandFeedbackController } from "./CommandFeedbackController";
import {
  createStudyComputeObservationStore,
  type StudyComputeObservation,
} from "./studyComputeObservations";

const first = sessionRequestScopeKey({ sessionId: "A", sessionEpoch: "A@1", requestScopeEpoch: "api:1" })!;
const reopened = sessionRequestScopeKey({ sessionId: "A", sessionEpoch: "A@1", requestScopeEpoch: "api:2" })!;
const replaced = sessionRequestScopeKey({ sessionId: "A", sessionEpoch: "A@2", requestScopeEpoch: "api:2" })!;
const otherSession = sessionRequestScopeKey({ sessionId: "B", sessionEpoch: "B@1", requestScopeEpoch: "api:2" })!;

function feedbackFixture(
  scopeKey: string | null,
  studyComputeObservations: ReturnType<typeof createStudyComputeObservationStore> | undefined,
) {
  const bus = new EventBus<KernelEventMap>();
  const listeners = new Set<() => void>();
  const controller = new CommandFeedbackController(bus, {
    getSessionScopeKey: () => scopeKey,
    studyComputeObservations,
    subscribeSessionScope: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
  return {
    bus,
    controller,
    setScope: (scope: string | null) => {
      scopeKey = scope;
      for (const listener of listeners) listener();
    },
  };
}

function storageFixture() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

const submission = { clientIntentId: "intent-a", kind: "relax", sessionScopeKey: first } as const;
const backend = { command_id: "command-a", client_intent_id: "intent-a", kind: "relax", status: "completed" };
function queue(...commands: object[]): CommandQueueStatusResource {
  return { commands } as CommandQueueStatusResource;
}


type RequestObservation = StudyComputeObservation & { requestJson?: string };

function requestJsonFor(
  clientIntentId = "intent-a",
  kind = "relax",
  stageId = "stage-a",
): string {
  return JSON.stringify({
    kind,
    client_intent_id: clientIntentId,
    target: { kind: "stage_id", stage_id: stageId },
    precondition: { command_revision: 7, current_run: { kind: "none" } },
    initial_state: {
      kind: "authored_initial_state",
      source: { kind: "stage", stage_id: stageId, scene_revision: 19 },
    },
    max_steps: 64,
    torque_tolerance_apm: 0.0001,
  });
}

function requestObservation(
  requestJson: string,
  overrides: Partial<StudyComputeObservation> = {},
): RequestObservation {
  return { ...submission, ...overrides, requestJson };
}

function emitComputeObservation(
  bus: EventBus<KernelEventMap>,
  observation: RequestObservation,
  state: "started" | "rejected",
): void {
  bus.emit("study:compute-observation", { ...observation, state } as KernelEventMap["study:compute-observation"]);
}

function pendingOutcome(overrides: Partial<KernelEventMap["command:outcome"]> = {}): KernelEventMap["command:outcome"] {
  return {
    backendCommandId: null,
    clientIntentId: "intent-a",
    clientIntentKind: "relax",
    commandId: "study.execute-stage",
    feedback: "foreground",
    invocationId: "foreground-invocation",
    message: "Accepted; waiting for the backend to finish.",
    observation: "waiting",
    phase: "run",
    sessionScopeKey: first,
    source: "ribbon",
    sourceDetail: null,
    status: "pending",
    title: "Relax stage",
    ...overrides,
  };
}

describe("Study Compute observation recovery", () => {
  it("reads the exact pending Compute after reopening the same logical session", () => {
    const storage = storageFixture();
    const originalRequest = requestJsonFor();
    const initial = feedbackFixture(first, createStudyComputeObservationStore("http://api:81", () => storage));
    emitComputeObservation(initial.bus, requestObservation(originalRequest), "started");
    expect(initial.controller.getSnapshot()).toEqual([]);
    initial.controller.dispose();

    const store = createStudyComputeObservationStore("http://api:81", () => storage);
    const successor = feedbackFixture(reopened, store);
    expect(successor.controller.hasPendingBackendCommands()).toBe(true);
    expect(successor.controller.getSnapshot()[0]).toMatchObject({
      backendCommandId: null, clientIntentId: "intent-a", sessionScopeKey: reopened, status: "pending",
    });
    expect(successor.controller.getRetryableStudyCompute(reopened, "intent-a")).toEqual({
      ...submission,
      sessionScopeKey: reopened,
      requestJson: originalRequest,
    });

    successor.controller.observeCommandQueue(queue(backend), first);
    successor.controller.observeCommandQueue(queue({ ...backend, kind: "run" }), reopened);
    successor.controller.observeCommandQueue(queue(backend, { ...backend, command_id: "another" }), reopened);
    expect(successor.controller.hasPendingBackendCommands()).toBe(true);
    expect(successor.controller.getSnapshot()[0].backendCommandId).toBeNull();

    successor.controller.observeCommandQueue(queue(backend), reopened);
    expect(successor.controller.getRetryableStudyCompute(reopened, "intent-a")).toBeNull();
    expect(successor.controller.hasPendingBackendCommands()).toBe(false);
    expect(successor.controller.getSnapshot()[0]).toMatchObject({
      backendCommandId: "command-a", clientIntentId: "intent-a", status: "completed",
    });
    expect(store.list(reopened)).toEqual([]);
  });

  it("only shows a stored observation under the original API and logical session", () => {
    const storage = storageFixture();
    const store = createStudyComputeObservationStore("http://api:81", () => storage);
    const otherAuthority = createStudyComputeObservationStore("http://api:82", () => storage);
    const initial = feedbackFixture(first, store);
    initial.bus.emit("study:compute-observation", { ...submission, state: "started" });
    expect(feedbackFixture(reopened, otherAuthority).controller.hasPendingBackendCommands()).toBe(false);

    initial.setScope(null);
    initial.setScope(otherSession);
    expect(initial.controller.getSnapshot()).toEqual([]);
    initial.setScope(replaced);
    expect(initial.controller.getSnapshot()).toEqual([]);
    initial.setScope(reopened);
    expect(initial.controller.getSnapshot()[0]).toMatchObject({ status: "pending", sessionScopeKey: reopened });

    initial.bus.emit("study:compute-observation", { ...submission, sessionScopeKey: replaced, state: "rejected" });
    expect(initial.controller.hasPendingBackendCommands()).toBe(true);
    initial.bus.emit("study:compute-observation", { ...submission, state: "rejected" });
    expect(initial.controller.hasPendingBackendCommands()).toBe(false);
    expect(initial.controller.getSnapshot()).toEqual([]);
  });

  it("tracks a local start synchronously and notifies polling without a foreground notice when storage throws", () => {
    const disabledStore = createStudyComputeObservationStore("http://api:81", () => {
      throw new Error("storage blocked");
    });
    const { bus, controller } = feedbackFixture(first, disabledStore);
    const before = controller.getSnapshot();
    let notifications = 0;
    controller.subscribe(() => { notifications += 1; });

    bus.emit("study:compute-observation", { ...submission, state: "started" });

    expect(controller.hasUnresolvedStudyCompute(first)).toBe(true);
    expect(controller.hasUnresolvedStudyCompute(reopened)).toBe(false);
    expect(controller.hasUnresolvedStudyCompute(null)).toBe(false);
    expect(controller.hasUnresolvedStudyCompute(undefined)).toBe(false);
    expect(controller.hasPendingBackendCommands()).toBe(true);
    expect(controller.getSnapshot()).toEqual([]);
    expect(controller.getSnapshot()).not.toBe(before);
    expect(notifications).toBe(1);
  });

  it("does not promote a local Compute terminal row to a foreground notice", () => {
    const { bus, controller } = feedbackFixture(first, undefined);
    const originalRequest = requestJsonFor();
    emitComputeObservation(bus, requestObservation(originalRequest), "started");
    expect(controller.getRetryableStudyCompute(first, "intent-a")?.requestJson).toBe(originalRequest);

    controller.observeCommandQueue(queue(backend), first);

    expect(controller.getRetryableStudyCompute(first, "intent-a")).toBeNull();
    expect(controller.hasUnresolvedStudyCompute(first)).toBe(false);
    expect(controller.hasPendingBackendCommands()).toBe(false);
    expect(controller.getSnapshot()).toEqual([]);
  });

  it("keeps ordinary foreground failure notices visible", () => {
    const { bus, controller } = feedbackFixture(first, undefined);
    bus.emit("command:outcome", pendingOutcome({
      backendCommandId: null,
      clientIntentId: null,
      clientIntentKind: null,
      commandId: "workspace.new-problem",
      invocationId: "ordinary-invocation",
      message: "The operation failed.",
      observation: null,
      status: "failed",
      title: "Create problem",
    }));

    expect(controller.getSnapshot()).toHaveLength(1);
    expect(controller.getSnapshot()[0]).toMatchObject({
      commandId: "workspace.new-problem",
      message: "The operation failed.",
      status: "failed",
      title: "Create problem: failed",
    });
    expect(controller.hasPendingBackendCommands()).toBe(false);
  });

  it("deduplicates a foreground ACK against the started intent and clears only from its exact terminal ledger row", () => {
    const { bus, controller } = feedbackFixture(first, undefined);
    bus.emit("study:compute-observation", { ...submission, state: "started" });
    bus.emit("command:outcome", pendingOutcome({ invocationId: "different-foreground-invocation" }));

    expect(controller.getSnapshot()).toHaveLength(1);
    expect(controller.hasUnresolvedStudyCompute(first)).toBe(true);
    controller.observeCommandQueue(queue(backend), otherSession);
    controller.observeCommandQueue(queue({ ...backend, kind: "run" }), first);
    controller.observeCommandQueue(queue(backend, { ...backend, command_id: "duplicate-command" }), first);
    expect(controller.hasUnresolvedStudyCompute(first)).toBe(true);

    controller.observeCommandQueue(queue(backend), first);

    expect(controller.hasUnresolvedStudyCompute(first)).toBe(false);
    expect(controller.hasPendingBackendCommands()).toBe(false);
    expect(controller.getSnapshot()).toHaveLength(1);
    expect(controller.getSnapshot()[0]).toMatchObject({ clientIntentId: "intent-a", status: "completed" });
  });

  it("keeps an in-memory Compute through A to B to A when storage is unavailable, but not across logical owners", () => {
    const { bus, controller, setScope } = feedbackFixture(first, undefined);
    const originalRequest = requestJsonFor();
    emitComputeObservation(bus, requestObservation(originalRequest), "started");
    expect(controller.hasUnresolvedStudyCompute(first)).toBe(true);

    setScope(otherSession);
    expect(controller.hasUnresolvedStudyCompute(otherSession)).toBe(false);
    expect(controller.hasUnresolvedStudyCompute(first)).toBe(false);
    setScope(first);
    expect(controller.hasUnresolvedStudyCompute(first)).toBe(true);
    expect(controller.getRetryableStudyCompute(first, "intent-a")?.requestJson).toBe(originalRequest);

    setScope(replaced);
    expect(controller.hasUnresolvedStudyCompute(replaced)).toBe(false);
    expect(controller.getRetryableStudyCompute(replaced, "intent-a")).toBeNull();
    setScope(otherSession);
    expect(controller.hasUnresolvedStudyCompute(otherSession)).toBe(false);
  });

  it("rebinds an in-memory Compute to a new request scope in the same logical session", () => {
    const disabledStore = createStudyComputeObservationStore("http://api:81", () => {
      throw new Error("storage blocked");
    });
    const { bus, controller, setScope } = feedbackFixture(first, disabledStore);
    const originalRequest = requestJsonFor();
    emitComputeObservation(bus, requestObservation(originalRequest), "started");

    setScope(reopened);

    expect(controller.hasUnresolvedStudyCompute(reopened)).toBe(true);
    expect(controller.getRetryableStudyCompute(reopened, "intent-a")?.requestJson).toBe(originalRequest);
    expect(controller.hasPendingBackendCommands()).toBe(true);
    expect(controller.getSnapshot()).toEqual([]);
  });

  it("clears a rejected intent without storage only for the matching kind and logical owner", () => {
    const disabledStore = createStudyComputeObservationStore("http://api:81", () => {
      throw new Error("storage blocked");
    });
    const { bus, controller, setScope } = feedbackFixture(first, disabledStore);
    const originalRequest = requestJsonFor();
    emitComputeObservation(bus, requestObservation(originalRequest), "started");

    bus.emit("study:compute-observation", { ...submission, kind: "run", state: "rejected" });
    bus.emit("study:compute-observation", { ...submission, sessionScopeKey: otherSession, state: "rejected" });
    expect(controller.hasUnresolvedStudyCompute(first)).toBe(true);
    expect(controller.getRetryableStudyCompute(first, "intent-a")?.requestJson).toBe(originalRequest);

    setScope(reopened);
    bus.emit("study:compute-observation", { ...submission, state: "rejected" });

    expect(controller.hasUnresolvedStudyCompute(reopened)).toBe(false);
    expect(controller.getRetryableStudyCompute(reopened, "intent-a")).toBeNull();
    expect(controller.getSnapshot()).toEqual([]);
  });

  it("returns only one exact current-scope retry request and preserves the original serialized bytes", () => {
    const { bus, controller } = feedbackFixture(first, undefined);
    const originalRequest = requestJsonFor();
    const anotherRequest = requestJsonFor("intent-b", "relax", "stage-b");
    emitComputeObservation(bus, requestObservation(originalRequest), "started");

    expect(controller.getRetryableStudyCompute(first)).toEqual({
      ...submission,
      requestJson: originalRequest,
    });
    expect(controller.getRetryableStudyCompute(first, "missing-intent")).toBeNull();
    expect(controller.getRetryableStudyCompute(reopened, "intent-a")).toBeNull();
    expect(controller.getRetryableStudyCompute(null, "intent-a")).toBeNull();
    expect(controller.getRetryableStudyCompute(undefined, "intent-a")).toBeNull();

    emitComputeObservation(bus, requestObservation(anotherRequest, { clientIntentId: "intent-b" }), "started");

    expect(controller.getRetryableStudyCompute(first)).toBeNull();
    expect(controller.getRetryableStudyCompute(first, "intent-a")).toEqual({
      ...submission,
      requestJson: originalRequest,
    });

    emitComputeObservation(bus, requestObservation(requestJsonFor("intent-a", "run"), {
      kind: "run",
    }), "started");
    expect(controller.getRetryableStudyCompute(first, "intent-a")).toBeNull();
  });

  it("keeps a valid request in memory when storage is unavailable and never replaces it on duplicate start", () => {
    const disabledStore = createStudyComputeObservationStore("http://api:81", () => {
      throw new Error("storage blocked");
    });
    const { bus, controller } = feedbackFixture(first, disabledStore);
    const originalRequest = requestJsonFor();
    const changedRequest = requestJsonFor("intent-a", "relax", "different-stage");
    emitComputeObservation(bus, requestObservation(originalRequest), "started");
    emitComputeObservation(bus, requestObservation(changedRequest), "started");

    expect(controller.getRetryableStudyCompute(first, "intent-a")).toEqual({
      ...submission,
      requestJson: originalRequest,
    });
    expect(controller.getSnapshot()).toEqual([]);
  });

  it("keeps an oversized valid request retryable in memory when optional storage keeps only its hint", () => {
    const storage = storageFixture();
    const store = createStudyComputeObservationStore("http://api:81", () => storage);
    const request = JSON.parse(requestJsonFor()) as Record<string, unknown>;
    request.reason = "x".repeat(20_000);
    const originalRequest = JSON.stringify(request);
    const { bus, controller } = feedbackFixture(first, store);
    emitComputeObservation(bus, requestObservation(originalRequest), "started");

    expect(controller.getRetryableStudyCompute(first, "intent-a")?.requestJson).toBe(originalRequest);
    expect(store.list(first)).toEqual([
      { clientIntentId: "intent-a", kind: "relax", sessionScopeKey: first },
    ]);
  });

  it.each([
    ["malformed JSON", "{"],
    ["an array", "[]"],
    ["a different kind", requestJsonFor("intent-a", "run")],
    ["a different intent ID", requestJsonFor("other-intent", "relax")],
  ] as const)("retains the observation hint but offers no retry for %s request JSON", (_description, invalidRequest) => {
    const storage = storageFixture();
    const store = createStudyComputeObservationStore("http://api:81", () => storage);
    store.remember(requestObservation(invalidRequest));
    const reloadedStore = createStudyComputeObservationStore("http://api:81", () => storage);
    const { controller } = feedbackFixture(first, reloadedStore);

    expect(controller.hasUnresolvedStudyCompute(first)).toBe(true);
    expect(controller.getRetryableStudyCompute(first, "intent-a")).toBeNull();
    expect(reloadedStore.list(first)).toMatchObject([
      { clientIntentId: "intent-a", kind: "relax", sessionScopeKey: first },
    ]);
  });

  it("uses a local accepted backend ID to disable retry without creating a foreground notice", () => {
    const { bus, controller, setScope } = feedbackFixture(first, undefined);
    const originalRequest = requestJsonFor();
    emitComputeObservation(bus, requestObservation(originalRequest), "started");

    bus.emit("command:outcome", pendingOutcome({
      backendCommandId: "accepted-command",
      feedback: "local",
    }));

    expect(controller.hasUnresolvedStudyCompute(first)).toBe(true);
    expect(controller.getRetryableStudyCompute(first, "intent-a")).toBeNull();
    expect(controller.hasPendingBackendCommands()).toBe(true);
    expect(controller.getSnapshot()).toEqual([]);

    setScope(reopened);
    expect(controller.getRetryableStudyCompute(reopened, "intent-a")).toBeNull();
    expect(controller.getSnapshot()).toEqual([]);

    controller.observeCommandQueue(queue({ ...backend, command_id: "accepted-command" }), reopened);

    expect(controller.getRetryableStudyCompute(reopened, "intent-a")).toBeNull();
    expect(controller.hasUnresolvedStudyCompute(reopened)).toBe(false);
    expect(controller.getSnapshot()).toEqual([]);
  });

  it("does not reopen an intent after exact rejection when its late pending outcome arrives", () => {
    const { bus, controller } = feedbackFixture(first, undefined);
    bus.emit("study:compute-observation", { ...submission, state: "started" });
    bus.emit("study:compute-observation", { ...submission, state: "rejected" });
    expect(controller.hasUnresolvedStudyCompute(first)).toBe(false);
    expect(controller.hasPendingBackendCommands()).toBe(false);

    bus.emit("command:outcome", pendingOutcome({
      invocationId: "late-unconfirmed-outcome",
      observation: "publication-unconfirmed",
      status: "pending",
      studyComputeObservationStarted: true,
    }));

    expect(controller.hasUnresolvedStudyCompute(first)).toBe(false);
    expect(controller.hasPendingBackendCommands()).toBe(false);
  });

  it("does not reopen an intent after its exact terminal ledger row and a late pending outcome", () => {
    const { bus, controller } = feedbackFixture(first, undefined);
    bus.emit("study:compute-observation", { ...submission, state: "started" });
    controller.observeCommandQueue(queue(backend), first);
    expect(controller.hasUnresolvedStudyCompute(first)).toBe(false);
    expect(controller.hasPendingBackendCommands()).toBe(false);

    bus.emit("command:outcome", pendingOutcome({
      invocationId: "late-after-terminal",
      observation: "publication-unconfirmed",
      status: "pending",
      studyComputeObservationStarted: true,
    }));

    expect(controller.hasUnresolvedStudyCompute(first)).toBe(false);
    expect(controller.hasPendingBackendCommands()).toBe(false);
  });

  it("continues tracking new legacy pending outcomes and known backend acknowledgements", () => {
    const { bus, controller } = feedbackFixture(first, undefined);
    bus.emit("command:outcome", pendingOutcome({
      backendCommandId: null,
      clientIntentId: "legacy-intent",
      clientIntentKind: "run",
      commandId: "study.execute-stage",
      invocationId: "legacy-outcome",
    }));
    expect(controller.hasUnresolvedStudyCompute(first)).toBe(true);
    expect(controller.hasUnresolvedStudyCompute(first, "legacy-intent")).toBe(true);
    expect(controller.hasUnresolvedStudyCompute(first, "other-intent")).toBe(false);

    controller.observeCommandQueue(queue({
      command_id: "legacy-command",
      client_intent_id: "legacy-intent",
      kind: "run",
      status: "pending",
    }), first);
    bus.emit("command:outcome", pendingOutcome({
      backendCommandId: "known-command",
      clientIntentId: "known-intent",
      clientIntentKind: "solve",
      commandId: "study.run",
      invocationId: "known-ack",
      studyComputeObservationStarted: true,
    }));
    expect(controller.hasPendingBackendCommands()).toBe(true);

    controller.observeCommandQueue(queue(
      { command_id: "legacy-command", client_intent_id: "legacy-intent", kind: "run", status: "completed" },
      { command_id: "known-command", client_intent_id: "known-intent", kind: "solve", status: "completed" },
    ), first);

    expect(controller.hasUnresolvedStudyCompute(first)).toBe(false);
    expect(controller.hasPendingBackendCommands()).toBe(false);
  });

  it("bounds observation hints and tolerates disabled or malformed storage", () => {
    const storage = storageFixture();
    const store = createStudyComputeObservationStore("http://api:81", () => storage);
    for (let index = 0; index < 20; index += 1) {
      store.remember({ ...submission, clientIntentId: `intent-${index}` });
    }
    expect(store.list(reopened).length).toBe(16);
    expect(store.list(reopened)[0].clientIntentId).toBe("intent-4");

    for (const key of storage.values.keys()) storage.values.set(key, "invalid JSON");
    expect(store.list(reopened)).toEqual([]);
    const disabled = createStudyComputeObservationStore("http://api:81", () => { throw new Error("storage blocked"); });
    disabled.remember(submission);
    expect(disabled.list(reopened)).toEqual([]);
  });
});
