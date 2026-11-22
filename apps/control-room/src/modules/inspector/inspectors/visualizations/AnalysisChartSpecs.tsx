"use client";

import {
  Activity,
  Download,
  ExternalLink,
  LineChart,
  Pin,
  RotateCcw,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { KernelContext } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { analysisWorkspaceStore } from "@/kernel/workspace/analysisWorkspace";
import type { AnalysisSurface } from "@/kernel/workspace/analysisViewPreferences";
import { useAnalysisViewPreferencesHydration } from "@/kernel/workspace/useAnalysisViewPreferencesHydration";
import { useAnalysisWorkspaceSelector } from "@/kernel/workspace/useAnalysisWorkspace";
import { Button } from "@/shared/ui/Button";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorSpec } from "../../template";
import { ConnectedInspectorSpec } from "../../panels/study/ConnectedInspectorSpec";
import {
  type ChartInspectorDraft,
  DEFAULT_CHART_DRAFT,
  type ChartPointPhysicalValues,
  type ResolvedPointReadout,
  inferAxisUnit,
  inferSeriesUnit,
  formatPhysicalTimeValue,
  formatPhysicalScalar,
  PointPhysicalReadoutCard,
} from "./chartInspectorShared";

/* ── 3. analysis.chart — Analysis Chart Inspector ────────────────────────── */

const ANALYSIS_SURFACES: readonly {
  value: AnalysisSurface;
  label: string;
}[] = [
  { value: "dynamics", label: "Dynamics" },
  { value: "hysteresis", label: "Hysteresis" },
  { value: "resonance-fmr", label: "Resonance / FMR" },
  { value: "dispersion", label: "Dispersion" },
  { value: "comparison", label: "Comparison" },
];

export function AnalysisChartTemplatePanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const activeSurface = useAnalysisWorkspaceSelector(
    (state) => state.activeSurface,
  );
  const activeDescriptorId = useAnalysisWorkspaceSelector(
    (state) => state.activeDescriptorId,
  );
  const activeDescriptorSelectedSeriesIds = useAnalysisWorkspaceSelector(
    (state) => state.activeDescriptorSelectedSeriesIds,
  );
  const activeDescriptorDisplayUnits = useAnalysisWorkspaceSelector(
    (state) => state.activeDescriptorDisplayUnits,
  );
  const activeDescriptorRange = useAnalysisWorkspaceSelector(
    (state) => state.activeDescriptorRange,
  );
  const selectedDatasetRef = useAnalysisWorkspaceSelector(
    (state) => state.selectedDatasetRef,
  );
  const comparisonDatasetRef = useAnalysisWorkspaceSelector(
    (state) => state.comparisonDatasetRef,
  );
  const comparisonSelectedSeriesKeys = useAnalysisWorkspaceSelector(
    (state) => state.comparisonSelectedSeriesKeys,
  );
  const xAxisId = useAnalysisWorkspaceSelector((state) => state.xAxisId);
  const preferences = useAnalysisViewPreferencesHydration();

  const [axisScale, setAxisScale] = useState<"linear" | "log">("linear");

  const descriptorPreference = activeDescriptorId
    ? preferences.preferences.descriptorPreferences[activeDescriptorId]
    : undefined;
  const range = descriptorPreference?.range ?? activeDescriptorRange ?? null;
  const displayUnits = useMemo(
    () => ({
      ...activeDescriptorDisplayUnits,
      ...(descriptorPreference?.displayUnits ?? {}),
    }),
    [activeDescriptorDisplayUnits, descriptorPreference?.displayUnits],
  );

  const removeSingleSeries = useCallback(
    (seriesIdToRemove: string) => {
      if (!activeDescriptorId) return;
      const nextSeries = activeDescriptorSelectedSeriesIds.filter(
        (id) => id !== seriesIdToRemove,
      );
      preferences.setDescriptorPreference(activeDescriptorId, {
        displayUnits: descriptorPreference?.displayUnits ?? {},
        range: descriptorPreference?.range ?? null,
        selectedSeriesIds: nextSeries,
      });
      analysisWorkspaceStore.setActiveDescriptorSelection(
        activeDescriptorId,
        nextSeries,
      );
      if (activeSurface === "dynamics") {
        analysisWorkspaceStore.setChartState(xAxisId ?? "x", nextSeries);
      }
    },
    [
      activeDescriptorId,
      activeDescriptorSelectedSeriesIds,
      activeSurface,
      descriptorPreference,
      preferences,
      xAxisId,
    ],
  );

  const clearSelectedSeries = useCallback(() => {
    if (!activeDescriptorId) return;
    preferences.setDescriptorPreference(activeDescriptorId, {
      displayUnits: descriptorPreference?.displayUnits ?? {},
      range: descriptorPreference?.range ?? null,
      selectedSeriesIds: [],
    });
    analysisWorkspaceStore.setActiveDescriptorSelection(activeDescriptorId, []);
    if (activeSurface === "comparison") {
      analysisWorkspaceStore.setComparisonSelection([]);
    }
    if (activeSurface === "dynamics") {
      analysisWorkspaceStore.setChartState(xAxisId ?? "x", []);
    }
  }, [
    activeDescriptorId,
    activeSurface,
    descriptorPreference,
    preferences,
    xAxisId,
  ]);

  const resetAxisRange = useCallback(() => {
    if (!activeDescriptorId) return;
    preferences.setDescriptorPreference(activeDescriptorId, {
      displayUnits: descriptorPreference?.displayUnits ?? {},
      range: null,
      selectedSeriesIds:
        descriptorPreference?.selectedSeriesIds ??
        activeDescriptorSelectedSeriesIds,
    });
  }, [
    activeDescriptorId,
    activeDescriptorSelectedSeriesIds,
    descriptorPreference,
    preferences,
  ]);

  const clearReferenceCurves = useCallback(() => {
    analysisWorkspaceStore.clearComparisonSelection();
    analysisWorkspaceStore.setComparisonDatasetRef(null);
  }, []);

  const openAnalysisView = useCallback(() => {
    if (!kernel) return;
    void kernel.commands.execute(
      "analysis-plots.open",
      createCommandContext("inspector", kernel),
    );
  }, [kernel]);

  const pinQuickChart = useCallback(() => {
    if (!kernel) return;
    void kernel.commands.execute(
      "quick-chart.pin",
      createCommandContext("inspector", kernel),
    );
  }, [kernel]);

  const spec = useMemo<InspectorSpec<ChartInspectorDraft>>(
    () => ({
      id: `analysis.chart:${selection.nodeId ?? "chart"}`,
      header: {
        breadcrumbs: [
          { id: "analysis", label: "Analysis" },
          { id: "chart", label: selection.label || "Analysis Chart" },
        ],
        ...(kernel
          ? {
              primaryHeaderAction: {
                label: "Open Analysis View",
                icon: ExternalLink,
                onRun: openAnalysisView,
              },
              extraMenuActions: [
                {
                  id: "pin-quick-chart",
                  label: "Pin Quick Chart",
                  icon: Pin,
                  onSelect: pinQuickChart,
                },
                {
                  id: "export-analysis-csv",
                  label: "Export CSV",
                  icon: Download,
                  onSelect: () => {
                    void kernel.commands.execute(
                      "analysis-plots.export.csv",
                      createCommandContext("inspector", kernel),
                    );
                  },
                },
                {
                  id: "export-analysis-tsv",
                  label: "Export TSV",
                  icon: Download,
                  onSelect: () => {
                    void kernel.commands.execute(
                      "analysis-plots.export.tsv",
                      createCommandContext("inspector", kernel),
                    );
                  },
                },
                {
                  id: "export-analysis-png",
                  label: "Export PNG",
                  icon: Download,
                  onSelect: () => {
                    void kernel.commands.execute(
                      "analysis-plots.export.png",
                      createCommandContext("inspector", kernel),
                    );
                  },
                },
              ],
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: LineChart,
        title: () => selection.label || "Analysis Plot",
        kindLabel: "Dataset-backed scientific 2D plot",
        entityId: activeDescriptorId ?? undefined,
        statePill: () => ({ tone: "ok", label: activeSurface }),
      },
      facts: () => [
        { id: "surface", label: "Surface", value: activeSurface },
        { id: "xaxis", label: "X Axis", value: xAxisId ?? "—" },
        {
          id: "signals",
          label: "Signals",
          value: String(activeDescriptorSelectedSeriesIds.length),
        },
        { id: "source", label: "Source", value: selection.moduleSource },
      ],
      sections: [
        {
          id: "chart-series",
          title: "Axes, Scale & Active Signals",
          icon: LineChart,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "Analysis surface",
              wide: true,
              render: () => (
                <Select
                  value={activeSurface}
                  onValueChange={(next) =>
                    analysisWorkspaceStore.setActiveSurface(
                      next as AnalysisSurface,
                    )
                  }
                >
                  <SelectTrigger aria-label="Analysis surface" density="compact">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ANALYSIS_SURFACES.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ),
            },
            {
              type: "readonly",
              label: "Dataset",
              mono: true,
              format: () => selectedDatasetRef ?? "None selected",
            },
            {
              type: "readonly",
              label: "X axis",
              mono: true,
              format: () => xAxisId ?? "None selected",
            },
            {
              type: "custom",
              label: "Y axis scale",
              wide: true,
              render: () => (
                <SegmentedControl<"linear" | "log">
                  aria-label="Y axis scale"
                  columns={2}
                  options={[
                    { value: "linear", label: "Linear" },
                    { value: "log", label: "Logarithmic" },
                  ]}
                  value={axisScale}
                  onValueChange={setAxisScale}
                />
              ),
            },
            {
              type: "readonly",
              label: "Range",
              format: () =>
                range ? `${range.fromSI} – ${range.toSI}` : "Full dataset",
            },
            ...(Object.keys(displayUnits).length > 0
              ? [
                  {
                    type: "readonly" as const,
                    label: "Display units",
                    format: () =>
                      Object.entries(displayUnits)
                        .map(([k, u]) => `${k}: ${u}`)
                        .join(", "),
                  },
                ]
              : []),
            {
              type: "custom",
              label: "Selected series",
              wide: true,
              render: () => (
                <div className="grid gap-1.5 text-xs">
                  {activeDescriptorSelectedSeriesIds.length > 0 ? (
                    <ul className="grid gap-1">
                      {activeDescriptorSelectedSeriesIds.map((seriesId) => (
                        <li
                          className="flex items-center justify-between gap-2 rounded border border-fm-border px-2 py-1"
                          key={seriesId}
                        >
                          <span className="truncate font-mono">{seriesId}</span>
                          <Button
                            aria-label={`Remove series ${seriesId}`}
                            disabled={!activeDescriptorId}
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() => removeSingleSeries(seriesId)}
                          >
                            <X aria-hidden="true" size={12} />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-fm-muted">None</span>
                  )}
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <Button
                      disabled={
                        !activeDescriptorId ||
                        activeDescriptorSelectedSeriesIds.length === 0
                      }
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={clearSelectedSeries}
                    >
                      Clear selected series
                    </Button>
                    {range ? (
                      <Button
                        size="sm"
                        type="button"
                        variant="ghost"
                        onClick={resetAxisRange}
                      >
                        <RotateCcw aria-hidden="true" size={13} />
                        <span>Reset range</span>
                      </Button>
                    ) : null}
                    {kernel ? (
                      <Button
                        size="sm"
                        type="button"
                        variant="ghost"
                        onClick={openAnalysisView}
                      >
                        Open Analysis View
                      </Button>
                    ) : null}
                  </div>
                </div>
              ),
            },
          ],
        },
        {
          id: "reference-comparison-curves",
          title: "Reference & Comparison Curves",
          icon: SlidersHorizontal,
          defaultOpen:
            activeSurface === "comparison" ||
            Boolean(comparisonDatasetRef) ||
            comparisonSelectedSeriesKeys.length > 0,
          rows: [
            {
              type: "readonly",
              label: "Reference dataset",
              mono: true,
              format: () => comparisonDatasetRef ?? "None attached",
            },
            {
              type: "readonly",
              label: "Reference curves",
              format: () =>
                comparisonSelectedSeriesKeys.length > 0
                  ? comparisonSelectedSeriesKeys.join(", ")
                  : "None",
            },
            ...(comparisonDatasetRef || comparisonSelectedSeriesKeys.length > 0
              ? [
                  {
                    type: "custom" as const,
                    label: "Reference actions",
                    wide: true,
                    render: () => (
                      <Button
                        size="sm"
                        type="button"
                        variant="secondary"
                        onClick={clearReferenceCurves}
                      >
                        Clear reference curves
                      </Button>
                    ),
                  },
                ]
              : []),
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [
      activeDescriptorId,
      activeDescriptorSelectedSeriesIds,
      activeSurface,
      axisScale,
      clearReferenceCurves,
      clearSelectedSeries,
      comparisonDatasetRef,
      comparisonSelectedSeriesKeys,
      displayUnits,
      kernel,
      openAnalysisView,
      pinQuickChart,
      range,
      removeSingleSeries,
      resetAxisRange,
      selectedDatasetRef,
      selection.label,
      selection.moduleSource,
      selection.nodeId,
      xAxisId,
    ],
  );

  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_CHART_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

/* ── 4. analysis.chart-point — Analysis Chart Point Inspector ────────────── */

export function AnalysisChartPointTemplatePanel({
  selection,
  testPointValues,
}: InspectorPanelProps & {
  testPointValues?: ChartPointPhysicalValues;
}) {
  const kernel = useContext(KernelContext);
  const activeSurface = useAnalysisWorkspaceSelector(
    (state) => state.activeSurface,
  );
  const activeDescriptorId = useAnalysisWorkspaceSelector(
    (state) => state.activeDescriptorId,
  );
  const activeDescriptorSelectedSeriesIds = useAnalysisWorkspaceSelector(
    (state) => state.activeDescriptorSelectedSeriesIds,
  );
  const selectedDatasetRef = useAnalysisWorkspaceSelector(
    (state) => state.selectedDatasetRef,
  );
  const xAxisId = useAnalysisWorkspaceSelector((state) => state.xAxisId);
  const displayUnits = useAnalysisWorkspaceSelector(
    (state) => state.activeDescriptorDisplayUnits,
  );
  const preferences = useAnalysisViewPreferencesHydration();
  const descriptorPreference = activeDescriptorId
    ? preferences.preferences.descriptorPreferences[activeDescriptorId]
    : undefined;
  const range = descriptorPreference?.range ?? null;

  const pt =
    selection.ref?.type === "analysis-chart-point" ? selection.ref : null;
  const seriesLabel = pt?.quantity ?? pt?.seriesId ?? "signal";

  const readout = useMemo<ResolvedPointReadout>(() => {
    if (testPointValues) {
      return {
        hasPhysicalX: true,
        xSI: testPointValues.xSI,
        xUnit: testPointValues.xUnit === "1" ? "" : testPointValues.xUnit,
        hasPhysicalY: true,
        ySI: testPointValues.ySI,
        yUnit: testPointValues.yUnit === "1" ? "" : testPointValues.yUnit,
      };
    }
    return {
      hasPhysicalX: true,
      xSI: pt?.x ?? 0,
      xUnit: inferAxisUnit(xAxisId),
      hasPhysicalY: true,
      ySI: pt?.y ?? 0,
      yUnit: inferSeriesUnit(seriesLabel, displayUnits),
    };
  }, [displayUnits, pt, seriesLabel, testPointValues, xAxisId]);

  const clearSelectedSeries = useCallback(() => {
    if (!activeDescriptorId) return;
    preferences.setDescriptorPreference(activeDescriptorId, {
      displayUnits: descriptorPreference?.displayUnits ?? {},
      range: descriptorPreference?.range ?? null,
      selectedSeriesIds: [],
    });
    analysisWorkspaceStore.setActiveDescriptorSelection(activeDescriptorId, []);
    if (activeSurface === "comparison") {
      analysisWorkspaceStore.setComparisonSelection([]);
    }
    if (activeSurface === "dynamics") {
      analysisWorkspaceStore.setChartState(xAxisId ?? "x", []);
    }
  }, [
    activeDescriptorId,
    activeSurface,
    descriptorPreference,
    preferences,
    xAxisId,
  ]);

  const handleClearPointSelection = useCallback(() => {
    if (!kernel) return;
    if (pt?.tableId) {
      const parentNodeId = `analysis:charts:${pt.tableId}`;
      kernel.selection.set(
        {
          kind: "analysis.chart",
          label: "Analysis chart",
          nodeId: parentNodeId,
          objectId: null,
          ref: {
            chartId: pt.chartId,
            kind: "analysis.chart",
            nodeId: parentNodeId,
            tableId: pt.tableId,
            type: "analysis-chart",
          },
        },
        "inspector",
      );
      return;
    }
    kernel.selection.clear("inspector");
  }, [kernel, pt]);

  const spec = useMemo<InspectorSpec<ChartInspectorDraft>>(
    () => ({
      id: `analysis.chart-point:${selection.nodeId ?? "pt"}`,
      header: {
        breadcrumbs: [
          { id: "analysis", label: "Analysis" },
          { id: "chart", label: pt?.chartId ?? "Chart" },
          { id: "pt", label: `Row #${pt?.rowIndex ?? 0}` },
        ],
      },
      identity: {
        domain: "physics",
        icon: LineChart,
        title: () => `${seriesLabel} · Row #${pt?.rowIndex ?? 0}`,
        kindLabel: "Analysis plot data point",
        entityId: pt?.seriesId ?? undefined,
        statePill: () => ({ tone: "ok", label: "Selected" }),
      },
      facts: () => [
        { id: "series", label: "Quantity", value: seriesLabel },
        { id: "row", label: "Row", value: String(pt?.rowIndex ?? 0) },
        {
          id: "x",
          label: readout.xUnit === "s" ? "Time t" : "X",
          value:
            readout.xUnit === "s"
              ? `${formatPhysicalTimeValue(readout.xSI ?? 0, "ns")} ns`
              : `${formatPhysicalScalar(readout.xSI ?? 0)}${readout.xUnit ? ` ${readout.xUnit}` : ""}`,
        },
        {
          id: "y",
          label: "Y",
          value: `${formatPhysicalScalar(readout.ySI ?? 0)}${readout.yUnit ? ` ${readout.yUnit}` : ""}`,
        },
      ],
      sections: [
        {
          id: "analysis-point-readout",
          title: "Selected Point",
          icon: Activity,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "Coordinates",
              wide: true,
              render: ({ notify }) => (
                <PointPhysicalReadoutCard
                  readout={readout}
                  seriesLabel={seriesLabel}
                  onClearPoint={handleClearPointSelection}
                  onCopyPoint={(text) => {
                    void navigator?.clipboard?.writeText?.(text);
                    notify("Copied point coordinates", text);
                  }}
                />
              ),
            },
            {
              type: "readonly",
              label: "Series ID",
              mono: true,
              format: () => pt?.seriesId ?? seriesLabel,
            },
            {
              type: "readonly",
              label: "Row index",
              format: () => String(pt?.rowIndex ?? 0),
            },
            ...(pt?.tableId
              ? [
                  {
                    type: "readonly" as const,
                    label: "Source table",
                    mono: true,
                    format: () => pt.tableId ?? "—",
                  },
                ]
              : []),
          ],
        },
        {
          id: "analysis-parent-chart",
          title: "Analysis Chart",
          icon: LineChart,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Surface",
              format: () => activeSurface,
            },
            {
              type: "readonly",
              label: "Dataset",
              mono: true,
              format: () => selectedDatasetRef ?? "None selected",
            },
            {
              type: "readonly",
              label: "X axis",
              mono: true,
              format: () => xAxisId ?? "None selected",
            },
            {
              type: "readonly",
              label: "Range",
              format: () =>
                range ? `${range.fromSI} – ${range.toSI}` : "Full dataset",
            },
            {
              type: "readonly",
              label: "Series",
              format: () =>
                activeDescriptorSelectedSeriesIds.length > 0
                  ? activeDescriptorSelectedSeriesIds.join(", ")
                  : "None",
            },
            {
              type: "custom",
              label: "Series selection",
              wide: true,
              render: () => (
                <Button
                  disabled={
                    !activeDescriptorId ||
                    activeDescriptorSelectedSeriesIds.length === 0
                  }
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={clearSelectedSeries}
                >
                  Clear selected series
                </Button>
              ),
            },
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [
      activeDescriptorId,
      activeDescriptorSelectedSeriesIds,
      activeSurface,
      clearSelectedSeries,
      handleClearPointSelection,
      pt,
      range,
      readout,
      selectedDatasetRef,
      selection.nodeId,
      seriesLabel,
      xAxisId,
    ],
  );

  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_CHART_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}
