"use client";

import { type Ref, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/shared/ui/Button";

import type { MeshJobsLogRow } from "./meshJobsModel";

export interface MeshBuildLogConsoleFilters {
  level: "all" | "debug" | "error" | "info" | "warn";
  query: string;
  source: "all" | "gmsh" | "mesh";
}

type MeshBuildLogCopyStatus = "copied" | "failed" | "idle";

function meshBuildLogRowKey(entry: MeshJobsLogRow): string {
  return [
    entry.time,
    entry.level,
    entry.source ?? "",
    entry.phaseId ?? "",
    entry.commandId ?? "",
    entry.message,
  ].join(":");
}

const DEFAULT_FILTERS: MeshBuildLogConsoleFilters = {
  level: "all",
  query: "",
  source: "all",
};

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

export function MeshBuildLogConsole({ rows }: { rows: MeshJobsLogRow[] }) {
  const [filters, setFilters] =
    useState<MeshBuildLogConsoleFilters>(DEFAULT_FILTERS);
  const [copyStatus, setCopyStatus] = useState<MeshBuildLogCopyStatus>("idle");
  const [autoScrollPaused, setAutoScrollPaused] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  const visibleRows = useMemo(
    () => filterMeshBuildLogRows(rows, filters),
    [filters, rows],
  );
  useEffect(() => {
    const logElement = logRef.current;
    if (!logElement || autoScrollPaused) return;
    logElement.scrollTop = logElement.scrollHeight;
  }, [autoScrollPaused, visibleRows]);
  const copyVisibleRows = async () => {
    const text = serializeMeshBuildLogRows(visibleRows);
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };

  return (
    <MeshBuildLogConsoleView
      autoScrollPaused={autoScrollPaused}
      copyStatus={copyStatus}
      filters={filters}
      logRef={logRef}
      rows={visibleRows}
      totalRows={rows.length}
      onCopy={copyVisibleRows}
      onFiltersChange={setFilters}
      onLogScroll={(element) =>
        setAutoScrollPaused(!isLogScrolledToBottom(element))
      }
    />
  );
}

export function MeshBuildLogConsoleView({
  autoScrollPaused = false,
  copyStatus,
  filters,
  logRef,
  rows,
  totalRows,
  onCopy,
  onFiltersChange,
  onLogScroll,
}: {
  autoScrollPaused?: boolean;
  copyStatus: MeshBuildLogCopyStatus;
  filters: MeshBuildLogConsoleFilters;
  logRef?: Ref<HTMLDivElement>;
  rows: MeshJobsLogRow[];
  totalRows: number;
  onCopy: () => void;
  onFiltersChange: (filters: MeshBuildLogConsoleFilters) => void;
  onLogScroll?: (element: HTMLDivElement) => void;
}) {
  return (
    <div className="fm-mesh-build-log-console">
      <div className="fm-footer__filters" aria-label="Mesh build log filters">
        <label className="fm-footer__filter">
          <span>Source</span>
          <select
            value={filters.source}
            onChange={(event) =>
              onFiltersChange({ ...filters, source: event.currentTarget.value as MeshBuildLogConsoleFilters["source"] })
            }
          >
            <option value="all">All</option>
            <option value="mesh">Mesh</option>
            <option value="gmsh">Gmsh</option>
          </select>
        </label>
        <label className="fm-footer__filter">
          <span>Level</span>
          <select
            value={filters.level}
            onChange={(event) =>
              onFiltersChange({ ...filters, level: event.currentTarget.value as MeshBuildLogConsoleFilters["level"] })
            }
          >
            <option value="all">All</option>
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
        </label>
        <label className="fm-footer__filter">
          <span>Search</span>
          <input
            type="search"
            value={filters.query}
            onChange={(event) =>
              onFiltersChange({ ...filters, query: event.currentTarget.value })
            }
          />
        </label>
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={onCopy}
        >
          Copy visible log
        </Button>
        <span className="fm-footer-diagnostics__meta" role="status">
          {rows.length}/{totalRows} visible
          {autoScrollPaused ? " · auto-scroll paused" : ""}
          {copyStatus === "copied" ? " · copied" : ""}
          {copyStatus === "failed" ? " · copy failed" : ""}
        </span>
      </div>
      {rows.length > 0 ? (
        <div
          ref={logRef}
          className="fm-footer-diagnostics__log"
          role="table"
          onScroll={(event) => onLogScroll?.(event.currentTarget)}
        >
          {rows.map((entry) => (
            <div
              className="fm-footer-diagnostics__log-row"
              role="row"
              key={meshBuildLogRowKey(entry)}
            >
              <time role="cell">{entry.time}</time>
              <span role="cell" data-level={entry.level}>
                {entry.level}
              </span>
              <span role="cell">
                {[entry.source, entry.phaseId].filter(Boolean).join(" / ") ||
                  "-"}
              </span>
              <span role="cell">{entry.message}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="fm-footer__empty" role="status">
          No mesh build log entries.
        </div>
      )}
    </div>
  );
}
