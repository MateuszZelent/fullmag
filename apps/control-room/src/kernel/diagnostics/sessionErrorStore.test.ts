import { beforeEach, describe, expect, it } from "vitest";

import {
  createSessionErrorStore,
  formatSessionErrorsForAiReport,
  mergeErrorLists,
  sessionErrorStore,
  type SessionErrorStorage,
} from "./sessionErrorStore";
import type { SessionErrorHistoryResource } from "../api/apiTypes";

describe("sessionErrorStore", () => {
  beforeEach(() => {
    sessionErrorStore.resetForTests();
  });

  it("deduplicates repeated identical errors and preserves first/last timestamps", () => {
    sessionErrorStore.setSessionScope("session-py-fem", "scope-session-py-fem");
    sessionErrorStore.record({
      category: "api",
      code: "HTTP_503",
      message: "Backend unavailable",
      path: "/v2/sessions/current/status",
      source: "http",
      timestampMs: 1_000,
      title: "HTTP 503",
    });
    sessionErrorStore.record({
      category: "api",
      code: "HTTP_503",
      message: "Backend unavailable",
      path: "/v2/sessions/current/status",
      source: "http",
      timestampMs: 2_500,
      title: "HTTP 503",
    });

    const snapshot = sessionErrorStore.getSnapshot();
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.count).toBe(2);
    expect(snapshot.entries[0]?.firstSeenMs).toBe(1_000);
    expect(snapshot.entries[0]?.lastSeenMs).toBe(2_500);
  });

  it("merges frontend, backend, api, and model errors into a structured AI Markdown report", () => {
    const first = sessionErrorStore.record({
      category: "frontend",
      code: "UNHANDLED_REJECTION",
      detail: "TypeError: Cannot read properties of undefined\n    at MeshPanel.tsx:42",
      message: "Cannot read properties of undefined",
      source: "window.unhandledrejection",
      timestampMs: 1_700_000_000_000,
      title: "Unhandled promise rejection",
    });
    const second = sessionErrorStore.record({
      category: "backend",
      code: "COMMAND_FAILED",
      message: "The FEM mesh needs a surrounding air domain",
      path: "mesh.build-shared-domain",
      requestId: "fm-2bf4aa7b",
      source: "backend:command_queue",
      timestampMs: 1_700_000_005_000,
      title: "mesh_build failed",
    });

    const merged = mergeErrorLists([second], [first, second]);
    expect(merged).toHaveLength(2);

    const report = formatSessionErrorsForAiReport(merged, {
      discretization: "fem",
      generatedAtIso: "2026-11-24T11:00:00.000Z",
      meshRevision: 6,
      sceneRevision: 15,
      sessionId: "py-antidot-1000x500x10-fem",
      url: "http://127.0.0.1:3410/session/py-antidot-1000x500x10-fem",
    });

    expect(report).toContain("# Fullmag Session Error Report");
    expect(report).toContain("`py-antidot-1000x500x10-fem`");
    expect(report).toContain("Solver lane:** `FEM`");
    expect(report).toContain("Frontend 1 · Backend 1 · API/WS 0 · Model 0");
    expect(report).toContain("mesh_build failed (`COMMAND_FAILED`)");
    expect(report).toContain("TypeError: Cannot read properties of undefined");
  });

  it("clears recorded session errors cleanly", () => {
    sessionErrorStore.record({
      category: "frontend",
      message: "Boom",
      source: "console.error",
      title: "Console error",
    });
    expect(sessionErrorStore.getSnapshot().entries).toHaveLength(1);

    sessionErrorStore.clear();
    expect(sessionErrorStore.getSnapshot().entries).toHaveLength(0);
  });

  it("persists only unacknowledged occurrences and replays stable receipt IDs after reload", () => {
    const storage = createMemoryStorage();
    const firstTab = createSessionErrorStore({
      createEventId: () => "occurrence-1",
      storage,
    });
    firstTab.setSessionScope("session-a", "scope-a");
    firstTab.applyResource("scope-a", emptyHistory("session-a"));
    firstTab.record({
      category: "frontend",
      message: "Renderer failed",
      source: "window.error",
      timestampMs: 10,
      title: "Renderer error",
    });

    expect(firstTab.getAppendBatch()).toEqual({
      clearGeneration: 0,
      events: [
        expect.objectContaining({
          eventId: "occurrence-1",
          firstSeenMs: 10,
          lastSeenMs: 10,
          count: 1,
        }),
      ],
    });

    const reloadedTab = createSessionErrorStore({ storage });
    reloadedTab.setSessionScope("session-a", "scope-a");
    expect(reloadedTab.getSnapshot().entries[0]?.message).toBe("Renderer failed");
    expect(reloadedTab.getAppendBatch()?.events[0]?.eventId).toBe("occurrence-1");

    const entry: SessionErrorHistoryResource["entries"][number] = {
      category: "frontend",
      code: null,
      count: 1,
      detail: null,
      fingerprint: "frontend|window.error||renderer error||renderer failed",
      firstSeenMs: 10,
      id: "server-entry-1",
      lastSeenMs: 10,
      message: "Renderer failed",
      path: null,
      requestId: null,
      sessionId: "session-a",
      severity: "error",
      source: "window.error",
      title: "Renderer error",
    };
    expect(
      reloadedTab.acknowledgeAppend("scope-a", ["occurrence-1"], {
        clearGeneration: 0,
        entries: [entry],
        revision: 1,
        sessionId: "session-a",
      }),
    ).toBe(true);
    expect(storage.getItem("fullmag:session-errors:outbox:v1:session-a")).toBeNull();
  });

  it("keeps pending diagnostics visible while offline", () => {
    const store = createSessionErrorStore({
      createEventId: () => "offline-event",
      storage: createMemoryStorage(),
    });
    store.setSessionScope("session-offline", "scope-offline");
    store.record({
      category: "api",
      message: "Request timed out",
      source: "http",
      title: "API timeout",
    });
    store.markSyncFailed("scope-offline");

    expect(store.getSnapshot()).toMatchObject({
      entries: [expect.objectContaining({ message: "Request timed out" })],
      pendingCount: 1,
      syncStatus: "offline",
    });
  });

  it("fences replies from an earlier session scope", () => {
    const store = createSessionErrorStore({ storage: createMemoryStorage() });
    store.setSessionScope("session-a", "scope-a");
    store.setSessionScope("session-b", "scope-b");

    expect(
      store.applyResource("scope-a", emptyHistory("session-a")),
    ).toBe(false);
    expect(store.getSnapshot()).toMatchObject({
      entries: [],
      sessionId: "session-b",
      syncStatus: "loading",
    });
  });

  it("does not restore pre-clear events after an authoritative clear generation arrives", () => {
    const store = createSessionErrorStore({
      createEventId: () => "before-clear",
      storage: createMemoryStorage(),
    });
    store.setSessionScope("session-clear", "scope-clear");
    store.applyResource("scope-clear", emptyHistory("session-clear"));
    store.record({
      category: "backend",
      message: "Old failure",
      source: "command",
      title: "Command failed",
    });

    expect(
      store.applyResource("scope-clear", {
        ...emptyHistory("session-clear"),
        clearGeneration: 1,
        revision: 2,
      }),
    ).toBe(true);
    expect(store.getSnapshot()).toMatchObject({
      clearGeneration: 1,
      entries: [],
      pendingCount: 0,
    });
    expect(store.getAppendBatch()).toBeNull();
  });

  it("clears the visible history immediately and queues later events for the new generation", () => {
    const store = createSessionErrorStore({
      createEventId: () => `event-${Date.now()}`,
      storage: createMemoryStorage(),
    });
    store.setSessionScope("session-clear", "scope-clear");
    store.applyResource("scope-clear", emptyHistory("session-clear"));
    store.record({
      category: "frontend",
      message: "Before clear",
      source: "console.error",
      title: "Console error",
    });

    store.clear();
    store.record({
      category: "frontend",
      message: "After clear",
      source: "console.error",
      title: "Console error",
    });

    expect(store.getSnapshot()).toMatchObject({
      clearGeneration: 1,
      entries: [expect.objectContaining({ message: "After clear" })],
      pendingClear: true,
      pendingCount: 1,
    });
    expect(store.getAppendBatch()).toBeNull();

    expect(
      store.acknowledgeClear("scope-clear", {
        clearGeneration: 1,
        entries: [],
        revision: 2,
        sessionId: "session-clear",
      }),
    ).toBe(true);
    expect(store.getSnapshot()).toMatchObject({
      pendingClear: false,
      entries: [expect.objectContaining({ message: "After clear" })],
    });
    expect(store.getAppendBatch()).toMatchObject({
      clearGeneration: 1,
      events: [expect.objectContaining({ message: "After clear" })],
    });
  });

  it("rebases fresh errors onto the server clear generation discovered during hydration", () => {
    const store = createSessionErrorStore({
      createEventId: () => "fresh-before-hydration",
      storage: createMemoryStorage(),
    });
    store.setSessionScope("session-reopened", "scope-reopened");
    store.record({
      category: "frontend",
      message: "New browser error",
      source: "window.error",
      title: "Browser error",
    });

    store.applyResource("scope-reopened", {
      ...emptyHistory("session-reopened"),
      clearGeneration: 4,
      revision: 8,
    });

    expect(store.getSnapshot()).toMatchObject({
      clearGeneration: 4,
      entries: [expect.objectContaining({ message: "New browser error" })],
      pendingCount: 1,
    });
    expect(store.getAppendBatch()).toMatchObject({ clearGeneration: 4 });
  });

  it("drops queued pre-clear events but keeps new events recorded during generation recovery", () => {
    let eventId = 0;
    const store = createSessionErrorStore({
      createEventId: () => `recovery-${++eventId}`,
      storage: createMemoryStorage(),
    });
    store.setSessionScope("session-recovery", "scope-recovery");
    store.applyResource("scope-recovery", emptyHistory("session-recovery"));
    store.record({
      category: "frontend",
      message: "Queued before clear",
      source: "window.error",
      title: "Browser error",
    });

    store.markGenerationUnknown("scope-recovery");
    store.record({
      category: "frontend",
      message: "Recorded while recovering",
      source: "window.error",
      title: "Browser error",
    });
    store.applyResource("scope-recovery", {
      ...emptyHistory("session-recovery"),
      clearGeneration: 1,
      revision: 2,
    });

    expect(store.getSnapshot().entries.map((entry) => entry.message)).toEqual([
      "Recorded while recovering",
    ]);
    expect(store.getAppendBatch()).toMatchObject({
      clearGeneration: 1,
      events: [expect.objectContaining({ message: "Recorded while recovering" })],
    });
  });

  it("keeps late command and transport failures from polluting the next session", () => {
    const store = createSessionErrorStore({ storage: createMemoryStorage() });
    store.setSessionScope("first", "first-scope");
    store.applyResource("first-scope", emptyHistory("first"));
    store.setSessionScope("next", "next-scope");
    store.applyResource("next-scope", emptyHistory("next"));
    const issue = { category: "api", source: "http", title: "Failed request" } as const;
    store.recordForScope("first-scope", { ...issue, message: "Late failure" });
    store.recordForScope("next-scope", { ...issue, message: "Current failure" });

    expect(store.getAppendBatch()?.events.map((event) => event.message)).toEqual(["Current failure"]);
  });

  it("rebinds events recorded after a clear from another browser tab", () => {
    const store = createSessionErrorStore({ storage: createMemoryStorage() });
    const key = "scope-remote-clear";
    const session = "session-remote-clear";
    store.setSessionScope(session, key);
    store.applyResource(key, emptyHistory(session));

    for (const [message, timestampMs] of [["before remote clear", 100], ["after remote clear", 200]] as const) {
      store.record({ category: "frontend", message, source: "window.error", timestampMs, title: "Browser error" });
    }
    const newHistory = { ...emptyHistory(session), clearGeneration: 1, clearedAtMs: 150, revision: 2 };
    store.applyResource(key, newHistory);

    expect(store.getAppendBatch()).toMatchObject({
      clearGeneration: 1,
      events: [expect.objectContaining({ message: "after remote clear" })],
    });
  });

  it("limits append batches to twenty events", () => {
    let eventId = 0;
    const store = createSessionErrorStore({
      createEventId: () => `batch-${++eventId}`,
      storage: createMemoryStorage(),
    });
    store.setSessionScope("session-batch", "scope-batch");
    store.applyResource("scope-batch", emptyHistory("session-batch"));
    for (let index = 0; index < 21; index += 1) {
      store.record({
        category: "frontend",
        message: `Failure ${index}`,
        source: "window.error",
        title: `Failure ${index}`,
      });
    }

    expect(store.getAppendBatch()?.events).toHaveLength(20);
    expect(store.getSnapshot().pendingCount).toBe(21);
  });

  it("migrates legacy sessionStorage entries once with stable event IDs", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "fullmag:session-errors:v1:session-legacy",
      JSON.stringify([
        {
          category: "model",
          code: null,
          count: 3,
          detail: null,
          fingerprint: "model|mesh||mesh error||mesh failed",
          firstSeenMs: 5,
          id: "err/5 0",
          lastSeenMs: 15,
          message: "Mesh failed",
          path: null,
          requestId: null,
          sessionId: "session-legacy",
          severity: "error",
          source: "mesh",
          title: "Mesh error",
        },
      ]),
    );

    const firstLoad = createSessionErrorStore({ storage });
    firstLoad.setSessionScope("session-legacy", "scope-legacy");
    firstLoad.applyResource("scope-legacy", emptyHistory("session-legacy"));
    const eventId = firstLoad.getAppendBatch()?.events[0]?.eventId;
    expect(eventId).toBeTruthy();
    expect(storage.getItem("fullmag:session-errors:v1:session-legacy")).toBeNull();

    const secondLoad = createSessionErrorStore({ storage });
    secondLoad.setSessionScope("session-legacy", "scope-legacy");
    expect(secondLoad.getAppendBatch()?.events[0]?.eventId).toBe(eventId);
    expect(secondLoad.getAppendBatch()?.events[0]?.count).toBe(3);
  });
});

function createMemoryStorage(): SessionErrorStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function emptyHistory(sessionId: string): SessionErrorHistoryResource {
  return { clearGeneration: 0, entries: [], revision: 0, sessionId };
}
