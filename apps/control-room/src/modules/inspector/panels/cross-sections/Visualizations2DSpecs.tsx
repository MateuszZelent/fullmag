"use client";

import {
  Gauge,
  Layers,
  Plus,
  Scissors,
  SlidersHorizontal,
} from "lucide-react";
import { useMemo, useSyncExternalStore, type ReactNode } from "react";

import {
  useVisualizationStateResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  beginCrossSectionDraft,
  commitCrossSectionDraft,
  crossSectionWorkspaceStore,
  discardCrossSectionDraft,
  getCrossSectionWorkspaceServerSnapshot,
  updateCrossSectionDraft,
  updateCrossSectionPlot,
  type CrossSectionFrameExtent,
} from "@/kernel/workspace/crossSectionWorkspace";
import type {
  CrossSectionPlane,
  CrossSectionQualityMetric,
  SliceMeshColorScale,
} from "@/kernel/api/apiTypes";
import {
  ScientificEChart,
  type ResolvedChartThemePalette,
} from "@/shared/charts/ScientificEChart";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorSpec } from "../../template";
import { SpecInspectorHost } from "../mesh-details/SpecInspectorHost";

function useCrossSectionState() {
  return useSyncExternalStore(
    crossSectionWorkspaceStore.subscribe,
    crossSectionWorkspaceStore.getSnapshot,
    getCrossSectionWorkspaceServerSnapshot,
  );
}

// ============================================================================
// 1. visualizations-2d.root — Visualizations2DRootInspectorSpecPanel
// ============================================================================

export function Visualizations2DRootInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const workspace = useCrossSectionState();
  const vizState = useVisualizationStateResource();

  const baseline = useMemo(() => ({ showGizmos: true }), []);

  const spec = useMemo<InspectorSpec<{ showGizmos: boolean }>>(
    () => ({
      id: "visualizations-2d.root",
      header: {
        breadcrumbs: [
          {
            id: "model",
            label: "Model",
            selection: {
              kind: "model.root",
              label: "Model",
              nodeId: "model:session",
              objectId: null,
              ref: null,
            },
          },
          { id: "viz2d", label: "Visualizations 2D" },
        ],
        primaryHeaderAction: {
          icon: Plus,
          label: "Add Cross-Section",
          onRun: (ctx) => {
            const draft = beginCrossSectionDraft(vizState.data);
            ctx.selectNode({
              kind: "visualizations-2d.draft",
              label: draft.name,
              nodeId: "model:visualizations-2d:draft",
              objectId: null,
              ref: null,
            });
          },
        },
      },
      identity: {
        domain: "visualization",
        entityId: "model:visualizations-2d",
        icon: Scissors,
        kindLabel: "Interactive 2D mesh & field slices",
        statePill: () => ({
          label: `${workspace.plots.length} active`,
          tone: workspace.plots.length > 0 ? "ok" : "neutral",
        }),
        title: () => "Cross-Sections 2D",
      },
      facts: () => [
        { id: "saved", label: "Saved slices", value: String(workspace.plots.length) },
        { id: "draft", label: "Draft", value: workspace.draft ? "Active" : "None" },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Scissors,
          id: "quick-presets",
          rows: [
            {
              label: "Quick orthogonal cuts",
              render: (ctx) => (
                <div className="fm-inspector-inline-actions">
                  {(
                    [
                      { label: "Mid-XY (z = 50%)", plane: "xy" as const },
                      { label: "Mid-XZ (y = 50%)", plane: "xz" as const },
                      { label: "Mid-YZ (x = 50%)", plane: "yz" as const },
                    ] as const
                  ).map((preset) => (
                    <Button
                      key={preset.plane}
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        beginCrossSectionDraft(vizState.data);
                        updateCrossSectionDraft({
                          name: preset.label,
                          plane: preset.plane,
                          positionPercent: 50,
                        });
                        const plot = commitCrossSectionDraft();
                        if (plot) {
                          ctx.selectNode({
                            kind: "visualizations-2d.plot",
                            label: plot.name,
                            nodeId: `model:visualizations-2d:${plot.id}`,
                            objectId: null,
                            ref: null,
                          });
                        }
                      }}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Quick orthogonal cuts",
        },
        {
          defaultOpen: true,
          emptyState: () =>
            workspace.plots.length === 0
              ? {
                  description:
                    "Click Add Cross-Section or choose an orthogonal preset above to slice the 3D domain.",
                  icon: Scissors,
                  title: "No saved 2D cross-sections yet",
                }
              : null,
          icon: Layers,
          id: "saved-slices",
          rows: [
            {
              columns: [
                {
                  header: "Slice",
                  id: "name",
                  renderCell: (r) => (r as (typeof workspace.plots)[number]).name,
                },
                {
                  header: "Plane",
                  id: "plane",
                  mono: true,
                  renderCell: (r) => {
                    const p = r as (typeof workspace.plots)[number];
                    return `${p.plane.toUpperCase()} · ${p.positionPercent.toFixed(0)}%`;
                  },
                },
                {
                  header: "Metric",
                  id: "metric",
                  mono: true,
                  renderCell: (r) => (r as (typeof workspace.plots)[number]).metric,
                },
              ],
              label: "Saved cross-sections",
              onSelectRow: (r, ctx) => {
                const plot = r as (typeof workspace.plots)[number];
                ctx.selectNode({
                  kind: "visualizations-2d.plot",
                  label: plot.name,
                  nodeId: `model:visualizations-2d:${plot.id}`,
                  objectId: null,
                  ref: null,
                });
              },
              rowKey: (r) => (r as (typeof workspace.plots)[number]).id,
              rows: () => workspace.plots,
              showWhen: () => workspace.plots.length > 0,
              type: "table",
              wide: true,
            },
          ],
          title: "Saved cross-sections",
        },
      ],
      commitBar: {
        hasOverrides: (d, b) => d.showGizmos !== b.showGizmos,
        mode: "liveViewport",
        onResetDisplay: () => undefined,
        statusMessage: "Select a slice or create a new 2D cross-section",
      },
    }),
    [vizState.data, workspace],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 2. visualizations-2d.draft — Visualizations2DDraftInspectorSpecPanel
// ============================================================================

interface SliceFormDraft {
  name: string;
  plane: CrossSectionPlane;
  positionPercent: number;
  rotationDegrees: number;
  frameExtent: CrossSectionFrameExtent;
  metric: CrossSectionQualityMetric;
  colorScale: SliceMeshColorScale;
  includeWireframe: boolean;
  shrinkFactor: number;
  filterExpression: string;
}

export function Visualizations2DDraftInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const workspace = useCrossSectionState();
  const vizState = useVisualizationStateResource();

  const baseline = useMemo<SliceFormDraft>(() => {
    const d = workspace.draft;
    return {
      colorScale: d?.colorScale ?? "viridis",
      filterExpression: d?.filterExpression ?? "",
      frameExtent: d?.frameExtent ?? "universe",
      includeWireframe: d?.includeWireframe ?? true,
      metric: d?.metric ?? "skewness",
      name: d?.name ?? "New Cross-Section",
      plane: d?.plane ?? "xy",
      positionPercent: d?.positionPercent ?? 50,
      rotationDegrees: d?.rotationDegrees ?? 0,
      shrinkFactor: d?.shrinkFactor ?? 1,
    };
  }, [workspace.draft]);

  const spec = useMemo<InspectorSpec<SliceFormDraft>>(
    () => ({
      id: "visualizations-2d.draft",
      header: {
        breadcrumbs: [
          {
            id: "viz2d",
            label: "Visualizations 2D",
            selection: {
              kind: "visualizations-2d.root",
              label: "Visualizations 2D",
              nodeId: "model:visualizations-2d",
              objectId: null,
              ref: null,
            },
          },
          { id: "draft", label: "New Cross-Section" },
        ],
        deleteAction: {
          confirmDescription: "Discard this unsaved 2D cross-section draft?",
          confirmTitle: (d) => `Discard "${d.name}"?`,
          label: "Discard draft",
          onDelete: async (ctx) => {
            discardCrossSectionDraft();
            ctx.selectNode({
              kind: "visualizations-2d.root",
              label: "Visualizations 2D",
              nodeId: "model:visualizations-2d",
              objectId: null,
              ref: null,
            });
          },
        },
      },
      identity: {
        domain: "visualization",
        entityId: "model:visualizations-2d:draft",
        icon: Scissors,
        kindLabel: "2D cross-section draft",
        renameFieldKey: "name",
        statePill: () => ({ label: "Draft", tone: "warn" }),
        title: (d) => d.name || "New Cross-Section",
      },
      facts: (d) => [
        { id: "plane", label: "Plane", value: d.plane.toUpperCase() },
        { id: "pos", label: "Position", value: `${d.positionPercent.toFixed(0)}%` },
        { id: "metric", label: "Metric", value: d.metric },
      ],
      sections: buildSliceSections("draft"),
      commitBar: {
        cleanMessage: () => "Configure plane & click Apply to create slice",
        mode: "staged",
        onApply: async (draft) => {
          if (!workspace.draft) {
            beginCrossSectionDraft(vizState.data);
          }
          updateCrossSectionDraft({
            colorScale: draft.colorScale,
            filterExpression: draft.filterExpression,
            frameExtent: draft.frameExtent,
            includeWireframe: draft.includeWireframe,
            metric: draft.metric,
            name: draft.name,
            plane: draft.plane,
            positionPercent: draft.positionPercent,
            rotationDegrees: draft.rotationDegrees,
            shrinkFactor: draft.shrinkFactor,
          });
          commitCrossSectionDraft();
          return true;
        },
      },
    }),
    [vizState.data, workspace.draft],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 3. visualizations-2d.plot — Visualizations2DPlotInspectorSpecPanel (ECharts)
// ============================================================================

export function Visualizations2DPlotInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const workspace = useCrossSectionState();
  const plotId =
    (selection.ref as { crossSectionPlotId?: string } | null)?.crossSectionPlotId ??
    selection.nodeId?.split("model:visualizations-2d:")[1] ??
    workspace.activePlotId ??
    workspace.plots[0]?.id ??
    "plot-1";

  const plot = useMemo(
    () => workspace.plots.find((p) => p.id === plotId) ?? workspace.plots[0] ?? null,
    [plotId, workspace.plots],
  );

  const baseline = useMemo<SliceFormDraft>(
    () => ({
      colorScale: plot?.renderOptions.colorScale ?? "viridis",
      filterExpression: plot?.renderOptions.filterExpression ?? "",
      frameExtent: plot?.frameExtent ?? "universe",
      includeWireframe: plot?.renderOptions.wireframeVisible ?? true,
      metric: plot?.metric ?? "skewness",
      name: plot?.name ?? selection.label ?? "Cross-Section",
      plane: plot?.plane ?? "xy",
      positionPercent: plot?.positionPercent ?? 50,
      rotationDegrees: plot?.rotationDegrees ?? 0,
      shrinkFactor: plot?.renderOptions.shrinkFactor ?? 1,
    }),
    [plot, selection.label],
  );

  const qualityChartBuilder = useMemo(
    () =>
      (metric: string, posPercent: number) =>
      (palette: ResolvedChartThemePalette) => ({
        animation: false,
        grid: { bottom: 26, left: 40, right: 12, top: 14 },
        series: [
          {
            data: [
              Math.round(8 + posPercent * 0.1),
              Math.round(26 + posPercent * 0.2),
              Math.round(54),
              Math.round(18),
            ],
            itemStyle: { color: palette.accent },
            name: metric,
            type: "bar" as const,
          },
        ],
        tooltip: {
          backgroundColor: palette.tooltipBackground,
          borderColor: palette.borderSubtle,
          textStyle: { color: palette.textPrimary, fontSize: palette.fontSize },
          trigger: "axis" as const,
        },
        xAxis: {
          axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
          data: ["0.0–0.25", "0.25–0.50", "0.50–0.75", "0.75–1.00"],
          type: "category" as const,
        },
        yAxis: {
          axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
          splitLine: { lineStyle: { color: palette.borderSubtle } },
          type: "value" as const,
        },
      }),
    [],
  );

  const spec = useMemo<InspectorSpec<SliceFormDraft>>(
    () => ({
      id: "visualizations-2d.plot",
      header: {
        breadcrumbs: [
          {
            id: "viz2d",
            label: "Visualizations 2D",
            selection: {
              kind: "visualizations-2d.root",
              label: "Visualizations 2D",
              nodeId: "model:visualizations-2d",
              objectId: null,
              ref: null,
            },
          },
          { id: "plot", label: plot?.name ?? selection.label ?? "Slice" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "visualization",
        entityId: plot?.id ?? plotId,
        icon: Gauge,
        kindLabel: "Saved 2D cross-section slice",
        renameFieldKey: "name",
        statePill: () => ({ label: "Ready", tone: "ok" }),
        title: (d) => d.name || "Cross-Section",
      },
      facts: (d) => [
        { id: "plane", label: "Plane", value: d.plane.toUpperCase() },
        { id: "pos", label: "Position", value: `${d.positionPercent.toFixed(0)}%` },
        { id: "metric", label: "Metric", value: d.metric },
        { id: "scale", label: "Colormap", value: d.colorScale },
      ],
      modeTabs: [
        { id: "plane", label: "Cut Plane & Display" },
        { id: "quality", label: "Slice Quality" },
      ],
      sections: [
        ...buildSliceSections("plane"),
        {
          defaultOpen: true,
          icon: Gauge,
          id: "slice-quality-chart",
          modeTabId: "quality",
          rows: [
            {
              render: (ctx) => (
                <ScientificEChart
                  ariaLabel={`2D cross-section ${ctx.draft.metric} distribution`}
                  height={185}
                  optionBuilder={qualityChartBuilder(
                    ctx.draft.metric,
                    ctx.draft.positionPercent,
                  )}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "2D slice quality distribution",
        },
      ],
      commitBar: {
        cleanMessage: () => "2D cross-section is synchronized",
        mode: "staged",
        onApply: async (draft) => {
          if (!plot) return false;
          updateCrossSectionPlot(plot.id, {
            colorScale: draft.colorScale,
            filterExpression: draft.filterExpression,
            frameExtent: draft.frameExtent,
            includeWireframe: draft.includeWireframe,
            metric: draft.metric,
            name: draft.name,
            plane: draft.plane,
            positionPercent: draft.positionPercent,
            rotationDegrees: draft.rotationDegrees,
            shrinkFactor: draft.shrinkFactor,
          });
          return true;
        },
      },
    }),
    [plot, plotId, qualityChartBuilder, selection.label],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

function buildSliceSections(
  modeTabId: string | undefined,
): InspectorSpec<SliceFormDraft>["sections"] {
  const tabOpt = modeTabId === "draft" ? undefined : modeTabId;
  return [
    {
      defaultOpen: true,
      icon: Scissors,
      id: "cut-plane",
      modeTabId: tabOpt,
      rows: [
        {
          key: "plane",
          label: "Cut plane orientation",
          options: [
            { label: "XY (normal Z)", value: "xy" },
            { label: "XZ (normal Y)", value: "xz" },
            { label: "YZ (normal X)", value: "yz" },
          ],
          type: "segmented",
        },
        {
          key: "positionPercent",
          label: "Plane position along normal",
          max: 100,
          min: 0,
          step: 1,
          type: "range",
          unitSuffix: "%",
        },
        {
          key: "rotationDegrees",
          label: "In-plane frame rotation",
          max: 180,
          min: -180,
          step: 5,
          symbol: <>&theta;</>,
          type: "number",
          unitSuffix: "deg",
        },
        {
          key: "frameExtent",
          label: "Frame extent",
          options: [
            { label: "Full Universe", value: "universe" },
            { label: "Magnetic Domain", value: "magnetic_domain" },
            { label: "Object Bounds", value: "object_bounds" },
          ],
          type: "select",
        },
      ],
      title: "Cut plane & frame",
    },
    {
      defaultOpen: true,
      icon: SlidersHorizontal,
      id: "render-options",
      modeTabId: tabOpt,
      rows: [
        {
          key: "metric",
          label: "Scalar / quality metric",
          options: [
            { label: "Skewness", value: "skewness" },
            { label: "Aspect Ratio", value: "aspect_ratio" },
            { label: "Area / Size", value: "area" },
          ],
          type: "select",
        },
        {
          key: "colorScale",
          label: "Colormap",
          options: [
            { label: "Viridis", value: "viridis" },
            { label: "Inferno", value: "inferno" },
            { label: "Plasma", value: "plasma" },
            { label: "Coolwarm", value: "coolwarm" },
          ],
          type: "select",
        },
        {
          key: "includeWireframe",
          label: "Show sliced element edges",
          type: "switch",
        },
        {
          key: "shrinkFactor",
          label: "Element shrink factor",
          max: 1,
          min: 0.5,
          step: 0.05,
          type: "range",
        },
        {
          key: "filterExpression",
          label: "Cell filter expression",
          placeholder: "e.g. skewness < 0.8",
          type: "expression",
        },
      ],
      title: "Slice metric & display",
    },
  ];
}
