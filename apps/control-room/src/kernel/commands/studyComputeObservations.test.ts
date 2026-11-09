import { describe, expect, it } from "vitest";

import { sessionRequestScopeKey } from "../resources/sessionResourceIdentity";
import {
  createStudyComputeObservationStore,
  type StudyComputeKind,
  type StudyComputeObservation,
} from "./studyComputeObservations";

const first = sessionRequestScopeKey({ sessionId: "A", sessionEpoch: "A@1", requestScopeEpoch: "api:1" })!;
const reopened = sessionRequestScopeKey({ sessionId: "A", sessionEpoch: "A@1", requestScopeEpoch: "api:2" })!;
const replaced = sessionRequestScopeKey({ sessionId: "A", sessionEpoch: "A@2", requestScopeEpoch: "api:2" })!;
const otherSession = sessionRequestScopeKey({ sessionId: "B", sessionEpoch: "B@1", requestScopeEpoch: "api:2" })!;

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

function observation(
  scopeKey: string,
  clientIntentId = "intent-a",
  kind: StudyComputeKind = "relax",
  requestJson?: string,
): RequestObservation {
  return {
    clientIntentId,
    kind,
    sessionScopeKey: scopeKey,
    ...(requestJson === undefined ? {} : { requestJson }),
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

describe("Study Compute observation store", () => {
  it("preserves the first valid request byte-for-byte across reload, transport epochs, and API owners", () => {
    const storage = storageFixture();
    const store = createStudyComputeObservationStore("http://api:81", () => storage);
    const otherApi = createStudyComputeObservationStore("http://api:82", () => storage);
    const originalRequest = requestJsonFor();
    const changedRequest = requestJsonFor("intent-a", "relax", "other-stage");
    store.remember(observation(first, "intent-a", "relax", originalRequest));
    store.remember(observation(first, "intent-a", "relax", changedRequest));

    const reloadedStore = createStudyComputeObservationStore("http://api:81", () => storage);
    expect(reloadedStore.list(reopened)).toEqual([
      {
        clientIntentId: "intent-a",
        kind: "relax",
        sessionScopeKey: reopened,
        requestJson: originalRequest,
      },
    ]);
    expect(reloadedStore.list(replaced)).toEqual([]);
    expect(reloadedStore.list(otherSession)).toEqual([]);
    expect(otherApi.list(reopened)).toEqual([]);

    expect(reloadedStore.forget(reopened, "intent-a")).toBe(true);
    expect(reloadedStore.list(first)).toEqual([]);
  });

  it("does not add a request body to a legacy observation that was first stored without one", () => {
    const storage = storageFixture();
    const store = createStudyComputeObservationStore("http://api:81", () => storage);
    store.remember(observation(first));
    store.remember(observation(first, "intent-a", "relax", requestJsonFor()));

    const reloadedStore = createStudyComputeObservationStore("http://api:81", () => storage);
    expect(reloadedStore.list(reopened)).toEqual([
      { clientIntentId: "intent-a", kind: "relax", sessionScopeKey: reopened },
    ]);
  });

  it.each([
    ["malformed JSON", "{"],
    ["an array", "[]"],
    ["a different kind", requestJsonFor("intent-a", "run")],
    ["a different intent ID", requestJsonFor("other-intent", "relax")],
  ] as const)("keeps the observation hint readable after %s request input", (_description, invalidRequest) => {
    const storage = storageFixture();
    const store = createStudyComputeObservationStore("http://api:81", () => storage);
    store.remember(observation(first, "intent-a", "relax", invalidRequest));

    const reloadedStore = createStudyComputeObservationStore("http://api:81", () => storage);

    expect(reloadedStore.list(reopened)).toMatchObject([
      { clientIntentId: "intent-a", kind: "relax", sessionScopeKey: reopened },
    ]);
  });
});
