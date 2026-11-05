"use client";

import { useCallback } from "react";

import { analysisWorkspaceStore } from "@/kernel/workspace/analysisWorkspace";
import { useAnalysisViewPreferencesHydration } from "@/kernel/workspace/useAnalysisViewPreferencesHydration";
import { useAnalysisWorkspaceSelector } from "@/kernel/workspace/useAnalysisWorkspace";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { InspectorMetricStrip } from "../primitives/InspectorMetricStrip";

export type ChartInspectorSectionScope = "all" | "chart" | "point";

export function ChartInspectorPanel({
  selection,
  sectionScope = "all",
}: InspectorPanelProps & {
  sectionScope?: ChartInspectorSectionScope;
}) {
  const activeSurface = useAnalysisWorkspaceSelector((state) => state.activeSurface);
  const activeDescriptorId = useAnalysisWorkspaceSelector((state) => state.activeDescriptorId);
  const activeDescriptorSelectedSeriesIds = useAnalysisWorkspaceSelector((state) => state.activeDescriptorSelectedSeriesIds);
  const selectedDatasetRef = useAnalysisWorkspaceSelector((state) => state.selectedDatasetRef);
  const xAxisId = useAnalysisWorkspaceSelector((state) => state.xAxisId);
  const preferences = useAnalysisViewPreferencesHydration();
  const selectedPoint = selection.ref?.type === "analysis-chart-point" ? selection.ref : null;
  const isPointScope =
    sectionScope === "point" ||
    selection.kind === "analysis.chart-point" ||
    Boolean(selectedPoint);
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

  const pointSection = selectedPoint ? (
    <InspectorGroup title="Selected Point" collapsible defaultOpen>
      <FieldRow label="Series" value={selectedPoint.quantity} />
      <FieldRow label="Row" value={String(selectedPoint.rowIndex)} />
      <FieldRow label="X" value={formatInspectorNumber(selectedPoint.x)} />
      <FieldRow label="Y" value={formatInspectorNumber(selectedPoint.y)} />
    </InspectorGroup>
  ) : null;

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <InspectorMetricStrip
        metrics={[
          { label: "Surface", tone: "neutral", value: activeSurface },
          { label: "X Axis", value: xAxisId ?? "none" },
          { label: "Signals", value: String(activeDescriptorSelectedSeriesIds.length) },
          { label: "Focus", value: isPointScope ? "point" : "chart" },
        ]}
      />
      {isPointScope ? pointSection : null}
      <InspectorGroup title="Analysis chart" collapsible defaultOpen>
        <FieldRow label="Surface" value={activeSurface} />
        <FieldRow label="Dataset" value={selectedDatasetRef ?? "not selected"} />
        <FieldRow label="X axis" value={xAxisId ?? "not selected"} />
        <FieldRow label="Range" value={range ? `${range.fromSI}–${range.toSI}` : "full dataset"} />
        <FieldRow label="Series" value={activeDescriptorSelectedSeriesIds.length ? activeDescriptorSelectedSeriesIds.join(", ") : "none"} />
      </InspectorGroup>
      {!isPointScope ? pointSection : null}
      <InspectorGroup title="Series selection" collapsible defaultOpen={!isPointScope}>
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
