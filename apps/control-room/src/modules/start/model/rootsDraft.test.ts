import { describe, expect, it } from "vitest";

import {
  ALL_KINDS,
  addRoot,
  describeScan,
  removeRoot,
  rootIdentity,
  sameRoots,
  toggleKind,
  updateRoot,
} from "./rootsDraft";
import type { ApiWorkspaceRoot } from "./workspaceApiTypes";

const root = (path: string, over: Partial<ApiWorkspaceRoot> = {}): ApiWorkspaceRoot => ({
  path,
  kinds: [...ALL_KINDS],
  recursive: true,
  enabled: true,
  ...over,
});

describe("addRoot", () => {
  it("adds an absolute path with every kind, subfolders and enabled", () => {
    const result = addRoot([], "  D:\\sim\\ ");
    expect(result).toEqual({ ok: true, roots: [root("D:\\sim\\")] });
  });

  it("refuses an empty, relative or duplicate path with a reason", () => {
    expect(addRoot([], "  ")).toMatchObject({ ok: false, reason: expect.stringContaining("absolute path") });
    expect(addRoot([], "data/runs")).toMatchObject({ ok: false, reason: expect.stringContaining("absolute") });
    expect(addRoot([root("D:\\sim")], "d:/SIM/")).toMatchObject({
      ok: false,
      reason: "That folder is already indexed.",
    });
  });

  it("does not treat two POSIX paths that differ in case as one folder", () => {
    expect(addRoot([root("/Data")], "/data")).toMatchObject({ ok: true });
  });
});

describe("root identity", () => {
  it("ignores separators, trailing slashes and drive-letter case", () => {
    expect(rootIdentity("C:\\Data\\")).toBe(rootIdentity("c:/data"));
    expect(rootIdentity("/a/b/")).toBe("/a/b");
  });
});

describe("editing roots", () => {
  const roots = [root("/a"), root("/b")];

  it("removes and updates by path without touching the others", () => {
    expect(removeRoot(roots, "/a").map((r) => r.path)).toEqual(["/b"]);
    const updated = updateRoot(roots, "/b", (r) => ({ ...r, enabled: false }));
    expect(updated[1]?.enabled).toBe(false);
    expect(updated[0]).toBe(roots[0]);
  });

  it("toggles a kind but never leaves a root indexing nothing", () => {
    const some = toggleKind(root("/a"), "script");
    expect(some.kinds).toEqual(["project", "result"]);
    expect(toggleKind(some, "script").kinds).toEqual(["project", "script", "result"]);
    const one = root("/a", { kinds: ["result"] });
    expect(toggleKind(one, "result")).toBe(one);
  });

  it("compares two lists structurally", () => {
    expect(sameRoots(roots, [root("/a"), root("/b")])).toBe(true);
    expect(sameRoots(roots, [root("/a")])).toBe(false);
    expect(sameRoots(roots, [root("/a"), root("/b", { recursive: false })])).toBe(false);
    expect(sameRoots(roots, [root("/a"), root("/b", { kinds: ["project"] })])).toBe(false);
  });
});

describe("describeScan", () => {
  it("writes the counts in one line", () => {
    expect(describeScan({ scanned: 1482, added: 3, updated: 5, missing: 1, skipped: 12 })).toBe(
      "Scanned 1,482: 3 added, 5 updated, 1 missing, 12 skipped.",
    );
  });
});
