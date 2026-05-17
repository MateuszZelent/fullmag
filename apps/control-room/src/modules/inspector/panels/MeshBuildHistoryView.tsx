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
  return `#${entry.index + 1} ${entry.meshName ?? "unnamed mesh"}`;
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
}: {
  entries: MeshBuildHistoryEntry[];
}) {
  const defaultSelection = useMemo(
    () => latestMeshBuildComparisonSelection(entries),
    [entries],
  );
  const [requestedSelection, setRequestedSelection] =
    useState<MeshBuildHistoryComparisonSelection | null>(null);
  const validIndices = useMemo(
    () => new Set(entries.map((entry) => entry.index)),
    [entries],
  );
  const selection =
    requestedSelection &&
    validIndices.has(requestedSelection.beforeIndex) &&
    validIndices.has(requestedSelection.afterIndex)
      ? requestedSelection
      : defaultSelection;
  const comparison = selection
    ? meshBuildHistoryComparisonForSelection(entries, selection)
    : null;

  const updateBeforeIndex = (beforeIndex: number) => {
    const afterIndex =
      selection?.afterIndex !== beforeIndex && selection?.afterIndex !== undefined
        ? selection.afterIndex
        : (entries.find((entry) => entry.index !== beforeIndex)?.index ??
          beforeIndex);
    setRequestedSelection({ afterIndex, beforeIndex });
  };

  const updateAfterIndex = (afterIndex: number) => {
    const beforeIndex =
      selection?.beforeIndex !== afterIndex &&
      selection?.beforeIndex !== undefined
        ? selection.beforeIndex
        : (entries.find((entry) => entry.index !== afterIndex)?.index ??
          afterIndex);
    setRequestedSelection({ afterIndex, beforeIndex });
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
                    updateBeforeIndex(Number(event.currentTarget.value))
                  }
                  value={comparison.beforeIndex}
                >
                  {entries.map((entry) => (
                    <option
                      disabled={entry.index === comparison.afterIndex}
                      key={entry.index}
                      value={entry.index}
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
                    updateAfterIndex(Number(event.currentTarget.value))
                  }
                  value={comparison.afterIndex}
                >
                  {entries.map((entry) => (
                    <option
                      disabled={entry.index === comparison.beforeIndex}
                      key={entry.index}
                      value={entry.index}
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
            key={`${entry.index}:${entry.meshName ?? "mesh"}`}
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
          </div>
        ))}
      </div>
    </div>
  );
}
