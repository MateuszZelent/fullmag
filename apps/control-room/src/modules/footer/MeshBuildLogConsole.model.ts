import type { MeshJobsLogRow } from "./meshJobsModel";

export interface MeshBuildLogConsoleFilters {
  level: "all" | "debug" | "error" | "info" | "warn";
  query: string;
  source: "all" | "gmsh" | "mesh";
}

function rowSourceMatches(row: MeshJobsLogRow, source: MeshBuildLogConsoleFilters["source"]): boolean {
  if (source === "all") return true;
  if (row.source?.toLowerCase() === source) return true;
  const message = row.message.toLowerCase();
  if (source === "gmsh") return message.includes("gmsh");
  return (
    message.includes("mesh") ||
    message.includes("meshing") ||
    message.includes("remesh")
  );
}

export function filterMeshBuildLogRows(
  rows: readonly MeshJobsLogRow[],
  filters: MeshBuildLogConsoleFilters,
): MeshJobsLogRow[] {
  const query = filters.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.level !== "all" && row.level.toLowerCase() !== filters.level) {
      return false;
    }
    if (!rowSourceMatches(row, filters.source)) return false;
    return query.length === 0 || row.message.toLowerCase().includes(query);
  });
}

export function serializeMeshBuildLogRows(rows: readonly MeshJobsLogRow[]): string {
  return rows
    .map((row) => {
      const metadata = [row.source, row.phaseId, row.commandId]
        .filter((value) => value && value.trim().length > 0)
        .join("/");
      const suffix = metadata.length > 0 ? ` (${metadata})` : "";
      return `[${row.time}] ${row.level.toUpperCase()}${suffix} ${row.message}`;
    })
    .join("\n");
}

export function isLogScrolledToBottom(
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">,
  tolerancePx = 4,
): boolean {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <= tolerancePx
  );
}
