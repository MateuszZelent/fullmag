import { describe, expect, it } from "vitest";

import { RAW_SCRIPT } from "./__fixtures__/workspaceScripts";
import {
  WorkspaceHostError,
  describeEventDetail,
  parseWorkspaceDialogResponse,
  parseWorkspaceHistory,
  parseWorkspaceItem,
  parseWorkspaceItemResponse,
  parseWorkspaceList,
  parseWorkspaceScriptText,
} from "./workspaceItems";

const READY = { state: "ready" };

describe("parseWorkspaceItem", () => {
  it("maps the wire shape to the typed item", () => {
    expect(parseWorkspaceItem(RAW_SCRIPT)).toEqual({
      id: 7,
      kind: "script",
      path: "C:\\work\\sp4.py",
      name: "sp4",
      projectId: undefined,
      firstSeenAt: "2026-09-01T08:00:00.000Z",
      lastUsedAt: "2026-10-03T12:00:00.000Z",
      useCount: 3,
      pinned: true,
      status: "ready",
      sizeBytes: 2048,
      modifiedAt: "2026-10-02T09:30:00.000Z",
      meta: {
        lines: 120,
        summary: "Standard problem 4",
        usesFullmag: true,
        truncated: false,
        lastRun: { status: "ok", at: "2026-10-03T11:00:00.000Z", durationSeconds: 42.5, device: "cpu" },
      },
    });
  });

  it("requires an integer id, a known kind, a path and a name", () => {
    expect(parseWorkspaceItem({ ...RAW_SCRIPT, id: "7" })).toBeNull();
    expect(parseWorkspaceItem({ ...RAW_SCRIPT, id: 1.5 })).toBeNull();
    expect(parseWorkspaceItem({ ...RAW_SCRIPT, kind: "notebook" })).toBeNull();
    expect(parseWorkspaceItem({ ...RAW_SCRIPT, path: undefined })).toBeNull();
    expect(parseWorkspaceItem({ ...RAW_SCRIPT, name: 3 })).toBeNull();
    expect(parseWorkspaceItem("script")).toBeNull();
    expect(parseWorkspaceItem(null)).toBeNull();
  });

  it("falls back for unknown status, bad counters and a malformed meta", () => {
    const item = parseWorkspaceItem({
      ...RAW_SCRIPT,
      status: "exploded",
      use_count: -4,
      pinned: "yes",
      meta: "nope",
    });
    expect(item).toMatchObject({ status: "ready", useCount: 0, pinned: false, meta: {} });
  });

  it("drops a last_run without a status", () => {
    const item = parseWorkspaceItem({ ...RAW_SCRIPT, meta: { last_run: { at: "x" } } });
    expect(item?.meta.lastRun).toBeUndefined();
  });
});

describe("parseWorkspaceList", () => {
  it("accepts the envelope and keeps every valid item in order", () => {
    const list = parseWorkspaceList({
      items: [RAW_SCRIPT, { ...RAW_SCRIPT, id: 8, name: "other" }],
      outcome: { state: "migrated", detail: "v1 to v2" },
    });
    expect(list.items.map((i) => i.id)).toEqual([7, 8]);
    expect(list.outcome).toEqual({ state: "migrated", detail: "v1 to v2" });
    expect(list.skipped).toBe(0);
  });

  it("rejects a response that is not the documented envelope", () => {
    for (const bad of [null, [], "x", {}, { items: [] }, { items: {}, outcome: READY }]) {
      expect(() => parseWorkspaceList(bad)).toThrowError(WorkspaceHostError);
    }
    try {
      parseWorkspaceList({ items: [] });
    } catch (error) {
      expect((error as WorkspaceHostError).code).toBe("invalid_response");
    }
  });

  it("rejects an unknown outcome state", () => {
    expect(() => parseWorkspaceList({ items: [], outcome: { state: "weird" } })).toThrowError(
      WorkspaceHostError,
    );
    expect(() => parseWorkspaceList({ items: [], outcome: "ready" })).toThrowError(WorkspaceHostError);
  });

  it("skips malformed and duplicate items instead of hiding the rest", () => {
    const list = parseWorkspaceList({
      items: [RAW_SCRIPT, { id: "bad" }, RAW_SCRIPT, 5],
      outcome: READY,
    });
    expect(list.items).toHaveLength(1);
    expect(list.skipped).toBe(3);
  });

  it("accepts every documented outcome state", () => {
    for (const state of ["ready", "created", "migrated", "quarantined", "read_only_newer_schema"]) {
      expect(parseWorkspaceList({ items: [], outcome: { state } }).outcome.state).toBe(state);
    }
  });
});

describe("parseWorkspaceItemResponse and the dialog answer", () => {
  it("returns the item, or throws on a bad shape", () => {
    expect(parseWorkspaceItemResponse(RAW_SCRIPT).id).toBe(7);
    expect(() => parseWorkspaceItemResponse({})).toThrowError(WorkspaceHostError);
    expect(() => parseWorkspaceItemResponse(null)).toThrowError(WorkspaceHostError);
  });

  it("treats null as a cancelled dialog but rejects garbage", () => {
    expect(parseWorkspaceDialogResponse(null)).toBeNull();
    expect(parseWorkspaceDialogResponse(undefined)).toBeNull();
    expect(parseWorkspaceDialogResponse(RAW_SCRIPT)?.name).toBe("sp4");
    expect(() => parseWorkspaceDialogResponse({ name: "x" })).toThrowError(WorkspaceHostError);
  });
});

describe("parseWorkspaceHistory", () => {
  it("keeps known events, drops unknown kinds and gives repeats distinct keys", () => {
    const events = parseWorkspaceHistory({
      events: [
        { at: "2026-10-03T10:00:00Z", kind: "open", actor: "desktop", detail: "{}" },
        { at: "2026-10-03T10:00:00Z", kind: "open", actor: "desktop", detail: "{}" },
        {
          at: "2026-10-03T09:00:00Z",
          kind: "run",
          actor: "cli",
          detail: { status: "ok", duration_seconds: 3 },
        },
        { at: "2026-10-03T08:00:00Z", kind: "teleport", actor: "cli", detail: "{}" },
        { kind: "open" },
      ],
    });
    expect(events.map((e) => e.kind)).toEqual(["open", "open", "run"]);
    expect(new Set(events.map((e) => e.key)).size).toBe(3);
    expect(events[2]?.detail).toBe("ok · 3 s");
  });

  it("rejects an answer without an events array", () => {
    expect(() => parseWorkspaceHistory({})).toThrowError(WorkspaceHostError);
    expect(() => parseWorkspaceHistory(null)).toThrowError(WorkspaceHostError);
  });
});

describe("describeEventDetail", () => {
  it("reads JSON text or an object and shows only the known keys", () => {
    expect(describeEventDetail('{"status":"failed","device":"gpu","secret":"x"}')).toBe("failed · gpu");
    expect(describeEventDetail({ revision: 4 })).toBe("rev 4");
    expect(describeEventDetail("not json")).toBe("");
    expect(describeEventDetail(undefined)).toBe("");
  });
});

describe("parseWorkspaceScriptText", () => {
  it("requires the text", () => {
    expect(
      parseWorkspaceScriptText({ name: "a", path: "/a.py", sha256: "ab", text: "x = 1\n" }).text,
    ).toBe("x = 1\n");
    expect(() => parseWorkspaceScriptText({ name: "a" })).toThrowError(WorkspaceHostError);
  });
});
