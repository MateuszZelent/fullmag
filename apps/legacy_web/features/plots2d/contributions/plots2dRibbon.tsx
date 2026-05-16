/**
 * @module features/plots2d/contributions/plots2dRibbon
 *
 * Ribbon contribution for the 2D Plots Workbench.
 *
 * Registered in the View tab with priority 80.
 * Active always (the groups show the current plots2d store state).
 * All actions dispatch through `usePlot2DStore` — single source of truth (§12.4).
 *
 * Groups:
 * - Series: Presets, x-axis, y-scale
 * - Display: Markers, range slider
 * - Export: CSV
 */

import {
  registerRibbonContribution,
  type RibbonBuildContext,
  type RibbonGroup,
} from "@/features/shell/registry/ribbonRegistry";
import type { RibbonMenuNode } from "@/features/shell/registry/ribbonMenuTypes";
import { usePlot2DStore } from "../store/usePlot2DStore";
import { getPresetsInOrder } from "../model/plotPresets";
import { serializeScalarTableCsv } from "../model/scalarTable";
import { Activity, BarChart3, Download, Ruler, Sparkles, CircleDot, MoveHorizontal } from "lucide-react";

function buildSeriesGroup(_ctx: RibbonBuildContext): RibbonGroup {
  const store = usePlot2DStore.getState();
  const { ui } = store;
  const presets = getPresetsInOrder();

  const presetMenuNodes: RibbonMenuNode[] = [
    { type: "label", id: "plots2d:presets:header", label: "Chart presets" },
    ...presets.map((preset): RibbonMenuNode => ({
      type: "item" as const,
      id: `plots2d:preset:${preset.id}`,
      label: `${preset.icon ?? ""} ${preset.label}`,
      action: () => usePlot2DStore.getState().applyPreset(preset.id),
    })),
  ];

  return {
    id: "plots2d-series",
    title: "Series",
    subtitle: ui.activePresetId
      ? presets.find((p) => p.id === ui.activePresetId)?.label ?? "Custom"
      : `${ui.activeSeriesKeys.length} series`,
    tone: "neutral",
    actions: [
      {
        id: "plots2d:presets",
        label: "Presets",
        icon: <Sparkles size={14} />,
        active: ui.activePresetId != null,
        menu: presetMenuNodes,
      },
      {
        id: "plots2d:x-axis",
        label: ui.xColumn === "time" ? "X: Time" : "X: Step",
        icon: <Ruler size={14} />,
        menu: [
          {
            type: "radio-group" as const,
            id: "plots2d:x-axis-select",
            label: "X axis",
            value: ui.xColumn,
            onValueChange: (value: string) =>
              usePlot2DStore.getState().setXColumn(value as "time" | "step"),
            items: [
              { value: "time", label: "Time (s)" },
              { value: "step", label: "Step" },
            ],
          },
        ],
      },
      {
        id: "plots2d:y-scale",
        label: ui.yScale === "log" ? "Y: Log" : "Y: Linear",
        icon: <BarChart3 size={14} />,
        active: ui.yScale === "log",
        action: () =>
          usePlot2DStore.getState().setYScale(ui.yScale === "linear" ? "log" : "linear"),
      },
    ],
  };
}

function buildDisplayGroup(_ctx: RibbonBuildContext): RibbonGroup {
  const { ui } = usePlot2DStore.getState();

  return {
    id: "plots2d-display",
    title: "Display",
    subtitle: "Chart appearance",
    tone: "neutral",
    actions: [
      {
        id: "plots2d:markers",
        label: "Markers",
        icon: <CircleDot size={14} />,
        active: ui.showMarkers,
        action: () => usePlot2DStore.getState().toggleMarkers(),
      },
      {
        id: "plots2d:range-slider",
        label: "Range Slider",
        icon: <MoveHorizontal size={14} />,
        active: ui.showRangeSlider,
        action: () => usePlot2DStore.getState().toggleRangeSlider(),
      },
    ],
  };
}

function buildExportGroup(_ctx: RibbonBuildContext): RibbonGroup {
  return {
    id: "plots2d-export",
    title: "Export",
    subtitle: "Data & image",
    tone: "neutral",
    actions: [
      {
        id: "plots2d:export-csv",
        label: "CSV",
        icon: <Download size={14} />,
        action: () => {
          const state = usePlot2DStore.getState();
          const table = state.scalar.table;
          if (!table || table.rowCount === 0) return;
          const csv = serializeScalarTableCsv(table, {
            columns: ["step", "time", ...state.ui.activeSeriesKeys],
          });
          const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `scalar_data_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`;
          a.click();
          URL.revokeObjectURL(url);
        },
      },
    ],
  };
}

export function buildPlots2DRibbonGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  return [
    buildSeriesGroup(ctx),
    buildDisplayGroup(ctx),
    buildExportGroup(ctx),
  ];
}

registerRibbonContribution({
  tab: "view",
  priority: 80,
  buildGroups: buildPlots2DRibbonGroups,
});
