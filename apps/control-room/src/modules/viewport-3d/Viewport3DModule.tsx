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
  FdmRegionMembershipResource,
  ResourceRevision,
  VisualizationStatePatch,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import {
  quantityUnitForColorbar,
  resolveCanonicalQuantityId,
} from "@/kernel/api/quantityIds";
import {
  viewport3DAuditRenderErrorInjectionEnabledFromBrowserConfig,
  viewport3DOrbitDebugEnabledFromBrowserConfig,
} from "@/kernel/browserFullmagConfig";
import type { MeshSizeHistogramHighlight } from "@/kernel/events/eventTypes";
import {
  type ObjectTranslation,
} from "@/kernel/authoring/objectTranslationMutation";
import {
  commitObjectMoveWorkflow,
  rebaseObjectMoveConflict,
  type ObjectMoveConflict,
} from "@/kernel/authoring/objectMoveConflictWorkflow";
import { useObjectMoveTool } from "@/kernel/authoring/ObjectMoveToolController";
import { useMeshHistogramBinElementsResource } from "@/kernel/resources/geometryLifecycleResources";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import type { SessionResourceIdentity } from "@/kernel/resources/sessionResourceIdentity";
import { useFieldMetaResource } from "@/kernel/resources/studyRuntimeResources";
import {
  frozenSpinsMaskIdFromResource,
  useFrozenSpinsActivePreviewId,
  useFrozenSpinsMaskResource,
  useFrozenSpinsPreviewResource,
} from "@/kernel/resources/frozenSpinsResources";
import {
  selectionSnapshotEquals,
  useSelectionActions,
  useSelectionSelector,
} from "@/kernel/selection/useSelection";
import {
  isVisualizationAirboxIdentity,
  type SelectionRef,
} from "@/kernel/selection/selectionTypes";
import { resolveVisualizationTargetForMeshPart } from "@/kernel/selection/visualizationTargetResolver";
import {
  resolveSemanticTargetForMeshPart,
  type SemanticRenderTargetCatalog,
} from "@/kernel/selection/semanticRenderTargetCatalog";
import { WorkspaceRenderProfiler } from "@/kernel/performance/reactRenderProfiler";
import { recordVisualizationDebugResourceCounts } from "@/kernel/performance/visualizationDebugPerformanceProbe";
import type { ModuleProps } from "@/kernel/types";
import {
  AIRBOX_VISUALIZATION_TARGET,
  surfaceColorSourceToColorMode,
  type VisualizationTargetRef,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
import {
  useVisualizationClientAckSender,
  type VisualizationDataAdoptionIdentity,
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
  createViewport3DVisualizationDebugCandidateBuilder,
  useViewport3DVisualizationDebugPublisher,
  type Viewport3DVisualizationDebugFrameCommit,
  type Viewport3DVisualizationDebugSource,
} from "./hooks/useViewport3DVisualizationDebugPublisher";
import { createViewport3DRenderAdoptionRegistry } from "./model/viewport3DRenderAdoptionRegistry";
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
import type { Viewport3DAirboxFrameState } from "./layers/Viewport3DScene";
import { recordViewport3DCameraTrajectorySample } from "./layers/viewport3DCameraTrajectoryProbe";
import { resolveViewport3DTargetSurfaceLayerInput } from "./layers/viewport3DLayerPassInputs";
import type { RegionOverlaySelection } from "./layers/RegionOverlayLayer";
import { buildFrozenSpinsOverlayModel } from "./layers/FrozenSpinsOverlay";
import {
  DEFAULT_REGION_DIAGNOSTIC_OVERLAY_STATE,
  regionDiagnosticOverlayMode,
  type RegionDiagnosticOverlaySource,
  type RegionDiagnosticOverlayState,
} from "./regionOverlayMode";
import { Viewport3DCameraDialog } from "./components/Viewport3DCameraDialog";
import { Viewport3DSettingsDialog } from "./components/Viewport3DSettingsDialog";
import { Viewport3DCanvas } from "./Viewport3DCanvas";
import { Viewport3DErrorBoundary } from "./Viewport3DErrorBoundary";
import { type Viewport3DPartSelection } from "./viewport3dDomainAdapter";
import {
  currentViewport3DMeshCellAuditTopology,
  listViewport3DMeshCellSelections,
  resolveViewport3DMeshCellSelection,
  type Viewport3DMeshCellSelectionIdentity,
  type Viewport3DMeshCellSelectionRequest,
} from "./viewport3dMeshCellSelection";
import {
  type HysteresisReplayGlyphModel,
  type HysteresisStepViewportTarget,
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
  viewportSelectionForFdmCell,
  viewportSelectionForFdmUniverseOutsideSupport,
  viewportSelectionForFdmTarget,
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
  buildViewport3DRenderedScalarRangeAliases,
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

declare global {
  interface Window {
    __FULLMAG_LIST_VIEWPORT_3D_MESH_CELLS__?: () =>
      Viewport3DMeshCellSelectionIdentity[];
    __FULLMAG_SELECT_VIEWPORT_3D_MESH_CELL__?: (
      request: Viewport3DMeshCellSelectionRequest,
    ) => Viewport3DMeshCellSelectionIdentity;
  }
}

export function buildViewport3DVisualizationDebugFrameCommit({
  airboxVectorsVisible,
  airboxWireframeVisible,
  contextLost,
  drawingBuffer,
  nowMs = Date.now,
  revision,
  slotId,
}: {
  airboxVectorsVisible?: boolean;
  airboxWireframeVisible?: boolean;
  contextLost: boolean | null;
  drawingBuffer: readonly [number, number] | null;
  nowMs?: () => number;
  revision: number;
  slotId: string;
}): Viewport3DVisualizationDebugFrameCommit {
  return {
    ...(typeof airboxVectorsVisible === "boolean"
      ? { airboxVectorsVisible }
      : {}),
    ...(typeof airboxWireframeVisible === "boolean"
      ? { airboxWireframeVisible }
      : {}),
    commitId: `${slotId}:${revision}`,
    committedAtMs: nowMs(),
    contextLost,
    drawingBuffer,
  };
}

export function buildViewport3DCameraRegistryPatch(
  camera: Viewport3DCameraChange,
): NonNullable<VisualizationStatePatch["camera"]> {
  return {
    position: camera.position,
    target: camera.target,
    up: camera.up ?? VIEWPORT_3D_WORLD_UP,
    ...(camera.projection === undefined
      ? {}
      : { projection: camera.projection }),
    ...(camera.orthographicScale === undefined
      ? {}
      : { orthographic_scale: camera.orthographicScale }),
  };
}

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
  scopeId?: string | null;
  scopeKind?: Viewport3DColorbarPlan["scopeKind"];
  sourceUnit?: string | null;
}

interface Viewport3DScopedColorbarLegend {
  key: string;
  legend: Viewport3DColorbarLegend;
}

interface Viewport3DColorbarTargetPart {
  id: string;
  label: string;
  objectScopeId?: string | null;
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
      scopeId: plan.scopeId,
      scopeKind: plan.scopeKind,
      sourceUnit: unit || null,
    },
  };
}

interface Viewport3DScalarColorbarLegendInput {
  colorPalette: string;
  fdmSurfaceColors?: ScalarColorBuffer | null;
  fdmVectorColors?: ScalarColorBuffer | null;
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
  fdmVectorColors,
  fieldModel,
  quantityId,
  surfaceColorMode,
  unit,
  vectorColorMode,
}: Viewport3DScalarColorbarLegendInput): Viewport3DColorbarLegend | null {
  const fdmColorBuffer =
    fdmSurfaceColors &&
    (!surfaceColorMode ||
      fdmSurfaceColors.colorMode === surfaceColorMode ||
      !fdmVectorColors)
      ? fdmSurfaceColors
      : fdmVectorColors;
  if (fdmColorBuffer) {
    return resolveViewport3DColorbarLegend({
      colorMode: surfaceColorMode ?? vectorColorMode,
      colorPalette: fdmColorBuffer.colorPalette ?? colorPalette,
      quantityId,
      range: fdmColorBuffer.range,
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
  availableQuantityIds,
  fdmSettings,
  parts,
}: {
  availableQuantityIds?: ReadonlySet<string> | null;
  fdmSettings?: VisualizationTargetSettings | null;
  parts: readonly Viewport3DColorbarTargetPart[];
}): Viewport3DTargetRenderPlan[] {
  const targets: Viewport3DTargetRenderPlan[] = [];
  for (const part of parts) {
    if (
      !isViewport3DColorbarTargetPartEligible(part) ||
      !viewport3DColorbarQuantityAvailable(
        part.settings.activeQuantityId,
        availableQuantityIds,
      )
    ) {
      continue;
    }
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
  if (
    fdmSettings &&
    viewport3DColorbarQuantityAvailable(
      fdmSettings.activeQuantityId,
      availableQuantityIds,
    )
  ) {
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

function viewport3DColorbarQuantityAvailable(
  quantityId: string,
  availableQuantityIds: ReadonlySet<string> | null | undefined,
): boolean {
  return (
    availableQuantityIds == null ||
    availableQuantityIds.has(resolveCanonicalQuantityId(quantityId))
  );
}

function isViewport3DColorbarTargetPartEligible(
  part: Viewport3DColorbarTargetPart,
): boolean {
  return (
    part.role !== "interface" &&
    (part.targetKind === "airbox" || !isVisualizationAirboxIdentity(part))
  );
}

export function resolveViewport3DColorbarLegendsFromPlans({
  labelByTargetId,
  plans,
}: {
  labelByTargetId: ReadonlyMap<string, string>;
  plans: readonly Viewport3DColorbarPlan[];
}): Viewport3DScopedColorbarLegend[] {
  const sharedScalePlans = new Map<string, Viewport3DColorbarPlan>();
  for (const plan of plans) {
    const scaleKey = viewport3DColorbarEffectiveScaleKey(plan);
    const existing = sharedScalePlans.get(scaleKey);
    if (!existing) {
      sharedScalePlans.set(scaleKey, plan);
      continue;
    }
    sharedScalePlans.set(scaleKey, {
      ...existing,
      renderKey: `viewport-3d-colorbar:shared:${scaleKey}`,
      targetIds: Array.from(
        new Set([...existing.targetIds, ...plan.targetIds]),
      ).toSorted(),
    });
  }

  return Array.from(sharedScalePlans.values(), (plan) =>
    resolveViewport3DColorbarLegendFromPlan({ labelByTargetId, plan }),
  );
}

function viewport3DColorbarEffectiveScaleKey(
  plan: Viewport3DColorbarPlan,
): string {
  return [
    resolveCanonicalQuantityId(plan.quantityId),
    plan.colorMode,
    plan.palette,
    plan.projectionMode,
    plan.rangeSource,
    plan.rangeState,
    plan.range?.min ?? "none",
    plan.range?.max ?? "none",
  ].join(":");
}

export function resolveViewport3DScalarColorbarLegends({
  colorPalette,
  fdmSettings,
  fdmSurfaceColors,
  fdmVectorColors,
  fieldModel,
  parts,
  surfaceColorMode,
  vectorColorMode,
}: Viewport3DScalarColorbarLegendInput): Viewport3DScopedColorbarLegend[] {
  const fdmColorBuffer = fdmSurfaceColors ?? fdmVectorColors;
  if (fdmColorBuffer && fdmSettings?.viewportColorbarVisible) {
    const legend = resolveViewport3DColorbarLegend({
      colorMode: surfaceColorMode ?? vectorColorMode,
      colorPalette: fdmColorBuffer.colorPalette ?? fdmSettings.scalarColorPalette,
      quantityId: fdmSettings.activeQuantityId,
      range: fdmColorBuffer.range,
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
  fieldIdentityCompatible = true,
  planned,
  renderSurfaceAvailable,
  retained,
  targetPlanAvailable,
  viewportColorbarRequested,
}: {
  fieldIdentityCompatible?: boolean;
  planned: readonly Viewport3DColorbarPlan[];
  renderSurfaceAvailable: boolean;
  retained: readonly Viewport3DColorbarPlan[];
  targetPlanAvailable: boolean;
  viewportColorbarRequested: boolean;
}): readonly Viewport3DColorbarPlan[] {
  if (!fieldIdentityCompatible) return EMPTY_VIEWPORT_3D_COLORBAR_PLANS;
  if (planned.length > 0) return planned;
  return viewportColorbarRequested || !renderSurfaceAvailable || !targetPlanAvailable
    ? retained
    : planned;
}

export function resolveRetainedViewport3DColorbarPlansForStore({
  fieldIdentityCompatible = true,
  planned,
  renderSurfaceAvailable,
  retained,
  targetPlanAvailable,
  viewportColorbarRequested,
}: {
  fieldIdentityCompatible?: boolean;
  planned: readonly Viewport3DColorbarPlan[];
  renderSurfaceAvailable: boolean;
  retained: readonly Viewport3DColorbarPlan[];
  targetPlanAvailable: boolean;
  viewportColorbarRequested: boolean;
}): readonly Viewport3DColorbarPlan[] {
  if (!fieldIdentityCompatible) return EMPTY_VIEWPORT_3D_COLORBAR_PLANS;
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

export function resolveViewport3DVectorSegmentLengthRange(
  segments: Float32Array | null | undefined,
): { max: number; min: number } | null {
  if (!segments || segments.length < 7) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (let offset = 0; offset + 6 < segments.length; offset += 7) {
    const length = Math.hypot(
      (segments[offset + 3] ?? 0) - (segments[offset] ?? 0),
      (segments[offset + 4] ?? 0) - (segments[offset + 1] ?? 0),
      (segments[offset + 5] ?? 0) - (segments[offset + 2] ?? 0),
    );
    min = Math.min(min, length);
    max = Math.max(max, length);
  }
  return Number.isFinite(min) ? { max, min } : null;
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
      bus.subscribe("viewport:mesh-size-bin-hovered", (event) => {
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
    | "moveDraftResetRevision"
    | "moveToolObjectId"
    | "onOrbitDebugAnglesChange"
    | "onMoveCommit"
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
  fdmFieldIdentityCompatible: boolean;
  fdmSelectionCellOrdinal: number | null;
  fdmSelectionAnnouncement: string | null;
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
  onFdmUniverseOverlayVisibilityChange: (visible: boolean) => void;
  onFrozenSpinsOverlayVisibilityChange: (visible: boolean) => void;
  onRegionOverlaySourceChange: (source: RegionDiagnosticOverlaySource) => void;
  onRegionOverlayVisibilityChange: (visible: boolean) => void;
  regionDiagnosticOverlayState: RegionDiagnosticOverlayState;
  quantityId: string;
  renderedMeshRevision: number | string | null;
  scalarColorPalette: string;
  sessionIdentity: SessionResourceIdentity | null;
  selectedLabel: string;
  sceneRefetch: () => void;
  sceneRevision: number | null;
  slotId: ModuleProps["slotId"];
  status: string;
  topologyRevision: number | string | null;
  visualizationEffectiveRenderMode: string;
  visualizationError: string | null;
  visualizationDebugSource: Viewport3DVisualizationDebugSource;
}

export default function Viewport3DModule({
  kernel,
  moduleId,
  slotId,
}: ModuleProps) {
  const { clientReady, colors } = useViewport3DColors();
  const sessionIdentity = useSessionResourceIdentity();
  const selection = useSelectionSelector((state) => state, {
    isEqual: selectionSnapshotEquals,
  });
  const { select, clear } = useSelectionActions(moduleId);
  const tracker = useViewport3DResourceTracker();
  const sessionIdentityKey = sessionIdentity
    ? `${sessionIdentity.sessionId}\u0000${sessionIdentity.sessionEpoch}`
    : null;
  const previousSessionIdentityKeyRef = useRef(sessionIdentityKey);
  useEffect(() => {
    if (previousSessionIdentityKeyRef.current === sessionIdentityKey) return;
    previousSessionIdentityKeyRef.current = sessionIdentityKey;
    tracker.recordDirtyFrame("session-identity-changed");
  }, [sessionIdentityKey, tracker]);
  const reportWorkerRuntimeCounts = useCallback(
    (counts: Parameters<typeof tracker.setWorkerRuntimeCounts>[0]) =>
      tracker.setWorkerRuntimeCounts(counts),
    [tracker],
  );
  useViewport3DWorkerRuntime(reportWorkerRuntimeCounts);
  const resourceCounts = useViewport3DResourceCounts(tracker);
  useEffect(() => {
    recordVisualizationDebugResourceCounts({
      geometries: resourceCounts.geometries,
      materials: resourceCounts.materials,
      renderTargets: resourceCounts.renderTargets,
      textures: resourceCounts.textures,
      workers: resourceCounts.workers,
    });
  }, [resourceCounts]);
  const commandState = useViewport3DCommandState();
  const meshSizeHighlight = useMeshSizeHistogramHighlight(kernel.bus);
  const [regionDiagnosticOverlayState, setRegionDiagnosticOverlayState] =
    useState<RegionDiagnosticOverlayState>(
      DEFAULT_REGION_DIAGNOSTIC_OVERLAY_STATE,
    );
  const [frozenSpinsOverlayVisible, setFrozenSpinsOverlayVisible] =
    useState(true);
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
  const frozenSpinsPreviewId = useFrozenSpinsActivePreviewId();
  const frozenSpinsPreview = useFrozenSpinsPreviewResource(
    frozenSpinsPreviewId ?? "",
    { enabled: frozenSpinsPreviewId !== null },
  );
  const frozenSpinsMaskId = frozenSpinsPreview.data
    ? frozenSpinsMaskIdFromResource(frozenSpinsPreview.data.mask_resource)
    : null;
  const frozenSpinsMask = useFrozenSpinsMaskResource(
    frozenSpinsMaskId ?? "",
    { enabled: frozenSpinsMaskId !== null },
  );
  const frozenSpinsOverlayModel = useMemo(
    () =>
      buildFrozenSpinsOverlayModel({
        current: frozenSpinsPreview.data?.current ?? false,
        fdmDomain: sceneModel.fdmDomain,
        // No OpenAPI resource currently publishes exact FEM true-DOF coordinates.
        // Never substitute topology vertices: higher-order true DOFs are not nodes.
        femTrueDofPositions: null,
        mask: frozenSpinsMask.data,
        previewId: frozenSpinsPreviewId ?? "",
      }),
    [
      frozenSpinsMask.data,
      frozenSpinsPreview.data,
      frozenSpinsPreviewId,
      sceneModel.fdmDomain,
    ],
  );
  const { onSelectDomain, onSelectFdmCell, onSelectFdmTarget, onSelectFdmUniverseOutsideSupport, onSelectObject, onSelectPart, onSelectPlanarMonitor, onSelectRegion } =
    useViewport3DSelectionHandlers({
      domainId,
      fdmDomain: sceneModel.fdmDomain,
      fdmInstanceModel: sceneModel.fdmInstanceModel,
      fdmRegionMembership: sceneModel.fdmRegionMembership,
      fdmRegionMembershipBinary: sceneModel.fdmRegionMembershipBinary,
      semanticTargetCatalog: sceneModel.semanticTargetCatalog,
      select,
  });
  const fdmSelectionAnnouncement = useMemo(
    () =>
      resolveViewport3DFdmSelectionAnnouncement({
        domainGenerationId:
          sceneModel.visualizationDebugSource.fullFieldBufferIdentity
            ?.currentDomainGenerationId ?? null,
        fieldIdentityCompatible: sceneModel.fdmFieldIdentityCompatible,
        fieldRevision:
          sceneModel.fieldRefresh.status === "ready"
            ? sceneModel.fieldRefresh.payloadRevision ??
              sceneModel.fieldRefresh.revision
            : null,
        membership: sceneModel.fdmRegionMembership,
        quantityId: sceneModel.quantityId,
        selection:
          selection.ref?.type === "fdm-cell" ? selection.ref : null,
      }),
    [
      sceneModel.fdmFieldIdentityCompatible,
      sceneModel.fdmRegionMembership,
      sceneModel.fieldRefresh.payloadRevision,
      sceneModel.fieldRefresh.revision,
      sceneModel.fieldRefresh.status,
      sceneModel.quantityId,
      sceneModel.visualizationDebugSource.fullFieldBufferIdentity,
      selection.ref,
    ],
  );
  const fdmSelectionCellOrdinal =
    fdmSelectionAnnouncement && selection.ref?.type === "fdm-cell"
      ? Number(selection.ref.cellOrdinal)
      : null;
  useViewport3DMeshCellAuditSelection({
    onSelectPart,
    topologyModel: currentViewport3DMeshCellAuditTopology(
      sceneModel.topologyModel,
      sceneModel.topologyFreshness,
    ),
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
    (camera: Viewport3DCameraChange, epoch?: number) => {
      const accepted = kernel.cameraRegistry.patchCamera(
        buildViewport3DCameraRegistryPatch(camera),
        epoch,
      );
      const registry = kernel.cameraRegistry.getSnapshot();
      if (accepted) {
        viewport3dStore.setCameraView({
          camera: {
            position: toCameraTuple(registry.camera.position),
            target: toCameraTuple(registry.camera.target),
            up: toCameraTuple(registry.camera.up),
          },
          orthographicScale: registry.camera.orthographic_scale,
          projection: registry.camera.projection,
        });
      }
      recordViewport3DCameraTrajectorySample({
        active: epoch !== undefined,
        committedCamera: registry.camera,
        epoch: epoch ?? -1,
        frame: registry.localVersion,
        liveCamera: null,
        reason: "commit",
        registry: {
          dirty: registry.dirty,
          lastRemoteRevision: registry.lastRemoteRevision,
          localVersion: registry.localVersion,
          persistedShadow: registry.persistedShadow,
        },
        source: null,
        storeCamera: viewport3dStore.getSnapshot().camera,
        timestamp: performance.now(),
      });
    },
    [kernel.cameraRegistry],
  );
  const cameraFieldUpdateHoldRef = useRef(false);
  const beginCameraInteraction = useCallback((epoch?: number) => {
    if (!cameraFieldUpdateHoldRef.current) {
      cameraFieldUpdateHoldRef.current = true;
      beginViewport3DFieldUpdateHold();
    }
    kernel.cameraRegistry.beginInteraction(epoch);
  }, [kernel.cameraRegistry]);
  const endCameraInteraction = useCallback((epoch?: number) => {
    kernel.cameraRegistry.endInteraction(epoch);
    if (cameraFieldUpdateHoldRef.current) {
      cameraFieldUpdateHoldRef.current = false;
      endViewport3DFieldUpdateHold();
    }
  }, [kernel.cameraRegistry]);
  useEffect(
    () => () => {
      if (!cameraFieldUpdateHoldRef.current) return;
      cameraFieldUpdateHoldRef.current = false;
      endViewport3DFieldUpdateHold();
    },
    [],
  );
  const changeRegionOverlaySource = useCallback(
    (source: RegionDiagnosticOverlaySource) => {
      setRegionDiagnosticOverlayState((state) => ({ ...state, source }));
    },
    [],
  );
  const changeRegionOverlayVisibility = useCallback((visible: boolean) => {
    setRegionDiagnosticOverlayState((state) => ({ ...state, visible }));
  }, []);
  const changeFdmUniverseOverlayVisibility = useCallback(
    (visible: boolean) => {
      kernel.visualization.patchTarget(AIRBOX_VISUALIZATION_TARGET, {
        visible,
      });
    },
    [kernel.visualization],
  );

  return (
    <Viewport3DErrorBoundary diagnosticRecorder={kernel.diagnosticRecorder}>
      {viewport3DAuditRenderErrorInjectionEnabledFromBrowserConfig() ? (
        <Viewport3DAuditRenderErrorInjection />
      ) : (
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
      fdmSelectionCellOrdinal={fdmSelectionCellOrdinal}
      fdmSelectionAnnouncement={fdmSelectionAnnouncement}
      onCameraPatch={patchCameraState}
      onClearSelection={clear}
      onFdmUniverseOverlayVisibilityChange={changeFdmUniverseOverlayVisibility}
      frozenSpinsOverlayModel={frozenSpinsOverlayModel}
      frozenSpinsOverlayVisible={frozenSpinsOverlayVisible}
      onFrozenSpinsOverlayVisibilityChange={setFrozenSpinsOverlayVisible}
      onRegionOverlaySourceChange={changeRegionOverlaySource}
      onRegionOverlayVisibilityChange={changeRegionOverlayVisibility}
      onSelectDomain={onSelectDomain}
      onSelectFdmCell={onSelectFdmCell}
      onSelectFdmTarget={onSelectFdmTarget}
      onSelectFdmUniverseOutsideSupport={onSelectFdmUniverseOutsideSupport}
      onSelectObject={onSelectObject}
      onSelectPlanarMonitor={onSelectPlanarMonitor}
      onSelectPart={onSelectPart}
      onSelectRegion={onSelectRegion}
      onCameraChange={saveCameraState}
      onCameraInteractionEnd={endCameraInteraction}
      onCameraInteractionStart={beginCameraInteraction}
      captureRevision={commandState.captureRevision}
      inspectEnabled={commandState.widgets.inspectEnabled}
      inspectRevision={commandState.widgets.inspectRevision}
      requestDiagnostics={kernel.diagnostics}
      resetCameraRevision={commandState.resetCameraRevision}
      regionDiagnosticOverlayState={regionDiagnosticOverlayState}
      regionOverlayMode={regionDiagnosticOverlayMode(regionDiagnosticOverlayState)}
      rotationMode={commandState.widgets.rotationMode}
      scaleLabelsVisible={commandState.widgets.scaleLabelsVisible}
      scaleUnitMode={commandState.widgets.scaleUnitMode}
      sessionIdentity={sessionIdentity}
      slotId={slotId}
      tracker={tracker}
      viewCubeVisible={commandState.widgets.viewCubeVisible}
        />
        </WorkspaceRenderProfiler>
      )}
    </Viewport3DErrorBoundary>
  );
}

function Viewport3DAuditRenderErrorInjection(): never {
  throw new Error("Maximum update depth exceeded (viewport audit injection)");
}

function useViewport3DMeshCellAuditSelection({
  onSelectPart,
  topologyModel,
}: {
  onSelectPart: (partSelection: Viewport3DPartSelection) => void;
  topologyModel: Viewport3DSceneProps["topologyModel"];
}) {
  useEffect(() => {
    if (process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_AUDIT_BUILD !== "1") {
      return undefined;
    }
    const config = (window as Window & {
      __FULLMAG_CONFIG__?: { enableAuditHooks?: unknown };
    }).__FULLMAG_CONFIG__;
    if (config?.enableAuditHooks !== true) return undefined;
    if (!topologyModel) return undefined;

    const list = () => listViewport3DMeshCellSelections(topologyModel);
    const selectMeshCell = (request: Viewport3DMeshCellSelectionRequest) => {
      const selection = resolveViewport3DMeshCellSelection(topologyModel, request);
      if (!selection || !selection.elementFamily || !selection.globalCellOrdinal) {
        throw new Error(
          `Viewport mesh-cell audit selection was not found: ${JSON.stringify(request)}`,
        );
      }
      onSelectPart(selection);
      return {
        carrier: request.carrier,
        carrierPartId: selection.carrierPartId,
        elementFamily: selection.elementFamily,
        globalCellOrdinal: selection.globalCellOrdinal,
      };
    };
    window.__FULLMAG_LIST_VIEWPORT_3D_MESH_CELLS__ = list;
    window.__FULLMAG_SELECT_VIEWPORT_3D_MESH_CELL__ = selectMeshCell;
    return () => {
      if (window.__FULLMAG_LIST_VIEWPORT_3D_MESH_CELLS__ === list) {
        delete window.__FULLMAG_LIST_VIEWPORT_3D_MESH_CELLS__;
      }
      if (window.__FULLMAG_SELECT_VIEWPORT_3D_MESH_CELL__ === selectMeshCell) {
        delete window.__FULLMAG_SELECT_VIEWPORT_3D_MESH_CELL__;
      }
    };
  }, [onSelectPart, topologyModel]);
}

function useViewport3DSelectionHandlers({
  domainId,
  fdmDomain,
  fdmInstanceModel,
  fdmRegionMembership,
  fdmRegionMembershipBinary,
  semanticTargetCatalog,
  select,
}: {
  domainId: string | null | undefined;
  fdmDomain: { shape: readonly [number, number, number] } | null;
  fdmInstanceModel: import("./layers/FdmCuboidLayer").FdmCuboidInstanceModel | null | undefined;
  fdmRegionMembership: import("@/kernel/api/apiTypes").FdmRegionMembershipResource | null | undefined;
  fdmRegionMembershipBinary: import("@/kernel/api/codecs").DecodedFdmRegionMembership | null | undefined;
  semanticTargetCatalog: SemanticRenderTargetCatalog;
  select: ReturnType<typeof useSelectionActions>["select"];
}) {
  const onSelectDomain = useCallback(() => {
    select(viewportSelectionForDomain(domainId));
  }, [domainId, select]);
  const onSelectFdmCell = useCallback(
    (instanceId: number) => {
      const selection = viewportSelectionForFdmCell({
        binary: fdmRegionMembershipBinary,
        domainShape: fdmDomain?.shape,
        instanceId,
        membership: fdmRegionMembership,
        model: fdmInstanceModel,
      });
      // Missing/stale/legacy identity deliberately produces no selection.
      if (selection) select(selection);
    },
    [fdmDomain?.shape, fdmInstanceModel, fdmRegionMembership, fdmRegionMembershipBinary, select],
  );
  const onSelectFdmUniverseOutsideSupport = useCallback(() => {
    select(viewportSelectionForFdmUniverseOutsideSupport());
  }, [select]);
  const onSelectFdmTarget = useCallback(
    (target: VisualizationTargetRef) => {
      const selection = viewportSelectionForFdmTarget(target);
      if (selection) select(selection);
    },
    [select],
  );
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
          elementFamily: partSelection.elementFamily,
          globalCellOrdinal: partSelection.globalCellOrdinal,
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
  const onSelectPlanarMonitor = useCallback(
    (monitorId: string, isDraft: boolean) => {
      select({
        kind: isDraft ? "model.planar.monitor.draft" : "model.planar.monitor",
        label: isDraft ? "Planar monitor draft" : monitorId,
        nodeId: isDraft ? "model:definitions:planar-monitors:draft" : `model:definitions:planar-monitors:${monitorId}`,
        objectId: null,
        ref: {
          ...(isDraft
            ? { draftId: "draft", kind: "model.planar.monitor.draft" as const, nodeId: "model:definitions:planar-monitors:draft", type: "planar-monitor-draft" as const, visualizationTargetId: "planar-monitor:draft" }
            : { kind: "model.planar.monitor" as const, monitorId, nodeId: `model:definitions:planar-monitors:${monitorId}`, type: "planar-monitor" as const, visualizationTargetId: `planar-monitor:${monitorId}` as `planar-monitor:${string}` }),
        },
      });
    },
    [select],
  );
  const onSelectRegion = useCallback(
    (region: RegionOverlaySelection) => {
      select(viewportSelectionForRegion(region));
    },
    [select],
  );

  return {
    onSelectDomain,
    onSelectFdmCell,
    onSelectFdmUniverseOutsideSupport,
    onSelectFdmTarget,
    onSelectObject,
    onSelectPlanarMonitor,
    onSelectPart,
    onSelectRegion,
  };
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
  fdmSelectionCellOrdinal,
  fdmSelectionAnnouncement,
  hysteresisReplayGlyphModel,
  hysteresisReplayTarget,
  inspectRevision,
  kernel,
  meshQualityMetric,
  meshQualityRange,
  onCameraPatch,
  onClearSelection,
  onFdmUniverseOverlayVisibilityChange,
  onFrozenSpinsOverlayVisibilityChange,
  onRegionOverlaySourceChange,
  onRegionOverlayVisibilityChange,
  regionDiagnosticOverlayState,
  quantityId,
  sessionIdentity,
  selectedLabel,
  sceneRefetch,
  sceneRevision,
  slotId,
  status,
  visualizationEffectiveRenderMode,
  visualizationError,
  visualizationDebugSource,
  ...sceneProps
}: Viewport3DFrameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pendingCaptureRevisionRef = useRef<number | null>(null);
  const primitiveObjectIds =
    sceneProps.primitiveModel?.objects
      .map((object) => object.objectId)
      .join(" ") ?? "";
  const colorbarSceneObjectIds = useMemo(
    () => new Set(sceneProps.primitiveModel?.objects.map((object) => object.objectId)),
    [sceneProps.primitiveModel],
  );
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
  const [inspectHover, setInspectHover] =
    useState<Viewport3DInspectHover | null>(null);
  const [moveConflict, setMoveConflict] = useState<ObjectMoveConflict | null>(null);
  const [moveDraftResetRevision, setMoveDraftResetRevision] = useState(0);
  const moveTool = useObjectMoveTool(kernel.objectMoveTool);
  const lastRenderedMeshRevision = useRef<number | string | null>(null);
  const sendVisualizationAck = useVisualizationClientAckSender({ api: kernel.api });
  const visualizationAckRevisionRef = useRef<{
    resourceFrameKey: string;
    revision: number;
  } | null>(null);
  const visualizationAckKindsRef = useRef(
    new Map<number, {
      changeKind: "data" | "style";
      dataIdentity: VisualizationDataAdoptionIdentity | null;
      resourceKey: string;
    }>(),
  );
  const visualizationDebugAdoptionRegistry = useMemo(
    () => createViewport3DRenderAdoptionRegistry(),
    [],
  );
  visualizationDebugAdoptionRegistry.setSessionIdentity(sessionIdentity);
  const visualizationDebugCandidateBuilder = useMemo(
    () =>
      createViewport3DVisualizationDebugCandidateBuilder({
        source: visualizationDebugSource,
        viewportId: slotId,
      }),
    [slotId, visualizationDebugSource],
  );
  const visualizationDebugTargetIds = useMemo(
    () => visualizationDebugSource.targets.map(({ target }) => target.id),
    [visualizationDebugSource.targets],
  );
  const visualizationDebugCarrierTargets = useMemo(() => {
    const mapping = new Map<string, string[]>();
    const appendTarget = (carrierId: string, targetId: string) => {
      const targetIds = mapping.get(carrierId) ?? [];
      if (!targetIds.includes(targetId)) targetIds.push(targetId);
      mapping.set(carrierId, targetIds);
    };
    for (const { carrierIds, target } of visualizationDebugSource.targets) {
      for (const carrierId of carrierIds) appendTarget(carrierId, target.id);
    }
    if (visualizationDebugSource.fullFieldVector) {
      for (const { carrierIds, target } of visualizationDebugSource.targets) {
        if (carrierIds.length === 0 && target.kind !== "airbox") {
          appendTarget("fdm-domain", target.id);
        }
      }
    }
    return mapping;
  }, [visualizationDebugSource]);
  const visualizationDebugPublisher = useViewport3DVisualizationDebugPublisher({
    adoptionRegistry: visualizationDebugAdoptionRegistry,
    buildCandidate: visualizationDebugCandidateBuilder,
    carrierTargets: visualizationDebugCarrierTargets,
    controller: kernel.visualizationDebug,
    revision: [
      visualizationDebugSource.visualizationRevision ?? "none",
      sceneProps.resourceFrameKey,
    ].join("|"),
    targetIds: visualizationDebugTargetIds,
    viewportId: slotId,
  });
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
      ...(colorbarTopologyModel?.magneticParts ?? []).map((partModel) => {
        const target = resolveVisualizationTargetForMeshPart({
          part: partModel.part,
          sceneObjectIds: colorbarSceneObjectIds,
          targetRegistry: null,
        });
        return {
          id: partModel.part.id,
          label: partModel.part.label ?? partModel.part.id,
          objectScopeId: target.kind === "object" ? target.id : null,
          role: partModel.part.role ?? null,
          settings: getColorbarPartSettings(partModel.part),
          targetKind: "part" as const,
        };
      }),
      ...(colorbarTopologyModel?.airboxParts ?? []).map((partModel) => ({
        id: partModel.part.id,
        label: partModel.part.label ?? partModel.part.id,
        role: partModel.part.role ?? null,
        settings: getColorbarPartSettings(partModel.part),
        targetKind: "airbox" as const,
      })),
      ...sceneProps.fdmTargetViews.map((view) => ({
        id: view.target.id,
        label: view.target.label ?? view.target.id,
        objectScopeId: null,
        role: null,
        settings: view.settings,
        targetKind: "fdm-domain" as const,
      })),
    ],
    [
      colorbarSceneObjectIds,
      colorbarTopologyModel,
      getColorbarPartSettings,
      sceneProps.fdmTargetViews,
    ],
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
        availableQuantityIds: sceneProps.availableQuantityIds,
        fdmSettings:
          sceneProps.fdmDomain && sceneProps.fdmTargetViews.length === 0
            ? sceneProps.fdmSettings
            : null,
        parts: colorbarParts,
      }),
    [
      colorbarParts,
      sceneProps.availableQuantityIds,
      sceneProps.fdmDomain,
      sceneProps.fdmSettings,
      sceneProps.fdmTargetViews.length,
    ],
  );
  const initialColorbarPlans = useMemo(
    () =>
      planViewport3DColorbars({
        includeInspectorRanges: true,
        targets: colorbarTargetPlans,
      }),
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
        fdmTargetColorBuffers: new Map(
          sceneProps.fdmTargetViews.map((view) => [
            view.target.id,
            [view.surfaceColors, view.vectorColors],
          ]),
        ),
        fdmVectorColors: sceneProps.fdmVectorColors,
        fieldModel: sceneProps.fieldModel,
        plans: initialColorbarPlans,
      }),
    [
      initialColorbarPlans,
      sceneProps.fdmSurfaceColors,
      sceneProps.fdmTargetViews,
      sceneProps.fdmVectorColors,
      sceneProps.fieldModel,
    ],
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
    fieldIdentityCompatible: sceneProps.fdmFieldIdentityCompatible,
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
  const renderedScalarRanges = useMemo(
    () =>
      initialColorbarPlans.flatMap((plan) => {
        const range = colorbarRangeStates.get(plan.groupKey)?.range;
        if (!range) return [];
        const target = colorbarParts.find(
          (candidate) => candidate.id === plan.targetIds[0],
        );
        return buildViewport3DRenderedScalarRangeAliases({
          component: plan.colorMode,
          quantityId: plan.quantityId,
          range,
          renderedScope: {
            scopeId: plan.scopeId,
            scopeKind: plan.scopeKind,
          },
          visualizationTarget: target?.objectScopeId
            ? { id: `object:${target.objectScopeId}`, kind: "object" }
            : null,
        });
      }),
    [colorbarParts, colorbarRangeStates, initialColorbarPlans],
  );
  useEffect(() => {
    setRetainedViewport3DColorbarPlans(
      slotId,
      resolveRetainedViewport3DColorbarPlansForStore({
        fieldIdentityCompatible: sceneProps.fdmFieldIdentityCompatible,
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
    viewport3dStore.setRenderedScalarRanges(renderedScalarRanges);
  }, [
    colorbarLegends,
    colorbarTargetPlanAvailable,
    plannedColorbars,
    renderSurfaceAvailable,
    retainedColorbarPlans,
    renderedScalarRanges,
    sceneProps.fdmFieldIdentityCompatible,
    slotId,
    viewportColorbarRequested,
  ]);
  useEffect(() => () => {
    viewport3dStore.setActiveScalarColorbarLegends([]);
    viewport3dStore.setRenderedScalarRanges([]);
  }, []);
  const onVisualizationFrameCommitted = useCallback((
    revision: number,
    airboxFrameState: Viewport3DAirboxFrameState,
  ) => {
    const canvas = canvasRef.current;
    const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    visualizationDebugPublisher.onFrameCommitted(
      buildViewport3DVisualizationDebugFrameCommit({
        ...airboxFrameState,
        revision,
        slotId,
        contextLost: gl?.isContextLost() ?? null,
        drawingBuffer: gl
          ? [gl.drawingBufferWidth, gl.drawingBufferHeight]
          : null,
      }),
    );
    const ackKind = visualizationAckKindsRef.current.get(revision);
    const resourceKey = ackKind?.resourceKey ?? sceneProps.resourceFrameKey;
    const hasMatchingAdoption = !ackKind ||
      ackKind.changeKind === "style" ||
      (ackKind.dataIdentity !== null &&
        visualizationDebugAdoptionRegistry.hasActiveAdoption({
          fieldBufferId: ackKind.dataIdentity.fieldBufferId,
          resourceKey,
          sessionEpoch: ackKind.dataIdentity.sessionEpoch,
          sessionId: ackKind.dataIdentity.sessionId,
        }));
    if (hasMatchingAdoption) sendVisualizationAck({
      changeKind: ackKind?.changeKind ?? "style",
      effectiveRenderMode: visualizationEffectiveRenderMode,
      enabled: clientReady && !visualizationError,
      dataIdentity: ackKind?.dataIdentity ?? null,
      renderCommit: ackKind?.dataIdentity ?? null,
      revision,
      resourceKey,
      sessionEpoch: sessionIdentity?.sessionEpoch ?? null,
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
    sceneProps.resourceFrameKey,
    sendVisualizationAck,
    sessionIdentity?.sessionEpoch,
    sessionIdentity?.sessionId,
    slotId,
    visualizationDebugPublisher,
    visualizationDebugAdoptionRegistry,
    visualizationEffectiveRenderMode,
    visualizationError,
  ]);
  useEffect(() => {
    const revision = sceneProps.visualizationRevision;
    if (revision == null) return;
    const previous = visualizationAckRevisionRef.current;
    const changeKind = previous?.resourceFrameKey === sceneProps.resourceFrameKey
      ? "style"
      : "data";
    const resourceKey =
      visualizationDebugSource.fullFieldBufferIdentity?.resourceKey ??
      sceneProps.resourceFrameKey;
    const bufferIdentity = visualizationDebugSource.fullFieldBufferIdentity;
    const dataIdentity =
      bufferIdentity?.resourceKey &&
      bufferIdentity.sessionEpoch &&
      bufferIdentity.sessionId
        ? {
            fieldBufferId: bufferIdentity.bufferId,
            fieldRevision: bufferIdentity.fieldRevision ?? null,
            resourceKey: bufferIdentity.resourceKey,
            sessionEpoch: bufferIdentity.sessionEpoch,
            sessionId: bufferIdentity.sessionId,
            visualizationRevision: revision,
          }
        : null;
    visualizationAckRevisionRef.current = {
      resourceFrameKey: sceneProps.resourceFrameKey,
      revision,
    };
    visualizationAckKindsRef.current.set(revision, { changeKind, dataIdentity, resourceKey });
    while (visualizationAckKindsRef.current.size > 64) {
      const oldest = visualizationAckKindsRef.current.keys().next().value;
      if (oldest === undefined) break;
      visualizationAckKindsRef.current.delete(oldest);
    }
    sendVisualizationAck({
      changeKind,
      dataIdentity,
      effectiveRenderMode: visualizationEffectiveRenderMode,
      enabled: clientReady,
      error: visualizationError,
      resourceKey,
      revision,
      sessionEpoch: sessionIdentity?.sessionEpoch ?? null,
      status: visualizationError ? "failed" : changeKind === "data" ? "applied" : "rendered",
      viewportId: slotId,
    });
  }, [
    clientReady,
    sceneProps.resourceFrameKey,
    sceneProps.visualizationRevision,
    sendVisualizationAck,
    sessionIdentity?.sessionEpoch,
    slotId,
    visualizationDebugSource.fullFieldBufferIdentity?.resourceKey,
    visualizationEffectiveRenderMode,
    visualizationError,
  ]);
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
  const commitMove = useCallback(async (
    objectId: string,
    translation: ObjectTranslation,
    baseRevision: number,
  ) => {
    return commitObjectMoveWorkflow({
      api: kernel.api,
      baseRevision,
      objectId,
      onAcknowledged: () => {
        setMoveConflict(null);
        setMoveDraftResetRevision((revision) => revision + 1);
      },
      onConflict: setMoveConflict,
      resources: kernel.resources,
      translation,
    });
  }, [kernel.api, kernel.resources]);
  const rebaseMove = useCallback(() => {
    if (
      !moveConflict ||
      sceneRevision === null ||
      sceneRevision === moveConflict.baseRevision
    ) return;
    setMoveConflict(rebaseObjectMoveConflict(moveConflict, sceneRevision));
  }, [moveConflict, sceneRevision]);
  const retryMove = useCallback(async () => {
    if (!moveConflict || moveConflict.phase !== "rebased") return;
    const retry = { ...moveConflict, phase: "retrying" as const };
    setMoveConflict(retry);
    await commitMove(retry.objectId, retry.translation, retry.baseRevision);
  }, [commitMove, moveConflict]);
  const moveCanRebase = Boolean(
    moveConflict?.phase === "conflict" &&
      sceneRevision !== null &&
      sceneRevision !== moveConflict.baseRevision,
  );
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
  const visibleInspectProvenance = resolveViewport3DInspectSelectionProvenance({
    announcement: fdmSelectionAnnouncement,
    hover: visibleInspectHover,
    selectedCellOrdinal: fdmSelectionCellOrdinal,
  });
  // Expose the actually rendered Airbox carrier for the browser gate.  The
  // public target is always `airbox`; the FDM outside-support id is only the
  // field/query carrier used by the legacy single-grid path.
  const airboxRenderView = sceneProps.fdmMultilayerAirboxView;
  const airboxModel =
    airboxRenderView?.model ?? sceneProps.fdmAirboxInstanceModel;
  const airboxVectorSegments =
    airboxRenderView?.vectorSegments ?? sceneProps.fdmAirboxVectorSegments;
  const airboxDisplaySettings =
    airboxRenderView?.settings ?? sceneProps.airboxSettings;
  const airboxModelCount = airboxModel?.count ?? 0;
  const airboxVectorSegmentCount = Math.floor(
    (airboxVectorSegments?.length ?? 0) / 7,
  );
  const airboxVectorSegmentLengthRange = useMemo(
    () => resolveViewport3DVectorSegmentLengthRange(airboxVectorSegments),
    [airboxVectorSegments],
  );
  const airboxWireframeVisible = Boolean(
    airboxDisplaySettings.visible &&
      airboxDisplaySettings.wireframeVisible &&
      airboxModelCount > 0,
  );
  const airboxPointsVisible = Boolean(
    airboxDisplaySettings.visible &&
      airboxDisplaySettings.pointsVisible &&
      airboxModelCount > 0,
  );
  const airboxVectorsVisible = Boolean(
    airboxDisplaySettings.visible &&
      airboxDisplaySettings.vectorsVisible &&
      airboxVectorSegmentCount > 0,
  );

  return (
    <section
      aria-label="3D viewport"
      className="fm-viewport-3d"
      data-camera-position={sceneProps.cameraState.position.join(" ")}
      data-camera-projection={sceneProps.cameraProjection}
      data-camera-target={sceneProps.cameraState.target.join(" ")}
      data-camera-up={sceneProps.cameraState.up.join(" ")}
      data-fdm-domain-bounds={
        sceneProps.fdmDomain?.bounds
          ? JSON.stringify(sceneProps.fdmDomain.bounds)
          : ""
      }
      data-fdm-model-count={String(sceneProps.fdmInstanceModel?.count ?? 0)}
      data-fdm-vector-segment-count={String(
        Math.floor((sceneProps.fdmVectorSegments?.length ?? 0) / 7),
      )}
      data-fdm-airbox-target={airboxRenderView?.target.id ?? "airbox"}
      data-fdm-airbox-view-present={airboxRenderView ? "true" : "false"}
      data-fdm-airbox-domain-cell-count={String(
        airboxRenderView?.domain.totalCells ?? 0,
      )}
      data-fdm-airbox-build-status={sceneProps.fdmMultilayerAirboxBuildStatus}
      data-fdm-airbox-build-key={sceneProps.fdmMultilayerAirboxBuildKey ?? ""}
      data-fdm-airbox-build-error={sceneProps.fdmMultilayerAirboxBuildError ?? ""}
      data-fdm-airbox-model-count={String(airboxModelCount)}
      data-fdm-airbox-vector-segment-count={String(airboxVectorSegmentCount)}
      data-fdm-airbox-vector-length-max={String(
        airboxVectorSegmentLengthRange?.max ?? 0,
      )}
      data-fdm-airbox-vector-length-min={String(
        airboxVectorSegmentLengthRange?.min ?? 0,
      )}
      data-fdm-airbox-vector-length-scale={String(
        airboxDisplaySettings.vectorLengthScale,
      )}
      data-fdm-airbox-points-visible={airboxPointsVisible ? "true" : "false"}
      data-fdm-airbox-wireframe-visible={airboxWireframeVisible ? "true" : "false"}
      data-fdm-airbox-vectors-visible={airboxVectorsVisible ? "true" : "false"}
      data-frozen-spins-overlay-count={String(
        sceneProps.frozenSpinsOverlayModel?.renderedCount ?? 0,
      )}
      data-frozen-spins-overlay-visible={
        sceneProps.frozenSpinsOverlayVisible ? "true" : "false"
      }
      data-frozen-spins-preview-current={
        sceneProps.frozenSpinsOverlayModel?.current ? "true" : "false"
      }
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
      data-viewport-bounds={
        sceneProps.bounds ? JSON.stringify(sceneProps.bounds) : ""
      }
      data-visual-profile-id={sceneProps.visualProfileId}
      onPointerDown={() => kernel.layout.setFocusedSlot(slotId)}
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
            <Button
              aria-pressed={regionDiagnosticOverlayState.visible}
              size="sm"
              type="button"
              variant={
                regionDiagnosticOverlayState.visible ? "primary" : "secondary"
              }
              onClick={() =>
                onRegionOverlayVisibilityChange(
                  !regionDiagnosticOverlayState.visible,
                )
              }
            >
              Regions
            </Button>
            {(
              [
                ["auto", "Auto"],
                ["authored", "Authored"],
                ["realized", "Realized"],
                ["both", "Both"],
              ] as const
            ).map(([mode, label]) => (
              <Button
                key={mode}
                aria-pressed={regionDiagnosticOverlayState.source === mode}
                disabled={
                  !regionDiagnosticOverlayState.visible ||
                  (mode === "realized" &&
                    sceneProps.meshRegionOverlays.length === 0)
                }
                size="sm"
                type="button"
                variant={
                  regionDiagnosticOverlayState.source === mode
                    ? "primary"
                    : "secondary"
                }
                onClick={() => onRegionOverlaySourceChange(mode)}
              >
                {label}
              </Button>
            ))}
          </fieldset>
        ) : null}
        {sceneProps.fdmUniverseOutsideSupport ? (
          <fieldset
            aria-label="Airbox overlay"
            className="fm-viewport-3d__airbox-controls fm-viewport-3d__region-modes"
            data-target-id={sceneProps.fdmUniverseOutsideSupport.target.id}
          >
            <Button
              aria-pressed={Boolean(
                sceneProps.airboxSettings.visible,
              )}
              size="sm"
              type="button"
              variant={
                sceneProps.airboxSettings.visible
                  ? "primary"
                  : "secondary"
              }
              onClick={() =>
                onFdmUniverseOverlayVisibilityChange(
                  !sceneProps.airboxSettings.visible,
                )
              }
            >
              Airbox
            </Button>
            {sceneProps.airboxSettings.visible ? (
              <span
                aria-label={`${sceneProps.fdmUniverseOutsideSupport.legend.magneticSupport} · ${sceneProps.fdmUniverseOutsideSupport.legend.outsideSupport}`}
                className="fm-viewport-3d__airbox-legend"
                title={`${sceneProps.fdmUniverseOutsideSupport.legend.magneticSupport} · ${sceneProps.fdmUniverseOutsideSupport.legend.outsideSupport}`}
              >
                {sceneProps.fdmUniverseOutsideSupport.legend.magneticSupport}
                {" · "}
                {sceneProps.fdmUniverseOutsideSupport.legend.outsideSupport}
              </span>
            ) : null}
          </fieldset>
        ) : null}
        {sceneProps.frozenSpinsOverlayModel ? (
          <fieldset
            aria-label="Frozen Spins overlay"
            className="fm-viewport-3d__frozen-spins-controls fm-viewport-3d__region-modes"
          >
            <Button
              aria-pressed={sceneProps.frozenSpinsOverlayVisible}
              size="sm"
              type="button"
              variant={
                sceneProps.frozenSpinsOverlayVisible ? "primary" : "secondary"
              }
              onClick={() =>
                onFrozenSpinsOverlayVisibilityChange(
                  !sceneProps.frozenSpinsOverlayVisible,
                )
              }
            >
              Frozen Spins
            </Button>
            <span className="fm-viewport-3d__frozen-spins-legend">
              {sceneProps.frozenSpinsOverlayModel.renderedCount.toLocaleString("en-US")}
              /{sceneProps.frozenSpinsOverlayModel.frozenCount.toLocaleString("en-US")}
              {" frozen · "}
              {sceneProps.frozenSpinsOverlayModel.carrierKind === "fdm-cells"
                ? "FDM cells"
                : "FEM true DOFs"}
              {sceneProps.frozenSpinsOverlayModel.current
                ? " · current"
                : " · stale preview"}
            </span>
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
            adoptionRegistry={visualizationDebugAdoptionRegistry}
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
            onMoveCommit={commitMove}
            moveToolObjectId={moveTool?.objectId ?? null}
            moveDraftResetRevision={moveDraftResetRevision}
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
        <Viewport3DInspectTooltip
          hover={visibleInspectHover}
          provenance={visibleInspectProvenance}
        />
      ) : null}
      {moveConflict ? (
        <aside className="fm-viewport-3d__move-conflict" data-move-conflict={moveConflict.phase}>
          <span>Scene changed. The move draft is preserved.</span>
          <Button
            disabled={moveConflict.phase !== "conflict"}
            size="sm"
            type="button"
            variant="ghost"
            onClick={sceneRefetch}
          >
            Refetch Scene
          </Button>
          <Button
            disabled={!moveCanRebase}
            size="sm"
            type="button"
            variant="ghost"
            onClick={rebaseMove}
          >
            Rebase Draft
          </Button>
          <Button
            disabled={moveConflict.phase !== "rebased"}
            size="sm"
            type="button"
            variant="primary"
            onClick={() => void retryMove()}
          >
            Retry Move
          </Button>
        </aside>
      ) : null}
      <Viewport3DFdmSelectionAnnouncement
        announcement={fdmSelectionAnnouncement}
      />
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

type FdmCellSelectionRef = Extract<SelectionRef, { type: "fdm-cell" }>;

export interface Viewport3DFdmSelectionAnnouncementInput {
  domainGenerationId: string | null;
  fieldIdentityCompatible: boolean;
  fieldRevision: ResourceRevision | null;
  membership: FdmRegionMembershipResource | null;
  quantityId: string;
  selection: FdmCellSelectionRef | null;
}

export function resolveViewport3DInspectSelectionProvenance({
  announcement,
  hover,
  selectedCellOrdinal,
}: {
  announcement: string | null;
  hover: Viewport3DInspectHover | null;
  selectedCellOrdinal: number | null;
}): string | null {
  return hover?.sample.status === "ready" &&
    hover.sample.pointIndex === selectedCellOrdinal
    ? announcement
    : null;
}

function nonEmptyAnnouncementText(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

export function resolveViewport3DFdmSelectionAnnouncement({
  domainGenerationId,
  fieldIdentityCompatible,
  fieldRevision,
  membership,
  quantityId,
  selection,
}: Viewport3DFdmSelectionAnnouncementInput): string | null {
  if (!selection || !membership) return null;
  const membershipRevision = `${membership.mesh_revision}:${membership.region_membership_revision}`;
  if (
    membership.freshness.toLowerCase() !== "current" ||
    !membership.grid_fingerprint ||
    selection.gridFingerprint !== membership.grid_fingerprint ||
    selection.membershipRevision !== membershipRevision ||
    !/^\d+$/.test(selection.cellOrdinal) ||
    !selection.ijk.every((value) => Number.isSafeInteger(value) && value >= 0)
  ) {
    return null;
  }

  const ordinal = Number(selection.cellOrdinal);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= membership.cell_count) {
    return null;
  }

  const maskParts: string[] = [];
  if (selection.maskState === "region") {
    const region = membership.region_legend.find(
      (entry) =>
        entry.numeric_id === selection.numericRegionId &&
        entry.region_id === selection.regionId,
    );
    if (!region) return null;
    maskParts.push(
      "Mask region",
      `Region ${region.region_id}, numeric region ${region.numeric_id}`,
    );
  } else if (
    selection.maskState === "active-unassigned" &&
    selection.numericRegionId === 0 &&
    selection.regionId === null
  ) {
    maskParts.push("Mask active unassigned");
  } else {
    // Inactive cells are not rendered/pickable. Never announce an
    // inconsistent synthetic ref as current scientific identity.
    return null;
  }

  const parts = [
    "FDM cell selected",
    `Cell ${ordinal}`,
    `Grid coordinates i ${selection.ijk[0]}, j ${selection.ijk[1]}, k ${selection.ijk[2]}`,
    ...maskParts,
    `Grid fingerprint ${membership.grid_fingerprint}`,
    `Membership revision ${membershipRevision}`,
  ];
  const quantity = nonEmptyAnnouncementText(quantityId);
  if (quantity) parts.push(`Quantity ${quantity}`);
  if (fieldIdentityCompatible) {
    const currentFieldRevision = nonEmptyAnnouncementText(fieldRevision);
    const currentDomainGeneration = nonEmptyAnnouncementText(domainGenerationId);
    if (currentFieldRevision) parts.push(`Field revision ${currentFieldRevision}`);
    if (currentDomainGeneration) {
      parts.push(`Domain generation ${currentDomainGeneration}`);
    }
  }
  return `${parts.join(". ")}.`;
}

export const Viewport3DFdmSelectionAnnouncement = memo(
  function Viewport3DFdmSelectionAnnouncement({
    announcement,
  }: {
    announcement: string | null;
  }) {
    if (!announcement) return null;
    return (
      <span
        aria-atomic="true"
        aria-live="polite"
        className="fm-visually-hidden"
        role="status"
        title={announcement}
      >
        {announcement}
      </span>
    );
  },
);

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
  const fieldMeta = useFieldMetaResource({
    component: legend.colorMode ?? null,
    enabled: Boolean(!legend.range && legend.colorMode && legend.quantityId),
    quantityId: legend.quantityId ?? "m",
    scope_id: legend.scopeKind === "airbox" ? null : legend.scopeId ?? null,
    scope_kind: legend.scopeKind ?? null,
  });
  const metadataRange =
    typeof fieldMeta.data?.stats?.min === "number" &&
    typeof fieldMeta.data.stats.max === "number"
      ? {
          max: fieldMeta.data.stats.max,
          min: fieldMeta.data.stats.min,
        }
      : null;
  const range = legend.range ?? metadataRange;
  const [selectedDisplayUnit, setSelectedDisplayUnit] = useState(
    legend.displayUnit ?? "",
  );
  const displayUnitItems = displayUnitItemsForSourceUnit(legend.sourceUnit);
  const hasUnitOptions =
    Boolean(range) && hasDisplayUnitOptions(legend.sourceUnit);
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
    hasUnitOptions && range
      ? formatValueWithDisplayUnit(
          range.min,
          legend.sourceUnit,
          effectiveDisplayUnit,
        )
      : legend.minLabel;
  const maxLabel =
    hasUnitOptions && range
      ? formatValueWithDisplayUnit(
          range.max,
          legend.sourceUnit,
          effectiveDisplayUnit,
        )
      : legend.maxLabel;
  const targetLabel = legend.labelPrefix?.replace(/:\s*$/, "") ?? "";
  const componentLabel = viewport3DColorbarComponentLabel(legend.colorMode);
  const unitLabel = effectiveDisplayUnit || legend.sourceUnit || "1";
  const rangeLabel = range ? "Rendered range" : "Loading field range";
  return (
    <aside
      aria-label={`Color range: ${label}, ${minLabel} to ${maxLabel}`}
      className="fm-viewport-3d__colorbar"
    >
      <div className="fm-viewport-3d__colorbar-header">
        <div className="fm-viewport-3d__colorbar-identity">
          {targetLabel ? (
            <span className="fm-viewport-3d__colorbar-context">{targetLabel}</span>
          ) : null}
          <span className="fm-viewport-3d__colorbar-quantity">
            {legend.quantityId ?? label}
          </span>
          {componentLabel ? (
            <span className="fm-viewport-3d__colorbar-component">
              {componentLabel}
            </span>
          ) : null}
        </div>
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
        ) : (
          <span className="fm-viewport-3d__colorbar-unit" title="Display unit">
            {unitLabel}
          </span>
        )}
      </div>
      <div className="fm-viewport-3d__colorbar-range">
        <span className="fm-viewport-3d__colorbar-range-label">{rangeLabel}</span>
        <div className="fm-viewport-3d__colorbar-row">
          <span className="fm-viewport-3d__colorbar-limit">{minLabel}</span>
          <span
            aria-hidden="true"
            className="fm-viewport-3d__colorbar-ramp"
            style={{ background: legend.paletteGradient }}
          />
          <span className="fm-viewport-3d__colorbar-limit">{maxLabel}</span>
        </div>
      </div>
    </aside>
  );
});

function viewport3DColorbarComponentLabel(
  colorMode: string | undefined,
): string | null {
  switch (colorMode) {
    case "x":
      return "Component X";
    case "y":
      return "Component Y";
    case "z":
      return "Component Z";
    case "magnitude":
      return "Magnitude";
    default:
      return null;
  }
}

export const Viewport3DInspectTooltip = memo(function Viewport3DInspectTooltip({
  hover,
  provenance,
}: {
  hover: Viewport3DInspectHover;
  provenance: string | null;
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
      title={provenance ?? undefined}
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
      {provenance ? (
        <div className="fm-viewport-3d__inspect-tooltip-values">
          <span>{provenance}</span>
        </div>
      ) : null}
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
