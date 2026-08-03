import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  DEFAULT_WORKSPACE_LAYOUT,
  moveWorkspaceColumn,
  restoreWorkspaceLayout,
  serializeWorkspaceLayout,
  resetWorkspaceLayout,
} from "./layoutModel";

describe("workspace layout model", () => {
  it("declares Quick Chart as a canonical bottom-panel tab", () => {
    const layoutTypes = readFileSync(new URL("./layoutTypes.ts", import.meta.url), "utf8");
    const eventTypes = readFileSync(new URL("../events/eventTypes.ts", import.meta.url), "utf8");
    const persistence = readFileSync(new URL("../persistence/controlRoomUiState.ts", import.meta.url), "utf8");

    expect(layoutTypes).toContain('| "quick-chart"');
    expect(eventTypes).toContain('| "quick-chart"');
    expect(persistence).toContain('"quick-chart"');
  });
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

  it("defines the Inspector as a pixel-sized scientific work surface", () => {
    const inspector = DEFAULT_WORKSPACE_LAYOUT.columns.find(
      (column) => column.slotId === "panel-right",
    );

    expect(inspector).toMatchObject({
      defaultSize: "416px",
      maxSize: "560px",
      minSize: "360px",
      resizeBehavior: "preserve-pixel-size",
    });
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
