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
      expandedIds: [],
      focusedEntryId: "fields/m",
    });
    expect(controller.getSnapshot(otherRun)).toEqual({
      query: "",
      collapsedIds: [],
      expandedIds: [],
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
      expandedIds: [],
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
      expandedIds: [],
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
      expandedIds: [],
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

  it("keeps an explicit Zarr-array expansion separate from ordinary collapse", () => {
    const controller = new ResultsBrowserUiController();
    const key = resultsBrowserUiIdentityKey(identity());

    controller.setExpanded(key, "array-m", true, true);
    expect(controller.getSnapshot(key)).toEqual({
      query: "",
      collapsedIds: [],
      expandedIds: ["array-m"],
      focusedEntryId: null,
    });

    controller.setExpanded(key, "array-m", false, true);
    expect(controller.getSnapshot(key)).toEqual({
      query: "",
      collapsedIds: ["array-m"],
      expandedIds: [],
      focusedEntryId: null,
    });

    controller.setExpanded(key, "array-m", true, true);
    expect(controller.getSnapshot(key).collapsedIds).toEqual([]);
    expect(controller.getSnapshot(key).expandedIds).toEqual(["array-m"]);
  });

  it("evicts the oldest override while keeping the newest action within the shared bound", () => {
    const controller = new ResultsBrowserUiController();
    const key = resultsBrowserUiIdentityKey(identity());

    for (let index = 0; index < 512; index += 1) {
      controller.setCollapsed(key, `folder-${index}`, true);
    }
    controller.setExpanded(key, "array-overflow", true, true);

    const snapshot = controller.getSnapshot(key);
    expect(snapshot.collapsedIds).toHaveLength(511);
    expect(snapshot.collapsedIds).not.toContain("folder-0");
    expect(snapshot.expandedIds).toEqual(["array-overflow"]);

    const reverse = new ResultsBrowserUiController();
    for (let index = 0; index < 512; index += 1) {
      reverse.setExpanded(key, `array-${index}`, true, true);
    }
    reverse.setCollapsed(key, "folder-overflow", true);

    const reverseSnapshot = reverse.getSnapshot(key);
    expect(reverseSnapshot.collapsedIds).toEqual(["folder-overflow"]);
    expect(reverseSnapshot.expandedIds).toHaveLength(511);
    expect(reverseSnapshot.expandedIds).not.toContain("array-0");
  });
});
