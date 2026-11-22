"use client";

import {
  Compass,
  Crosshair,
  Eye,
  Layers,
  Plus,
  Scissors,
  Trash2,
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
import { useVisualizationStateResource } from "@/kernel/resources/geometryLifecycleResources";
import { usePlanarMonitorsResource } from "@/kernel/resources/planarMonitorResources";
import { resourceHasDisplayableData } from "@/kernel/resources/resourceState";
import {
  activeCrossSectionPlot,
  beginCrossSectionDraft,
  discardCrossSectionDraft,
  selectCrossSectionPlot,
  updateCrossSectionDraft,
  type CrossSectionPlot,
  type PlanarMonitor,
} from "@/kernel/workspace/crossSectionWorkspace";
import {
  planarMonitorFramePreviewStore,
  usePlanarMonitorFramePreview,
} from "@/kernel/workspace/planarMonitorFramePreview";
import { Button } from "@/shared/ui/Button";
import { EmptyState } from "@/shared/ui/EmptyState";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type {
  InspectorActionContext,
  InspectorNotice,
  InspectorSpec,
} from "../../template";
import { defaultPlanarDisplayPatch, planarDisplayDiffersFromDefault } from "../../visualization/planarDisplayDefaults";
import { SpecInspectorHost } from "../../panels/mesh-details/SpecInspectorHost";
import {
  deleteCompanionSliceMeta,
  formatQualityMetricValue,
  isMixedTopologyUnsupportedError,
  removeCrossSectionPlotById,
  resolvePlanarMonitorDeleteFn,
  resolveSelectedCrossSectionElement,
  type PlanarMonitorsApiCompat,
} from "../../panels/cross-sections/visualizations2DModel";
import {
  useResolvedSessionScopeKey,
  useCrossSectionWorkspace,
  useCompanionSliceMetaMap,
  resolveSelectedElementIndex,
} from "./visualizations2DShared";

// ═══════════════════════════════════════════════════════════════════════════
// 1. visualizations-2d.root (+ redirected mesh.cross-section)
// ═══════════════════════════════════════════════════════════════════════════

interface Visualizations2DRootDraft {
  showSliceGizmo: boolean;
  showSliceMeshEdges: boolean;
  showPlanarOverlay: boolean;
}

interface UnifiedSliceOverviewRow {
  readonly id: string;
  readonly name: string;
  readonly subtitle: string;
  readonly plot: CrossSectionPlot | null;
  readonly monitor: PlanarMonitor | null;
}

export function Visualizations2DRootInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = useResolvedSessionScopeKey();
  const workspace = useCrossSectionWorkspace();
  const companionMap = useCompanionSliceMetaMap();
  const vizState = useVisualizationStateResource();
  const planarPreview = usePlanarMonitorFramePreview();

  const canQueryMonitors =
    kernel?.api === undefined ||
    typeof kernel.api?.model?.planarMonitors?.list === "function";
  const monitorsRes = usePlanarMonitorsResource({ enabled: canQueryMonitors });

  const vizData = vizState.data;
  const vizPlanar = vizData?.planar;
  const vizPlanarLayers = vizPlanar?.layers;
  const monitorsList = monitorsRes.data?.monitors;
  const monitorsSceneRevision = monitorsRes.data?.scene_revision;
  const workspaceDraft = workspace.draft;
  const workspacePlots = workspace.plots;

  const selectedElementIndex = resolveSelectedElementIndex(selection);
  const activePlot = activeCrossSectionPlot(workspace);
  const canQueryCrossSection =
    (selectedElementIndex !== null || activePlot !== null) &&
    (kernel?.api === undefined ||
      typeof kernel.api?.meshing?.sharedDomain?.crossSection === "function");

  const activeIncludeWireframe = activePlot?.renderOptions.wireframeVisible ?? true;
  const activePlane = activePlot?.plane ?? "xy";
  const activePositionPercent = activePlot?.positionPercent ?? 50;
  const activeMetric =
    activePlot?.metric ?? vizData?.slice?.mesh_quality_metric ?? "skewness";

  const activeQuery = useMemo<CrossSectionQuery>(
    () => ({
      includePolygons: true,
      includeWireframe: activeIncludeWireframe,
      plane: activePlane,
      positionPercent: activePositionPercent,
    }),
    [activeIncludeWireframe, activePlane, activePositionPercent],
  );

  const activeQualityQuery = useMemo<CrossSectionQualityQuery>(
    () => ({
      metric: activeMetric,
      plane: activePlane,
      positionPercent: activePositionPercent,
    }),
    [activeMetric, activePlane, activePositionPercent],
  );

  const crossSectionRes = useCrossSectionResource(activeQuery, {
    enabled: canQueryCrossSection,
  });
  const qualityRes = useCrossSectionQualityResource(activeQualityQuery, {
    enabled: canQueryCrossSection && resourceHasDisplayableData(crossSectionRes),
  });

  const crossSectionParentIds = crossSectionRes.data?.parentElementIds;
  const qualityPerElement = qualityRes.data?.perElementQuality;

  const selectedElement = useMemo(
    () =>
      resolveSelectedCrossSectionElement(
        selectedElementIndex,
        crossSectionParentIds,
        qualityPerElement,
      ),
    [crossSectionParentIds, qualityPerElement, selectedElementIndex],
  );

  const [removeError, setRemoveError] = useState<string | null>(null);

  const gizmoVisibleInStore =
    Boolean(vizData?.clip?.enabled) ||
    (planarPreview !== null && planarPreview.visible !== false);
  const meshEdgesVisibleInStore = vizData?.slice?.show_mesh ?? true;
  const planarOverlayVisibleInStore = vizPlanar?.visible ?? true;

  const baseline = useMemo<Visualizations2DRootDraft>(
    () => ({
      showPlanarOverlay: planarOverlayVisibleInStore,
      showSliceGizmo: gizmoVisibleInStore,
      showSliceMeshEdges: meshEdgesVisibleInStore,
    }),
    [gizmoVisibleInStore, meshEdgesVisibleInStore, planarOverlayVisibleInStore],
  );

  const unifiedRows = useMemo<readonly UnifiedSliceOverviewRow[]>(() => {
    const monitors = monitorsList ?? [];
    const matchedMonitorIds = new Set<string>();
    const rows: UnifiedSliceOverviewRow[] = [];

    for (const plot of workspacePlots) {
      const companion = companionMap.get(plot.id);
      const linkedMonitor =
        monitors.find(
          (m) =>
            m.id === companion?.linkedMonitorId ||
            m.id === plot.id ||
            m.name === plot.name,
        ) ?? null;
      if (linkedMonitor) {
        matchedMonitorIds.add(linkedMonitor.id);
      }
      rows.push({
        id: `plot:${plot.id}`,
        monitor: linkedMonitor,
        name: plot.name,
        plot,
        subtitle: `${plot.plane.toUpperCase()} · ${plot.positionPercent.toFixed(1)}% · ${companion?.quantity && companion.quantity !== "mesh" ? companion.fieldComponent : plot.metric}`,
      });
    }

    for (const monitor of monitors) {
      if (matchedMonitorIds.has(monitor.id)) continue;
      rows.push({
        id: `monitor:${monitor.id}`,
        monitor,
        name: monitor.name,
        plot: null,
        subtitle: `${(monitor.frame.preset ?? "custom").toUpperCase()} · ${monitor.target.kind} · ${monitor.operator.kind}`,
      });
    }

    return rows;
  }, [companionMap, monitorsList, workspacePlots]);

  const handleStartNewDraft = useCallback(
    (preset?: { name?: string; plane: CrossSectionPlane; positionPercent: number }) => {
      const draft = beginCrossSectionDraft(vizData);
      const updated = preset ? (updateCrossSectionDraft(preset) ?? draft) : draft;
      const nodeId = "model:visualizations-2d:draft";
      kernel?.selection?.set?.(
        {
          kind: "visualizations-2d.draft",
          label: updated.name,
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
    },
    [kernel, vizData],
  );

  const handleInspectRow = useCallback(
    (row: UnifiedSliceOverviewRow) => {
      if (row.plot) {
        selectCrossSectionPlot(row.plot.id);
        const nodeId = `model:visualizations-2d:${row.plot.id}`;
        kernel?.selection?.set?.(
          {
            kind: "visualizations-2d.plot",
            label: row.plot.name,
            nodeId,
            objectId: null,
            ref: {
              kind: "visualizations-2d.plot",
              nodeId,
              plotId: row.plot.id,
              type: "cross-section-plot",
              visualizationTargetId: `cross-section:plot:${row.plot.id}`,
            },
          },
          "inspector",
        );
        return;
      }
      if (row.monitor) {
        const nodeId = `model:definitions:planar-monitors:${row.monitor.id}`;
        kernel?.selection?.set?.(
          {
            kind: "model.planar.monitor",
            label: row.monitor.name,
            nodeId,
            objectId: null,
            ref: {
              kind: "model.planar.monitor",
              monitorId: row.monitor.id,
              nodeId,
              type: "planar-monitor",
              visualizationTargetId: `planar-monitor:${row.monitor.id}`,
            },
          },
          "inspector",
        );
      }
    },
    [kernel],
  );

  const handleOpenRowIn2D = useCallback(
    (row: UnifiedSliceOverviewRow) => {
      if (row.monitor) {
        kernel?.visualizationSync?.queuePatch({
          planar: {
            source: { kind: "monitor", monitor_id: row.monitor.id },
          },
        });
        kernel?.layout?.setActiveViewportMainModule?.("field-map");
        return;
      }
      handleInspectRow(row);
    },
    [handleInspectRow, kernel],
  );

  const handleRemoveRow = useCallback(
    async (row: UnifiedSliceOverviewRow) => {
      setRemoveError(null);
      try {
        if (row.monitor) {
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
              `Remove planar monitor ${row.monitor.name}`,
              async ({ baseRevision }) => {
                const expectedRevision =
                  baseRevision ?? monitorsSceneRevision ?? 1;
                return deleteFn(
                  row.monitor!.id,
                  { expected_scene_revision: expectedRevision },
                  sessionScopeKey ? { sessionScopeKey } : undefined,
                );
              },
            );

            if (!isCurrentSessionScope()) return;

            if (
              vizPlanar?.source?.kind === "monitor" &&
              vizPlanar.source.monitor_id === row.monitor.id
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

        if (row.plot) {
          removeCrossSectionPlotById(row.plot.id);
        }
      } catch (error) {
        if (error instanceof SessionCommandCancelledError) return;
        setRemoveError(
          error instanceof Error
            ? error.message
            : "Could not remove planar monitor.",
        );
      }
    },
    [kernel, monitorsSceneRevision, sessionScopeKey, vizPlanar],
  );

  const handleRootFieldChange = useCallback(
    <K extends keyof Visualizations2DRootDraft & string>(
      key: K,
      value: Visualizations2DRootDraft[K],
    ) => {
      if (key === "showSliceGizmo") {
        const nextVal = Boolean(value);
        kernel?.visualizationSync?.queuePatch({
          clip: { enabled: nextVal },
        });
        planarMonitorFramePreviewStore.setVisible(nextVal);
      } else if (key === "showSliceMeshEdges") {
        const nextVal = Boolean(value);
        kernel?.visualizationSync?.queuePatch({
          slice: { show_mesh: nextVal },
          ...(vizPlanarLayers
            ? { planar: { layers: { ...vizPlanarLayers, mesh: nextVal } } }
            : {}),
        });
      } else if (key === "showPlanarOverlay") {
        const nextVal = Boolean(value);
        kernel?.visualizationSync?.queuePatch({
          planar: { visible: nextVal },
        });
      }
    },
    [kernel, vizPlanarLayers],
  );

  const handleResetRootDisplay = useCallback(async () => {
    planarMonitorFramePreviewStore.setVisible(true);
    kernel?.visualizationSync?.queuePatch({
      clip: { enabled: false },
      planar: defaultPlanarDisplayPatch(),
      slice: { show_mesh: true },
    });
    await kernel?.visualizationSync?.flushNow?.();
  }, [kernel]);

  const mixedTopologyError = isMixedTopologyUnsupportedError(crossSectionRes.error);

  const spec = useMemo<InspectorSpec<Visualizations2DRootDraft>>(
    () => ({
      id: "visualizations-2d.root",
      header: {
        breadcrumbs: [
          {
            id: "model",
            label: "Session Model",
            selection: {
              kind: "session.root",
              label: "Session Model",
              nodeId: "model:session",
              objectId: null,
              ref: null,
            },
          },
          { id: "viz2d", label: "Visualizations 2D" },
        ],
        primaryHeaderAction: {
          label: "New 2D Visualization",
          icon: Plus,
          onRun: () => handleStartNewDraft(),
        },
      },
      identity: {
        domain: "visualization",
        icon: Scissors,
        title: () => "Visualizations 2D",
        kindLabel: "2D cross-section slices & planar monitors",
        entityId: "model:visualizations-2d",
        statePill: () =>
          workspaceDraft
            ? { tone: "warn", label: "Draft open" }
            : {
                tone: unifiedRows.length > 0 ? "ok" : "neutral",
                label: `${unifiedRows.length} saved`,
              },
      },
      facts: () => [
        {
          id: "saved",
          label: "Saved slices",
          value: String(unifiedRows.length),
        },
        {
          id: "draft",
          label: "Active draft",
          value: workspaceDraft ? workspaceDraft.name : "None",
          ...(workspaceDraft ? { tone: "warn" as const } : {}),
        },
        {
          id: "gizmo",
          label: "3D slice gizmo",
          value: gizmoVisibleInStore ? "Visible" : "Hidden",
        },
        ...(monitorsSceneRevision !== undefined
          ? [
              {
                id: "rev",
                label: "Scene",
                value: `rev ${monitorsSceneRevision}`,
              },
            ]
          : []),
      ],
      notices: () => {
        const items: InspectorNotice<Visualizations2DRootDraft>[] = [];
        if (removeError) {
          items.push({
            id: "remove-error",
            tone: "err",
            title: "Monitor removal failed",
            text: removeError,
          });
        }
        if (mixedTopologyError) {
          items.push({
            id: "mixed-topology-unsupported",
            tone: "warn",
            title: "Mixed topology cross-sections are not supported",
            text: "Mixed topology cross-sections are not supported yet. Meshes with prism and pyramid cells require a generic convex slicer, and Fullmag will not reinterpret them as tetrahedra.",
          });
        }
        return items;
      },
      sections: [
        {
          id: "plane-gizmo-visibility",
          title: "3D Plane & Slice Visibility",
          icon: Eye,
          defaultOpen: true,
          live: true,
          rows: [
            {
              key: "showSliceGizmo",
              label: "Show 3D slice gizmo",
              type: "switch",
            },
            {
              key: "showSliceMeshEdges",
              label: "Show mesh edges on slice",
              type: "switch",
            },
            {
              key: "showPlanarOverlay",
              label: "Show 2D planar overlay",
              type: "switch",
            },
          ],
        },
        ...(workspaceDraft
          ? [
              {
                id: "active-draft-banner",
                title: "Active Unsaved Draft",
                icon: Compass,
                defaultOpen: true,
                rows: [
                  {
                    type: "custom" as const,
                    label: workspaceDraft.name,
                    wide: true,
                    render: (ctx: InspectorActionContext<Visualizations2DRootDraft>) => (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-fm-border px-2.5 py-2 text-xs">
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {workspaceDraft.name}
                          </div>
                          <div className="text-fm-muted">
                            {workspaceDraft.plane.toUpperCase()} ·{" "}
                            {workspaceDraft.positionPercent.toFixed(1)}% ·{" "}
                            {workspaceDraft.metric}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            type="button"
                            variant="primary"
                            onClick={() =>
                              ctx.selectNode({
                                kind: "visualizations-2d.draft",
                                label: workspaceDraft.name,
                                nodeId: "model:visualizations-2d:draft",
                                objectId: null,
                                ref: {
                                  draftId: "draft",
                                  kind: "visualizations-2d.draft",
                                  nodeId: "model:visualizations-2d:draft",
                                  type: "cross-section-draft",
                                  visualizationTargetId: "cross-section:draft",
                                },
                              })
                            }
                          >
                            Resume Draft
                          </Button>
                          <Button
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() => {
                              discardCrossSectionDraft();
                              deleteCompanionSliceMeta("draft");
                              planarMonitorFramePreviewStore.clear();
                            }}
                          >
                            Discard
                          </Button>
                        </div>
                      </div>
                    ),
                  },
                ],
              },
            ]
          : []),
        {
          id: "saved-slices",
          title: "Saved Cross-Sections & Planar Monitors",
          icon: Layers,
          defaultOpen: true,
          footer: () => (
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                type="button"
                variant="primary"
                onClick={() => handleStartNewDraft()}
              >
                <Plus aria-hidden="true" data-icon="inline-start" size={14} />
                New 2D Visualization
              </Button>
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
                  onClick={() =>
                    handleStartNewDraft({
                      name: `${preset.plane.toUpperCase()} Midplane`,
                      plane: preset.plane,
                      positionPercent: 50,
                    })
                  }
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          ),
          rows:
            unifiedRows.length === 0
              ? [
                  {
                    type: "custom",
                    label: "Saved slices",
                    wide: true,
                    render: () => (
                      <EmptyState
                        description="Create a 2D cross-section visualization or planar monitor to inspect field projections and mesh slice quality."
                        heading="No saved 2D visualizations"
                      />
                    ),
                  },
                ]
              : unifiedRows.map((row) => ({
                  type: "custom" as const,
                  label: row.name,
                  wide: true,
                  render: () => (
                    <div
                      className="flex flex-wrap items-center justify-between gap-2 rounded border border-fm-border px-2.5 py-1.5 text-xs"
                      data-slot="saved-slice-row"
                    >
                      <Button
                        className="h-auto min-w-0 flex-1 justify-start px-1 py-0.5 text-left"
                        type="button"
                        variant="ghost"
                        onClick={() => handleInspectRow(row)}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">
                            {row.name}
                          </span>
                          <span className="block text-fm-muted">
                            {row.subtitle}
                          </span>
                        </span>
                      </Button>
                      <div className="flex items-center gap-1.5">
                        <Button
                          aria-label={`Open ${row.name} in 2D view`}
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() => handleOpenRowIn2D(row)}
                        >
                          <Eye aria-hidden="true" size={13} />
                          <span>Open 2D</span>
                        </Button>
                        <Button
                          aria-label={`Inspect ${row.name}`}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => handleInspectRow(row)}
                        >
                          Inspect
                        </Button>
                        <Button
                          aria-label={`Remove ${row.name}`}
                          size="sm"
                          type="button"
                          variant="danger"
                          onClick={() => void handleRemoveRow(row)}
                        >
                          <Trash2 aria-hidden="true" size={13} />
                          <span>Remove</span>
                        </Button>
                      </div>
                    </div>
                  ),
                })),
        },
        ...(selectedElement
          ? [
              {
                id: "selected-element-overview",
                title: "Selected Element",
                icon: Crosshair,
                defaultOpen: true,
                rows: [
                  {
                    label: "Parent tet",
                    mono: true,
                    type: "readonly" as const,
                    format: () => String(selectedElement.parentElementId),
                  },
                  {
                    label: "Polygon",
                    mono: true,
                    type: "readonly" as const,
                    format: () =>
                      selectedElement.polygonIndex >= 0
                        ? String(selectedElement.polygonIndex)
                        : "Outside current slice",
                  },
                  {
                    label: "Quality",
                    mono: true,
                    type: "readonly" as const,
                    format: () =>
                      formatQualityMetricValue(selectedElement.quality),
                  },
                ],
              },
            ]
          : []),
      ],
      commitBar: {
        mode: "liveViewport",
        statusMessage: "Live · 3D slice gizmo and planar overlay sync immediately",
        hasOverrides: (draft) =>
          draft.showSliceGizmo !== false ||
          draft.showSliceMeshEdges !== true ||
          draft.showPlanarOverlay !== true ||
          (vizPlanar ? planarDisplayDiffersFromDefault(vizPlanar) : false),
        onResetDisplay: handleResetRootDisplay,
      },
    }),
    [
      gizmoVisibleInStore,
      handleInspectRow,
      handleOpenRowIn2D,
      handleRemoveRow,
      handleResetRootDisplay,
      handleStartNewDraft,
      mixedTopologyError,
      monitorsSceneRevision,
      removeError,
      selectedElement,
      unifiedRows,
      vizPlanar,
      workspaceDraft,
    ],
  );

  return (
    <SpecInspectorHost
      baseline={baseline}
      selection={selection}
      spec={spec}
      onAfterFieldChange={handleRootFieldChange}
    />
  );
}
