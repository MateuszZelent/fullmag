import { beforeEach, describe, expect, it } from "vitest";

import {
  formatSessionErrorsForAiReport,
  mergeErrorLists,
  sessionErrorStore,
} from "./sessionErrorStore";

describe("sessionErrorStore", () => {
  beforeEach(() => {
    sessionErrorStore.resetForTests();
  });

  it("deduplicates repeated identical errors and preserves first/last timestamps", () => {
    sessionErrorStore.setSessionId("session-py-fem");
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
});
