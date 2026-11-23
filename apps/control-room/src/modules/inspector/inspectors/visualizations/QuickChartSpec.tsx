"use client";

import {
  Activity,
  ExternalLink,
  LineChart,
  Pin,
  PinOff,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useMemo,
} from "react";
import { KernelContext } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { analysisWorkspaceStore } from "@/kernel/workspace/analysisWorkspace";
import { quickChartWorkspaceStore } from "@/kernel/workspace/quickChartWorkspace";
import { useQuickChartWorkspaceSelector } from "@/kernel/workspace/useQuickChartWorkspace";
import { QuickChartResourceView } from "@/shared/analysis-charts/QuickChartResourceView";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorSpec } from "../../template";
import { ConnectedInspectorSpec } from "../../panels/study/ConnectedInspectorSpec";
import {
  inferSeriesUnit,
  type ChartInspectorDraft,
  formatPhysicalScalar,
  DEFAULT_CHART_DRAFT,
} from "./chartInspectorShared";

/* ── 5. results.quick_chart — Pinned Quick Chart Inspector ───────────────── */

export function QuickChartTemplatePanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const pinned = useQuickChartWorkspaceSelector((state) => state.pinned);
  const hasTableRuntime = Boolean(
    kernel &&
      typeof (kernel.resources as { subscribe?: unknown } | undefined)
        ?.subscribe === "function",
  );

  const pinnedObservables = useMemo(
    () =>
      (pinned?.selectedSeriesIds ?? []).map((seriesId) => {
        const columnId = seriesId.slice(seriesId.lastIndexOf(":") + 1);
        const unit =
          pinned?.displayUnits[columnId] ??
          pinned?.displayUnits[seriesId] ??
          inferSeriesUnit(columnId, pinned?.displayUnits);
        return { seriesId, columnId, unit };
      }),
    [pinned],
  );

  const handleOpenInAnalysis = useCallback(() => {
    if (pinned) {
      analysisWorkspaceStore.setActiveSurface("dynamics");
      analysisWorkspaceStore.setSelectedDatasetRef(pinned.tableId);
      if (kernel) {
        void kernel.commands.execute(
          "analysis-plots.open",
          createCommandContext("inspector", kernel, {
            sourceDetail: "quick-chart-inspector",
          }),
          {
            datasetRef: `table:${pinned.tableId}`,
            surface: "dynamics",
            tableId: pinned.tableId,
          },
        );
        return;
      }
    }
    if (kernel) {
      void kernel.commands.execute(
        "analysis-plots.open",
        createCommandContext("inspector", kernel, {
          sourceDetail: "quick-chart-inspector",
        }),
      );
    }
  }, [kernel, pinned]);

  const handleUnpinQuickChart = useCallback(() => {
    quickChartWorkspaceStore.clear();
    if (kernel) {
      void kernel.commands.execute(
        "quick-chart.unpin",
        createCommandContext("inspector", kernel, {
          sourceDetail: "quick-chart-inspector",
        }),
      );
    }
  }, [kernel]);

  const spec = useMemo<InspectorSpec<ChartInspectorDraft>>(
    () => ({
      id: `results.quick_chart:${selection.nodeId ?? "quick"}`,
      header: {
        breadcrumbs: [
          { id: "res", label: "Results" },
          { id: "quick", label: "Quick Chart" },
        ],
        ...(pinned
          ? {
              primaryHeaderAction: {
                label: "Open in Analysis",
                icon: ExternalLink,
                onRun: handleOpenInAnalysis,
              },
              extraMenuActions: [
                {
                  id: "unpin-quick-chart",
                  label: "Unpin Quick Chart",
                  icon: PinOff,
                  onSelect: handleUnpinQuickChart,
                },
              ],
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Pin,
        title: () =>
          pinned
            ? `Quick Chart · ${pinned.tableId}`
            : selection.label || "Quick Chart",
        kindLabel: "Pinned scalar table preview",
        entityId: pinned?.chartId,
        statePill: () =>
          pinned
            ? { tone: "ok", label: "Pinned" }
            : { tone: "neutral", label: "Unpinned" },
      },
      facts: () =>
        pinned
          ? [
              { id: "table", label: "Table", value: pinned.tableId },
              { id: "xaxis", label: "X Axis", value: pinned.xAxisId },
              {
                id: "series",
                label: "Columns",
                value: String(pinnedObservables.length),
              },
              {
                id: "range",
                label: "Range",
                value: pinned.range
                  ? `${formatPhysicalScalar(pinned.range.fromSI)}–${formatPhysicalScalar(pinned.range.toSI)}`
                  : "Full",
              },
            ]
          : [{ id: "mode", label: "Surface", value: "Store-driven preview" }],
      sections: [
        ...(pinned
          ? [
              {
                id: "quick-chart-details",
                title: "Pinned Observable & Column Details",
                icon: Activity,
                defaultOpen: true,
                rows: [
                  {
                    type: "readonly" as const,
                    label: "Chart ID",
                    mono: true,
                    format: () => pinned.chartId,
                  },
                  {
                    type: "readonly" as const,
                    label: "Source table",
                    mono: true,
                    format: () => pinned.tableId,
                  },
                  {
                    type: "readonly" as const,
                    label: "X axis column",
                    mono: true,
                    format: () => pinned.xAxisId,
                  },
                  {
                    type: "readonly" as const,
                    label: "Pinned columns",
                    format: () =>
                      pinnedObservables.length > 0
                        ? pinnedObservables
                            .map((entry) =>
                              entry.unit && entry.unit !== "1"
                                ? `${entry.columnId} (${entry.unit})`
                                : entry.columnId,
                            )
                            .join(", ")
                        : "None",
                  },
                  {
                    type: "custom" as const,
                    label: "Actions",
                    wide: true,
                    render: () => (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={handleOpenInAnalysis}
                        >
                          <ExternalLink aria-hidden="true" size={13} />
                          <span>Open in Analysis</span>
                        </Button>
                        <Button
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={handleUnpinQuickChart}
                        >
                          <PinOff aria-hidden="true" size={13} />
                          <span>Unpin Quick Chart</span>
                        </Button>
                      </div>
                    ),
                  },
                ],
              },
            ]
          : []),
        {
          id: "quick-chart-preview",
          title: "Pinned Quick Chart",
          icon: LineChart,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "Preview",
              wide: true,
              render: () =>
                hasTableRuntime ? (
                  <QuickChartResourceView />
                ) : (
                  <span className="text-xs text-fm-muted">
                    {pinned
                      ? `Pinned ${pinned.chartId} (${pinnedObservables.map((o) => o.columnId).join(", ") || "no series"})`
                      : "Pin a chart from Analysis to preview scalar signals here."}
                  </span>
                ),
            },
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [
      handleOpenInAnalysis,
      handleUnpinQuickChart,
      hasTableRuntime,
      pinned,
      pinnedObservables,
      selection.label,
      selection.nodeId,
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
