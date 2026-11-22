"use client";

import {
  Palette,
  Scissors,
  Sliders,
} from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";
import { useKernel } from "@/kernel/KernelContext";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  crossSectionWorkspaceStore,
  getCrossSectionWorkspaceServerSnapshot,
} from "@/kernel/workspace/crossSectionWorkspace";
import type { InspectorRowSpec, InspectorSectionSpec } from "../../template";
import {
  axisRangeForDraft,
  clampPositionMetres,
  defaultComponentForQuantity,
  dominantPlaneFromNormal,
  formatCrossSectionArea,
  formatIntegerCount,
  formatQualityMetricValue,
  getCompanionSliceMetaServerSnapshot,
  getCompanionSliceMetaSnapshot,
  inferQuantityFromComponent,
  NORMAL_MODE_OPTIONS,
  normalizeUnitVector,
  positionMetresFromPercent,
  positionPercentFromMetres,
  presetNormalForPlane,
  QUALITY_METRIC_OPTIONS,
  SAMPLE_GRID_OPTIONS,
  SLICE_COLORMAP_OPTIONS,
  SLICE_FIELD_COMPONENT_OPTIONS,
  SLICE_LENGTH_UNITS,
  SLICE_QUANTITY_OPTIONS,
  subscribeCompanionSliceMeta,
  type CompanionSliceMeta,
  type DomainAxisBounds,
  type ExtendedCrossSectionStatistics,
  type NormalPresetMode,
  type SliceFieldComponentId,
  type SliceFormDraft,
  type SliceQuantityKind,
} from "../../panels/cross-sections/visualizations2DModel";

export function useCrossSectionWorkspace() {
  return useSyncExternalStore(
    crossSectionWorkspaceStore.subscribe,
    crossSectionWorkspaceStore.getSnapshot,
    getCrossSectionWorkspaceServerSnapshot,
  );
}

export function useCompanionSliceMetaMap(): ReadonlyMap<string, CompanionSliceMeta> {
  return useSyncExternalStore(
    subscribeCompanionSliceMeta,
    getCompanionSliceMetaSnapshot,
    getCompanionSliceMetaServerSnapshot,
  );
}

export function useResolvedSessionScopeKey(): string | null {
  const kernel = useKernel();
  const identity = useSessionResourceIdentity();
  const fromIdentity = sessionRequestScopeKey(identity);
  const fromCommands = kernel?.commands?.getSessionScopeKey?.() ?? null;
  return fromIdentity ?? (typeof fromCommands === "string" ? fromCommands : null);
}

export function resolveSelectedElementIndex(selection: Selection): number | null {
  if (selection.ref?.type === "mesh-quality-element") {
    return selection.ref.elementIndex;
  }
  return null;
}

export function syncCoupledSliceFieldChange<K extends keyof SliceFormDraft & string>(
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

export function buildSharedAuthoringSections(
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
// 3. visualizations-2d.plot (+ redirected visualizations-2d.parameter, mesh.cross-section.plot)
// ═══════════════════════════════════════════════════════════════════════════

export function resolvePlotSelectionId(selection: Selection): string | null {
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

export function buildStatisticsRows(
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
