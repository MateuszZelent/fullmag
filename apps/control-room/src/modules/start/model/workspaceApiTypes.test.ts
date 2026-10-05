import { describe, expect, it } from "vitest";

import { RAW_API_ITEM, RAW_API_PROJECT_DETAIL, RAW_API_RESULT_DETAIL, RAW_API_SCRIPT_DETAIL } from "./__fixtures__/workspaceApi";
import {
  formatGrid,
  metaLastRun,
  metaNumber,
  metaString,
  parseApiEvents,
  parseApiHistory,
  parseApiItemDetail,
  parseApiItemDetailAnswer,
  parseApiRoots,
  parseApiScanReport,
  parseApiWorkspaceItem,
  parseApiWorkspaceList,
} from "./workspaceApiTypes";
import { WorkspaceHostError } from "./workspaceItems";

const outcome = { state: "ready" };

describe("parseApiWorkspaceItem", () => {
  it("reads a full item", () => {
    expect(parseApiWorkspaceItem(RAW_API_ITEM)).toMatchObject({
      id: "wi-script-1",
      kind: "script",
      name: "sp4",
      path: "C:\\work\\sp4.py",
      useCount: 3,
      pinned: true,
      status: "ready",
      sizeBytes: 2048,
      hasThumbnail: false,
    });
  });

  it("defaults what may be absent instead of rejecting the item", () => {
    const item = parseApiWorkspaceItem({ id: "a", kind: "result", path: "/r.zarr", name: "r" });
    expect(item).toMatchObject({
      firstSeenAt: "",
      lastUsedAt: "",
      useCount: 0,
      pinned: false,
      status: "ready",
      sizeBytes: undefined,
      modifiedAt: undefined,
      meta: {},
      hasThumbnail: false,
    });
  });

  it.each([
    ["not an object", "x"],
    ["array", []],
    ["no id", { kind: "script", path: "/a.py", name: "a" }],
    ["empty id", { id: "", kind: "script", path: "/a.py", name: "a" }],
    ["numeric id", { id: 7, kind: "script", path: "/a.py", name: "a" }],
    ["unknown kind", { id: "a", kind: "notebook", path: "/a.py", name: "a" }],
    ["no path", { id: "a", kind: "script", name: "a" }],
    ["no name", { id: "a", kind: "script", path: "/a.py" }],
  ])("rejects an item with %s", (_label, value) => {
    expect(parseApiWorkspaceItem(value)).toBeNull();
  });

  it("falls back to ready for an unknown status and ignores a non-object meta", () => {
    const item = parseApiWorkspaceItem({
      id: "a",
      kind: "project",
      path: "/a.fms",
      name: "a",
      status: "exploded",
      meta: "nope",
      use_count: -4.7,
    });
    expect(item).toMatchObject({ status: "ready", meta: {}, useCount: 0 });
  });
});

describe("parseApiWorkspaceList", () => {
  it("returns the items and the outcome", () => {
    const list = parseApiWorkspaceList({ items: [RAW_API_ITEM], outcome: { state: "migrated", detail: "v1 to v2" } });
    expect(list.items).toHaveLength(1);
    expect(list.outcome).toEqual({ state: "migrated", detail: "v1 to v2" });
    expect(list.skipped).toBe(0);
  });

  it("skips and counts a bad row and a duplicate id, keeping the rest", () => {
    const list = parseApiWorkspaceList({
      items: [RAW_API_ITEM, { id: "broken" }, RAW_API_ITEM, null, { ...RAW_API_ITEM, id: "wi-2" }],
      outcome,
    });
    expect(list.items.map((i) => i.id)).toEqual(["wi-script-1", "wi-2"]);
    expect(list.skipped).toBe(3);
  });

  it.each([
    ["null", null],
    ["no items", { outcome }],
    ["items not an array", { items: {}, outcome }],
    ["no outcome", { items: [] }],
    ["unknown outcome state", { items: [], outcome: { state: "melted" } }],
    ["outcome not an object", { items: [], outcome: "ready" }],
  ])("rejects an envelope with %s", (_label, value) => {
    expect(() => parseApiWorkspaceList(value)).toThrow(WorkspaceHostError);
  });

  it("accepts every documented outcome state", () => {
    for (const state of ["ready", "created", "migrated", "quarantined", "read_only_newer_schema"]) {
      expect(parseApiWorkspaceList({ items: [], outcome: { state } }).outcome.state).toBe(state);
    }
  });
});

describe("parseApiItemDetail", () => {
  it("reads a project detail with its summary, authors, history and runs", () => {
    const detail = parseApiItemDetail(RAW_API_PROJECT_DETAIL);
    expect(detail?.kind).toBe("project");
    if (detail?.kind !== "project") return;
    expect(detail).toMatchObject({
      schemaVersion: "1.2",
      revision: 42,
      solver: "FDM",
      migrated: false,
      canWrite: true,
      mode: "read_write",
      previewColouring: "mz",
    });
    expect(detail.summary?.model).toMatchObject({
      discretisation: "512 x 512 x 8",
      materials: ["YIG"],
      interactions: ["exchange", "demag"],
    });
    expect(detail.summary?.execution.integrator).toBe("RK45");
    expect(detail.summary?.outputs).toEqual({ frames: 400, sizeBytes: 1420000000 });
    expect(detail.authors[0]).toMatchObject({ name: "Mateusz Zelent", role: "creator" });
    expect(detail.history).toHaveLength(1);
    expect(detail.runs.map((r) => r.runId)).toEqual(["run-7"]);
  });

  it("leaves every absent project field undefined", () => {
    const detail = parseApiItemDetail({ kind: "project" });
    expect(detail).toMatchObject({
      kind: "project",
      schemaVersion: undefined,
      revision: undefined,
      summary: undefined,
      warnings: [],
      authors: [],
      history: [],
      runs: [],
      readError: undefined,
    });
  });

  it("keeps a read_error and does not invent a summary", () => {
    const detail = parseApiItemDetail({ kind: "project", read_error: "archive is truncated" });
    expect(detail).toMatchObject({ readError: "archive is truncated", summary: undefined });
  });

  it("reads a script detail", () => {
    expect(parseApiItemDetail(RAW_API_SCRIPT_DETAIL)).toMatchObject({
      kind: "script",
      lines: 120,
      bytes: 2048,
      encoding: "utf-8",
      usesFullmag: true,
      syntax: { ok: false, line: 14, message: "unexpected indent" },
      unresolvedImports: ["scipy"],
      envReads: ["FULLMAG_DEVICE"],
      lastRun: { status: "ok", durationSeconds: 42 },
    });
  });

  it("ignores a syntax block without a boolean ok", () => {
    expect(parseApiItemDetail({ kind: "script", syntax: { ok: "yes" } })).toMatchObject({
      syntax: undefined,
    });
  });

  it("reads a result detail with its stages, quantities, grid and source", () => {
    const detail = parseApiItemDetail(RAW_API_RESULT_DETAIL);
    expect(detail).toMatchObject({
      kind: "result",
      format: "zarr",
      formatVersion: "2",
      runId: "run-3",
      source: { kind: "script", path: "C:\\work\\sp4.py" },
      quantities: ["m", "H_demag"],
      frames: 400,
      totalBytes: 318000000,
      status: "completed",
    });
    if (detail?.kind !== "result") return;
    expect(detail.stages).toEqual([
      { id: "relax", kind: "relaxation", steps: 4210, timeS: undefined },
      { id: "pulse", kind: undefined, steps: undefined, timeS: 1e-9 },
    ]);
    expect(detail.grid).toBe("200 × 50 × 1 cells, 2.5 × 2.5 × 2.5 nm");
  });

  it("drops a stage without an id and a source without a path", () => {
    const detail = parseApiItemDetail({
      kind: "result",
      stages: [{ steps: 3 }, "x", { id: "ok" }],
      source: { kind: "script" },
    });
    expect(detail).toMatchObject({ stages: [{ id: "ok" }], source: undefined });
  });

  it.each([null, "x", [], {}, { kind: "notebook" }])("returns undefined for %j", (value) => {
    expect(parseApiItemDetail(value)).toBeUndefined();
  });
});

describe("formatGrid", () => {
  it("passes a string through, formats cells, and refuses the rest", () => {
    expect(formatGrid("64 x 64")).toBe("64 x 64");
    expect(formatGrid({ nx: 4, ny: 5, nz: 6 })).toBe("4 × 5 × 6 cells");
    expect(formatGrid({ description: "adaptive" })).toBe("adaptive");
    expect(formatGrid({ nx: 4, ny: 5 })).toBeUndefined();
    expect(formatGrid(42)).toBeUndefined();
    expect(formatGrid(null)).toBeUndefined();
  });
});

describe("parseApiEvents and history", () => {
  it("reads events whose detail is an object or JSON text, and drops the malformed", () => {
    const events = parseApiEvents([
      { at: "2026-10-03T10:00:00Z", kind: "run", actor: "cli", detail: { status: "ok" } },
      { at: "2026-10-03T09:00:00Z", kind: "edit", actor: "desktop", detail: '{"after":{"lines":3}}' },
      { at: "2026-10-03T08:00:00Z", kind: "open", detail: "not json" },
      { kind: "open" },
      { at: "2026-10-03T07:00:00Z" },
      "x",
    ]);
    expect(events.map((e) => e.kind)).toEqual(["run", "edit", "open"]);
    expect(events[0]?.detail).toEqual({ status: "ok" });
    expect(events[1]?.detail).toEqual({ after: { lines: 3 } });
    expect(events[2]).toMatchObject({ actor: "", detail: {} });
  });

  it("gives identical events distinct keys", () => {
    const same = { at: "2026-10-03T10:00:00Z", kind: "open", actor: "web" };
    const keys = parseApiEvents([same, same]).map((e) => e.key);
    expect(new Set(keys).size).toBe(2);
  });

  it("treats a non-array as no events, and requires the history envelope", () => {
    expect(parseApiEvents(undefined)).toEqual([]);
    expect(parseApiHistory({ events: [{ at: "2026-10-03T10:00:00Z", kind: "open" }] })).toHaveLength(1);
    expect(() => parseApiHistory(null)).toThrow(WorkspaceHostError);
  });
});

describe("parseApiItemDetailAnswer", () => {
  it("reads the item, detail, events, linked results and source", () => {
    const answer = parseApiItemDetailAnswer({
      item: RAW_API_ITEM,
      detail: RAW_API_SCRIPT_DETAIL,
      events: [{ at: "2026-10-03T10:00:00Z", kind: "run", actor: "cli", detail: {} }],
      read_at: "2026-10-04T10:00:00Z",
      linked_results: [{ ...RAW_API_ITEM, id: "r1", kind: "result" }, { id: "bad" }],
      linked_source: { ...RAW_API_ITEM, id: "p1", kind: "project", path: "/p.fms" },
    });
    expect(answer.item.id).toBe("wi-script-1");
    expect(answer.detail?.kind).toBe("script");
    expect(answer.events).toHaveLength(1);
    expect(answer.readAt).toBe("2026-10-04T10:00:00Z");
    expect(answer.linkedResults.map((r) => r.id)).toEqual(["r1"]);
    expect(answer.linkedSource?.id).toBe("p1");
  });

  it("shows the item when the backend sent no detail, events or links", () => {
    const answer = parseApiItemDetailAnswer({ item: RAW_API_ITEM });
    expect(answer.detail).toBeUndefined();
    expect(answer.events).toEqual([]);
    expect(answer.linkedResults).toEqual([]);
    expect(answer.linkedSource).toBeUndefined();
  });

  it.each([null, "x", {}, { item: { id: "x" } }])("rejects %j", (value) => {
    expect(() => parseApiItemDetailAnswer(value)).toThrow(WorkspaceHostError);
  });
});

describe("roots and scan report", () => {
  it("reads roots, defaulting kinds to all and the flags to true", () => {
    expect(
      parseApiRoots({
        roots: [
          { path: "D:\\sim", kinds: ["project"], recursive: false, enabled: false },
          { path: "/data" },
          { path: "" },
          { kinds: ["script"] },
          7,
        ],
      }),
    ).toEqual([
      { path: "D:\\sim", kinds: ["project"], recursive: false, enabled: false },
      { path: "/data", kinds: ["project", "script", "result"], recursive: true, enabled: true },
    ]);
  });

  it("ignores unknown kinds and falls back to all when none are known", () => {
    expect(parseApiRoots({ roots: [{ path: "/a", kinds: ["notebook"] }] })[0]?.kinds).toEqual([
      "project",
      "script",
      "result",
    ]);
  });

  it("rejects a roots answer without the array", () => {
    expect(() => parseApiRoots({})).toThrow(WorkspaceHostError);
  });

  it("reads a scan report and clamps bad counts to zero", () => {
    expect(
      parseApiScanReport({ scanned: 10, added: 2.9, updated: -1, missing: "x", warnings: ["a", 3, ""] }),
    ).toEqual({ scanned: 10, added: 2, updated: 0, missing: 0, skipped: 0, warnings: ["a"] });
    expect(() => parseApiScanReport("x")).toThrow(WorkspaceHostError);
  });
});

describe("meta accessors", () => {
  const item = { meta: { solver: "FEM", revision: 3, last_run: { status: "ok", at: "t", duration_seconds: 2 } } };

  it("reads typed values and ignores the wrong type", () => {
    expect(metaString(item, "solver")).toBe("FEM");
    expect(metaString(item, "revision")).toBeUndefined();
    expect(metaNumber(item, "revision")).toBe(3);
    expect(metaNumber(item, "solver")).toBeUndefined();
    expect(metaLastRun(item)).toEqual({ status: "ok", at: "t", durationSeconds: 2, device: undefined });
    expect(metaLastRun({ meta: { last_run: "ok" } })).toBeUndefined();
  });
});
