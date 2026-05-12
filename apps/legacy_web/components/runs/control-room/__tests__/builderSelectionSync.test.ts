import { describe, expect, it } from "vitest";

import {
  isBuilderSelectionNodeId,
  resolveBuilderSidebarNodeId,
  resolveBuilderSidebarSelectionSync,
} from "../builderSelectionSync";

describe("builderSelectionSync", () => {
  it("recognizes transient builder selection nodes", () => {
    expect(isBuilderSelectionNodeId("builder-universe")).toBe(true);
    expect(isBuilderSelectionNodeId("builder-prim-abc")).toBe(true);
    expect(isBuilderSelectionNodeId("builder-bool-abc")).toBe(true);
    expect(isBuilderSelectionNodeId("builder-root")).toBe(false);
  });

  it("maps builder selections to canonical sidebar ids", () => {
    expect(resolveBuilderSidebarNodeId({ type: "universe", id: "universe" })).toBe("builder-universe");
    expect(resolveBuilderSidebarNodeId({ type: "primitive", id: "abc" })).toBe("builder-prim-abc");
    expect(resolveBuilderSidebarNodeId({ type: "boolean", id: "bool-1" })).toBe("builder-bool-bool-1");
    expect(resolveBuilderSidebarNodeId({ type: "none" })).toBeNull();
  });

  it("falls back to builder-root after removing the selected builder node", () => {
    expect(
      resolveBuilderSidebarSelectionSync({
        builderEnabled: true,
        builderSelection: { type: "none" },
        currentSidebarNodeId: "builder-prim-abc",
      }),
    ).toBe("builder-root");
  });

  it("does not override stable non-selection builder nodes", () => {
    expect(
      resolveBuilderSidebarSelectionSync({
        builderEnabled: true,
        builderSelection: { type: "none" },
        currentSidebarNodeId: "builder-primitives",
      }),
    ).toBeNull();
  });

  it("does nothing when builder mode is disabled", () => {
    expect(
      resolveBuilderSidebarSelectionSync({
        builderEnabled: false,
        builderSelection: { type: "primitive", id: "abc" },
        currentSidebarNodeId: null,
      }),
    ).toBeNull();
  });
});
