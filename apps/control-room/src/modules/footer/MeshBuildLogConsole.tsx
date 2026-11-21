"use client";

import { type Ref, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/shared/ui/Button";

import type { MeshJobsLogRow } from "./meshJobsModel";
import { type MeshBuildLogConsoleFilters, filterMeshBuildLogRows, serializeMeshBuildLogRows, isLogScrolledToBottom } from "./MeshBuildLogConsole.model";

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
      <div role="group" className="fm-footer__filters" aria-label="Mesh build log filters">
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
          onScroll={(event) => onLogScroll?.(event.currentTarget)}
        >
          <table aria-label="Mesh build log entries" className="fm-footer-diagnostics__log-table">
            <tbody>
              {rows.map((entry) => (
                <tr
                  className="fm-footer-diagnostics__log-row"
                  key={meshBuildLogRowKey(entry)}
                >
                  <td><time>{entry.time}</time></td>
                  <td data-level={entry.level}>
                    {entry.level}
                  </td>
                  <td>
                    {[entry.source, entry.phaseId].filter(Boolean).join(" / ") ||
                      "-"}
                  </td>
                  <td>{entry.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="fm-footer__empty" role="status">
          No mesh build log entries.
        </div>
      )}
    </div>
  );
}
