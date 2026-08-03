"use client";

import { useCallback } from "react";

import { analysisWorkspaceStore } from "@/kernel/workspace/analysisWorkspace";
import { useAnalysisViewPreferencesHydration } from "@/kernel/workspace/useAnalysisViewPreferencesHydration";
import { useAnalysisWorkspaceSelector } from "@/kernel/workspace/useAnalysisWorkspace";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorGroup } from "../primitives/InspectorGroup";

export function ChartInspectorPanel({ selection }: InspectorPanelProps) {
  const activeSurface = useAnalysisWorkspaceSelector((state) => state.activeSurface);
  const activeDescriptorId = useAnalysisWorkspaceSelector((state) => state.activeDescriptorId);
  const activeDescriptorSelectedSeriesIds = useAnalysisWorkspaceSelector((state) => state.activeDescriptorSelectedSeriesIds);
  const selectedDatasetRef = useAnalysisWorkspaceSelector((state) => state.selectedDatasetRef);
  const xAxisId = useAnalysisWorkspaceSelector((state) => state.xAxisId);
  const preferences = useAnalysisViewPreferencesHydration();
  const selectedPoint = selection.ref?.type === "analysis-chart-point" ? selection.ref : null;
  const range = activeDescriptorId ? preferences.preferences.descriptorPreferences[activeDescriptorId]?.range ?? null : null;

  const clearSelectedSeries = useCallback(() => {
    if (!activeDescriptorId) return;
    const descriptor = preferences.preferences.descriptorPreferences[activeDescriptorId];
    preferences.setDescriptorPreference(activeDescriptorId, {
      displayUnits: descriptor?.displayUnits ?? {},
      range: descriptor?.range ?? null,
      selectedSeriesIds: [],
    });
    analysisWorkspaceStore.setActiveDescriptorSelection(activeDescriptorId, []);
    if (activeSurface === "comparison") analysisWorkspaceStore.setComparisonSelection([]);
    if (activeSurface === "dynamics") analysisWorkspaceStore.setChartState(xAxisId ?? "x", []);
  }, [activeDescriptorId, activeSurface, preferences, xAxisId]);

  return (
    <div className="fm-inspector-panel">
      <InspectorGroup title="Analysis chart">
        <FieldRow label="Surface" value={activeSurface} />
        <FieldRow label="Dataset" value={selectedDatasetRef ?? "not selected"} />
        <FieldRow label="X axis" value={xAxisId ?? "not selected"} />
        <FieldRow label="Range" value={range ? `${range.fromSI}–${range.toSI}` : "full dataset"} />
        <FieldRow label="Series" value={activeDescriptorSelectedSeriesIds.length ? activeDescriptorSelectedSeriesIds.join(", ") : "none"} />
      </InspectorGroup>
      {selectedPoint ? (
        <InspectorGroup title="Selected Point">
          <FieldRow label="Series" value={selectedPoint.quantity} />
          <FieldRow label="Row" value={String(selectedPoint.rowIndex)} />
          <FieldRow label="X" value={formatInspectorNumber(selectedPoint.x)} />
          <FieldRow label="Y" value={formatInspectorNumber(selectedPoint.y)} />
        </InspectorGroup>
      ) : null}
      <InspectorGroup title="Series selection">
        <Button disabled={!activeDescriptorId || activeDescriptorSelectedSeriesIds.length === 0} onClick={clearSelectedSeries} size="sm" type="button" variant="secondary">
          Clear selected series
        </Button>
      </InspectorGroup>
    </div>
  );
}

function formatInspectorNumber(value: number): string {
  if (Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3)) return value.toExponential(6);
  return Number.isInteger(value) ? String(value) : value.toPrecision(7);
}
