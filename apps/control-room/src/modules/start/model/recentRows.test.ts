import { describe, expect, it } from "vitest";

import { project, script } from "./__fixtures__/workspaceScripts";
import {
  buildRows,
  coerceSort,
  filterScripts,
  isKindFilter,
  isSortKey,
  projectRow,
  scriptRow,
  sortKeysFor,
  sortRows,
  type KindFilter,
  type RecentRow,
  type SortKey,
} from "./recentRows";

const keys = (rows: readonly RecentRow[]) => rows.map((r) => r.key);

describe("sort options per kind", () => {
  it("offers Most used for scripts only, because projects record no use count", () => {
    expect(sortKeysFor("script")).toContain("use_count");
    expect(sortKeysFor("project")).not.toContain("use_count");
    expect(sortKeysFor("all")).not.toContain("use_count");
  });

  it("keeps Created and Size for projects", () => {
    expect(sortKeysFor("project")).toEqual(["last_used", "name", "modified", "created", "size"]);
  });

  it("falls back to Last used when the kind does not offer the remembered sort", () => {
    expect(coerceSort("project", "use_count")).toBe("last_used");
    expect(coerceSort("all", "size")).toBe("last_used");
    expect(coerceSort("script", "use_count")).toBe("use_count");
  });

  it("validates stored values", () => {
    expect(isKindFilter("script")).toBe(true);
    expect(isKindFilter("notebook")).toBe(false);
    expect(isSortKey("use_count")).toBe(true);
    expect(isSortKey("toString")).toBe(false);
    expect(isSortKey(3)).toBe(false);
  });
});

describe("sortRows: last used merges projects and scripts by time", () => {
  it("orders by project last_opened and script last_used_at together, newest first", () => {
    const rows = [
      projectRow(project({ projectId: "a", lastOpenedAt: "2026-10-01T10:00:00Z" })),
      scriptRow(script({ id: 1, lastUsedAt: "2026-10-03T10:00:00Z" })),
      projectRow(project({ projectId: "b", lastOpenedAt: "2026-10-02T10:00:00Z" })),
      scriptRow(script({ id: 2, lastUsedAt: "2026-09-30T10:00:00Z" })),
    ];
    expect(keys(sortRows(rows, "last_used"))).toEqual([
      "script:1",
      "project:b",
      "project:a",
      "script:2",
    ]);
  });

  it("puts rows with a missing or unparsable time last", () => {
    const rows = [
      scriptRow(script({ id: 1, lastUsedAt: "" })),
      scriptRow(script({ id: 2, lastUsedAt: "not a date" })),
      scriptRow(script({ id: 3, lastUsedAt: "2026-10-03T10:00:00Z" })),
    ];
    expect(sortRows(rows, "last_used")[0]?.key).toBe("script:3");
  });

  it("breaks equal timestamps by name, then path, then kind, then id, the same every time", () => {
    const same = "2026-10-03T10:00:00Z";
    const rows = [
      scriptRow(script({ id: 5, name: "same", path: "/b/same.py", lastUsedAt: same })),
      scriptRow(script({ id: 3, name: "same", path: "/a/same.py", lastUsedAt: same })),
      projectRow(project({ projectId: "p", name: "same", path: "/a/same.py", lastOpenedAt: same })),
      scriptRow(script({ id: 4, name: "alpha", path: "/z/alpha.py", lastUsedAt: same })),
    ];
    const expected = ["script:4", "project:p", "script:3", "script:5"];
    expect(keys(sortRows(rows, "last_used"))).toEqual(expected);
    expect(keys(sortRows([...rows].reverse(), "last_used"))).toEqual(expected);
  });

  it("orders script ids numerically when everything else ties", () => {
    const rows = [
      scriptRow(script({ id: 10, name: "x", path: "/x.py" })),
      scriptRow(script({ id: 9, name: "x", path: "/x.py" })),
    ];
    expect(keys(sortRows(rows, "last_used"))).toEqual(["script:9", "script:10"]);
  });
});

describe("sortRows: name", () => {
  it("is case-insensitive and treats digits as numbers", () => {
    const rows = ["beta", "Alpha", "gamma", "run 10", "Run 2"].map((name, i) =>
      scriptRow(script({ id: i + 1, name })),
    );
    expect(sortRows(rows, "name").map((r) => (r.kind === "script" ? r.item.name : ""))).toEqual([
      "Alpha",
      "beta",
      "gamma",
      "Run 2",
      "run 10",
    ]);
  });

  it("places non-ASCII letters with their base letter, not after z", () => {
    const rows = ["zebra", "Éclair", "apple"].map((name, i) => scriptRow(script({ id: i + 1, name })));
    expect(sortRows(rows, "name").map((r) => (r.kind === "script" ? r.item.name : ""))).toEqual([
      "apple",
      "Éclair",
      "zebra",
    ]);
  });

  it("does not let case split names that differ only by case; path decides", () => {
    const rows = [
      scriptRow(script({ id: 1, name: "Sp4", path: "/b/Sp4.py" })),
      scriptRow(script({ id: 2, name: "sp4", path: "/a/sp4.py" })),
    ];
    expect(keys(sortRows(rows, "name"))).toEqual(["script:2", "script:1"]);
  });

  it("merges projects and scripts into one alphabetical list", () => {
    const rows = [
      projectRow(project({ projectId: "p1", name: "Vortex" })),
      scriptRow(script({ id: 1, name: "bench" })),
      projectRow(project({ projectId: "p2", name: "alpha" })),
    ];
    expect(keys(sortRows(rows, "name"))).toEqual(["project:p2", "script:1", "project:p1"]);
  });
});

describe("sortRows: modified, use count, created, size", () => {
  it("sorts by modified time, newest first, missing last", () => {
    const rows = [
      projectRow(project({ projectId: "none" })),
      projectRow(project({ projectId: "old", modifiedAt: "2026-01-01T00:00:00Z" })),
      scriptRow(script({ id: 1, modifiedAt: "2026-06-01T00:00:00Z" })),
    ];
    expect(keys(sortRows(rows, "modified"))).toEqual(["script:1", "project:old", "project:none"]);
  });

  it("sorts scripts by use count, most first; ties fall back to name", () => {
    const rows = [
      scriptRow(script({ id: 1, name: "b", useCount: 2 })),
      scriptRow(script({ id: 2, name: "a", useCount: 2 })),
      scriptRow(script({ id: 3, name: "c", useCount: 9 })),
    ];
    expect(keys(sortRows(rows, "use_count"))).toEqual(["script:3", "script:2", "script:1"]);
  });

  it("ranks a row with no use count (a project) after every counted script", () => {
    const rows = [
      projectRow(project({ projectId: "p" })),
      scriptRow(script({ id: 1, useCount: 0 })),
    ];
    expect(keys(sortRows(rows, "use_count"))).toEqual(["script:1", "project:p"]);
  });

  it("maps created to a script's first_seen_at and size to size_bytes", () => {
    const rows = [
      scriptRow(script({ id: 1, firstSeenAt: "2026-01-01T00:00:00Z", sizeBytes: 10 })),
      projectRow(project({ projectId: "p", createdAt: "2026-05-01T00:00:00Z", sizeBytes: 5000 })),
    ];
    expect(keys(sortRows(rows, "created"))).toEqual(["project:p", "script:1"]);
    expect(keys(sortRows(rows, "size"))).toEqual(["project:p", "script:1"]);
  });
});

describe("pinned rows come first in every sort", () => {
  const rows = [
    scriptRow(script({ id: 1, name: "zz", pinned: true, lastUsedAt: "2020-01-01T00:00:00Z", useCount: 0 })),
    projectRow(project({ projectId: "new", name: "aa", lastOpenedAt: "2026-10-03T10:00:00Z" })),
    projectRow(
      project({ projectId: "pinned-project", name: "mm", pinned: true, lastOpenedAt: "2019-01-01T00:00:00Z" }),
    ),
    scriptRow(script({ id: 2, name: "bb", useCount: 50 })),
  ];

  for (const key of ["last_used", "name", "modified", "use_count", "created", "size"] as SortKey[]) {
    it(`sort ${key}`, () => {
      const sorted = sortRows(rows, key);
      expect(sorted.slice(0, 2).map((r) => r.key).sort()).toEqual(["project:pinned-project", "script:1"]);
      expect(sorted.slice(2).every((r) => !(r.kind === "script" ? r.item.pinned : r.entry.pinned))).toBe(
        true,
      );
    });
  }

  it("does not mutate its input", () => {
    const before = keys(rows);
    sortRows(rows, "name");
    expect(keys(rows)).toEqual(before);
  });
});

describe("filterScripts", () => {
  const items = [
    script({ id: 1, name: "SP4", path: "/home/ana/benchmarks/sp4.py" }),
    script({ id: 2, name: "vortex", path: "/home/ana/Skyrmion/run.py", pinned: true }),
  ];

  it("matches name and path, case-insensitively", () => {
    expect(filterScripts(items, "all", "sp4").map((s) => s.id)).toEqual([1]);
    expect(filterScripts(items, "all", "SKYRMION").map((s) => s.id)).toEqual([2]);
    expect(filterScripts(items, "all", "  ").map((s) => s.id)).toEqual([1, 2]);
    expect(filterScripts(items, "all", "nothing")).toEqual([]);
  });

  it("does not match the summary or other metadata", () => {
    const withSummary = [script({ id: 3, name: "x", meta: { summary: "needle" } })];
    expect(filterScripts(withSummary, "all", "needle")).toEqual([]);
  });

  it("applies Pinned and excludes scripts from the solver chips", () => {
    expect(filterScripts(items, "pinned", "").map((s) => s.id)).toEqual([2]);
    expect(filterScripts(items, "fdm", "")).toEqual([]);
    expect(filterScripts(items, "fem", "")).toEqual([]);
  });
});

describe("buildRows", () => {
  const entries = [
    project({ projectId: "p1", name: "Vortex", lastOpenedAt: "2026-10-02T10:00:00Z" }),
    project({ projectId: "p2", name: "Beam", solver: "FEM", lastOpenedAt: "2026-10-01T10:00:00Z" }),
  ];
  const scripts = [
    script({ id: 1, name: "bench", lastUsedAt: "2026-10-03T10:00:00Z", useCount: 4 }),
    script({ id: 2, name: "vortex_fit", lastUsedAt: "2026-09-01T10:00:00Z", useCount: 9 }),
  ];
  const build = (kind: KindFilter, over: Partial<Parameters<typeof buildRows>[0]> = {}) =>
    keys(buildRows({ kind, entries, scripts, filter: "all", query: "", sort: "last_used", ...over }));

  it("shows only the chosen kind", () => {
    expect(build("project")).toEqual(["project:p1", "project:p2"]);
    expect(build("script")).toEqual(["script:1", "script:2"]);
  });

  it("merges both kinds for All, newest first", () => {
    expect(build("all")).toEqual(["script:1", "project:p1", "project:p2", "script:2"]);
  });

  it("searches name and path across kinds with one query", () => {
    expect(build("all", { query: "vortex" })).toEqual(["project:p1", "script:2"]);
  });

  it("drops scripts when a solver chip is on", () => {
    expect(build("all", { filter: "fem" })).toEqual(["project:p2"]);
  });

  it("applies Most used to scripts and coerces it away for projects and All", () => {
    expect(build("script", { sort: "use_count" })).toEqual(["script:2", "script:1"]);
    expect(build("all", { sort: "use_count" })).toEqual(build("all"));
    expect(build("project", { sort: "use_count" })).toEqual(build("project"));
  });
});
