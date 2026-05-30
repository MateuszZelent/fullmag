import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKSPACE_LAYOUT,
  moveWorkspaceColumn,
  restoreWorkspaceLayout,
  serializeWorkspaceLayout,
  resetWorkspaceLayout,
} from "./layoutModel";

describe("workspace layout model", () => {
  it("moves columns by id while preserving every column exactly once", () => {
    const layout = moveWorkspaceColumn(
      DEFAULT_WORKSPACE_LAYOUT,
      "viewport-main",
      "panel-left",
    );

    expect(layout.columns.map((column) => column.slotId)).toEqual([
      "viewport-main",
      "panel-left",
      "viewport-aux",
      "panel-right",
    ]);
    expect(new Set(layout.columns.map((column) => column.slotId)).size).toBe(4);
  });

  it("returns the same layout when drag source or target is missing", () => {
    const layout = moveWorkspaceColumn(
      DEFAULT_WORKSPACE_LAYOUT,
      "unknown-slot",
      "panel-left",
    );

    expect(layout).toBe(DEFAULT_WORKSPACE_LAYOUT);
  });

  it("includes the auxiliary viewport in the default workspace layout", () => {
    expect(DEFAULT_WORKSPACE_LAYOUT.columns.map((column) => column.slotId)).toEqual([
      "panel-left",
      "viewport-main",
      "viewport-aux",
      "panel-right",
    ]);
  });

  it("resets to the default workspace column order", () => {
    const moved = moveWorkspaceColumn(
      DEFAULT_WORKSPACE_LAYOUT,
      "panel-right",
      "panel-left",
    );

    expect(resetWorkspaceLayout()).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    expect(moved).not.toBe(DEFAULT_WORKSPACE_LAYOUT);
  });

  it("serializes and restores the sticky column order", () => {
    const moved = moveWorkspaceColumn(
      DEFAULT_WORKSPACE_LAYOUT,
      "panel-right",
      "panel-left",
    );

    expect(
      restoreWorkspaceLayout(serializeWorkspaceLayout(moved)).columns.map(
        (column) => column.slotId,
      ),
    ).toEqual(["panel-right", "panel-left", "viewport-main", "viewport-aux"]);
  });

  it("falls back to the default layout for invalid stored layouts", () => {
    expect(restoreWorkspaceLayout("{")).toBe(DEFAULT_WORKSPACE_LAYOUT);
    expect(restoreWorkspaceLayout('{"columns":["panel-left"]}')).toBe(
      DEFAULT_WORKSPACE_LAYOUT,
    );
  });
});
