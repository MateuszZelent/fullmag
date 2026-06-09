import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  filterMeshBuildLogRows,
  isLogScrolledToBottom,
  MeshBuildLogConsoleView,
  serializeMeshBuildLogRows,
  type MeshBuildLogConsoleFilters,
} from "./MeshBuildLogConsole";
import type { MeshJobsLogRow } from "./meshJobsModel";

const rows: MeshJobsLogRow[] = [
  {
    level: "info",
    message: "tetrahedralization started",
    phaseId: "gmsh_meshing",
    source: "gmsh",
    time: "00:00:01",
  },
  { level: "warn", message: "Mesh build quality warning", time: "00:00:02" },
  { level: "error", message: "Solver warning unrelated", time: "00:00:03" },
];

describe("MeshBuildLogConsole", () => {
  it("filters mesh build log rows by source, level, and search text", () => {
    const filters: MeshBuildLogConsoleFilters = {
      level: "warn",
      query: "quality",
      source: "mesh",
    };

    expect(filterMeshBuildLogRows(rows, filters)).toEqual([
      { level: "warn", message: "Mesh build quality warning", time: "00:00:02" },
    ]);
  });

  it("filters by backend source metadata before falling back to message text", () => {
    expect(
      filterMeshBuildLogRows(rows, {
        level: "all",
        query: "",
        source: "gmsh",
      }),
    ).toEqual([
      {
        level: "info",
        message: "tetrahedralization started",
        phaseId: "gmsh_meshing",
        source: "gmsh",
        time: "00:00:01",
      },
    ]);
  });

  it("serializes visible rows for clipboard copy", () => {
    expect(serializeMeshBuildLogRows(rows.slice(0, 2))).toBe(
      "[00:00:01] INFO (gmsh/gmsh_meshing) tetrahedralization started\n[00:00:02] WARN Mesh build quality warning",
    );
  });

  it("detects whether the log viewport is pinned to the newest rows", () => {
    expect(
      isLogScrolledToBottom({
        clientHeight: 100,
        scrollHeight: 300,
        scrollTop: 200,
      }),
    ).toBe(true);
    expect(
      isLogScrolledToBottom({
        clientHeight: 100,
        scrollHeight: 300,
        scrollTop: 120,
      }),
    ).toBe(false);
  });

  it("renders controls and all visible rows without an eight-line cap", () => {
    const manyRows = Array.from({ length: 12 }, (_, index) => ({
      level: "info",
      message: `Gmsh step ${index + 1}`,
      time: `00:00:${String(index + 1).padStart(2, "0")}`,
    }));
    const html = renderToStaticMarkup(
      <MeshBuildLogConsoleView
        copyStatus="idle"
        filters={{ level: "all", query: "", source: "all" }}
        autoScrollPaused={true}
        rows={manyRows}
        totalRows={manyRows.length}
        onCopy={() => {}}
        onFiltersChange={() => {}}
      />,
    );

    expect(html).toContain("aria-label=\"Mesh build log filters\"");
    expect(html).toContain("Copy visible log");
    expect(html).toContain("12 visible");
    expect(html).toContain("auto-scroll paused");
    expect(html).toContain("Gmsh step 12");
  });

  it("includes the visible row index in React keys for repeated log messages", () => {
    const source = readFileSync(
      new URL("./MeshBuildLogConsole.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("rows.map((entry, index)");
    expect(source).toContain(
      'key={`${entry.time}:${entry.level}:${entry.message}:${index}`}',
    );
  });
});
