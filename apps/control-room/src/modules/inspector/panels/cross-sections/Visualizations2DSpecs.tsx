"use client";

import type { EChartsOption } from "echarts";
import {
  BarChart3,
  Compass,
  Copy,
  Crosshair,
  Eye,
  Layers,
  Palette,
  Plus,
  Scissors,
  Sliders,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
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
import {
  useCrossSectionQualityResource,
  useCrossSectionResource,
} from "@/kernel/resources/crossSectionResources";
import {
  useDomainMetaResource,
  useSceneResource,
  useVisualizationStateResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { usePlanarMonitorsResource } from "@/kernel/resources/planarMonitorResources";
import { resourceHasDisplayableData } from "@/kernel/resources/resourceState";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  activeCrossSectionPlot,
  beginCrossSectionDraft,
  beginCrossSectionDraftFromPlot,
  commitCrossSectionDraft,
  crossSectionWorkspaceStore,
  discardCrossSectionDraft,
  getCrossSectionWorkspaceServerSnapshot,
  isPlanarMonitorRevisionConflict,
  selectCrossSectionPlot,
  updateCrossSectionDraft,
  updateCrossSectionPlot,
  type CrossSectionDraft,
  type CrossSectionPlot,
  type PlanarMonitor,
} from "@/kernel/workspace/crossSectionWorkspace";
import {
  planarMonitorFramePreviewStore,
  usePlanarMonitorFramePreview,
} from "@/kernel/workspace/planarMonitorFramePreview";
import {
  ScientificEChart,
  type ResolvedChartThemePalette,
} from "@/shared/charts/ScientificEChart";
import { Button } from "@/shared/ui/Button";
import { EmptyState } from "@/shared/ui/EmptyState";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  type InspectorActionContext,
  type InspectorNotice,
  type InspectorRowSpec,
  type InspectorSectionSpec,
  type InspectorSpec,
} from "../../template";
import {
  defaultPlanarDisplayPatch,
  planarDisplayDiffersFromDefault,
} from "../../visualization/planarDisplayDefaults";
import { SpecInspectorHost } from "../mesh-details/SpecInspectorHost";

import {
  axisRangeForDraft,
  buildFramePreviewFor3DGizmo,
  buildPlanarMonitorCreatePayload,
  buildPlanarVisualizationPatch,
  buildRightHandedMonitorFrame,
  buildSliceDraftFromWorkspace,
  buildTargetOptions,
  clampPositionMetres,
  computeExtendedCrossSectionStatistics,
  defaultComponentForQuantity,
  deleteCompanionSliceMeta,
  dominantPlaneFromNormal,
  formatCrossSectionArea,
  formatIntegerCount,
  formatQualityMetricValue,
  getCompanionSliceMeta,
  getCompanionSliceMetaServerSnapshot,
  getCompanionSliceMetaSnapshot,
  inferQuantityFromComponent,
  isMixedTopologyUnsupportedError,
  NORMAL_MODE_OPTIONS,
  normalizeUnitVector,
  parseMonitorTarget,
  positionMetresFromPercent,
  positionPercentFromMetres,
  presetNormalForPlane,
  QUALITY_METRIC_OPTIONS,
  removeCrossSectionPlotById,
  resolveDomainBounds,
  resolvePlanarMonitorDeleteFn,
  resolveSelectedCrossSectionElement,
  SAMPLE_GRID_OPTIONS,
  serializeMonitorTarget,
  setCompanionSliceMeta,
  SLICE_COLORMAP_OPTIONS,
  SLICE_FIELD_COMPONENT_OPTIONS,
  SLICE_LENGTH_UNITS,
  SLICE_QUANTITY_OPTIONS,
  subscribeCompanionSliceMeta,
  toCompanionSliceMeta,
  toCrossSectionDraft,
  type CompanionSliceMeta,
  type DomainAxisBounds,
  type ExtendedCrossSectionStatistics,
  type NormalPresetMode,
  type PlanarMonitorsApiCompat,
  type SliceFieldComponentId,
  type SliceFormDraft,
  type SliceQuantityKind,
} from "./visualizations2DModel";

function useCrossSectionWorkspace() {
  return useSyncExternalStore(
    crossSectionWorkspaceStore.subscribe,
    crossSectionWorkspaceStore.getSnapshot,
    getCrossSectionWorkspaceServerSnapshot,
  );
}

function useCompanionSliceMetaMap(): ReadonlyMap<string, CompanionSliceMeta> {
  return useSyncExternalStore(
    subscribeCompanionSliceMeta,
    getCompanionSliceMetaSnapshot,
    getCompanionSliceMetaServerSnapshot,
  );
}

function useResolvedSessionScopeKey(): string | null {
  const kernel = useKernel();
  const identity = useSessionResourceIdentity();
  const fromIdentity = sessionRequestScopeKey(identity);
  const fromCommands = kernel?.commands?.getSessionScopeKey?.() ?? null;
  return fromIdentity ?? (typeof fromCommands === "string" ? fromCommands : null);
}

function resolveSelectedElementIndex(selection: Selection): number | null {
  if (selection.ref?.type === "mesh-quality-element") {
    return selection.ref.elementIndex;
  }
  return null;
}

function syncCoupledSliceFieldChange<K extends keyof SliceFormDraft & string>(
  key: K,
  value: SliceFormDraft[K],
  currentDraft: SliceFormDraft,
  bounds: DomainAxisBounds,
  patchDraft: (partial: Partial<SliceFormDraft>) => void,
): SliceFormDraft {
  let nextDraft: SliceFormDraft = { ...currentDraft, [key]: value };

  if (key === "normalMode") {
    const mode = value as NormalPresetMode;
    if (mode !== "custom") {
      const nextPosM = positionMetresFromPercent(
        currentDraft.positionPercent,
        bounds,
        mode,
      );
      const patch: Partial<SliceFormDraft> = {
        customNormal: presetNormalForPlane(mode),
        plane: mode,
        positionM: nextPosM,
      };
      patchDraft(patch);
      nextDraft = { ...nextDraft, ...patch };
    } else {
      const domPlane = dominantPlaneFromNormal(currentDraft.customNormal);
      patchDraft({ plane: domPlane });
      nextDraft = { ...nextDraft, plane: domPlane };
    }
  } else if (key === "customNormal") {
    const vec = value as readonly [number, number, number];
    const domPlane = dominantPlaneFromNormal(vec);
    patchDraft({ plane: domPlane });
    nextDraft = { ...nextDraft, plane: domPlane };
  } else if (key === "positionM") {
    const clampedM = clampPositionMetres(
      value as number,
      bounds,
      currentDraft.plane,
    );
    const pct = positionPercentFromMetres(clampedM, bounds, currentDraft.plane);
    patchDraft({ positionM: clampedM, positionPercent: pct });
    nextDraft = { ...nextDraft, positionM: clampedM, positionPercent: pct };
  } else if (key === "positionPercent") {
    const posM = positionMetresFromPercent(
      value as number,
      bounds,
      currentDraft.plane,
    );
    patchDraft({ positionM: posM });
    nextDraft = { ...nextDraft, positionM: posM };
  } else if (key === "quantity") {
    const q = value as SliceQuantityKind;
    if (q !== "mesh") {
      const nextComp = defaultComponentForQuantity(q);
      patchDraft({ fieldComponent: nextComp });
      nextDraft = { ...nextDraft, fieldComponent: nextComp };
    }
  } else if (key === "fieldComponent") {
    const comp = value as SliceFieldComponentId;
    const inferredQ = inferQuantityFromComponent(comp);
    if (currentDraft.quantity !== "mesh" && currentDraft.quantity !== inferredQ) {
      patchDraft({ quantity: inferredQ });
      nextDraft = { ...nextDraft, quantity: inferredQ };
    }
  }

  return nextDraft;
}

function buildSharedAuthoringSections(
  bounds: DomainAxisBounds,
  targetOptions: readonly { label: string; value: string }[],
  options: {
    modeTabId?: string;
    meshFooter?: () => ReactNode;
  } = {},
): readonly InspectorSectionSpec<SliceFormDraft>[] {
  const { modeTabId, meshFooter } = options;

  return [
    {
      id: "cut-plane-frame",
      title: "Cut Plane & Frame",
      icon: Scissors,
      ...(modeTabId ? { modeTabId } : {}),
      defaultOpen: true,
      summary: (d) =>
        `${d.normalMode === "custom" ? "Custom" : d.plane.toUpperCase()} · ${d.positionPercent.toFixed(1)}% · ${d.target === "domain" ? "Shared domain" : d.target}`,
      rows: [
        {
          key: "name",
          label: "Name",
          type: "text",
          placeholder: "Midplane slice",
          validate: (v) =>
            v.trim().length === 0 ? "Slice name is required." : null,
        },
        {
          key: "target",
          label: "Target",
          type: "select",
          options: targetOptions,
        },
        {
          key: "frameExtent",
          label: "Frame extent",
          type: "select",
          options: [
            { value: "universe", label: "Full computational universe" },
            { value: "magnetic_domain", label: "Magnetic support bounds" },
            { value: "object_bounds", label: "Target object bounds" },
          ],
        },
        {
          key: "normalMode",
          label: "Normal",
          type: "segmented",
          structural: true,
          options: NORMAL_MODE_OPTIONS,
        },
        {
          key: "customNormal",
          label: "Custom normal",
          type: "vector3",
          axisPresets: true,
          normalizeAction: true,
          showWhen: (d) => d.normalMode === "custom",
          validate: (vec) =>
            normalizeUnitVector(vec) === null
              ? "Normal vector must be non-zero."
              : null,
        },
        {
          key: "positionM",
          label: "Position",
          symbol: <>p</>,
          type: "quantity",
          units: SLICE_LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          scrub: "lin",
          hint: (() => {
            const zRange = axisRangeForDraft(bounds, "xy");
            return `Clamped to domain bounds (${(zRange.minM * 1e9).toFixed(1)} to ${(zRange.maxM * 1e9).toFixed(1)} nm on Z)`;
          })(),
          validate: (val, d) => {
            const { minM, maxM } = axisRangeForDraft(bounds, d.plane);
            if (!Number.isFinite(val)) return "Position must be finite.";
            if (val < minM - 1e-15 || val > maxM + 1e-15) {
              return `Position must lie within [${(minM * 1e9).toFixed(2)}, ${(maxM * 1e9).toFixed(2)}] nm.`;
            }
            return null;
          },
        },
        {
          key: "positionPercent",
          label: "Position (%)",
          type: "range",
          min: 0,
          max: 100,
          step: 0.5,
          unitSuffix: "%",
        },
        {
          key: "rotationDegrees",
          label: "In-plane rotation",
          symbol: <>&theta;</>,
          type: "range",
          min: -180,
          max: 180,
          step: 0.5,
          unitSuffix: "deg",
        },
      ],
    },
    {
      id: "field-and-colormap",
      title: "Quantity, Metric & Colormap",
      icon: Palette,
      ...(modeTabId ? { modeTabId } : {}),
      defaultOpen: true,
      summary: (d) =>
        `${d.quantity === "mesh" ? d.metric : d.fieldComponent} · ${d.colormap} · ${d.sampleGrid}×${d.sampleGrid}`,
      rows: [
        {
          key: "quantity",
          label: "Quantity",
          type: "segmented",
          structural: true,
          options: SLICE_QUANTITY_OPTIONS,
        },
        {
          key: "fieldComponent",
          label: "Component",
          type: "select",
          showWhen: (d) => d.quantity !== "mesh",
          options: SLICE_FIELD_COMPONENT_OPTIONS,
        },
        {
          key: "metric",
          label: "Quality metric",
          type: "select",
          options: QUALITY_METRIC_OPTIONS,
        },
        {
          key: "colormap",
          label: "Colormap",
          type: "select",
          options: SLICE_COLORMAP_OPTIONS,
        },
        {
          key: "rangeMode",
          label: "Value range",
          type: "segmented",
          structural: true,
          options: [
            { value: "auto", label: "Auto" },
            { value: "manual", label: "Manual" },
          ],
        },
        {
          key: "rangeMin",
          label: "Minimum value",
          type: "number",
          step: 0.1,
          scrub: "lin",
          showWhen: (d) => d.rangeMode === "manual",
        },
        {
          key: "rangeMax",
          label: "Maximum value",
          type: "number",
          step: 0.1,
          scrub: "lin",
          showWhen: (d) => d.rangeMode === "manual",
          validate: (maxVal, d) =>
            d.rangeMode === "manual" && maxVal <= d.rangeMin
              ? "Maximum value must exceed minimum value."
              : null,
        },
        {
          key: "sampleGrid",
          label: "Sample grid",
          type: "select",
          options: SAMPLE_GRID_OPTIONS,
        },
      ],
    },
    {
      id: "mesh-overlay-and-filter",
      title: "Mesh Overlay & Filter",
      icon: Sliders,
      ...(modeTabId ? { modeTabId } : {}),
      defaultOpen: true,
      ...(meshFooter ? { footer: meshFooter } : {}),
      summary: (d) =>
        `${d.includeWireframe ? `Edges ${d.edgeWidth} px` : "No edges"} · shrink ${d.shrinkFactor.toFixed(2)}`,
      rows: [
        {
          key: "includeWireframe",
          label: "Show mesh edges",
          type: "switch",
        },
        {
          key: "edgeWidth",
          label: "Edge width",
          type: "number",
          min: 0.5,
          max: 4,
          step: 0.25,
          unitSuffix: "px",
          scrub: "lin",
        },
        {
          key: "shrinkFactor",
          label: "Element shrink factor",
          type: "range",
          min: 0.5,
          max: 1,
          step: 0.05,
        },
        {
          key: "filterExpression",
          label: "Element filter",
          type: "expression",
          placeholder: "quality < 0.35 && z > 0",
        },
      ],
    },
  ];
}

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

// ═══════════════════════════════════════════════════════════════════════════
// 2. visualizations-2d.draft (+ redirected mesh.cross-section.draft)
// ═══════════════════════════════════════════════════════════════════════════

export function Visualizations2DDraftInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = useResolvedSessionScopeKey();
  const workspace = useCrossSectionWorkspace();
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
  const workspaceDraft = workspace.draft;

  const [revisionConflict, setRevisionConflict] = useState(false);

  useEffect(() => {
    if (!crossSectionWorkspaceStore.getSnapshot().draft) {
      beginCrossSectionDraft(vizData);
    }
  }, [vizData]);

  const bounds = useMemo(
    () => resolveDomainBounds(domainData),
    [domainData],
  );
  const targetOptions = useMemo(
    () => buildTargetOptions(sceneData),
    [sceneData],
  );

  const draftSessionKey = selection.nodeId ?? "draft";
  const [anchoredDraftState, setAnchoredDraftState] = useState<{
    companion: CompanionSliceMeta | undefined;
    sessionKey: string;
    source: CrossSectionDraft | null;
  }>(() => ({
    companion: getCompanionSliceMeta("draft"),
    sessionKey: draftSessionKey,
    source: workspaceDraft,
  }));

  if (
    anchoredDraftState.sessionKey !== draftSessionKey ||
    (anchoredDraftState.source === null && workspaceDraft !== null)
  ) {
    setAnchoredDraftState({
      companion: getCompanionSliceMeta("draft"),
      sessionKey: draftSessionKey,
      source: workspaceDraft,
    });
  }

  const anchoredSource = anchoredDraftState.source;
  const anchoredCompanion = anchoredDraftState.companion;

  const baseline = useMemo<SliceFormDraft>(
    () =>
      buildSliceDraftFromWorkspace(
        anchoredSource,
        anchoredCompanion,
        bounds,
        "Draft Cross-Section",
        "m",
      ),
    [anchoredCompanion, anchoredSource, bounds],
  );

  const syncLiveDraftPreview = useCallback(
    (nextDraft: SliceFormDraft) => {
      if (!crossSectionWorkspaceStore.getSnapshot().draft) {
        beginCrossSectionDraft(vizData);
      }
      updateCrossSectionDraft(toCrossSectionDraft(nextDraft));
      setCompanionSliceMeta("draft", toCompanionSliceMeta(nextDraft, null));
      planarMonitorFramePreviewStore.set(
        buildFramePreviewFor3DGizmo(nextDraft, bounds, "draft", true),
      );
    },
    [bounds, vizData],
  );

  const handleDraftFieldChange = useCallback(
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
      syncLiveDraftPreview(nextDraft);
    },
    [bounds, syncLiveDraftPreview],
  );

  const handleDiscardDraft = useCallback(() => {
    discardCrossSectionDraft();
    deleteCompanionSliceMeta("draft");
    planarMonitorFramePreviewStore.clear();
    kernel?.selection?.set?.(
      {
        kind: "visualizations-2d.root",
        label: "Visualizations 2D",
        nodeId: "model:visualizations-2d",
        objectId: null,
        ref: null,
      },
      "inspector",
    );
  }, [kernel]);

  const handleApplyDraft = useCallback(
    async (draft: SliceFormDraft): Promise<boolean> => {
      setRevisionConflict(false);
      const hasPlanarCreateApi =
        typeof kernel?.api?.model?.planarMonitors?.create === "function";

      if (hasPlanarCreateApi) {
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
          const fetchedDomain =
            typeof kernel.api.data?.domain?.meta === "function"
              ? await kernel.api.data.domain.meta({
                  sessionScopeKey: operationScopeKey,
                })
              : domainData;

          if (!isCurrentSessionScope()) return false;

          const effectiveBounds = resolveDomainBounds(fetchedDomain);
          const existingMonitors = monitorsList ?? [];

          const created = await runAuthoringMutationWithHistory(
            {
              api: kernel.api,
              authoringHistory: kernel.authoringHistory,
              isCurrentSessionScope,
              selection: kernel.selection,
              sessionScopeKey: operationScopeKey,
            },
            `Create planar monitor ${draft.name}`,
            async ({ baseRevision }) => {
              const commitRevision = baseRevision ?? monitorsSceneRevision;
              if (
                typeof commitRevision !== "number" ||
                !Number.isFinite(commitRevision)
              ) {
                throw new Error(
                  "The canonical scene revision is not ready. Reload current monitors before applying.",
                );
              }
              const request = buildPlanarMonitorCreatePayload(
                draft,
                commitRevision,
                effectiveBounds,
                existingMonitors,
              );
              return kernel.api.model.planarMonitors.create(request, {
                sessionScopeKey: operationScopeKey,
              });
            },
          );

          if (!isCurrentSessionScope()) return false;

          if (!crossSectionWorkspaceStore.getSnapshot().draft) {
            beginCrossSectionDraft(vizData);
          }
          updateCrossSectionDraft({
            ...toCrossSectionDraft(draft),
            name: created.monitor.name,
          });
          const committedPlot = commitCrossSectionDraft();
          deleteCompanionSliceMeta("draft");
          planarMonitorFramePreviewStore.clear();

          if (committedPlot) {
            setCompanionSliceMeta(
              committedPlot.id,
              toCompanionSliceMeta(draft, created.monitor.id),
            );
          }

          kernel.visualizationSync?.queuePatch({
            planar: buildPlanarVisualizationPatch(
              draft,
              created.monitor.id,
              vizPlanar,
            ),
          });
          kernel.resources?.invalidate(
            MODEL_PLANAR_MONITORS_PATH,
            created.scene_revision,
          );
          kernel.layout?.setActiveViewportMainModule?.("field-map");
          kernel.layout?.setFocusedSlot?.("viewport-main");
          kernel.layout?.setPanelVisible?.("right", true);

          if (committedPlot) {
            const nodeId = `model:visualizations-2d:${committedPlot.id}`;
            kernel.selection?.set?.(
              {
                kind: "visualizations-2d.plot",
                label: committedPlot.name,
                nodeId,
                objectId: null,
                ref: {
                  kind: "visualizations-2d.plot",
                  nodeId,
                  plotId: committedPlot.id,
                  type: "cross-section-plot",
                  visualizationTargetId: `cross-section:plot:${committedPlot.id}`,
                },
              },
              "inspector",
            );
          } else {
            const nodeId = `model:definitions:planar-monitors:${created.monitor.id}`;
            kernel.selection?.set?.(
              {
                kind: "model.planar.monitor",
                label: created.monitor.name,
                nodeId,
                objectId: null,
                ref: {
                  kind: "model.planar.monitor",
                  monitorId: created.monitor.id,
                  nodeId,
                  type: "planar-monitor",
                  visualizationTargetId: `planar-monitor:${created.monitor.id}`,
                },
              },
              "inspector",
            );
          }
          return true;
        } catch (error) {
          if (error instanceof SessionCommandCancelledError) {
            return false;
          }
          if (isPlanarMonitorRevisionConflict(error)) {
            setRevisionConflict(true);
            throw new Error(
              "The scene changed while this monitor draft was open. Reload the current revision before applying again.",
            );
          }
          throw error instanceof Error
            ? error
            : new Error("Planar monitor creation failed.");
        }
      }

      if (!crossSectionWorkspaceStore.getSnapshot().draft) {
        beginCrossSectionDraft(vizData);
      }
      updateCrossSectionDraft(toCrossSectionDraft(draft));
      const plot = commitCrossSectionDraft();
      deleteCompanionSliceMeta("draft");
      planarMonitorFramePreviewStore.clear();
      if (plot) {
        setCompanionSliceMeta(plot.id, toCompanionSliceMeta(draft, null));
        kernel?.visualizationSync?.queuePatch({
          planar: buildPlanarVisualizationPatch(draft, null, vizPlanar),
        });
        const nodeId = `model:visualizations-2d:${plot.id}`;
        kernel?.selection?.set?.(
          {
            kind: "visualizations-2d.plot",
            label: plot.name,
            nodeId,
            objectId: null,
            ref: {
              kind: "visualizations-2d.plot",
              nodeId,
              plotId: plot.id,
              type: "cross-section-plot",
              visualizationTargetId: `cross-section:plot:${plot.id}`,
            },
          },
          "inspector",
        );
      }
      return Boolean(plot);
    },
    [
      domainData,
      kernel,
      monitorsList,
      monitorsSceneRevision,
      sessionScopeKey,
      vizData,
      vizPlanar,
    ],
  );

  const authoringSections = useMemo(
    () => buildSharedAuthoringSections(bounds, targetOptions),
    [bounds, targetOptions],
  );

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
          { id: "draft", label: "Draft" },
        ],
        primaryHeaderAction: {
          label: "Discard Draft",
          icon: Trash2,
          variant: "secondary",
          onRun: handleDiscardDraft,
        },
      },
      identity: {
        domain: "visualization",
        icon: Scissors,
        title: (d) => d.name || "Draft Cross-Section",
        renameFieldKey: "name",
        kindLabel: "Unsaved 2D cross-section draft",
        entityId: "cross-section:draft",
        statePill: () =>
          revisionConflict
            ? { tone: "err", label: "Revision conflict" }
            : { tone: "warn", label: "Draft" },
      },
      facts: (d) => [
        {
          id: "normal",
          label: "Normal",
          value: d.normalMode === "custom" ? "Custom" : d.plane.toUpperCase(),
        },
        {
          id: "pos",
          label: "Position",
          value: `${(d.positionM * 1e9).toFixed(1)} nm (${d.positionPercent.toFixed(1)}%)`,
        },
        {
          id: "qty",
          label: "Field / Metric",
          value: d.quantity === "mesh" ? d.metric : d.fieldComponent,
        },
        {
          id: "grid",
          label: "Sample grid",
          value: `${d.sampleGrid} × ${d.sampleGrid}`,
        },
      ],
      notices: () =>
        revisionConflict
          ? [
              {
                id: "revision-conflict",
                tone: "warn",
                title: "Scene revision conflict",
                text: "The scene changed while this monitor draft was open. Reload the current revision before applying again.",
                quickFix: {
                  label: "Reload current monitors",
                  onApply: () => {
                    setRevisionConflict(false);
                    refetchMonitors?.();
                  },
                },
              },
            ]
          : [],
      sections: authoringSections,
      commitBar: {
        mode: "staged",
        allowCleanApply: true,
        applyLabel: "Apply monitor",
        cleanMessage: () => "Ready to create planar monitor and 2D slice",
        onApply: handleApplyDraft,
        onRevert: (base) => {
          setRevisionConflict(false);
          syncLiveDraftPreview(base);
        },
      },
    }),
    [
      authoringSections,
      handleApplyDraft,
      handleDiscardDraft,
      refetchMonitors,
      revisionConflict,
      syncLiveDraftPreview,
    ],
  );

  return (
    <SpecInspectorHost
      baseline={baseline}
      selection={selection}
      spec={spec}
      onAfterFieldChange={handleDraftFieldChange}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. visualizations-2d.plot (+ redirected visualizations-2d.parameter, mesh.cross-section.plot)
// ═══════════════════════════════════════════════════════════════════════════

function resolvePlotSelectionId(selection: Selection): string | null {
  const ref = selection.ref as {
    plotId?: unknown;
    crossSectionPlotId?: unknown;
  } | null;

  if (typeof ref?.plotId === "string" && ref.plotId.trim().length > 0) {
    return ref.plotId.trim();
  }
  if (
    typeof ref?.crossSectionPlotId === "string" &&
    ref.crossSectionPlotId.trim().length > 0
  ) {
    return ref.crossSectionPlotId.trim();
  }
  if (selection.nodeId?.startsWith("model:visualizations-2d:")) {
    const suffix = selection.nodeId
      .slice("model:visualizations-2d:".length)
      .trim();
    if (suffix && suffix !== "draft") {
      return suffix;
    }
  }
  return null;
}

function buildStatisticsRows(
  stats: ExtendedCrossSectionStatistics | null,
  mixedUnsupported: boolean,
  loading: boolean,
): readonly InspectorRowSpec<SliceFormDraft>[] {
  if (mixedUnsupported) {
    return [
      {
        label: "Current support",
        mono: true,
        type: "readonly",
        format: () => "tet4-only",
      },
      {
        label: "Requested mesh",
        mono: true,
        type: "readonly",
        format: () => "mixed prism / pyramid / tet",
      },
      {
        label: "Fallback",
        mono: true,
        type: "readonly",
        format: () => "disabled",
      },
    ];
  }

  if (!stats) {
    return [
      {
        label: "Slice status",
        type: "readonly",
        format: () =>
          loading
            ? "Loading cross-section geometry…"
            : "No FEM cross-section mesh published for this slice",
      },
    ];
  }

  return [
    {
      label: "Intersected elements",
      mono: true,
      type: "readonly",
      format: () => formatIntegerCount(stats.qualityStats.polygonCount),
    },
    {
      label: "Polygons",
      mono: true,
      type: "readonly",
      format: () => formatIntegerCount(stats.qualityStats.visiblePolygonCount),
    },
    {
      label: "Triangles",
      mono: true,
      type: "readonly",
      format: () => formatIntegerCount(stats.triangleCount),
    },
    {
      label: "Quads",
      mono: true,
      type: "readonly",
      format: () => formatIntegerCount(stats.quadCount),
    },
    {
      label: "Area",
      mono: true,
      type: "readonly",
      format: () => formatCrossSectionArea(stats.areaM2),
    },
    {
      label: "Mesh nodes on plane",
      mono: true,
      type: "readonly",
      format: () => formatIntegerCount(stats.intersectionStats.meshNodeCount),
    },
    {
      label: "Edge-plane intersections",
      mono: true,
      type: "readonly",
      format: () =>
        formatIntegerCount(stats.intersectionStats.edgeIntersectionCount),
    },
    {
      label: "Intersection points",
      mono: true,
      type: "readonly",
      format: () => formatIntegerCount(stats.intersectionStats.totalPointCount),
    },
    {
      label: "Min",
      mono: true,
      type: "readonly",
      format: () => formatQualityMetricValue(stats.qualityStats.min),
    },
    {
      label: "P5",
      mono: true,
      type: "readonly",
      format: () => formatQualityMetricValue(stats.qualityStats.p05),
    },
    {
      label: "Median",
      mono: true,
      type: "readonly",
      format: () => formatQualityMetricValue(stats.median),
    },
    {
      label: "Mean",
      mono: true,
      type: "readonly",
      format: () => formatQualityMetricValue(stats.qualityStats.mean),
    },
    {
      label: "Std dev",
      mono: true,
      type: "readonly",
      format: () => formatQualityMetricValue(stats.stdDev),
    },
    {
      label: "Max",
      mono: true,
      type: "readonly",
      format: () => formatQualityMetricValue(stats.qualityStats.max),
    },
    {
      label: "Below threshold (< 0.10)",
      mono: true,
      type: "readonly",
      format: () =>
        stats.qualityStats.belowThresholdCount === null
          ? "—"
          : formatIntegerCount(stats.qualityStats.belowThresholdCount),
    },
  ];
}

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
