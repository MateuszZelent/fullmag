import { describe, expect, it } from "vitest";

import type { CommandQueueStatusResource } from "../api/apiTypes";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { sessionRequestScopeKey } from "../resources/sessionResourceIdentity";
import { CommandFeedbackController } from "./CommandFeedbackController";
import { createStudyComputeObservationStore } from "./studyComputeObservations";

const first = sessionRequestScopeKey({ sessionId: "A", sessionEpoch: "A@1", requestScopeEpoch: "api:1" })!;
const reopened = sessionRequestScopeKey({ sessionId: "A", sessionEpoch: "A@1", requestScopeEpoch: "api:2" })!;
const replaced = sessionRequestScopeKey({ sessionId: "A", sessionEpoch: "A@2", requestScopeEpoch: "api:2" })!;
const otherSession = sessionRequestScopeKey({ sessionId: "B", sessionEpoch: "B@1", requestScopeEpoch: "api:2" })!;

function feedbackFixture(
  scopeKey: string | null,
  studyComputeObservations: ReturnType<typeof createStudyComputeObservationStore>,
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

describe("Study Compute observation recovery", () => {
  it("reads the exact pending Compute after reopening the same logical session", () => {
    const storage = storageFixture();
    const initial = feedbackFixture(first, createStudyComputeObservationStore("http://api:81", () => storage));
    initial.bus.emit("study:compute-observation", { ...submission, state: "started" });
    expect(initial.controller.getSnapshot()).toEqual([]);
    initial.controller.dispose();

    const store = createStudyComputeObservationStore("http://api:81", () => storage);
    const successor = feedbackFixture(reopened, store);
    expect(successor.controller.hasPendingBackendCommands()).toBe(true);
    expect(successor.controller.getSnapshot()[0]).toMatchObject({
      backendCommandId: null, clientIntentId: "intent-a", sessionScopeKey: reopened, status: "pending",
    });

    successor.controller.observeCommandQueue(queue(backend), first);
    successor.controller.observeCommandQueue(queue({ ...backend, kind: "run" }), reopened);
    successor.controller.observeCommandQueue(queue(backend, { ...backend, command_id: "another" }), reopened);
    expect(successor.controller.hasPendingBackendCommands()).toBe(true);
    expect(successor.controller.getSnapshot()[0].backendCommandId).toBeNull();

    successor.controller.observeCommandQueue(queue(backend), reopened);
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
