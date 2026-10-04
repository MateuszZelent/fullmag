import { describe, expect, it } from "vitest";

import {
  filterEntries,
  formatEta,
  groupByRecency,
  parseRecentIndex,
  shortenPath,
  sortEntries,
} from "./recentIndex";
import type { RecentEntry } from "./types";

function entry(partial: Partial<RecentEntry> & { projectId: string }): RecentEntry {
  return {
    name: partial.projectId,
    path: `/p/${partial.projectId}.fms`,
    solver: "FDM",
    status: "ready",
    lastOpenedAt: new Date(2026, 9, 3, 12).toISOString(),
    ...partial,
  };
}

// Local-time constructors on purpose: grouping is defined on local calendar days.
const local = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min).toISOString();

describe("parseRecentIndex", () => {
  const raw = (entries: unknown, extra: Record<string, unknown> = {}) => ({
    format_version: 1,
    generated_at: "2026-10-03T10:00:00Z",
    entries,
    ...extra,
  });

  it("rejects a non-object as a recoverable error", () => {
    expect(parseRecentIndex(null).kind).toBe("error");
    expect(parseRecentIndex("{").kind).toBe("error");
  });

  it("rejects an unknown format version", () => {
    const state = parseRecentIndex({ ...raw([]), format_version: 2 });
    expect(state).toMatchObject({ kind: "error" });
  });

  it("treats a truncated index without an entries array as an error", () => {
    expect(parseRecentIndex({ format_version: 1, generated_at: "x" }).kind).toBe("error");
  });

  it("reports empty for an index with no usable entries", () => {
    expect(parseRecentIndex(raw([])).kind).toBe("empty");
    expect(parseRecentIndex(raw([{ name: "no id" }, 7, null])).kind).toBe("empty");
  });

  it("skips malformed rows and de-duplicates on project_id", () => {
    const state = parseRecentIndex(
      raw([
        { project_id: "a", name: "A", path: "/a.fms", solver: "FEM", status: "failed" },
        { project_id: "a", name: "A again" },
        { name: "no id" },
        { project_id: "b", name: "B", status: "bogus", solver: "weird" },
      ]),
    );
    if (state.kind !== "ready") throw new Error(`expected ready, got ${state.kind}`);
    expect(state.index.entries.map((e) => e.projectId)).toEqual(["a", "b"]);
    expect(state.index.entries[0]).toMatchObject({ solver: "FEM", status: "failed" });
    // Unknown enum values degrade instead of poisoning the row.
    expect(state.index.entries[1]).toMatchObject({ solver: "FDM", status: "ready" });
  });

  it("carries a recorded thumbnail data URI through to the entry", () => {
    const thumbnail = "data:image/png;base64,iVBORw0KGgo=";
    const state = parseRecentIndex(
      raw([
        { project_id: "a", name: "A", path: "/a.fms", thumbnail },
        { project_id: "b", name: "B", path: "/b.fms" },
      ]),
    );
    if (state.kind !== "ready") throw new Error(`expected ready, got ${state.kind}`);
    expect(state.index.entries[0].thumbnail).toBe(thumbnail);
    expect(state.index.entries[1].thumbnail).toBeUndefined();
  });

  it("clamps continue progress and never trusts a missing resumable flag as false", () => {
    const state = parseRecentIndex(
      raw([{ project_id: "a", name: "A" }], {
        continue: { project_id: "a", progress: { fraction: 4 } },
      }),
    );
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.index.continue?.progress.fraction).toBe(1);
    expect(state.index.continue?.progress.etaSeconds).toBeNull();
    expect(state.index.continue?.resumable).toBe(true);
  });
});

describe("groupByRecency", () => {
  const now = new Date(2026, 9, 3, 0, 10); // 00:10 local

  it("uses local calendar days: 23:50 yesterday is Yesterday at 00:10", () => {
    const groups = groupByRecency(
      [
        entry({ projectId: "late", lastOpenedAt: local(2026, 10, 2, 23, 50) }),
        entry({ projectId: "now", lastOpenedAt: local(2026, 10, 3, 0, 5) }),
      ],
      now,
    );
    expect(groups.map((g) => [g.id, g.entries.map((e) => e.projectId)])).toEqual([
      ["today", ["now"]],
      ["yesterday", ["late"]],
    ]);
  });

  it("puts a future timestamp in today rather than older", () => {
    const groups = groupByRecency(
      [entry({ projectId: "skew", lastOpenedAt: local(2027, 1, 1) })],
      now,
    );
    expect(groups.map((g) => g.id)).toEqual(["today"]);
  });

  it("hoists pinned entries out of their date group", () => {
    const groups = groupByRecency(
      [
        entry({ projectId: "old-pinned", pinned: true, lastOpenedAt: local(2025, 1, 1) }),
        entry({ projectId: "t", lastOpenedAt: local(2026, 10, 3, 0, 1) }),
      ],
      now,
    );
    expect(groups.map((g) => g.id)).toEqual(["pinned", "today"]);
    expect(groups[0]?.entries[0]?.projectId).toBe("old-pinned");
  });

  it("keeps day boundaries on the calendar across a DST change", () => {
    // Late October / March transitions fall inside this window in most zones;
    // the assertion holds in every zone because it is calendar-relative.
    for (const [y, m, d] of [
      [2026, 3, 29],
      [2026, 10, 25],
      [2026, 11, 1],
    ] as const) {
      const noon = new Date(y, m - 1, d, 12);
      const groups = groupByRecency(
        [
          entry({ projectId: "y", lastOpenedAt: local(y, m, d - 1, 0, 30) }),
          entry({ projectId: "w", lastOpenedAt: local(y, m, d - 6, 0, 30) }),
          entry({ projectId: "o", lastOpenedAt: local(y, m, d - 7, 23, 30) }),
        ],
        noon,
      );
      const byId = Object.fromEntries(
        groups.flatMap((g) => g.entries.map((e) => [e.projectId, g.id] as const)),
      );
      expect(byId).toEqual({ y: "yesterday", w: "week", o: "older" });
    }
  });

  it("omits empty groups", () => {
    expect(groupByRecency([], now)).toEqual([]);
  });
});

describe("filterEntries and sortEntries", () => {
  const entries = [
    entry({ projectId: "a", name: "DMI sweep", solver: "FEM", tags: ["skyrmion"], sizeBytes: 5 }),
    entry({ projectId: "b", name: "standard problem 4", pinned: true, sizeBytes: 50 }),
    entry({ projectId: "c", name: "Śmigło 10", sizeBytes: 20 }),
    entry({ projectId: "d", name: "Śmigło 2", sizeBytes: 1 }),
  ];

  it("filters by solver, pinned and query over name, path, tags and solver", () => {
    expect(filterEntries(entries, "fem", "").map((e) => e.projectId)).toEqual(["a"]);
    expect(filterEntries(entries, "pinned", "").map((e) => e.projectId)).toEqual(["b"]);
    expect(filterEntries(entries, "all", "SKYRMION").map((e) => e.projectId)).toEqual(["a"]);
    expect(filterEntries(entries, "all", "  /p/c ").map((e) => e.projectId)).toEqual(["c"]);
  });

  it("sorts names numerically and sizes descending without mutating input", () => {
    const names = sortEntries(entries, "name").map((e) => e.projectId);
    expect(names.indexOf("d")).toBeLessThan(names.indexOf("c"));
    expect(sortEntries(entries, "size").map((e) => e.projectId)).toEqual(["b", "c", "a", "d"]);
    expect(entries.map((e) => e.projectId)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("formatting", () => {
  it("renders no estimate rather than a guess", () => {
    expect(formatEta(null)).toBeNull();
    expect(formatEta(-1)).toBeNull();
    expect(formatEta(30)).toBe("≈ 30 s");
    expect(formatEta(7200)).toBe("≈ 2 h");
  });

  it("keeps the file name when shortening a path", () => {
    expect(shortenPath("C:\\a\\b\\c\\d\\run.fms")).toBe("…\\c\\d\\run.fms");
    expect(shortenPath("/a/b.fms")).toBe("/a/b.fms");
  });
});
