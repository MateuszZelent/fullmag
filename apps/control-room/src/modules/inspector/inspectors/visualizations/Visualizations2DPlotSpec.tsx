"use client";

import type { EChartsOption } from "echarts";
import {
  BarChart3,
  Copy,
  Crosshair,
  Scissors,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { MODEL_PLANAR_MONITORS_PATH } from "@/kernel/api/apiPaths";
import type {
  CrossSectionPlane,
  CrossSectionQualityQuery,
  CrossSectionQuery,
} from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { SessionCommandCancelledError } from "@/kernel/commands/commandSessionScope";
import { useKernel } from "@/kernel/KernelContext";
import { useCrossSectionQualityResource, useCrossSectionResource } from "@/kernel/resources/crossSectionResources";
import {
  useDomainMetaResource,
  useSceneResource,
  useVisualizationStateResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { usePlanarMonitorsResource } from "@/kernel/resources/planarMonitorResources";
import { resourceHasDisplayableData } from "@/kernel/resources/resourceState";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  activeCrossSectionPlot,
  beginCrossSectionDraft,
  beginCrossSectionDraftFromPlot,
  isPlanarMonitorRevisionConflict,
  selectCrossSectionPlot,
  updateCrossSectionPlot,
} from "@/kernel/workspace/crossSectionWorkspace";
import { planarMonitorFramePreviewStore } from "@/kernel/workspace/planarMonitorFramePreview";
import { ScientificEChart, type ResolvedChartThemePalette } from "@/shared/charts/ScientificEChart";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorNotice, InspectorSpec } from "../../template";
import { SpecInspectorHost } from "../../panels/mesh-details/SpecInspectorHost";
import {
  buildFramePreviewFor3DGizmo,
  buildPlanarVisualizationPatch,
  buildRightHandedMonitorFrame,
  buildSliceDraftFromWorkspace,
  buildTargetOptions,
  computeExtendedCrossSectionStatistics,
  formatIntegerCount,
  formatQualityMetricValue,
  isMixedTopologyUnsupportedError,
  parseMonitorTarget,
  QUALITY_METRIC_OPTIONS,
  removeCrossSectionPlotById,
  resolveDomainBounds,
  resolvePlanarMonitorDeleteFn,
  resolveSelectedCrossSectionElement,
  serializeMonitorTarget,
  setCompanionSliceMeta,
  toCompanionSliceMeta,
  toCrossSectionDraft,
  type PlanarMonitorsApiCompat,
  type SliceFormDraft,
} from "../../panels/cross-sections/visualizations2DModel";
import {
  useResolvedSessionScopeKey,
  useCrossSectionWorkspace,
  useCompanionSliceMetaMap,
  resolvePlotSelectionId,
  resolveSelectedElementIndex,
  syncCoupledSliceFieldChange,
  buildSharedAuthoringSections,
  buildStatisticsRows,
} from "./visualizations2DShared";

export function Visualizations2DPlotInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = useResolvedSessionScopeKey();
  const workspace = useCrossSectionWorkspace();
  const companionMap = useCompanionSliceMetaMap();
  const domainMetaRes = useDomainMetaResource();
  const sceneRes = useSceneResource();
  const vizState = useVisualizationStateResource();

  const canQueryMonitors =
    kernel?.api === undefined ||
    typeof kernel.api?.model?.planarMonitors?.list === "function";
  const monitors = usePlanarMonitorsResource({ enabled: canQueryMonitors });

  const vizData = vizState.data;
  const vizPlanar = vizData?.planar;
  const domainData = domainMetaRes.data;
  const sceneData = sceneRes.data;
  const monitorsList = monitors.data?.monitors;
  const monitorsSceneRevision = monitors.data?.scene_revision;
  const refetchMonitors = monitors.refetch;
  const selectionLabel = selection.label;

  const explicitPlotId = resolvePlotSelectionId(selection);
  const plot = useMemo(() => {
    if (explicitPlotId) {
      const matched = workspace.plots.find((p) => p.id === explicitPlotId);
      if (matched) return matched;
    }
    return activeCrossSectionPlot(workspace) ?? workspace.plots[0] ?? null;
  }, [explicitPlotId, workspace]);
  const plotId = plot?.id ?? explicitPlotId ?? "plot-1";
  const plotName = plot?.name;

  const [liveSliceOverride, setLiveSliceOverride] = useState<{
    forPlotId: string;
    plane: CrossSectionPlane;
    positionPercent: number;
    metric: CrossSectionQualityQuery["metric"];
    includeWireframe: boolean;
  } | null>(null);
  const [revisionConflict, setRevisionConflict] = useState(false);

  const bounds = useMemo(
    () => resolveDomainBounds(domainData),
    [domainData],
  );
  const targetOptions = useMemo(
    () => buildTargetOptions(sceneData),
    [sceneData],
  );

  const companion = companionMap.get(plotId);
  const companionLinkedMonitorId = companion?.linkedMonitorId;

  const linkedMonitor = useMemo(() => {
    const list = monitorsList ?? [];
    return (
      list.find(
        (m) =>
          m.id === companionLinkedMonitorId ||
          m.id === plotId ||
          (plotName ? m.name === plotName : false),
      ) ?? null
    );
  }, [companionLinkedMonitorId, monitorsList, plotId, plotName]);
  const linkedMonitorId = linkedMonitor?.id ?? null;

  const baseline = useMemo<SliceFormDraft>(() => {
    const base = buildSliceDraftFromWorkspace(
      plot,
      companion,
      bounds,
      selectionLabel ?? "Plot 1",
      "mesh",
    );
    if (linkedMonitor && !companion) {
      return {
        ...base,
        name: plotName ?? linkedMonitor.name,
        target: serializeMonitorTarget(linkedMonitor.target),
      };
    }
    return base;
  }, [bounds, companion, linkedMonitor, plot, plotName, selectionLabel]);

  const activeLiveQuery =
    liveSliceOverride?.forPlotId === plotId ? liveSliceOverride : null;
  const effectiveWireframe =
    activeLiveQuery?.includeWireframe ?? baseline.includeWireframe;
  const effectivePlane = activeLiveQuery?.plane ?? baseline.plane;
  const effectivePositionPercent =
    activeLiveQuery?.positionPercent ?? baseline.positionPercent;
  const effectiveMetric = activeLiveQuery?.metric ?? baseline.metric;

  const query = useMemo<CrossSectionQuery>(
    () => ({
      includePolygons: true,
      includeWireframe: effectiveWireframe,
      plane: effectivePlane,
      positionPercent: effectivePositionPercent,
    }),
    [effectivePlane, effectivePositionPercent, effectiveWireframe],
  );

  const qualityQuery = useMemo<CrossSectionQualityQuery>(
    () => ({
      metric: effectiveMetric,
      plane: effectivePlane,
      positionPercent: effectivePositionPercent,
    }),
    [effectiveMetric, effectivePlane, effectivePositionPercent],
  );

  const canQueryCrossSection =
    kernel?.api === undefined ||
    typeof kernel.api?.meshing?.sharedDomain?.crossSection === "function";

  const crossSection = useCrossSectionResource(query, {
    enabled: canQueryCrossSection,
  });
  const quality = useCrossSectionQualityResource(qualityQuery, {
    enabled: canQueryCrossSection && resourceHasDisplayableData(crossSection),
  });

  const crossSectionData = crossSection.data;
  const crossSectionStatus = crossSection.status;
  const crossSectionParentIds = crossSectionData?.parentElementIds;
  const qualityData = quality.data;
  const qualityStatus = quality.status;
  const qualityPerElement = qualityData?.perElementQuality;

  const mixedTopologyError = isMixedTopologyUnsupportedError(crossSection.error);
  const genericCrossSectionError =
    crossSectionStatus === "error" && !mixedTopologyError
      ? crossSection.error instanceof Error
        ? crossSection.error.message
        : null
      : null;

  const stats = useMemo(
    () => computeExtendedCrossSectionStatistics(crossSectionData, qualityData, 0.1),
    [crossSectionData, qualityData],
  );
  const histogramBins = stats?.qualityStats.histogram;

  const selectedElementIndex = resolveSelectedElementIndex(selection);
  const selectedElement = useMemo(
    () =>
      resolveSelectedCrossSectionElement(
        selectedElementIndex,
        crossSectionParentIds,
        qualityPerElement,
      ),
    [crossSectionParentIds, qualityPerElement, selectedElementIndex],
  );

  const buildHistogramOption = useCallback(
    (palette: ResolvedChartThemePalette): EChartsOption => {
      const bins = histogramBins ?? [];
      return {
        animation: false,
        grid: { left: 40, right: 12, top: 14, bottom: 28 },
        tooltip: { trigger: "axis" },
        xAxis: {
          type: "category",
          data: bins.map((bin) => bin.label),
          axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
        },
        yAxis: {
          type: "value",
          name: "Polygons",
          axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
          splitLine: { lineStyle: { color: palette.borderSubtle } },
        },
        series: [
          {
            type: "bar",
            data: bins.map((bin) => bin.count),
            itemStyle: { color: palette.accent, borderRadius: [3, 3, 0, 0] },
          },
        ],
      };
    },
    [histogramBins],
  );

  const handlePlotFieldChange = useCallback(
    <K extends keyof SliceFormDraft & string>(
      key: K,
      value: SliceFormDraft[K],
      helpers: {
        draft: SliceFormDraft;
        patchDraft: (partial: Partial<SliceFormDraft>) => void;
      },
    ) => {
      setRevisionConflict(false);
      const nextDraft = syncCoupledSliceFieldChange(
        key,
        value,
        helpers.draft,
        bounds,
        helpers.patchDraft,
      );

      setLiveSliceOverride({
        forPlotId: plotId,
        includeWireframe: nextDraft.includeWireframe,
        metric: nextDraft.metric,
        plane: nextDraft.plane,
        positionPercent: nextDraft.positionPercent,
      });

      planarMonitorFramePreviewStore.set(
        buildFramePreviewFor3DGizmo(nextDraft, bounds, plotId, false),
      );
      kernel?.visualizationSync?.queuePatch({
        planar: buildPlanarVisualizationPatch(
          nextDraft,
          linkedMonitorId,
          vizPlanar,
        ),
      });
    },
    [bounds, kernel, linkedMonitorId, plotId, vizPlanar],
  );

  const handleNewImageFromPlot = useCallback(() => {
    const newDraft = plot
      ? beginCrossSectionDraftFromPlot(plot.id)
      : beginCrossSectionDraft(vizData);
    if (!newDraft) return;
    if (companion) {
      setCompanionSliceMeta("draft", { ...companion, linkedMonitorId: null });
    }
    const nodeId = "model:visualizations-2d:draft";
    kernel?.selection?.set?.(
      {
        kind: "visualizations-2d.draft",
        label: newDraft.name,
        nodeId,
        objectId: null,
        ref: {
          draftId: "draft",
          kind: "visualizations-2d.draft",
          nodeId,
          type: "cross-section-draft",
          visualizationTargetId: "cross-section:draft",
        },
      },
      "inspector",
    );
    kernel?.layout?.setPanelVisible?.("right", true);
  }, [companion, kernel, plot, vizData]);

  const handleRemovePlot = useCallback(
    async (selectNode: (next: Omit<Selection, "moduleSource">) => void) => {
      if (linkedMonitor) {
        const deleteFn = resolvePlanarMonitorDeleteFn(
          kernel?.api?.model?.planarMonitors as PlanarMonitorsApiCompat | undefined,
        );
        if (deleteFn) {
          const initialScope =
            kernel?.commands?.getSessionScopeKey?.() ?? sessionScopeKey;
          const historyGeneration = kernel?.authoringHistory?.getGeneration?.();
          const isCurrentSessionScope = () =>
            Boolean(sessionScopeKey ?? initialScope) &&
            (typeof kernel?.commands?.getSessionScopeKey === "function"
              ? kernel.commands.getSessionScopeKey() === initialScope
              : true) &&
            (historyGeneration === undefined ||
              kernel?.authoringHistory?.getGeneration?.() === historyGeneration);

          const response = await runAuthoringMutationWithHistory(
            {
              api: kernel.api,
              authoringHistory: kernel.authoringHistory,
              isCurrentSessionScope,
              selection: kernel.selection,
              sessionScopeKey: sessionScopeKey ?? undefined,
            },
            `Remove planar monitor ${linkedMonitor.name}`,
            async ({ baseRevision }) => {
              const expectedRevision =
                baseRevision ?? monitorsSceneRevision ?? 1;
              return deleteFn(
                linkedMonitor.id,
                { expected_scene_revision: expectedRevision },
                sessionScopeKey ? { sessionScopeKey } : undefined,
              );
            },
          );
          if (!isCurrentSessionScope()) return;
          if (
            vizPlanar?.source?.kind === "monitor" &&
            vizPlanar.source.monitor_id === linkedMonitor.id
          ) {
            kernel?.visualizationSync?.queuePatch({
              planar: { source: { kind: "default" } },
            });
          }
          kernel?.resources?.invalidate(
            MODEL_PLANAR_MONITORS_PATH,
            response.scene_revision,
          );
        }
      }

      if (plot) {
        removeCrossSectionPlotById(plot.id);
      }
      planarMonitorFramePreviewStore.clear();
      selectNode({
        kind: "visualizations-2d.root",
        label: "Visualizations 2D",
        nodeId: "model:visualizations-2d",
        objectId: null,
        ref: null,
      });
    },
    [kernel, linkedMonitor, monitorsSceneRevision, plot, sessionScopeKey, vizPlanar],
  );

  const handleApplyPlot = useCallback(
    async (draft: SliceFormDraft): Promise<boolean> => {
      setRevisionConflict(false);

      if (
        linkedMonitor &&
        typeof kernel?.api?.model?.planarMonitors?.patch === "function"
      ) {
        const activeCommandScope = kernel?.commands?.getSessionScopeKey?.();
        const operationScopeKey =
          sessionScopeKey ??
          (typeof activeCommandScope === "string" ? activeCommandScope : null);
        if (!operationScopeKey || activeCommandScope === null) {
          throw new Error(
            "Session identity is not ready. Try again after it loads.",
          );
        }
        const initialScope = activeCommandScope ?? operationScopeKey;
        const historyGeneration = kernel?.authoringHistory?.getGeneration?.();
        const isCurrentSessionScope = () =>
          (typeof kernel?.commands?.getSessionScopeKey === "function"
            ? (kernel.commands.getSessionScopeKey() ?? operationScopeKey) ===
              initialScope
            : true) &&
          (historyGeneration === undefined ||
            kernel?.authoringHistory?.getGeneration?.() === historyGeneration);

        try {
          const response = await runAuthoringMutationWithHistory(
            {
              api: kernel.api,
              authoringHistory: kernel.authoringHistory,
              isCurrentSessionScope,
              selection: kernel.selection,
              sessionScopeKey: operationScopeKey,
            },
            `Update planar monitor ${draft.name}`,
            async ({ baseRevision }) => {
              const expectedRevision =
                baseRevision ?? monitorsSceneRevision ?? 1;
              return kernel.api.model.planarMonitors.patch(
                linkedMonitor.id,
                {
                  expected_scene_revision: expectedRevision,
                  monitor: {
                    ...linkedMonitor,
                    frame: buildRightHandedMonitorFrame(draft, bounds),
                    name: draft.name.trim() || linkedMonitor.name,
                    target: parseMonitorTarget(draft.target),
                  },
                },
                { sessionScopeKey: operationScopeKey },
              );
            },
          );
          if (!isCurrentSessionScope()) return false;
          kernel.resources?.invalidate(
            MODEL_PLANAR_MONITORS_PATH,
            response.scene_revision,
          );
        } catch (error) {
          if (error instanceof SessionCommandCancelledError) return false;
          if (isPlanarMonitorRevisionConflict(error)) {
            setRevisionConflict(true);
            throw new Error(
              "The scene changed while this monitor was being edited. Reload the current revision before applying again.",
            );
          }
          throw error instanceof Error
            ? error
            : new Error("Planar monitor update failed.");
        }
      }

      if (plot) {
        updateCrossSectionPlot(plot.id, toCrossSectionDraft(draft));
        selectCrossSectionPlot(plot.id);
      }
      setCompanionSliceMeta(
        plotId,
        toCompanionSliceMeta(draft, linkedMonitorId),
      );
      setLiveSliceOverride(null);
      kernel?.visualizationSync?.queuePatch({
        planar: buildPlanarVisualizationPatch(draft, linkedMonitorId, vizPlanar),
      });
      return true;
    },
    [
      bounds,
      kernel,
      linkedMonitor,
      linkedMonitorId,
      monitorsSceneRevision,
      plot,
      plotId,
      sessionScopeKey,
      vizPlanar,
    ],
  );

  const authoringSections = useMemo(
    () =>
      buildSharedAuthoringSections(bounds, targetOptions, {
        meshFooter: () => (
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={handleNewImageFromPlot}
            >
              <Copy aria-hidden="true" data-icon="inline-start" size={14} />
              New Image
            </Button>
          </div>
        ),
        modeTabId: "plane",
      }),
    [bounds, handleNewImageFromPlot, targetOptions],
  );

  const isSliceLoading =
    crossSectionStatus === "loading" || qualityStatus === "loading";
  const statisticsRows = useMemo(
    () => buildStatisticsRows(stats, mixedTopologyError, isSliceLoading),
    [isSliceLoading, mixedTopologyError, stats],
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
          { id: "plot", label: plotName ?? selectionLabel ?? "Plot" },
        ],
        canFitView: true,
        primaryHeaderAction: {
          label: "New Image",
          icon: Copy,
          variant: "secondary",
          onRun: handleNewImageFromPlot,
        },
        deleteAction: {
          label: "Remove",
          confirmTitle: (d) => `Remove "${d.name}"?`,
          confirmDescription:
            "Remove this 2D cross-section visualization and any linked planar monitor?",
          onDelete: async (ctx) => {
            await handleRemovePlot(ctx.selectNode);
          },
        },
      },
      identity: {
        domain: "visualization",
        icon: Scissors,
        title: (d) => d.name || "Plot",
        renameFieldKey: "name",
        kindLabel: "2D cross-section plot",
        entityId: plotId,
        statePill: () =>
          mixedTopologyError
            ? { tone: "warn", label: "Mixed topology" }
            : revisionConflict
              ? { tone: "err", label: "Revision conflict" }
              : { tone: "ok", label: "Active" },
      },
      facts: (d) => [
        {
          id: "plane",
          label: "Plane",
          value: d.normalMode === "custom" ? "Custom" : d.plane.toUpperCase(),
        },
        {
          id: "pos",
          label: "Position",
          value: `${d.positionPercent.toFixed(1)}%`,
        },
        {
          id: "metric",
          label: "Field / Metric",
          value: d.quantity === "mesh" ? d.metric : d.fieldComponent,
        },
        {
          id: "polys",
          label: "Polygons",
          value: stats
            ? formatIntegerCount(stats.qualityStats.visiblePolygonCount)
            : d.colormap,
        },
      ],
      notices: () => {
        const notices: InspectorNotice<SliceFormDraft>[] = [];
        if (mixedTopologyError) {
          notices.push({
            id: "mixed-topology-unsupported",
            tone: "warn",
            title: "Mixed topology cross-sections are not supported",
            text: "Mixed topology cross-sections are not supported yet. Meshes with prism and pyramid cells require a generic convex slicer, and Fullmag will not reinterpret them as tetrahedra.",
          });
        } else if (genericCrossSectionError) {
          notices.push({
            id: "cross-section-error",
            tone: "err",
            title: "Cross-section read error",
            text: genericCrossSectionError,
          });
        }
        if (revisionConflict) {
          notices.push({
            id: "revision-conflict",
            tone: "warn",
            title: "Scene revision conflict",
            text: "The scene changed while this monitor was being edited. Reload the current revision before applying again.",
            quickFix: {
              label: "Reload current monitors",
              onApply: () => {
                setRevisionConflict(false);
                refetchMonitors?.();
              },
            },
          });
        }
        return notices;
      },
      modeTabs: [
        { id: "plane", label: "Cut Plane & Display", icon: Scissors },
        { id: "quality", label: "Slice Quality", icon: BarChart3 },
      ],
      sections: [
        ...authoringSections,
        {
          id: "slice-statistics",
          title: "Cross-Section Statistics",
          icon: BarChart3,
          modeTabId: "quality",
          defaultOpen: true,
          rows: statisticsRows,
        },
        {
          id: "slice-quality-histogram",
          title: "2D Slice Quality Distribution",
          icon: BarChart3,
          modeTabId: "quality",
          defaultOpen: true,
          rows: [
            {
              key: "metric",
              label: "Quality metric",
              type: "select",
              options: QUALITY_METRIC_OPTIONS,
            },
            {
              type: "custom",
              wide: true,
              render: (ctx) => {
                const binCount = histogramBins?.length ?? 0;
                const emptyMsg = mixedTopologyError
                  ? "Mixed topology cross-sections do not publish tetrahedral slice quality histograms."
                  : binCount === 0
                    ? "No FEM cross-section quality samples published for this slice."
                    : undefined;
                return (
                  <ScientificEChart
                    ariaLabel={`2D slice ${ctx.draft.metric} quality distribution`}
                    emptyMessage={emptyMsg}
                    height={165}
                    optionBuilder={buildHistogramOption}
                  />
                );
              },
            },
          ],
        },
        {
          id: "selected-element",
          title: "Selected Element",
          icon: Crosshair,
          modeTabId: "quality",
          defaultOpen: true,
          emptyState: () =>
            selectedElement
              ? null
              : {
                  icon: Crosshair,
                  title: "No slice polygon selected",
                  description:
                    "Hover or click a cross-section polygon to inspect its parent tet.",
                },
          rows: selectedElement
            ? [
                {
                  label: "Parent tet",
                  mono: true,
                  type: "readonly",
                  format: () => String(selectedElement.parentElementId),
                },
                {
                  label: "Polygon",
                  mono: true,
                  type: "readonly",
                  format: () =>
                    selectedElement.polygonIndex >= 0
                      ? String(selectedElement.polygonIndex)
                      : "Outside current slice",
                },
                {
                  label: "Quality",
                  mono: true,
                  type: "readonly",
                  format: () =>
                    formatQualityMetricValue(selectedElement.quality),
                },
              ]
            : [],
        },
      ],
      commitBar: {
        mode: "staged",
        onApply: handleApplyPlot,
        onRevert: (base) => {
          setRevisionConflict(false);
          setLiveSliceOverride(null);
          planarMonitorFramePreviewStore.set(
            buildFramePreviewFor3DGizmo(base, bounds, plotId, false),
          );
        },
      },
    }),
    [
      authoringSections,
      bounds,
      buildHistogramOption,
      genericCrossSectionError,
      handleApplyPlot,
      handleNewImageFromPlot,
      handleRemovePlot,
      histogramBins,
      mixedTopologyError,
      plotId,
      plotName,
      refetchMonitors,
      revisionConflict,
      selectedElement,
      selectionLabel,
      statisticsRows,
      stats,
    ],
  );

  return (
    <SpecInspectorHost
      baseline={baseline}
      options={
        selectedElementIndex !== null
          ? { initialModeTabId: "quality" }
          : undefined
      }
      selection={selection}
      spec={spec}
      onAfterFieldChange={handlePlotFieldChange}
    />
  );
}
