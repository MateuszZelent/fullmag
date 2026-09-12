"use client";

import { useMemo, useState } from "react";

import {
  latestMeshBuildComparisonSelection,
  meshBuildHistoryComparisonForSelection,
  type MeshBuildHistoryEntry,
  type MeshBuildHistoryComparisonRow,
  type MeshBuildHistoryComparisonSelection,
} from "@/shared/domain/mesh/meshBuildHistory";

import {
  formatCount,
  formatValue,
  MeshResourceEmpty,
} from "./MeshResourceView";
import { Button } from "@/shared/ui/Button";

function formatDelta(value: number | null): string {
  if (value === null) return "baseline";
  if (value > 0) return `+${value.toLocaleString("en-US")}`;
  return value.toLocaleString("en-US");
}

function formatComparisonValue(value: number | null): string {
  return value === null ? "unset" : formatValue(value);
}

function qualitySummary(entry: MeshBuildHistoryEntry): string {
  const parts = [
    entry.sicnP05 === null ? null : `SICN p05 ${formatValue(entry.sicnP05)}`,
    entry.gammaMin === null ? null : `gamma min ${formatValue(entry.gammaMin)}`,
    entry.avgQuality === null ? null : `avg ${formatValue(entry.avgQuality)}`,
  ].filter(Boolean);
  return parts.join(" / ") || "quality unavailable";
}

function buildOptionLabel(entry: MeshBuildHistoryEntry): string {
  return `#${entry.index + 1} ${entry.meshName ?? "unnamed mesh"} · ${entry.id}`;
}

function buildReason(entry: MeshBuildHistoryEntry): string {
  return (
    entry.meshReason ??
    entry.kind ??
    entry.generationMode ??
    entry.meshTarget ??
    "build"
  );
}

function MeshBuildHistoryComparisonTable({
  rows,
}: {
  rows: MeshBuildHistoryComparisonRow[];
}) {
  return (
    <div className="fm-mesh-build-comparison" role="table">
      <div className="fm-mesh-build-comparison__row" role="row">
        <span>Metric</span>
        <span>Before</span>
        <span>After</span>
        <span>Delta</span>
      </div>
      {rows.map((row) => (
        <div
          className="fm-mesh-build-comparison__row"
          key={row.id}
          role="row"
        >
          <span>{row.label}</span>
          <span>{formatComparisonValue(row.before)}</span>
          <span>{formatComparisonValue(row.after)}</span>
          <span>{formatDelta(row.delta)}</span>
        </div>
      ))}
    </div>
  );
}

export function MeshBuildHistoryView({
  entries,
  onRestore,
}: {
  entries: MeshBuildHistoryEntry[];
  onRestore?: (entry: MeshBuildHistoryEntry) => void;
}) {
  const defaultSelection = useMemo(
    () => latestMeshBuildComparisonSelection(entries),
    [entries],
  );
  const [requestedSelection, setRequestedSelection] =
    useState<MeshBuildHistoryComparisonSelection | null>(null);
  const validIds = useMemo(
    () => new Set(entries.map((entry) => entry.id)),
    [entries],
  );
  const selection =
    requestedSelection &&
    requestedSelection.beforeId &&
    requestedSelection.afterId &&
    validIds.has(requestedSelection.beforeId) &&
    validIds.has(requestedSelection.afterId)
      ? requestedSelection
      : defaultSelection;
  const comparison = selection
    ? meshBuildHistoryComparisonForSelection(entries, selection)
    : null;

  const updateBeforeId = (beforeId: string) => {
    const afterId =
      selection?.afterId !== beforeId && selection?.afterId !== undefined
        ? selection.afterId
        : (entries.find((entry) => entry.id !== beforeId)?.id ?? beforeId);
    setRequestedSelection({ afterId, beforeId });
  };

  const updateAfterId = (afterId: string) => {
    const beforeId =
      selection?.beforeId !== afterId && selection?.beforeId !== undefined
        ? selection.beforeId
        : (entries.find((entry) => entry.id !== afterId)?.id ?? afterId);
    setRequestedSelection({ afterId, beforeId });
  };

  if (entries.length === 0) {
    return <MeshResourceEmpty label="No mesh build history is available." />;
  }

  return (
    <div className="fm-mesh-build-history">
      {comparison ? (
        <section className="fm-mesh-build-history__comparison">
          <header>
            <h4>Compare builds</h4>
            <div className="fm-mesh-build-history__controls">
              <label>
                <span>From</span>
                  <select
                    className="fm-inspector-select"
                  onChange={(event) =>
                    updateBeforeId(event.currentTarget.value)
                  }
                  value={selection?.beforeId ?? entries[0].id}
                >
                  {entries.map((entry) => (
                    <option
                      disabled={entry.id === selection?.afterId}
                      key={entry.id}
                      value={entry.id}
                    >
                      {buildOptionLabel(entry)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>To</span>
                <select
                  className="fm-inspector-select"
                  onChange={(event) =>
                    updateAfterId(event.currentTarget.value)
                  }
                  value={selection?.afterId ?? entries.at(-1)?.id}
                >
                  {entries.map((entry) => (
                    <option
                      disabled={entry.id === selection?.beforeId}
                      key={entry.id}
                      value={entry.id}
                    >
                      {buildOptionLabel(entry)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <span>
              Build #{comparison.beforeIndex + 1} / Build #
              {comparison.afterIndex + 1}
            </span>
          </header>
          <MeshBuildHistoryComparisonTable rows={comparison.rows} />
        </section>
      ) : null}
      <div className="fm-mesh-detail-list">
        {[...entries].reverse().map((entry) => (
          <div
            className="fm-mesh-detail-list__item"
            data-status={entry.deltaElementCount === null ? "unknown" : "ready"}
            data-build-id={entry.id}
            key={entry.id}
          >
            <strong>
              #{entry.index + 1} {entry.meshName ?? "unnamed mesh"}
            </strong>
            <span>
              nodes {formatDelta(entry.deltaNodeCount)} / elements{" "}
              {formatDelta(entry.deltaElementCount)}
            </span>
            <small>
              {formatCount(entry.nodeCount)} nodes /{" "}
              {formatCount(entry.elementCount)} elements / {buildReason(entry)} /{" "}
              {qualitySummary(entry)}
              {entry.qualityDataAvailable ? " / FMMQ" : ""}
            </small>
            <small>
              build {entry.buildId ?? entry.id} / command {entry.commandId ?? "not linked"}
              {entry.meshTarget ? ` / target ${entry.meshTarget}` : ""}
              {entry.durationSeconds === null ? "" : ` / ${formatValue(entry.durationSeconds)} s`}
            </small>
            {entry.restorable && onRestore ? (
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => onRestore(entry)}
              >
                Restore policy to draft
              </Button>
            ) : (
              <small>
                {entry.restoreReason === "snapshot-unavailable"
                  ? "Configuration snapshot unavailable; mesh artifact is not restored."
                  : ""}
              </small>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
