import { describe, expect, it, vi } from "vitest";

import {
  ResultsBrowserUiController,
  resultsBrowserUiIdentityKey,
  type ResultsBrowserUiIdentity,
} from "./ResultsBrowserUiController";

function identity(
  itemId: string | null = null,
  runId = "run-1",
  sessionIdentityKey = "session-1",
): ResultsBrowserUiIdentity {
  return {
    source: itemId === null ? { kind: "current" } : { kind: "workspace", itemId },
    runId,
    sessionIdentityKey,
  };
}

describe("ResultsBrowserUiController", () => {
  it("keeps only bounded UI state and fences it by source, run and session", () => {
    const controller = new ResultsBrowserUiController();
    const current = resultsBrowserUiIdentityKey(identity());
    const otherRun = resultsBrowserUiIdentityKey(identity(null, "run-2"));
    const otherSource = resultsBrowserUiIdentityKey(identity("7"));
    const otherSession = resultsBrowserUiIdentityKey(identity(null, "run-1", "session-2"));

    controller.setQuery(current, "fields");
    controller.toggleCollapsed(current, "fields");
    controller.setFocusedEntryId(current, "fields/m");

    expect(controller.getSnapshot(current)).toEqual({
      query: "fields",
      collapsedIds: ["fields"],
      focusedEntryId: "fields/m",
    });
    expect(controller.getSnapshot(otherRun)).toEqual({
      query: "",
      collapsedIds: [],
      focusedEntryId: null,
    });
    expect(controller.getSnapshot(otherSource).query).toBe("");
    expect(controller.getSnapshot(otherSession).query).toBe("");
  });

  it("retains state across subscribers without retaining catalog data or revision", () => {
    const controller = new ResultsBrowserUiController();
    const key = resultsBrowserUiIdentityKey(identity());
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(key, listener);

    controller.setQuery(key, "m");
    controller.setQuery(key, "m");
    controller.setFocusedEntryId(key, "array-m");

    expect(listener).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot(key)).toEqual({
      query: "m",
      collapsedIds: [],
      focusedEntryId: "array-m",
    });
    expect(controller.size).toBe(1);
    unsubscribe();
  });

  it("evicts the oldest source/run/session key after the bounded limit", () => {
    const controller = new ResultsBrowserUiController();
    const first = resultsBrowserUiIdentityKey(identity("0"));
    controller.setQuery(first, "first");

    for (let index = 1; index <= 32; index += 1) {
      controller.setQuery(
        resultsBrowserUiIdentityKey(identity(String(index))),
        `query-${index}`,
      );
    }

    expect(controller.size).toBe(32);
    expect(controller.getSnapshot(first).query).toBe("");
    expect(controller.getSnapshot(resultsBrowserUiIdentityKey(identity("32"))).query).toBe(
      "query-32",
    );
  });

  it("keeps an active subscriber across eviction and later key reuse", () => {
    const controller = new ResultsBrowserUiController();
    const first = resultsBrowserUiIdentityKey(identity("0"));
    const snapshots: string[] = [];
    const listener = vi.fn(() => snapshots.push(controller.getSnapshot(first).query));
    controller.subscribe(first, listener);
    controller.setQuery(first, "first");

    for (let index = 1; index <= 32; index += 1) {
      controller.setQuery(
        resultsBrowserUiIdentityKey(identity(String(index))),
        `query-${index}`,
      );
    }

    expect(controller.getSnapshot(first)).toEqual({
      query: "",
      collapsedIds: [],
      focusedEntryId: null,
    });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(snapshots).toEqual(["first", ""]);

    controller.setQuery(first, "recreated");

    expect(controller.getSnapshot(first).query).toBe("recreated");
    expect(listener).toHaveBeenCalledTimes(3);
    expect(snapshots).toEqual(["first", "", "recreated"]);
  });

  it("does not create a state entry for an incomplete identity", () => {
    const controller = new ResultsBrowserUiController();

    expect(controller.getSnapshot(null)).toEqual({
      query: "",
      collapsedIds: [],
      focusedEntryId: null,
    });
    controller.setQuery(null, "ignored");
    expect(controller.size).toBe(0);
  });

  it("does not alias distinct non-empty identity strings after validation", () => {
    const trimmed = resultsBrowserUiIdentityKey(identity("7", "run-1", "session-1"));
    const spaced = resultsBrowserUiIdentityKey(identity("7", " run-1", "session-1"));

    expect(trimmed).not.toBe(spaced);
  });
});
