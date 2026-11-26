import type { FdmRegionMembershipResource, ResourceRevision, VisualizationStatePatch } from "@/kernel/api/apiTypes";
import { isVisualizationAirboxIdentity, type SelectionRef } from "@/kernel/selection/selectionTypes";
import { type Viewport3DInspectSample, type Viewport3DInspectScreenPosition } from "./viewport3dInspect";
import { type HysteresisStepViewportTarget } from "./model/viewport3DTargets";
import { scalarColorBufferMatchesColorbarRequest, type Viewport3DColorbarPlan } from "./model/viewport3DColorbarPlan";
import { surfaceColorSourceToColorMode, type VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";
import { quantityUnitForColorbar, resolveCanonicalQuantityId } from "@/kernel/api/quantityIds";
import type { ScalarColorBuffer } from "./viewport3dFieldMapping";
import { type ComponentProps } from "react";
import { Viewport3DScene } from "./layers/Viewport3DScene";
import { resolveViewport3DTargetSurfaceLayerInput } from "./layers/viewport3DLayerPassInputs";
import { viewport3DColorPaletteGradientCss } from "./viewport3dVectorColoring";
import { formatDisplayUnitValue, formatValueWithDisplayUnit, normalizeDisplayUnit } from "@/shared/domain/physics/displayUnits";
import { buildViewport3DTargetRenderPlan, type Viewport3DTargetRenderPlan } from "./model/viewport3DFieldDataPlan";
import { type Viewport3DVisibleColorScales } from "./model/viewport3DVisibleColorScale";
import type { ArtifactFieldOverlayModel } from "./model/artifactFieldOverlayModel";
import type { MeshQualityColorMetric } from "./viewport3dQualityMapping";
import type { ModuleProps } from "@/kernel/types";
import { VIEWPORT_3D_WORLD_UP } from "./layers/CameraControls";
import { type Viewport3DCameraChange } from "./layers/CameraControls.model";
import { type Viewport3DVisualizationDebugFrameCommit, type Viewport3DVisualizationDebugSource } from "./hooks/useViewport3DVisualizationDebugPublisher";
import { type VisualizationDataAdoptionIdentity } from "@/kernel/visualization/useVisualizationClientAck";
import { type Viewport3DRenderAdoptionRegistry } from "./model/viewport3DRenderAdoptionRegistry";
import { type SessionResourceIdentity } from "@/kernel/resources/sessionResourceIdentity";

export function resolveViewport3DVisualizationAckDataIdentity({
  adoptionRegistry,
  sessionIdentity,
  source,
  visualizationRevision,
}: {
  adoptionRegistry: Viewport3DRenderAdoptionRegistry;
  sessionIdentity: SessionResourceIdentity | null;
  source: Viewport3DVisualizationDebugSource;
  visualizationRevision: number;
}): VisualizationDataAdoptionIdentity | null {
  if (sessionIdentity?.sessionEpoch && sessionIdentity.sessionId) {
    const receipt = adoptionRegistry.latestActiveAdoption({
      sessionEpoch: sessionIdentity.sessionEpoch,
      sessionId: sessionIdentity.sessionId,
    });
    if (receipt?.fieldBufferId && receipt.resourceKey) {
      const fieldRevision = [...(source.fieldModel?.targetPasses.values() ?? [])]
        .map((renderPass) => renderPass.fieldBuffer)
        .find((fieldBuffer) => fieldBuffer?.bufferId === receipt.fieldBufferId)
        ?.fieldRevision ?? null;
      return {
        fieldBufferId: receipt.fieldBufferId,
        fieldRevision,
        resourceKey: receipt.resourceKey,
        sessionEpoch: receipt.sessionEpoch,
        sessionId: receipt.sessionId,
        visualizationRevision,
      };
    }
  }
  const fallback = source.fullFieldBufferIdentity;
  if (
    !fallback?.bufferId ||
    !fallback.resourceKey ||
    !fallback.sessionEpoch ||
    !fallback.sessionId
  ) return null;
  return {
    fieldBufferId: fallback.bufferId,
    fieldRevision: fallback.fieldRevision ?? null,
    resourceKey: fallback.resourceKey,
    sessionEpoch: fallback.sessionEpoch,
    sessionId: fallback.sessionId,
    visualizationRevision,
  };
}

export function resolveViewport3DVisualizationFrameAck({
  committedDataIdentity,
  registeredChangeKind,
}: {
  committedDataIdentity: VisualizationDataAdoptionIdentity | null;
  registeredChangeKind: "data" | "style" | null;
}): {
  changeKind: "data" | "style";
  dataIdentity: VisualizationDataAdoptionIdentity | null;
} {
  const changeKind = registeredChangeKind ??
    (committedDataIdentity ? "data" : "style");
  return {
    changeKind,
    dataIdentity: changeKind === "data" ? committedDataIdentity : null,
  };
}

export function resolveViewport3DVisualizationAckRegistration({
  existing,
  previousResourceFrameKey,
  resourceFrameKey,
  resourceKey,
}: {
  existing: { changeKind: "data" | "style"; resourceKey: string } | null;
  previousResourceFrameKey: string | null;
  resourceFrameKey: string;
  resourceKey: string;
}): { changeKind: "data" | "style"; resourceKey: string } {
  if (existing) return existing;
  return {
    changeKind: previousResourceFrameKey === resourceFrameKey ? "style" : "data",
    resourceKey,
  };
}

export type Viewport3DSceneProps = ComponentProps<typeof Viewport3DScene>;

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

export interface MeshQualityRange {
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

export interface Viewport3DColorbarLegend {
  colorMode?: string;
  displayUnit?: string;
  label: string;
  labelPrefix?: string;
  maxLabel: string;
  minLabel: string;
  paletteGradient: string;
  quantityId?: string;
  rangeSource?: NonNullable<ScalarColorBuffer["rangeSource"]>;
  range?: MeshQualityRange | null;
  rangeState?: Viewport3DColorbarPlan["rangeState"];
  scopeId?: string | null;
  scopeKind?: Viewport3DColorbarPlan["scopeKind"];
  sourceUnit?: string | null;
}

interface Viewport3DScopedColorbarLegend {
  key: string;
  legend: Viewport3DColorbarLegend;
}

export interface Viewport3DColorbarTargetPart {
  id: string;
  label: string;
  objectScopeId?: string | null;
  role?: string | null;
  settings: VisualizationTargetSettings;
  targetKind: Viewport3DTargetRenderPlan["targetKind"];
}

export interface Viewport3DInspectHover {
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

export function formatViewport3DColorbarQuantityLabel({
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

/** Each historical pass uses its own actual projection and finite payload range. */
export function resolveArtifactFieldColorbars(model: ArtifactFieldOverlayModel | null): Viewport3DScopedColorbarLegend[] {
  if (!model || !model.settings.visible || !model.settings.viewportColorbarVisible) return [];
  const result: Viewport3DScopedColorbarLegend[] = [];
  const append = (pass: string, mode: string, min: number, max: number) => {
    const legend = resolveViewport3DColorbarLegend({ colorMode: mode, colorPalette: model.settings.scalarColorPalette,
      quantityId: model.quantityId, unit: model.unit, range: { min, max } });
    if (legend) result.push({ key: `${model.key}:${pass}`, legend: { ...legend, labelPrefix: `Historical ${pass}: ` } });
  };
  if (model.settings.shaderVisible && model.settings.surfaceColorSource !== "solid") append("surface", model.scalar ? "scalar" : model.settings.shaderColorMode, model.minimum, model.maximum);
  if (!model.scalar && model.settings.vectorsVisible && model.glyphCount > 0 && model.vectorColorRange) append("vectors", model.settings.vectorColorMode, model.vectorColorRange.min, model.vectorColorRange.max);
  return result;
}

/** Saved surface and glyph colors may use different components and scales. */
export function resolveSavedFieldColorbars({ scales, scopeKey, settings, quantityId, unit }: {
  scales: Viewport3DVisibleColorScales;
  scopeKey: string | null;
  settings: VisualizationTargetSettings;
  quantityId: string;
  unit: string | null;
}): Viewport3DScopedColorbarLegend[] {
  if (!scopeKey || scales.scopeKey !== scopeKey || !settings.visible || !settings.viewportColorbarVisible) return [];
  const result: Viewport3DScopedColorbarLegend[] = [];
  for (const pass of ["surface", "vectors"] as const) {
    if (pass === "surface" ? !settings.shaderVisible || settings.surfaceColorSource === "solid" : !settings.vectorsVisible) continue;
    const scale = scales.passes[pass]?.scale;
    if (!scale || scale.quantityId !== quantityId) continue;
    const legend = resolveViewport3DColorbarLegend({ colorMode: scale.colorMode,
      colorPalette: scale.colorPalette, quantityId: scale.quantityId, unit, range: scale.range });
    if (!legend) continue;
    const matching = result.find(item => item.legend.colorMode === legend.colorMode &&
      item.legend.paletteGradient === legend.paletteGradient &&
      item.legend.range?.min === scale.range.min && item.legend.range?.max === scale.range.max);
    if (matching) matching.legend.labelPrefix = "Saved surface / vectors: ";
    else result.push({ key: `saved:${pass}:${scale.colorMode}`, legend: { ...legend, labelPrefix: `Saved ${pass}: ` } });
  }
  return result;
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
      rangeSource: plan.rangeSource,
      range: plan.range,
      rangeState: plan.rangeState,
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
  analysisOverlayQuantityId,
  availableQuantityIds,
  fdmSettings,
  parts,
}: {
  analysisOverlayQuantityId?: string | null;
  availableQuantityIds?: ReadonlySet<string> | null;
  fdmSettings?: VisualizationTargetSettings | null;
  parts: readonly Viewport3DColorbarTargetPart[];
}): Viewport3DTargetRenderPlan[] {
  const targets: Viewport3DTargetRenderPlan[] = [];
  for (const part of parts) {
    // Analysis artifacts supply the displayed magnetic quantity independently
    // of the target's live field catalog and projection.
    const overlayQuantityId = part.targetKind === "part" ? analysisOverlayQuantityId : null;
    const quantityId = overlayQuantityId || part.settings.activeQuantityId;
    if (
      !isViewport3DColorbarTargetPartEligible(part) ||
      (!overlayQuantityId &&
        !viewport3DColorbarQuantityAvailable(quantityId, availableQuantityIds))
    ) {
      continue;
    }
    targets.push(
      buildViewport3DTargetRenderPlan({
        label: part.label,
        quantityId,
        settings: overlayQuantityId ? { ...part.settings, tensorProjection: null } : part.settings,
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

export const EMPTY_VIEWPORT_3D_COLORBAR_PLANS: readonly Viewport3DColorbarPlan[] = [];

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
