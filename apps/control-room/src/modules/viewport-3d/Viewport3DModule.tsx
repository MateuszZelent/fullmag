"use client";

import { useThree } from "@react-three/fiber";
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useMemo,
  memo,
  type ComponentProps,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type {
  VisualizationStatePatch,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import {
  quantityUnitForColorbar,
  resolveCanonicalQuantityId,
} from "@/kernel/api/quantityIds";
import { viewport3DOrbitDebugEnabledFromBrowserConfig } from "@/kernel/browserFullmagConfig";
import type { MeshSizeHistogramHighlight } from "@/kernel/events/eventTypes";
import { useMeshHistogramBinElementsResource } from "@/kernel/resources/geometryLifecycleResources";
import {
  selectionSnapshotEquals,
  useSelectionActions,
  useSelectionSelector,
} from "@/kernel/selection/useSelection";
import {
  resolveSemanticTargetForMeshPart,
  type SemanticRenderTargetCatalog,
} from "@/kernel/selection/semanticRenderTargetCatalog";
import { WorkspaceRenderProfiler } from "@/kernel/performance/reactRenderProfiler";
import type { ModuleProps } from "@/kernel/types";
import {
  surfaceColorSourceToColorMode,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
import {
  useVisualizationClientAck,
  useVisualizationClientAckSender,
} from "@/kernel/visualization/useVisualizationClientAck";
import { Button } from "@/shared/ui/Button";
import {
  displayUnitItemsForSourceUnit,
  formatDisplayUnitValue,
  formatValueWithDisplayUnit,
  hasDisplayUnitOptions,
  normalizeDisplayUnit,
} from "@/shared/domain/physics/displayUnits";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

import { useViewport3DColors } from "./hooks/useViewport3DColors";
import {
  useViewport3DSceneModel,
  type Viewport3DFieldDataIssue,
} from "./hooks/useViewport3DSceneModel";
import {
  resolveViewport3DCameraFit,
  normalizeViewport3DOrbitDebugAngles,
  shouldApplyViewport3DOrbitDebugAngles,
  type Viewport3DCameraChange,
  type Viewport3DOrbitDebugAngles,
  VIEWPORT_3D_WORLD_UP,
  VIEWPORT_3D_ORBIT_DEBUG_LIMITS,
} from "./layers/CameraControls";
import { Viewport3DScene } from "./layers/Viewport3DScene";
import { resolveViewport3DTargetSurfaceLayerInput } from "./layers/viewport3DLayerPassInputs";
import type { RegionOverlaySelection } from "./layers/RegionOverlayLayer";
import type { RegionOverlayMode } from "./regionOverlayMode";
import { Viewport3DCameraDialog } from "./components/Viewport3DCameraDialog";
import { Viewport3DSettingsDialog } from "./components/Viewport3DSettingsDialog";
import { Viewport3DCanvas } from "./Viewport3DCanvas";
import {
  type Viewport3DPartSelection,
} from "./viewport3dDomainAdapter";
import type {
  HysteresisReplayGlyphModel,
  HysteresisStepViewportTarget,
} from "./model/viewport3DTargets";
import {
  buildViewport3DTargetRenderPlan,
  type Viewport3DTargetRenderPlan,
} from "./model/viewport3DFieldDataPlan";
import {
  planViewport3DColorbars,
  resolveViewport3DColorbarRangeStates,
  scalarColorBufferMatchesColorbarRequest,
  type Viewport3DColorbarPlan,
} from "./model/viewport3DColorbarPlan";
export { resolveViewport3DColorbarRangeStates } from "./model/viewport3DColorbarPlan";
import {
  useViewport3DResourceCounts,
  useViewport3DResourceTracker,
} from "./viewport3dDiagnostics";
import { useViewport3DWorkerRuntime } from "./viewport3dWorkerRuntime";
import { createViewport3DEventManager } from "./viewport3dEventManager";
import { retainViewport3DMeshSizeHighlight } from "./viewport3dMeshSizeHighlight";
import {
  formatViewport3DInspectComponents,
  type Viewport3DInspectSample,
  type Viewport3DInspectScreenPosition,
} from "./viewport3dInspect";
import {
  type Viewport3DPrimitiveObject,
} from "./viewport3dPrimitiveModel";
import { toCameraTuple } from "./viewport3dCameraModel";
import {
  viewportSelectionForMeshPart,
  viewportSelectionForDomain,
  viewportSelectionForObject,
  viewportSelectionForRegion,
} from "./viewport3dSelection";
import {
  EMPTY_VIEWPORT_3D_REFRESH_SAMPLE,
  resolveViewport3DRefreshCountdownDisplay,
  resolveViewport3DRefreshCountdownNextTickDelay,
  updateViewport3DRefreshSample,
  type Viewport3DFieldRefreshState,
} from "./viewport3dRefreshCountdown";
import {
  DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  viewport3dStore,
  useViewport3DCommandState,
} from "./viewport3dStore";
import type { MeshQualityColorMetric } from "./viewport3dQualityMapping";
import { VIEWPORT_3D_FRAMELOOP } from "./viewport3dTypes";
import { viewport3DColorPaletteGradientCss } from "./viewport3dVectorColoring";
import {
  configureViewport3DRenderer,
  getViewport3DVisualProfile,
  resolveViewport3DCanvasDpr,
  type Viewport3DVisualProfile,
} from "./viewport3dVisualProfile";
import {
  beginViewport3DFieldUpdateHold,
  endViewport3DFieldUpdateHold,
} from "./viewport3dFieldUpdateHold";
import type { ScalarColorBuffer } from "./viewport3dFieldMapping";
import { installViewport3DThreeConsolePolicy } from "./viewport3dThreeConsolePolicy";

type Viewport3DSceneProps = ComponentProps<typeof Viewport3DScene>;
type Viewport3DCanvasCreatedState = Parameters<
  NonNullable<ComponentProps<typeof Viewport3DCanvas>["onCreated"]>
>[0];

const VIEWPORT_3D_CANVAS_GL_NO_ANTIALIAS = {
  alpha: false,
  antialias: false,
  powerPreference: "high-performance" as const,
  preserveDrawingBuffer: false,
};

const VIEWPORT_3D_CANVAS_GL_ANTIALIAS = {
  alpha: false,
  antialias: true,
  powerPreference: "high-performance" as const,
  preserveDrawingBuffer: false,
};

const VIEWPORT_3D_CANVAS_GL_CAPTURE = {
  alpha: false,
  antialias: true,
  powerPreference: "high-performance" as const,
  preserveDrawingBuffer: true,
};

interface Viewport3DPointerHoldEventTarget {
  addEventListener(
    type: "pointerup" | "pointercancel",
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: "pointerup" | "pointercancel",
    listener: EventListener,
    options?: boolean | EventListenerOptions,
  ): void;
}

export interface Viewport3DPointerHoldLifecycle {
  begin(pointerId: number): void;
  dispose(): void;
  end(pointerId: number): void;
}

export function createViewport3DPointerHoldLifecycle({
  onBegin,
  onEnd,
  target,
}: {
  onBegin: () => void;
  onEnd: () => void;
  target: Viewport3DPointerHoldEventTarget;
}): Viewport3DPointerHoldLifecycle {
  const activePointerIds = new Set<number>();
  let terminalListenersInstalled = false;
  const removeTerminalListeners = () => {
    if (!terminalListenersInstalled) return;
    terminalListenersInstalled = false;
    target.removeEventListener("pointerup", handleTerminalEvent, true);
    target.removeEventListener("pointercancel", handleTerminalEvent, true);
  };
  const end = (pointerId: number) => {
    if (!activePointerIds.delete(pointerId) || activePointerIds.size > 0) return;
    removeTerminalListeners();
    onEnd();
  };
  const handleTerminalEvent: EventListener = (event) => {
    const pointerId = (event as PointerEvent).pointerId;
    if (Number.isInteger(pointerId)) end(pointerId);
  };

  return {
    begin(pointerId) {
      if (activePointerIds.has(pointerId)) return;
      const wasEmpty = activePointerIds.size === 0;
      activePointerIds.add(pointerId);
      if (!wasEmpty) return;
      onBegin();
      target.addEventListener("pointerup", handleTerminalEvent, true);
      target.addEventListener("pointercancel", handleTerminalEvent, true);
      terminalListenersInstalled = true;
    },
    dispose() {
      if (activePointerIds.size === 0) return;
      activePointerIds.clear();
      removeTerminalListeners();
      onEnd();
    },
    end,
  };
}

installViewport3DThreeConsolePolicy();

interface MeshQualityRange {
  max: number;
  min: number;
}

interface Viewport3DColorbarLegendInput {
  colorMode: string;
  colorPalette?: string | null;
  displayUnit?: string | null;
  quantityId: string;
  range: MeshQualityRange | null;
  unit?: string | null;
}

interface Viewport3DColorbarLegend {
  colorMode?: string;
  displayUnit?: string;
  label: string;
  labelPrefix?: string;
  maxLabel: string;
  minLabel: string;
  paletteGradient: string;
  quantityId?: string;
  range?: MeshQualityRange | null;
  sourceUnit?: string | null;
}

interface Viewport3DScopedColorbarLegend {
  key: string;
  legend: Viewport3DColorbarLegend;
}

interface Viewport3DColorbarTargetPart {
  id: string;
  label: string;
  role?: string | null;
  settings: VisualizationTargetSettings;
  targetKind: Viewport3DTargetRenderPlan["targetKind"];
}

interface Viewport3DInspectHover {
  inspectRevision: number;
  sample: Viewport3DInspectSample;
  screenPosition: Viewport3DInspectScreenPosition;
}

export function notifyMeshTopologyRendered({
  bus,
  lastRevision,
  meshRevision,
  rendererId,
}: {
  bus: Pick<ModuleProps["kernel"]["bus"], "emit">;
  lastRevision: { current: number | string | null };
  meshRevision: number | string | null;
  rendererId: string;
}) {
  if (meshRevision === null || lastRevision.current === meshRevision) return;
  lastRevision.current = meshRevision;
  bus.emit("mesh:topology-rendered", { meshRevision, rendererId });
}

function formatLegendValue(value: number): string {
  return formatDisplayUnitValue(value);
}

function resolveStableViewport3DCanvasGlOptions(
  profile: Viewport3DVisualProfile,
) {
  if (profile.preserveDrawingBuffer) {
    return VIEWPORT_3D_CANVAS_GL_CAPTURE;
  }
  return profile.antialias
    ? VIEWPORT_3D_CANVAS_GL_ANTIALIAS
    : VIEWPORT_3D_CANVAS_GL_NO_ANTIALIAS;
}

function formatViewport3DColorbarQuantityLabel({
  colorMode,
  quantityId,
  unit,
}: {
  colorMode: string;
  quantityId: string;
  unit?: string | null;
}): string {
  const component =
    colorMode === "x" || colorMode === "y" || colorMode === "z"
      ? ` ${colorMode}`
      : "";
  const unitLabel = unit?.trim() ? ` [${unit.trim()}]` : "";
  return `${quantityId}${component}${unitLabel}`;
}

export function resolveViewport3DMeshQualityLegend(
  visible: boolean,
  metric: MeshQualityColorMetric,
  range: MeshQualityRange | null,
): string | null {
  if (!visible || !range) return null;
  const metricLabel = metric === "sicn" ? "SICN" : metric;
  return `Mesh quality ${metricLabel} ${formatLegendValue(range.min)} to ${formatLegendValue(range.max)}`;
}

export function resolveViewport3DColorbarLegend({
  colorMode,
  colorPalette,
  displayUnit,
  quantityId,
  range,
  unit,
}: Viewport3DColorbarLegendInput): Viewport3DColorbarLegend | null {
  const normalizedMode = colorMode.trim().toLowerCase();
  if (
    normalizedMode === "orientation" ||
    normalizedMode === "hsl_sphere" ||
    normalizedMode === "hsl" ||
    normalizedMode === "monochrome" ||
    !range ||
    !Number.isFinite(range.min) ||
    !Number.isFinite(range.max)
  ) {
    return null;
  }

  const resolvedDisplayUnit = normalizeDisplayUnit(unit, displayUnit);
  const labelUnit = resolvedDisplayUnit || unit;
  return {
    colorMode: normalizedMode,
    displayUnit: resolvedDisplayUnit,
    label: formatViewport3DColorbarQuantityLabel({
      colorMode: normalizedMode,
      quantityId,
      unit: labelUnit,
    }),
    labelPrefix: "",
    maxLabel: formatValueWithDisplayUnit(range.max, unit, resolvedDisplayUnit),
    minLabel: formatValueWithDisplayUnit(range.min, unit, resolvedDisplayUnit),
    paletteGradient: viewport3DColorPaletteGradientCss(colorPalette),
    quantityId,
    range,
    sourceUnit: unit?.trim() || null,
  };
}

function resolveViewport3DColorbarLegendFromPlan({
  labelByTargetId,
  plan,
}: {
  labelByTargetId: ReadonlyMap<string, string>;
  plan: Viewport3DColorbarPlan;
}): Viewport3DScopedColorbarLegend {
  const unit = quantityUnitForColorbar(plan.quantityId);
  const displayUnit = normalizeDisplayUnit(unit, null);
  const labelUnit = displayUnit || unit;
  const quantityLabel = formatViewport3DColorbarQuantityLabel({
    colorMode: plan.colorMode,
    quantityId: plan.quantityId,
    unit: labelUnit,
  });
  const targetLabels: string[] = [];
  const seenTargetLabels = new Set<string>();
  for (const targetId of plan.targetIds) {
    const label = labelByTargetId.get(targetId) ?? targetId;
    if (seenTargetLabels.has(label)) continue;
    seenTargetLabels.add(label);
    targetLabels.push(label);
  }
  const labelPrefix =
    targetLabels.length === 1
      ? `${targetLabels[0]}: `
      : targetLabels.length > 1
        ? `${targetLabels.length} targets: `
        : "";
  return {
    key: plan.renderKey,
    legend: {
      colorMode: plan.colorMode,
      displayUnit,
      label: `${labelPrefix}${quantityLabel}`,
      labelPrefix,
      maxLabel: plan.range
        ? formatValueWithDisplayUnit(plan.range.max, unit, displayUnit)
        : "pending",
      minLabel: plan.range
        ? formatValueWithDisplayUnit(plan.range.min, unit, displayUnit)
        : "pending",
      paletteGradient: viewport3DColorPaletteGradientCss(plan.palette),
      quantityId: plan.quantityId,
      range: plan.range,
      sourceUnit: unit || null,
    },
  };
}

interface Viewport3DScalarColorbarLegendInput {
  colorPalette: string;
  fdmSurfaceColors?: ScalarColorBuffer | null;
  fdmSettings?: Pick<
    Viewport3DSceneProps["fdmSettings"],
    "activeQuantityId" | "scalarColorPalette" | "viewportColorbarVisible"
  > | null;
  fieldModel?: Pick<
    NonNullable<Viewport3DSceneProps["fieldModel"]>,
    "scalarColors" | "scalarColorsByMode" | "scalarColorsByPartAndMode"
  > &
    Partial<Pick<NonNullable<Viewport3DSceneProps["fieldModel"]>, "targetPasses">>
    | null;
  parts?: ReadonlyArray<{
    id: string;
    label: string;
    settings: Pick<
      Viewport3DSceneProps["fallbackSettings"],
      | "activeQuantityId"
      | "shaderVisible"
      | "surfaceColorSource"
      | "surfaceProjectionMode"
      | "viewportColorbarVisible"
      | "visible"
    > & {
      scalarColorPalette?: string | null;
    };
  }>;
  quantityId: string;
  surfaceColorMode: string | null;
  unit?: string | null;
  vectorColorMode: string;
}

function scalarColorRangeKey(buffer: ScalarColorBuffer): string {
  return `${buffer.range.min}:${buffer.range.max}`;
}

export function resolveViewport3DScalarColorbarLegend({
  colorPalette,
  fdmSurfaceColors,
  fieldModel,
  quantityId,
  surfaceColorMode,
  unit,
  vectorColorMode,
}: Viewport3DScalarColorbarLegendInput): Viewport3DColorbarLegend | null {
  if (fdmSurfaceColors) {
    return resolveViewport3DColorbarLegend({
      colorMode: surfaceColorMode ?? vectorColorMode,
      colorPalette: fdmSurfaceColors.colorPalette ?? colorPalette,
      quantityId,
      range: fdmSurfaceColors.range,
      unit,
    });
  }

  const partBuffers: Array<{ buffer: ScalarColorBuffer; mode: string }> = [];
  for (const partModes of fieldModel?.scalarColorsByPartAndMode.values() ?? []) {
    for (const [mode, buffer] of partModes) {
      if (buffer) partBuffers.push({ buffer, mode });
    }
  }

  if (partBuffers.length > 0) {
    const first = partBuffers[0];
    if (
      !first ||
      partBuffers.some(
        ({ buffer, mode }) =>
          mode !== first.mode ||
          (buffer.colorPalette ?? colorPalette) !==
            (first.buffer.colorPalette ?? colorPalette) ||
          scalarColorRangeKey(buffer) !== scalarColorRangeKey(first.buffer),
      )
    ) {
      return null;
    }

    return resolveViewport3DColorbarLegend({
      colorMode: first.mode,
      colorPalette: first.buffer.colorPalette ?? colorPalette,
      quantityId,
      range: first.buffer.range,
      unit,
    });
  }

  const colorMode = surfaceColorMode ?? vectorColorMode;
  const colors =
    (surfaceColorMode
      ? fieldModel?.scalarColorsByMode.get(surfaceColorMode)
      : null) ??
    fieldModel?.scalarColorsByMode.get(vectorColorMode) ??
    fieldModel?.scalarColors ??
    null;
  return resolveViewport3DColorbarLegend({
    colorMode,
    colorPalette: colors?.colorPalette ?? colorPalette,
    quantityId,
    range: colors?.range ?? null,
    unit,
  });
}

function resolveViewport3DTargetColorbarLegend({
  colorMode,
  colorPalette,
  quantityId,
  range,
  unit,
}: Viewport3DColorbarLegendInput): Viewport3DColorbarLegend | null {
  const legend = resolveViewport3DColorbarLegend({
    colorMode,
    colorPalette,
    quantityId,
    range,
    unit,
  });
  if (legend) return legend;

  const normalizedMode = colorMode.trim().toLowerCase();
  if (
    normalizedMode === "orientation" ||
    normalizedMode === "hsl_sphere" ||
    normalizedMode === "hsl" ||
    normalizedMode === "monochrome"
  ) {
    return null;
  }

  return {
    label: formatViewport3DColorbarQuantityLabel({
      colorMode: normalizedMode,
      quantityId,
      unit,
    }),
    maxLabel: "pending",
    minLabel: "pending",
    paletteGradient: viewport3DColorPaletteGradientCss(colorPalette),
  };
}

export function buildViewport3DColorbarTargetPlans({
  fdmSettings,
  parts,
}: {
  fdmSettings?: VisualizationTargetSettings | null;
  parts: readonly Viewport3DColorbarTargetPart[];
}): Viewport3DTargetRenderPlan[] {
  const targets: Viewport3DTargetRenderPlan[] = [];
  for (const part of parts) {
    if (!isViewport3DColorbarTargetPartEligible(part)) continue;
    targets.push(
      buildViewport3DTargetRenderPlan({
        label: part.label,
        quantityId: part.settings.activeQuantityId,
        settings: part.settings,
        targetId: part.id,
        targetKind: part.targetKind,
      }),
    );
  }
  if (fdmSettings) {
    targets.push(
      buildViewport3DTargetRenderPlan({
        label: "FDM domain",
        quantityId: fdmSettings.activeQuantityId,
        settings: fdmSettings,
        targetId: "fdm",
        targetKind: "fdm-domain",
      }),
    );
  }
  return targets;
}

function isViewport3DColorbarTargetPartEligible(
  part: Viewport3DColorbarTargetPart,
): boolean {
  return part.role !== "air" && part.role !== "interface";
}

export function resolveViewport3DColorbarLegendsFromPlans({
  labelByTargetId,
  plans,
}: {
  labelByTargetId: ReadonlyMap<string, string>;
  plans: readonly Viewport3DColorbarPlan[];
}): Viewport3DScopedColorbarLegend[] {
  return plans.map((plan) =>
    resolveViewport3DColorbarLegendFromPlan({ labelByTargetId, plan }),
  );
}

export function resolveViewport3DScalarColorbarLegends({
  colorPalette,
  fdmSettings,
  fdmSurfaceColors,
  fieldModel,
  parts,
  surfaceColorMode,
  vectorColorMode,
}: Viewport3DScalarColorbarLegendInput): Viewport3DScopedColorbarLegend[] {
  if (fdmSurfaceColors && fdmSettings?.viewportColorbarVisible) {
    const legend = resolveViewport3DColorbarLegend({
      colorMode: surfaceColorMode ?? vectorColorMode,
      colorPalette: fdmSurfaceColors.colorPalette ?? fdmSettings.scalarColorPalette,
      quantityId: fdmSettings.activeQuantityId,
      range: fdmSurfaceColors.range,
      unit: quantityUnitForColorbar(fdmSettings.activeQuantityId),
    });
    return legend ? [{ key: "fdm", legend }] : [];
  }

  const legends: Viewport3DScopedColorbarLegend[] = [];
  const emitted = new Set<string>();
  for (const part of parts ?? []) {
    const settings = part.settings;
    if (
      !settings.viewportColorbarVisible ||
      !settings.visible ||
      !settings.shaderVisible
    ) {
      continue;
    }
    const colorMode = surfaceColorSourceToColorMode(settings.surfaceColorSource);
    if (!colorMode) continue;
    const palette = settings.scalarColorPalette ?? colorPalette;
    const targetBuffer = resolveViewport3DTargetSurfaceLayerInput({
      fieldModel: fieldModel ?? null,
      partId: part.id,
      scalarColorMode: colorMode,
    }).scalarColors;
    const buffer = scalarColorBufferMatchesColorbarRequest({
      buffer: targetBuffer,
      colorMode,
      colorPalette: palette,
      quantityId: settings.activeQuantityId,
    })
      ? targetBuffer
      : null;
    const legend = resolveViewport3DTargetColorbarLegend({
      colorMode,
      colorPalette: buffer?.colorPalette ?? palette,
      quantityId: settings.activeQuantityId,
      range: buffer?.range ?? null,
      unit: quantityUnitForColorbar(settings.activeQuantityId),
    });
    if (!legend) continue;
    const scopedLegend = {
      ...legend,
      label: `${part.label}: ${legend.label}`,
    };
    const key = viewport3DScalarColorbarLegendKey({
      colorMode,
      palette,
      projectionMode: settings.surfaceProjectionMode,
      quantityId: settings.activeQuantityId,
      targetId: part.id,
    });
    if (emitted.has(key)) continue;
    emitted.add(key);
    legends.push({ key, legend: scopedLegend });
  }

  return legends;
}

export function resolveRetainedViewport3DScalarColorbarLegends({
  current,
  previous,
  requested,
  requestedGroupKeys,
}: {
  current: readonly Viewport3DScopedColorbarLegend[];
  previous: readonly Viewport3DScopedColorbarLegend[];
  requested: boolean;
  requestedGroupKeys?: ReadonlySet<string>;
}): readonly Viewport3DScopedColorbarLegend[] {
  if (!requested) return [];
  const retainablePrevious = requestedGroupKeys
    ? previous.filter((entry) =>
        requestedGroupKeys.has(viewport3DColorbarRetentionGroupKey(entry.key)),
      )
    : previous;
  if (current.length === 0) return retainablePrevious;
  if (retainablePrevious.length === 0) return current;
  const retained = new Map(retainablePrevious.map((entry) => [entry.key, entry]));
  const retainedGroups = new Map(
    retainablePrevious.map((entry) => [
      viewport3DColorbarRetentionGroupKey(entry.key),
      entry.key,
    ]),
  );
  for (const entry of current) {
    const groupKey = viewport3DColorbarRetentionGroupKey(entry.key);
    const retainedKey = retainedGroups.get(groupKey);
    if (retainedKey && retainedKey !== entry.key) {
      retained.delete(retainedKey);
    }
    retainedGroups.set(groupKey, entry.key);
    retained.set(entry.key, entry);
  }
  return Array.from(retained.values());
}

export function resolveViewport3DRequestedColorbarGroupKeys(
  parts: readonly NonNullable<Viewport3DScalarColorbarLegendInput["parts"]>[number][],
  colorPalette: string,
  { fdmColorbarRequested = false }: { fdmColorbarRequested?: boolean } = {},
): ReadonlySet<string> {
  const keys = new Set<string>();
  if (fdmColorbarRequested) {
    keys.add(viewport3DColorbarRetentionGroupKey("fdm"));
  }
  for (const part of parts) {
    const settings = part.settings;
    if (
      !settings.viewportColorbarVisible ||
      !settings.visible ||
      !settings.shaderVisible
    ) {
      continue;
    }
    const colorMode = surfaceColorSourceToColorMode(settings.surfaceColorSource);
    if (!colorMode) continue;
    keys.add(
      viewport3DColorbarRetentionGroupKey(
        viewport3DScalarColorbarLegendKey({
          colorMode,
          palette: settings.scalarColorPalette ?? colorPalette,
          projectionMode: settings.surfaceProjectionMode,
          quantityId: settings.activeQuantityId,
          targetId: part.id,
        }),
      ),
    );
  }
  return keys;
}

export function shouldClearRetainedViewport3DScalarColorbarLegends({
  fdmColorbarRequested,
  renderSurfaceAvailable,
  viewportColorbarRequested,
}: {
  fdmColorbarRequested: boolean;
  renderSurfaceAvailable: boolean;
  viewportColorbarRequested: boolean;
}): boolean {
  return (
    renderSurfaceAvailable &&
    !viewportColorbarRequested &&
    !fdmColorbarRequested
  );
}

export function shouldRetainViewport3DScalarColorbarLegends({
  fdmColorbarRequested,
  renderSurfaceAvailable,
  viewportColorbarRequested,
}: {
  fdmColorbarRequested: boolean;
  renderSurfaceAvailable: boolean;
  viewportColorbarRequested: boolean;
}): boolean {
  return (
    viewportColorbarRequested ||
    fdmColorbarRequested ||
    !renderSurfaceAvailable
  );
}

export function resolveViewport3DColorbarPlansForRender({
  planned,
  renderSurfaceAvailable,
  retained,
  targetPlanAvailable,
  viewportColorbarRequested,
}: {
  planned: readonly Viewport3DColorbarPlan[];
  renderSurfaceAvailable: boolean;
  retained: readonly Viewport3DColorbarPlan[];
  targetPlanAvailable: boolean;
  viewportColorbarRequested: boolean;
}): readonly Viewport3DColorbarPlan[] {
  if (planned.length > 0) return planned;
  return viewportColorbarRequested || !renderSurfaceAvailable || !targetPlanAvailable
    ? retained
    : planned;
}

export function resolveRetainedViewport3DColorbarPlansForStore({
  planned,
  renderSurfaceAvailable,
  retained,
  targetPlanAvailable,
  viewportColorbarRequested,
}: {
  planned: readonly Viewport3DColorbarPlan[];
  renderSurfaceAvailable: boolean;
  retained: readonly Viewport3DColorbarPlan[];
  targetPlanAvailable: boolean;
  viewportColorbarRequested: boolean;
}): readonly Viewport3DColorbarPlan[] {
  if (planned.length > 0) return planned;
  return viewportColorbarRequested || !renderSurfaceAvailable || !targetPlanAvailable
    ? retained
    : EMPTY_VIEWPORT_3D_COLORBAR_PLANS;
}

function viewport3DColorbarRetentionGroupKey(key: string): string {
  return key;
}

function viewport3DScalarColorbarLegendKey({
  colorMode,
  palette,
  projectionMode,
  quantityId,
  targetId,
}: {
  colorMode: string;
  palette: string;
  projectionMode?: VisualizationTargetSettings["surfaceProjectionMode"];
  quantityId: string;
  targetId: string;
}): string {
  const key = [
    targetId,
    resolveCanonicalQuantityId(quantityId),
    colorMode,
    palette,
  ];
  if (projectionMode && projectionMode !== "raw_nodal") {
    key.push(`projection=${projectionMode}`);
  }
  return key.join(":");
}

const retainedViewport3DColorbarPlansBySlot = new Map<
  string,
  readonly Viewport3DColorbarPlan[]
>();
const retainedViewport3DColorbarPlanListeners = new Set<() => void>();
const EMPTY_VIEWPORT_3D_COLORBAR_PLANS: readonly Viewport3DColorbarPlan[] = [];

function sameViewport3DColorbarPlans(
  left: readonly Viewport3DColorbarPlan[],
  right: readonly Viewport3DColorbarPlan[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const plan = left[index];
    const other = right[index];
    if (!plan || !other) return false;
    if (
      plan.groupKey !== other.groupKey ||
      plan.range?.min !== other.range?.min ||
      plan.range?.max !== other.range?.max ||
      plan.rangeState !== other.rangeState ||
      plan.targetIds.length !== other.targetIds.length
    ) {
      return false;
    }
    for (let targetIndex = 0; targetIndex < plan.targetIds.length; targetIndex += 1) {
      if (plan.targetIds[targetIndex] !== other.targetIds[targetIndex]) {
        return false;
      }
    }
  }
  return true;
}

function subscribeRetainedViewport3DColorbarPlans(
  listener: () => void,
): () => void {
  retainedViewport3DColorbarPlanListeners.add(listener);
  return () => {
    retainedViewport3DColorbarPlanListeners.delete(listener);
  };
}

function getRetainedViewport3DColorbarPlans(
  slotId: string,
): readonly Viewport3DColorbarPlan[] {
  return (
    retainedViewport3DColorbarPlansBySlot.get(slotId) ??
    EMPTY_VIEWPORT_3D_COLORBAR_PLANS
  );
}

function setRetainedViewport3DColorbarPlans(
  slotId: string,
  plans: readonly Viewport3DColorbarPlan[],
): void {
  const current = getRetainedViewport3DColorbarPlans(slotId);
  if (sameViewport3DColorbarPlans(current, plans)) return;
  if (plans.length > 0) {
    retainedViewport3DColorbarPlansBySlot.set(slotId, plans);
  } else {
    retainedViewport3DColorbarPlansBySlot.delete(slotId);
  }
  for (const listener of retainedViewport3DColorbarPlanListeners) {
    listener();
  }
}

export function formatHysteresisReplayLabel(
  target: HysteresisStepViewportTarget | null,
): string | null {
  if (!target) return null;
  return `Replay Hysteresis point ${target.pointId} · ${target.snapshotId}`;
}

export function formatHysteresisReplayGlyphVector(
  vector: readonly [number, number, number] | null | undefined,
): string {
  return vector?.map((component) => component.toFixed(6)).join(" ") ?? "";
}

function completePendingViewport3DCapture(
  canvasRef: { current: HTMLCanvasElement | null },
  pendingCaptureRevisionRef: { current: number | null },
  captureRevision: number,
): void {
  if (
    captureRevision <= 0 ||
    pendingCaptureRevisionRef.current !== captureRevision
  ) {
    return;
  }
  const canvas = canvasRef.current;
  if (!canvas) return;
  const link = document.createElement("a");
  link.download = "fullmag-viewport-3d.png";
  link.href = canvas.toDataURL("image/png");
  link.click();
  pendingCaptureRevisionRef.current = null;
  viewport3dStore.completeCapture();
}

function useMeshSizeHistogramHighlight(
  bus: ModuleProps["kernel"]["bus"],
): MeshSizeHistogramHighlight | null {
  const [highlight, setHighlight] =
    useState<MeshSizeHistogramHighlight | null>(null);
  useEffect(
    () =>
      bus.on("viewport:mesh-size-bin-hovered", (event) => {
        setHighlight((current) =>
          retainViewport3DMeshSizeHighlight(current, event.highlight),
        );
      }),
    [bus],
  );
  return highlight;
}

interface Viewport3DFrameProps
  extends Omit<
    Viewport3DSceneProps,
    | "colors"
    | "onOrbitDebugAnglesChange"
    | "onVisualizationFrameCommitted"
    | "orbitDebugAngles"
    | "orbitDebugCommitRevision"
    | "orbitDebugRevision"
  > {
  cameraDialogOpen: boolean;
  cameraDialogState: Viewport3DSceneProps["cameraState"];
  cameraResource: VisualizationStateResource["camera"] | null;
  clientReady: boolean;
  colors: Viewport3DSceneProps["colors"] | null;
  captureRevision: number;
  diagnostics: string;
  domainSummary: string;
  fieldDataIssue: Viewport3DFieldDataIssue | null;
  fieldRefresh: Viewport3DFieldRefreshState;
  hysteresisReplayGlyphModel: HysteresisReplayGlyphModel | null;
  hysteresisReplayTarget: HysteresisStepViewportTarget | null;
  inspectRevision: number;
  kernel: ModuleProps["kernel"];
  meshQualityMetric: MeshQualityColorMetric;
  meshQualityRange: MeshQualityRange | null;
  onCameraPatch: (
    patch: NonNullable<VisualizationStatePatch["camera"]>,
  ) => void;
  onClearSelection: () => void;
  onRegionOverlayModeChange: (mode: RegionOverlayMode) => void;
  quantityId: string;
  renderedMeshRevision: number | string | null;
  scalarColorPalette: string;
  selectedLabel: string;
  slotId: ModuleProps["slotId"];
  status: string;
  topologyRevision: number | string | null;
  visualizationEffectiveRenderMode: string;
  visualizationError: string | null;
}

export default function Viewport3DModule({
  kernel,
  moduleId,
  slotId,
}: ModuleProps) {
  const { clientReady, colors } = useViewport3DColors();
  const selection = useSelectionSelector((state) => state, {
    isEqual: selectionSnapshotEquals,
  });
  const { select, clear } = useSelectionActions(moduleId);
  const tracker = useViewport3DResourceTracker();
  const reportWorkerRuntimeCounts = useCallback(
    (counts: Parameters<typeof tracker.setWorkerRuntimeCounts>[0]) =>
      tracker.setWorkerRuntimeCounts(counts),
    [tracker],
  );
  useViewport3DWorkerRuntime(reportWorkerRuntimeCounts);
  const resourceCounts = useViewport3DResourceCounts(tracker);
  const commandState = useViewport3DCommandState();
  const meshSizeHighlight = useMeshSizeHistogramHighlight(kernel.bus);
  const [regionOverlayMode, setRegionOverlayMode] =
    useState<RegionOverlayMode>("auto");
  const meshHistogramBinElements = useMeshHistogramBinElementsResource(
    meshSizeHighlight?.resource ?? null,
  );
  const { domainId, ...sceneModel } = useViewport3DSceneModel({
    commandState,
    colors,
    meshSizeHighlight,
    meshSizeHighlightSelection: meshSizeHighlight
      ? meshHistogramBinElements.data
      : null,
    resourceCounts,
    selection,
  });
  const { onSelectDomain, onSelectObject, onSelectPart, onSelectRegion } =
    useViewport3DSelectionHandlers({
      domainId,
      semanticTargetCatalog: sceneModel.semanticTargetCatalog,
      select,
  });
  const patchCameraState = useCallback(
    (patch: NonNullable<VisualizationStatePatch["camera"]>) => {
      kernel.cameraRegistry.patchCamera(patch);
      if (patch.position && patch.target) {
        const nextCamera = {
          position: toCameraTuple(patch.position),
          target: toCameraTuple(patch.target),
          up: toCameraTuple(patch.up ?? VIEWPORT_3D_WORLD_UP),
        };
        if (patch.projection || "orthographic_scale" in patch) {
          viewport3dStore.setCameraView({
            camera: nextCamera,
            orthographicScale: patch.orthographic_scale,
            projection:
              patch.projection ??
              viewport3dStore.getSnapshot().widgets.cameraProjection,
          });
        } else {
          viewport3dStore.setCamera(nextCamera);
        }
      }
      if (patch.projection) {
        viewport3dStore.setCameraProjection(patch.projection);
      }
      if ("orthographic_scale" in patch) {
        viewport3dStore.setCameraOrthographicScale(patch.orthographic_scale ?? null);
      }
    },
    [kernel.cameraRegistry],
  );
  const saveCameraState = useCallback(
    (camera: Viewport3DCameraChange) => {
      const nextCamera = {
        position: camera.position,
        target: camera.target,
        up: camera.up ?? VIEWPORT_3D_WORLD_UP,
      };
      if (
        camera.projection !== undefined ||
        camera.orthographicScale !== undefined
      ) {
        viewport3dStore.setCameraView({
          camera: nextCamera,
          orthographicScale: camera.orthographicScale ?? null,
          projection:
            camera.projection ??
            viewport3dStore.getSnapshot().widgets.cameraProjection,
        });
      } else {
        viewport3dStore.setCamera(nextCamera);
      }
    },
    [],
  );
  const beginCameraInteraction = useCallback(() => {
    kernel.cameraRegistry.beginInteraction();
  }, [kernel.cameraRegistry]);
  const endCameraInteraction = useCallback(() => {
    kernel.cameraRegistry.endInteraction();
  }, [kernel.cameraRegistry]);

  return (
    <WorkspaceRenderProfiler id="Viewport3DModule">
      <Viewport3DFrame
      {...sceneModel}
      clientReady={clientReady}
      colors={colors}
      cameraDialogOpen={commandState.widgets.cameraDialogOpen}
      cameraDialogState={commandState.camera}
      dimensionFrameDensity={commandState.widgets.dimensionFrameDensity}
      dimensionFrameMode={commandState.widgets.dimensionFrameMode}
      fitRevision={commandState.fitRevision}
      kernel={kernel}
      onCameraPatch={patchCameraState}
      onClearSelection={clear}
      onRegionOverlayModeChange={setRegionOverlayMode}
      onSelectDomain={onSelectDomain}
      onSelectObject={onSelectObject}
      onSelectPart={onSelectPart}
      onSelectRegion={onSelectRegion}
      onCameraChange={saveCameraState}
      onCameraInteractionEnd={endCameraInteraction}
      onCameraInteractionStart={beginCameraInteraction}
      captureRevision={commandState.captureRevision}
      inspectEnabled={commandState.widgets.inspectEnabled}
      inspectQuantityId={sceneModel.quantityId}
      inspectRevision={commandState.widgets.inspectRevision}
      requestDiagnostics={kernel.diagnostics}
      resetCameraRevision={commandState.resetCameraRevision}
      regionOverlayMode={regionOverlayMode}
      rotationMode={commandState.widgets.rotationMode}
      scaleLabelsVisible={commandState.widgets.scaleLabelsVisible}
      scaleUnitMode={commandState.widgets.scaleUnitMode}
      slotId={slotId}
      tracker={tracker}
      viewCubeVisible={commandState.widgets.viewCubeVisible}
      />
    </WorkspaceRenderProfiler>
  );
}

function useViewport3DSelectionHandlers({
  domainId,
  semanticTargetCatalog,
  select,
}: {
  domainId: string | null | undefined;
  semanticTargetCatalog: SemanticRenderTargetCatalog;
  select: ReturnType<typeof useSelectionActions>["select"];
}) {
  const onSelectDomain = useCallback(() => {
    select(viewportSelectionForDomain(domainId));
  }, [domainId, select]);
  const onSelectPart = useCallback(
    (partSelection: Viewport3DPartSelection) => {
      const address = resolveSemanticTargetForMeshPart(
        semanticTargetCatalog,
        partSelection.part,
      );
      if (!address) return;
      select(
        viewportSelectionForMeshPart(address, {
          boundaryFaceIndex: partSelection.boundaryFaceIndex,
          carrierPartId: partSelection.carrierPartId,
          label: partSelection.label,
        }),
      );
    },
    [select, semanticTargetCatalog],
  );
  const onSelectObject = useCallback(
    (object: Viewport3DPrimitiveObject) => {
      select(viewportSelectionForObject(object));
    },
    [select],
  );
  const onSelectRegion = useCallback(
    (region: RegionOverlaySelection) => {
      select(viewportSelectionForRegion(region));
    },
    [select],
  );

  return { onSelectDomain, onSelectObject, onSelectPart, onSelectRegion };
}

const Viewport3DFrame = memo(function Viewport3DFrame({
  captureRevision,
  cameraDialogOpen,
  cameraDialogState,
  cameraResource,
  clientReady,
  colors,
  diagnostics,
  domainSummary,
  fieldDataIssue,
  fieldRefresh,
  hysteresisReplayGlyphModel,
  hysteresisReplayTarget,
  inspectRevision,
  kernel,
  meshQualityMetric,
  meshQualityRange,
  onCameraPatch,
  onClearSelection,
  onRegionOverlayModeChange,
  quantityId,
  selectedLabel,
  slotId,
  status,
  visualizationEffectiveRenderMode,
  visualizationError,
  ...sceneProps
}: Viewport3DFrameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pendingCaptureRevisionRef = useRef<number | null>(null);
  const primitiveObjectIds =
    sceneProps.primitiveModel?.objects
      .map((object) => object.objectId)
      .join(" ") ?? "";
  const visualProfile = getViewport3DVisualProfile(
    sceneProps.visualProfileId,
  );
  const canvasDpr = resolveViewport3DCanvasDpr({
    devicePixelRatio:
      typeof window === "undefined" ? 1 : window.devicePixelRatio,
    profile: visualProfile,
  });
  const canvasGlOptions = resolveStableViewport3DCanvasGlOptions(visualProfile);
  const canvasContextKey = `viewport-3d-canvas-aa:${canvasGlOptions.antialias ? "1" : "0"}-preserve:${canvasGlOptions.preserveDrawingBuffer ? "1" : "0"}`;
  const orbitDebugEnabled = viewport3DOrbitDebugEnabledFromBrowserConfig();
  const hysteresisReplayLabel = formatHysteresisReplayLabel(hysteresisReplayTarget);
  const [orbitDebugAngles, setOrbitDebugAngles] =
    useState<Viewport3DOrbitDebugAngles>(() =>
      normalizeViewport3DOrbitDebugAngles(null),
    );
  const [orbitDebugRevision, setOrbitDebugRevision] = useState(0);
  const [orbitDebugCommitRevision, setOrbitDebugCommitRevision] = useState(0);
  const [dismissedResourceIssueKey, setDismissedResourceIssueKey] =
    useState<string | null>(null);
  const fieldUpdatePointerHoldLifecycleRef =
    useRef<Viewport3DPointerHoldLifecycle | null>(null);
  const releaseFieldUpdatePointerHold = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    fieldUpdatePointerHoldLifecycleRef.current?.end(event.pointerId);
  }, []);
  const holdFieldUpdatesForPointerGesture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button < 0 || event.button > 2) return;
      fieldUpdatePointerHoldLifecycleRef.current?.begin(event.pointerId);
    },
    [],
  );
  useEffect(() => {
    const lifecycle = createViewport3DPointerHoldLifecycle({
      onBegin: beginViewport3DFieldUpdateHold,
      onEnd: endViewport3DFieldUpdateHold,
      target: window,
    });
    fieldUpdatePointerHoldLifecycleRef.current = lifecycle;
    return () => {
      lifecycle.dispose();
      if (fieldUpdatePointerHoldLifecycleRef.current === lifecycle) {
        fieldUpdatePointerHoldLifecycleRef.current = null;
      }
    };
  }, []);
  const [inspectHover, setInspectHover] =
    useState<Viewport3DInspectHover | null>(null);
  const lastRenderedMeshRevision = useRef<number | string | null>(null);
  const sendVisualizationAck = useVisualizationClientAckSender({ api: kernel.api });
  const initialCameraFit = resolveViewport3DCameraFit(null);
  const canvasCamera = useMemo(
    () => ({
      far: initialCameraFit.far,
      fov: 42,
      near: initialCameraFit.near,
      position: DEFAULT_VIEWPORT_3D_CAMERA_STATE.position,
      up: VIEWPORT_3D_WORLD_UP,
    }),
    [initialCameraFit.far, initialCameraFit.near],
  );
  const discretizationKind = sceneProps.fdmDomain
    ? "FDM"
    : sceneProps.femDomain.magneticParts.length > 0
      ? "FEM"
      : null;
  const meshQualityLegend = resolveViewport3DMeshQualityLegend(
    sceneProps.meshQualityOverlayVisible,
    meshQualityMetric,
    meshQualityRange,
  );
  const colorbarTopologyModel = sceneProps.topologyModel;
  const getColorbarPartSettings = sceneProps.getPartSettings;
  const colorbarParts = useMemo<Viewport3DColorbarTargetPart[]>(
    () => [
      ...(colorbarTopologyModel?.magneticParts ?? []).map((partModel) => ({
        id: partModel.part.id,
        label: partModel.part.label ?? partModel.part.id,
        role: partModel.part.role ?? null,
        settings: getColorbarPartSettings(partModel.part),
        targetKind: "part" as const,
      })),
      ...(colorbarTopologyModel?.airboxParts ?? []).map((partModel) => ({
        id: partModel.part.id,
        label: partModel.part.label ?? partModel.part.id,
        role: partModel.part.role ?? null,
        settings: getColorbarPartSettings(partModel.part),
        targetKind: "airbox" as const,
      })),
    ],
    [colorbarTopologyModel, getColorbarPartSettings],
  );
  const renderSurfaceAvailable = Boolean(sceneProps.topology || sceneProps.fdmDomain);
  const retainedColorbarPlans = useSyncExternalStore(
    subscribeRetainedViewport3DColorbarPlans,
    () => getRetainedViewport3DColorbarPlans(slotId),
    () => EMPTY_VIEWPORT_3D_COLORBAR_PLANS,
  );
  const colorbarTargetPlans = useMemo(
    () =>
      buildViewport3DColorbarTargetPlans({
        fdmSettings: sceneProps.fdmDomain ? sceneProps.fdmSettings : null,
        parts: colorbarParts,
      }),
    [colorbarParts, sceneProps.fdmDomain, sceneProps.fdmSettings],
  );
  const initialColorbarPlans = useMemo(
    () => planViewport3DColorbars({ targets: colorbarTargetPlans }),
    [colorbarTargetPlans],
  );
  const previousColorbarPlansByGroupKey = useMemo(
    () => new Map(retainedColorbarPlans.map((plan) => [plan.groupKey, plan])),
    [retainedColorbarPlans],
  );
  const colorbarRangeStates = useMemo(
    () =>
      resolveViewport3DColorbarRangeStates({
        fdmSurfaceColors: sceneProps.fdmSurfaceColors,
        fieldModel: sceneProps.fieldModel,
        plans: initialColorbarPlans,
      }),
    [initialColorbarPlans, sceneProps.fdmSurfaceColors, sceneProps.fieldModel],
  );
  const plannedColorbars = useMemo(
    () =>
      planViewport3DColorbars({
        previousPlans: previousColorbarPlansByGroupKey,
        rangeStatesByGroupKey: colorbarRangeStates,
        targets: colorbarTargetPlans,
      }),
    [
      colorbarRangeStates,
      colorbarTargetPlans,
      previousColorbarPlansByGroupKey,
    ],
  );
  const viewportColorbarRequested = colorbarTargetPlans.some(
    (target) => target.colorbar.viewportVisible,
  );
  const colorbarTargetPlanAvailable = Boolean(
    sceneProps.fdmDomain || colorbarTopologyModel,
  );
  const colorbarPlans = resolveViewport3DColorbarPlansForRender({
    planned: plannedColorbars,
    renderSurfaceAvailable,
    retained: retainedColorbarPlans,
    targetPlanAvailable: colorbarTargetPlanAvailable,
    viewportColorbarRequested,
  });
  const colorbarLabelByTargetId = useMemo(() => {
    const labels = new Map<string, string>(
      colorbarParts.map((part) => [part.id, part.label]),
    );
    if (sceneProps.fdmDomain) {
      labels.set("fdm", "FDM domain");
    }
    return labels;
  }, [colorbarParts, sceneProps.fdmDomain]);
  const colorbarLegends = useMemo(
    () =>
      resolveViewport3DColorbarLegendsFromPlans({
        labelByTargetId: colorbarLabelByTargetId,
        plans: colorbarPlans,
      }),
    [colorbarLabelByTargetId, colorbarPlans],
  );
  useEffect(() => {
    setRetainedViewport3DColorbarPlans(
      slotId,
      resolveRetainedViewport3DColorbarPlansForStore({
        planned: plannedColorbars,
        renderSurfaceAvailable,
        retained: retainedColorbarPlans,
        targetPlanAvailable: colorbarTargetPlanAvailable,
        viewportColorbarRequested,
      }),
    );
    viewport3dStore.setActiveScalarColorbarLegends(
      colorbarLegends.map(({ legend }) => legend),
    );
  }, [
    colorbarLegends,
    colorbarTargetPlanAvailable,
    plannedColorbars,
    renderSurfaceAvailable,
    retainedColorbarPlans,
    slotId,
    viewportColorbarRequested,
  ]);
  useEffect(
    () => () => viewport3dStore.setActiveScalarColorbarLegends([]),
    [],
  );
  const onVisualizationFrameCommitted = useCallback((revision: number) => {
    sendVisualizationAck({
      effectiveRenderMode: visualizationEffectiveRenderMode,
      enabled: clientReady && !visualizationError,
      revision,
      status: "rendered",
      viewportId: slotId,
    });
    notifyMeshTopologyRendered({
      bus: kernel.bus,
      lastRevision: lastRenderedMeshRevision,
      meshRevision: sceneProps.renderedMeshRevision,
      rendererId: slotId,
    });
    completePendingViewport3DCapture(
      canvasRef,
      pendingCaptureRevisionRef,
      captureRevision,
    );
  }, [
    captureRevision,
    clientReady,
    kernel.bus,
    sceneProps.renderedMeshRevision,
    sendVisualizationAck,
    slotId,
    visualizationEffectiveRenderMode,
    visualizationError,
  ]);
  useVisualizationClientAck({
    api: kernel.api,
    effectiveRenderMode: visualizationEffectiveRenderMode,
    enabled: clientReady,
    error: visualizationError,
    revision: sceneProps.visualizationRevision,
    status: visualizationError ? "failed" : "applied",
    viewportId: slotId,
  });
  const resourceIssueOpen = Boolean(
    fieldDataIssue && dismissedResourceIssueKey !== fieldDataIssue.key,
  );
  const setResourceIssueOpen = useCallback(
    (open: boolean) => {
      if (open) {
        setDismissedResourceIssueKey(null);
        return;
      }
      setDismissedResourceIssueKey(fieldDataIssue?.key ?? null);
    },
    [fieldDataIssue?.key, setDismissedResourceIssueKey],
  );
  useEffect(() => {
    if (captureRevision <= 0) return;
    pendingCaptureRevisionRef.current = captureRevision;
  }, [captureRevision]);
  const syncOrbitDebugAngles = useCallback(
    (angles: Viewport3DOrbitDebugAngles) => {
      const nextAngles = normalizeViewport3DOrbitDebugAngles(angles);
      setOrbitDebugAngles((currentAngles) =>
        shouldApplyViewport3DOrbitDebugAngles(currentAngles, nextAngles)
          ? nextAngles
          : currentAngles,
      );
    },
    [setOrbitDebugAngles],
  );
  const applyOrbitDebugAngles = useCallback(
    (angles: Viewport3DOrbitDebugAngles) => {
      const nextAngles = normalizeViewport3DOrbitDebugAngles(angles);
      setOrbitDebugAngles(nextAngles);
      setOrbitDebugRevision((revision) => revision + 1);
    },
    [setOrbitDebugAngles, setOrbitDebugRevision],
  );
  const commitOrbitDebugAngles = useCallback(() => {
    setOrbitDebugCommitRevision((revision) => revision + 1);
  }, [setOrbitDebugCommitRevision]);
  const clearInspectHover = useCallback(() => {
    setInspectHover(null);
  }, [setInspectHover]);
  const handleCanvasCreated = useCallback(
    ({ gl }: Viewport3DCanvasCreatedState) => {
      canvasRef.current = gl.domElement;
      configureViewport3DRenderer(gl, visualProfile);
    },
    [visualProfile],
  );
  const handleCanvasContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
    },
    [],
  );
  const handleCanvasPointerMissed = useCallback(() => {
    clearInspectHover();
    onClearSelection();
  }, [clearInspectHover, onClearSelection]);
  const updateInspectHover = useCallback(
    (
      sample: Viewport3DInspectSample,
      screenPosition: Viewport3DInspectScreenPosition,
    ) => {
      setInspectHover({ inspectRevision, sample, screenPosition });
    },
    [inspectRevision, setInspectHover],
  );
  const visibleInspectHover =
    sceneProps.inspectEnabled &&
    inspectHover?.inspectRevision === inspectRevision &&
    inspectHover.sample.quantityId === quantityId
      ? inspectHover
      : null;

  return (
    <section
      aria-label="3D viewport"
      className="fm-viewport-3d"
      data-camera-position={sceneProps.cameraState.position.join(" ")}
      data-camera-projection={sceneProps.cameraProjection}
      data-camera-target={sceneProps.cameraState.target.join(" ")}
      data-camera-up={sceneProps.cameraState.up.join(" ")}
      data-inspect-enabled={sceneProps.inspectEnabled ? "true" : "false"}
      data-primitive-object-count={sceneProps.primitiveModel?.objects.length ?? 0}
      data-primitive-object-ids={primitiveObjectIds}
      data-hysteresis-replay-snapshot-id={hysteresisReplayTarget?.snapshotId ?? ""}
      data-hysteresis-replay-stage-id={hysteresisReplayTarget?.stageId ?? ""}
      data-hysteresis-replay-field-direction={formatHysteresisReplayGlyphVector(
        hysteresisReplayGlyphModel?.fieldDirection?.vector,
      )}
      data-hysteresis-replay-measurement-axis={formatHysteresisReplayGlyphVector(
        hysteresisReplayGlyphModel?.measurementAxis?.vector,
      )}
      data-topology-freshness={sceneProps.topologyFreshness}
      data-visual-profile-id={sceneProps.visualProfileId}
      onPointerCancelCapture={releaseFieldUpdatePointerHold}
      onPointerDown={() => kernel.layout.setFocusedSlot(slotId)}
      onPointerDownCapture={holdFieldUpdatesForPointerGesture}
      onPointerUpCapture={releaseFieldUpdatePointerHold}
    >
      <div aria-live="polite" className="fm-viewport-3d__hud">
        <span>{quantityId}</span>
        <span>{selectedLabel}</span>
        {hysteresisReplayLabel ? <span>{hysteresisReplayLabel}</span> : null}
        <span>{domainSummary}</span>
        {meshQualityLegend ? <span>{meshQualityLegend}</span> : null}
        {sceneProps.meshSizeHighlightModel ? (
          <span>
            {sceneProps.meshSizeHighlightModel.label} ·{" "}
            {sceneProps.meshSizeHighlightModel.sampledElementCount.toLocaleString(
              "en-US",
            )}
            /
            {sceneProps.meshSizeHighlightModel.matchedElementCount.toLocaleString(
              "en-US",
            )} highlighted
          </span>
        ) : null}
        <span>{status}</span>
        {sceneProps.regionOverlays.length > 0 ||
        sceneProps.meshRegionOverlays.length > 0 ? (
          <fieldset
            aria-label="Region overlays"
            className="fm-viewport-3d__region-modes"
          >
            {(
              [
                ["off", "Off"],
                ["auto", "Auto"],
                ["authored", "Authored"],
                ["realized", "Realized"],
                ["both", "Both"],
              ] as const
            ).map(([mode, label]) => (
              <Button
                key={mode}
                aria-pressed={sceneProps.regionOverlayMode === mode}
                disabled={
                  mode === "realized" &&
                  sceneProps.meshRegionOverlays.length === 0
                }
                size="sm"
                type="button"
                variant={
                  sceneProps.regionOverlayMode === mode
                    ? "primary"
                    : "secondary"
                }
                onClick={() => onRegionOverlayModeChange(mode)}
              >
                {label}
              </Button>
            ))}
          </fieldset>
        ) : null}
        <Viewport3DFieldRefreshCountdown refresh={fieldRefresh} />
        <span>{diagnostics}</span>
      </div>
      {clientReady && colors ? (
        <Viewport3DCanvas
          camera={canvasCamera}
          className="fm-viewport-3d__canvas"
          dpr={canvasDpr}
          events={createViewport3DEventManager}
          frameloop={VIEWPORT_3D_FRAMELOOP}
          gl={canvasGlOptions}
          key={canvasContextKey}
          onCreated={handleCanvasCreated}
          onContextMenu={handleCanvasContextMenu}
          onPointerMissed={handleCanvasPointerMissed}
        >
          <Viewport3DRendererProfile visualProfile={visualProfile} />
          <Viewport3DScene
            {...sceneProps}
            colors={colors}
            hysteresisReplayGlyphModel={hysteresisReplayGlyphModel}
            orbitDebugAngles={orbitDebugAngles}
            orbitDebugCommitRevision={orbitDebugCommitRevision}
            orbitDebugRevision={orbitDebugRevision}
            onOrbitDebugAnglesChange={
              orbitDebugEnabled ? syncOrbitDebugAngles : undefined
            }
            onInspectClear={clearInspectHover}
            onInspectSample={updateInspectHover}
            onVisualizationFrameCommitted={onVisualizationFrameCommitted}
            visualProfileId={visualProfile.id}
          />
        </Viewport3DCanvas>
      ) : (
        <div className="fm-viewport-3d__placeholder">Preparing viewport</div>
      )}
      {discretizationKind && (
        <div
          aria-label={`Discretization method: ${discretizationKind}`}
          className="fm-viewport-3d__method-badge"
        >
          {discretizationKind}
        </div>
      )}
      {colorbarLegends.length > 0 ? (
        <div className="fm-viewport-3d__colorbar-stack">
          {colorbarLegends.map(({ key, legend }) => (
            <Viewport3DColorbar key={key} legend={legend} />
          ))}
        </div>
      ) : null}
      {visibleInspectHover ? (
        <Viewport3DInspectTooltip hover={visibleInspectHover} />
      ) : null}
      {orbitDebugEnabled && clientReady && colors ? (
        <Viewport3DOrbitDebugPanel
          angles={orbitDebugAngles}
          onAnglesChange={applyOrbitDebugAngles}
          onAnglesCommit={commitOrbitDebugAngles}
          onInteractionStart={sceneProps.onCameraInteractionStart}
        />
      ) : null}
      <Viewport3DCameraDialog
        cameraOrthographicScale={sceneProps.cameraOrthographicScale}
        cameraProjection={sceneProps.cameraProjection}
        cameraResource={cameraResource}
        cameraState={cameraDialogState}
        onCameraPatch={onCameraPatch}
        onOpenChange={(open) => viewport3dStore.setCameraDialogOpen(open)}
        open={cameraDialogOpen}
      />
      <Viewport3DSettingsDialog />
      <Viewport3DResourceIssueDialog
        issue={fieldDataIssue}
        open={Boolean(fieldDataIssue && resourceIssueOpen)}
        onOpenChange={setResourceIssueOpen}
      />
    </section>
  );
});

const INSPECT_TOOLTIP_OFFSET_PX = 14;

function Viewport3DRendererProfile({
  visualProfile,
}: {
  visualProfile: Viewport3DVisualProfile;
}) {
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    configureViewport3DRenderer(gl, visualProfile);
  }, [gl, visualProfile]);
  return null;
}

const Viewport3DColorbar = memo(function Viewport3DColorbar({
  legend,
}: {
  legend: Viewport3DColorbarLegend;
}) {
  const [selectedDisplayUnit, setSelectedDisplayUnit] = useState(
    legend.displayUnit ?? "",
  );
  const displayUnitItems = displayUnitItemsForSourceUnit(legend.sourceUnit);
  const hasUnitOptions =
    Boolean(legend.range) && hasDisplayUnitOptions(legend.sourceUnit);
  const effectiveDisplayUnit = hasUnitOptions
    ? normalizeDisplayUnit(
        legend.sourceUnit,
        selectedDisplayUnit || legend.displayUnit,
      )
    : "";
  const label =
    hasUnitOptions && legend.colorMode && legend.quantityId
      ? `${legend.labelPrefix ?? ""}${formatViewport3DColorbarQuantityLabel({
          colorMode: legend.colorMode,
          quantityId: legend.quantityId,
          unit: effectiveDisplayUnit,
        })}`
      : legend.label;
  const minLabel =
    hasUnitOptions && legend.range
      ? formatValueWithDisplayUnit(
          legend.range.min,
          legend.sourceUnit,
          effectiveDisplayUnit,
        )
      : legend.minLabel;
  const maxLabel =
    hasUnitOptions && legend.range
      ? formatValueWithDisplayUnit(
          legend.range.max,
          legend.sourceUnit,
          effectiveDisplayUnit,
        )
      : legend.maxLabel;
  return (
    <aside
      aria-label={`Color range: ${label}, ${minLabel} to ${maxLabel}`}
      className="fm-viewport-3d__colorbar"
    >
      <div className="fm-viewport-3d__colorbar-header">
        <span>{label}</span>
        {hasUnitOptions ? (
          <select
            aria-label={`${legend.label} display unit`}
            className="fm-viewport-3d__colorbar-unit"
            value={effectiveDisplayUnit}
            onChange={(event) => setSelectedDisplayUnit(event.target.value)}
          >
            {displayUnitItems.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <div className="fm-viewport-3d__colorbar-row">
        <span className="fm-viewport-3d__colorbar-limit">
          {minLabel}
        </span>
        <span
          aria-hidden="true"
          className="fm-viewport-3d__colorbar-ramp"
          style={{ background: legend.paletteGradient }}
        />
        <span className="fm-viewport-3d__colorbar-limit">
          {maxLabel}
        </span>
      </div>
    </aside>
  );
});

const Viewport3DInspectTooltip = memo(function Viewport3DInspectTooltip({
  hover,
}: {
  hover: Viewport3DInspectHover;
}) {
  const { sample, screenPosition } = hover;
  const lines =
    sample.status === "ready"
      ? formatViewport3DInspectComponents(sample)
      : [sample.message];
  return (
    <div
      aria-live="polite"
      className="fm-viewport-3d__inspect-tooltip"
      role="status"
      style={{
        left: screenPosition.x + INSPECT_TOOLTIP_OFFSET_PX,
        top: screenPosition.y + INSPECT_TOOLTIP_OFFSET_PX,
      }}
    >
      <div className="fm-viewport-3d__inspect-tooltip-header">
        <span>{sample.quantityId}</span>
        <span>{sample.targetLabel}</span>
      </div>
      <div className="fm-viewport-3d__inspect-tooltip-values">
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </div>
    </div>
  );
});

interface Viewport3DRefreshCountdownState {
  nowMs: number;
  sample: typeof EMPTY_VIEWPORT_3D_REFRESH_SAMPLE;
}

interface Viewport3DRefreshCountdownTick {
  nowMs: number;
  revision: Viewport3DFieldRefreshState["revision"];
  status: Viewport3DFieldRefreshState["status"];
}

const INITIAL_VIEWPORT_3D_REFRESH_COUNTDOWN: Viewport3DRefreshCountdownState = {
  nowMs: 0,
  sample: EMPTY_VIEWPORT_3D_REFRESH_SAMPLE,
};

function reduceViewport3DRefreshCountdown(
  current: Viewport3DRefreshCountdownState,
  tick: Viewport3DRefreshCountdownTick,
): Viewport3DRefreshCountdownState {
  return {
    nowMs: tick.nowMs,
    sample: updateViewport3DRefreshSample(current.sample, tick),
  };
}

const Viewport3DFieldRefreshCountdown = memo(
  function Viewport3DFieldRefreshCountdown({
    refresh,
  }: {
    refresh: Viewport3DFieldRefreshState;
  }) {
    const [countdown, dispatchCountdownTick] = useReducer(
      reduceViewport3DRefreshCountdown,
      INITIAL_VIEWPORT_3D_REFRESH_COUNTDOWN,
    );

    useEffect(() => {
      if (!refresh.enabled) {
        return;
      }

      dispatchCountdownTick({
        nowMs: Date.now(),
        revision: refresh.revision,
        status: refresh.status,
      });
    }, [refresh.enabled, refresh.revision, refresh.status]);

    const display = resolveViewport3DRefreshCountdownDisplay({
      enabled: refresh.enabled,
      nowMs: countdown.nowMs,
      payloadRevision: refresh.payloadRevision,
      requestedRevision: refresh.requestedRevision,
      sample: countdown.sample,
      status: refresh.status,
    });

    useEffect(() => {
      const delayMs = resolveViewport3DRefreshCountdownNextTickDelay({
        enabled: refresh.enabled,
        nowMs: countdown.nowMs,
        sample: countdown.sample,
        status: refresh.status,
      });
      if (delayMs === null) return;

      const timeoutId = setTimeout(() => {
        dispatchCountdownTick({
          nowMs: Date.now(),
          revision: refresh.revision,
          status: refresh.status,
        });
      }, delayMs);
      return () => clearTimeout(timeoutId);
    }, [
      countdown.nowMs,
      countdown.sample,
      refresh.enabled,
      refresh.revision,
      refresh.status,
    ]);

    if (!display) return null;

    const progressDegrees = `${Math.round(display.progress * 360)}deg`;
    const style = {
      "--fm-refresh-progress": progressDegrees,
    } as CSSProperties;

    return (
      <span
        aria-label={`${display.ariaLabel} for ${refresh.quantityId}`}
        className="fm-viewport-3d__refresh-countdown"
        data-pulse-id={countdown.sample.pulseId}
        data-refresh-state={display.state}
        data-resource-key={refresh.resourceKey}
        data-payload-revision={refresh.payloadRevision ?? "none"}
        data-revision={refresh.revision ?? "none"}
        data-requested-revision={refresh.requestedRevision ?? "none"}
        style={style}
      >
        <span
          aria-hidden="true"
          className="fm-viewport-3d__refresh-countdown-ring"
        >
          <span className="fm-viewport-3d__refresh-countdown-core" />
        </span>
        <span className="fm-viewport-3d__refresh-countdown-copy">
          <span className="fm-viewport-3d__refresh-countdown-title">
            {display.title}
          </span>
          <span className="fm-viewport-3d__refresh-countdown-detail">
            {display.detail}
          </span>
        </span>
      </span>
    );
  },
);

function Viewport3DResourceIssueDialog({
  issue,
  onOpenChange,
  open,
}: {
  issue: Viewport3DFieldDataIssue | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="fm-viewport-field-data-issue-description">
        <DialogHeader>
          <DialogTitle>Magnetic field data unavailable</DialogTitle>
          <DialogDescription id="fm-viewport-field-data-issue-description">
            {issue
              ? `Quantity ${issue.quantityId} cannot be rendered because ${issue.message}`
              : "The active field resource cannot be rendered."}
          </DialogDescription>
        </DialogHeader>
        {issue ? (
          <div className="fm-dialog__body">
            <dl className="fm-dialog__details">
              <div className="fm-dialog__details-row">
                <dt className="fm-dialog__details-label">Resource</dt>
                <dd className="fm-dialog__details-value">{issue.resourceKey}</dd>
              </div>
              <div className="fm-dialog__details-row">
                <dt className="fm-dialog__details-label">Reason</dt>
                <dd className="fm-dialog__details-value">{issue.message}</dd>
              </div>
            </dl>
          </div>
        ) : null}
        <DialogFooter>
          {issue ? (
            <Button type="button" variant="secondary" onClick={issue.retry}>
              Retry
            </Button>
          ) : null}
          <DialogClose asChild>
            <Button type="button" variant="primary">
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Viewport3DOrbitDebugPanel({
  angles,
  onAnglesChange,
  onAnglesCommit,
  onInteractionStart,
}: {
  angles: Viewport3DOrbitDebugAngles;
  onAnglesChange: (angles: Viewport3DOrbitDebugAngles) => void;
  onAnglesCommit: () => void;
  onInteractionStart?: () => void;
}) {
  const updateAngle = useCallback(
    (axis: keyof Viewport3DOrbitDebugAngles, value: string) => {
      onAnglesChange(
        normalizeViewport3DOrbitDebugAngles({
          ...angles,
          [axis]: Number(value),
        }),
      );
    },
    [angles, onAnglesChange],
  );

  function beginInputInteraction(
    event: ReactPointerEvent<HTMLInputElement>,
  ): void {
    event.stopPropagation();
    onInteractionStart?.();
  }

  function beginKeyboardInteraction(
    event: ReactFocusEvent<HTMLInputElement>,
  ): void {
    event.stopPropagation();
    onInteractionStart?.();
  }

  function endInputInteraction(
    event:
      | ReactFocusEvent<HTMLInputElement>
      | ReactPointerEvent<HTMLInputElement>,
  ): void {
    event.stopPropagation();
    onAnglesCommit();
  }

  return (
    <aside
      aria-label="Temporary orbit controls"
      className="fm-viewport-3d__orbit-debug"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="fm-viewport-3d__orbit-debug-header">
        <strong>Orbit Debug</strong>
        <span>rad</span>
      </div>
      <Viewport3DOrbitDebugSlider
        label="Azimuth"
        max={VIEWPORT_3D_ORBIT_DEBUG_LIMITS.azimuthMax}
        min={VIEWPORT_3D_ORBIT_DEBUG_LIMITS.azimuthMin}
        value={angles.azimuth}
        onChange={(value) => updateAngle("azimuth", value)}
        onInteractionBegin={beginKeyboardInteraction}
        onInteractionEnd={endInputInteraction}
        onInteractionStart={beginInputInteraction}
      />
      <Viewport3DOrbitDebugSlider
        label="Polar"
        max={VIEWPORT_3D_ORBIT_DEBUG_LIMITS.polarMax}
        min={VIEWPORT_3D_ORBIT_DEBUG_LIMITS.polarMin}
        value={angles.polar}
        onChange={(value) => updateAngle("polar", value)}
        onInteractionBegin={beginKeyboardInteraction}
        onInteractionEnd={endInputInteraction}
        onInteractionStart={beginInputInteraction}
      />
    </aside>
  );
}

function Viewport3DOrbitDebugSlider({
  label,
  max,
  min,
  onChange,
  onInteractionBegin,
  onInteractionEnd,
  onInteractionStart,
  value,
}: {
  label: string;
  max: number;
  min: number;
  onChange: (value: string) => void;
  onInteractionBegin: (event: ReactFocusEvent<HTMLInputElement>) => void;
  onInteractionEnd: (
    event:
      | ReactFocusEvent<HTMLInputElement>
      | ReactPointerEvent<HTMLInputElement>,
  ) => void;
  onInteractionStart: (event: ReactPointerEvent<HTMLInputElement>) => void;
  value: number;
}) {
  return (
    <label className="fm-viewport-3d__orbit-debug-field">
      <span>{label}</span>
      <output>{value.toFixed(3)}</output>
      <input
        max={max}
        min={min}
        step="0.001"
        type="range"
        value={value}
        onBlur={onInteractionEnd}
        onChange={(event) => onChange(event.target.value)}
        onFocus={onInteractionBegin}
        onPointerCancel={onInteractionEnd}
        onPointerDown={onInteractionStart}
        onPointerUp={onInteractionEnd}
      />
    </label>
  );
}
