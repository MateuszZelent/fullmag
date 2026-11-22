import { useCallback, useMemo, useSyncExternalStore } from "react";

import type {
  FdmMultilayerLayoutResource,
  RegionDiagnosticsResource,
  RegionListResource,
  SceneResource,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import * as geometryLifecycleResources from "@/kernel/resources/geometryLifecycleResources";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import * as sessionStatusHooks from "@/kernel/resources/useSessionStatus";
import {
  airboxLocalVisualizationPatchFromTargetPatch,
  airboxVisualizationStatePatchFromTargetPatch,
  hasVisualizationStatePatch,
  mergeVisualizationStateTargetOverride,
  persistentVisualizationTargetPatch,
  resetAirboxVisualizationState,
  resolveTargetVisualization,
  visualizationTargetKey,
  type ObjectVisualizationSnapshot,
  type VisualizationTargetPatch,
  type VisualizationTargetRef,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
import {
  EMPTY_OBJECT_VISUALIZATION_SNAPSHOT,
  useObjectVisualizationController,
} from "@/kernel/visualization/useObjectVisualization";

import {
  scalarColorPalettePatch,
  visualizationOverridesForTargetReset,
} from "../../../panels/ObjectVisualizationPanelModel";

export type FdmLayerLayoutResource = NonNullable<
  FdmMultilayerLayoutResource["layers"]
>[number];

export const ELEMENTARY_CHARGE_J = 1.602176634e-19;

export type LengthDisplayUnit = "nm" | "µm" | "mm" | "m";

export const UNIT_SCALE: Readonly<Record<LengthDisplayUnit, number>> = {
  m: 1,
  mm: 1e3,
  nm: 1e9,
  "µm": 1e6,
};

// Safe optional resource hook accessors for partial test harnesses
export const useDomainMetaResourceSafe =
  geometryLifecycleResources.useDomainMetaResource;
export const useFdmMultilayerLayoutResourceSafe =
  geometryLifecycleResources.useFdmMultilayerLayoutResource;
export const useFdmRegionMembershipResourceSafe =
  geometryLifecycleResources.useFdmRegionMembershipResource;
export const useFdmRegionMembershipBinaryResourceSafe =
  geometryLifecycleResources.useFdmRegionMembershipBinaryResource ??
  (() => ({
    availability: { reason: "loading" as const, status: "pending" as const },
    data: null,
    error: null,
    refetch: () => undefined,
    revision: null,
    status: "idle" as const,
  }));
export const useFdmMultilayerLayerActiveMasksResourceSafe =
  geometryLifecycleResources.useFdmMultilayerLayerActiveMasksResource ??
  (() => ({
    data: null,
    error: null,
    refetch: () => undefined,
    revision: null,
    status: "idle" as const,
  }));
export const useSceneResourceSafe =
  geometryLifecycleResources.useSceneResource ??
  ((): ResourceResult<SceneResource> & { sessionScopeKey: string | null } => ({
    data: null,
    error: null,
    refetch: () => undefined,
    revision: null,
    sessionScopeKey: null,
    status: "idle" as const,
  }));

export function useSessionStatusDataSafe(): unknown {
  const kernel = useKernel();
  const enabled = Boolean(
    (kernel?.api as { sessions?: { current?: { status?: unknown } } } | undefined)
      ?.sessions?.current?.status,
  );
  const hook = sessionStatusHooks.useSessionStatusSelector;
  if (typeof hook === "function") {
    return hook((status) => status.data ?? null, { enabled });
  }
  return null;
}

export function useSessionScopeKeySafe(): string | null {
  const kernel = useKernel();
  return kernel.commands?.getSessionScopeKey?.() ?? null;
}

export const useModelRegionsResourceSafe =
  geometryLifecycleResources.useModelRegionsResource ??
  ((): ResourceResult<RegionListResource> => ({
    data: null,
    error: null,
    refetch: () => undefined,
    revision: null,
    status: "idle" as const,
  }));
export const useModelRegionDiagnosticsResourceSafe =
  geometryLifecycleResources.useModelRegionDiagnosticsResource ??
  ((): ResourceResult<RegionDiagnosticsResource> => ({
    data: null,
    error: null,
    refetch: () => undefined,
    revision: null,
    status: "idle" as const,
  }));
export const useVisualizationStateResourceSafe =
  geometryLifecycleResources.useVisualizationStateResource ??
  (() => ({
    data: null as VisualizationStateResource | null,
    error: null,
    optimisticData: null as VisualizationStateResource | null,
    rawData: null as VisualizationStateResource | null,
    refetch: () => undefined,
    revision: null,
    status: "idle" as const,
  }));

export function fmtTuple3(
  tuple: readonly [number, number, number] | readonly number[],
  unit: LengthDisplayUnit,
): string {
  const mult = UNIT_SCALE[unit];
  const a = Number(((tuple[0] ?? 0) * mult).toFixed(3));
  const b = Number(((tuple[1] ?? 0) * mult).toFixed(3));
  const c = Number(((tuple[2] ?? 0) * mult).toFixed(3));
  return `${a} × ${b} × ${c} ${unit}`;
}

export function fmtCoord3(
  tuple: readonly [number, number, number] | readonly number[],
  unit: LengthDisplayUnit,
): string {
  const mult = UNIT_SCALE[unit];
  const a = Number(((tuple[0] ?? 0) * mult).toFixed(2));
  const b = Number(((tuple[1] ?? 0) * mult).toFixed(2));
  const c = Number(((tuple[2] ?? 0) * mult).toFixed(2));
  return `(${a}, ${b}, ${c}) ${unit}`;
}

export function tuple3OrNull(
  values: readonly number[] | null | undefined,
): [number, number, number] | null {
  if (!values || values.length < 3) return null;
  const a = values[0];
  const b = values[1];
  const c = values[2];
  if (
    typeof a !== "number" ||
    typeof b !== "number" ||
    typeof c !== "number" ||
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    !Number.isFinite(c)
  ) {
    return null;
  }
  return [a, b, c];
}

export function sameTupleApprox(
  left: readonly number[] | null | undefined,
  right: readonly [number, number, number],
): boolean {
  const parsed = tuple3OrNull(left);
  if (!parsed) return false;
  return parsed.every((val, idx) => {
    const scale = Math.max(1, Math.abs(val), Math.abs(right[idx]));
    return Math.abs(val - right[idx]) <= 1e-12 * scale;
  });
}

export function sanitizeDisplayReason(
  raw: string | null | undefined,
  fallback: string,
): string {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  return trimmed
    .replace(/\bunavailable\b/gi, "not published")
    .replace(/\bunknown\b/gi, "unverified")
    .replace(/\bn\/a\b/gi, "not applicable");
}

// ============================================================================
// Shared Live 3D Visualization Target Binding (ObjectVisualizationController + Sync)
// ============================================================================

export interface FdmTargetVizFields {
  visible: boolean;
  boundsVisible: boolean;
  renderMode: "surface" | "surface+edges" | "wireframe" | "points" | "off";
  surfaceOpacityPercent: number;
  wireframeOpacityPercent: number;
  activeQuantityId: string;
  scalarColorPalette: string;
  vectorsVisible: boolean;
  vectorBudget: number;
}

export const FDM_VIZ_FIELD_KEYS = new Set<string>([
  "visible",
  "boundsVisible",
  "renderMode",
  "surfaceOpacityPercent",
  "wireframeOpacityPercent",
  "activeQuantityId",
  "scalarColorPalette",
  "vectorsVisible",
  "vectorBudget",
]);

function deriveRenderModeFromVizSettings(
  settings: Partial<VisualizationTargetSettings> | null | undefined,
  defaultMode: FdmTargetVizFields["renderMode"],
): FdmTargetVizFields["renderMode"] {
  if (!settings) return defaultMode;
  if (settings.pointsVisible && !settings.shaderVisible) return "points";
  if (settings.wireframeVisible && settings.shaderVisible) return "surface+edges";
  if (settings.wireframeVisible) return "wireframe";
  if (settings.shaderVisible) return "surface";
  if (
    settings.shaderVisible === false &&
    settings.wireframeVisible === false &&
    settings.pointsVisible === false
  ) {
    return "off";
  }
  return defaultMode;
}

function buildTargetPatchFromVizFields(
  fields: FdmTargetVizFields,
  isAirboxTarget: boolean,
): VisualizationTargetPatch {
  if (isAirboxTarget) {
    const wireframeVisible = fields.renderMode === "wireframe";
    const pointsVisible = fields.renderMode === "points";
    return {
      activeQuantityId:
        fields.activeQuantityId === "solid" ? "H_demag" : fields.activeQuantityId,
      boundsVisible: fields.boundsVisible,
      pointsVisible,
      renderMode: pointsVisible ? "points" : wireframeVisible ? "wireframe" : "off",
      vectorBudget: fields.vectorBudget,
      vectorsVisible: fields.vectorsVisible,
      visible: fields.visible,
      wireframeOpacityPercent: fields.wireframeOpacityPercent,
      wireframeVisible,
    };
  }
  const shaderVisible =
    fields.renderMode === "surface" || fields.renderMode === "surface+edges";
  const wireframeVisible =
    fields.renderMode === "wireframe" || fields.renderMode === "surface+edges";
  const pointsVisible = fields.renderMode === "points";
  return {
    activeQuantityId: fields.activeQuantityId === "solid" ? "m" : fields.activeQuantityId,
    boundsVisible: fields.boundsVisible,
    pointsVisible,
    renderMode: fields.renderMode,
    shaderVisible,
    surfaceColorSource: fields.activeQuantityId === "solid" ? "solid" : "colormap",
    surfaceOpacityPercent: fields.surfaceOpacityPercent,
    ...scalarColorPalettePatch(fields.scalarColorPalette),
    vectorBudget: fields.vectorBudget,
    vectorsVisible: fields.vectorsVisible,
    visible: fields.visible,
    wireframeOpacityPercent: fields.wireframeOpacityPercent,
    wireframeVisible,
  };
}

export function hasVizDraftChanges(
  a: FdmTargetVizFields,
  b: FdmTargetVizFields,
): boolean {
  return (
    a.visible !== b.visible ||
    a.boundsVisible !== b.boundsVisible ||
    a.renderMode !== b.renderMode ||
    a.surfaceOpacityPercent !== b.surfaceOpacityPercent ||
    a.wireframeOpacityPercent !== b.wireframeOpacityPercent ||
    a.activeQuantityId !== b.activeQuantityId ||
    a.scalarColorPalette !== b.scalarColorPalette ||
    a.vectorsVisible !== b.vectorsVisible ||
    a.vectorBudget !== b.vectorBudget
  );
}

export function useSafeFdmTargetVisualization(
  target: VisualizationTargetRef | null,
  defaultMode: FdmTargetVizFields["renderMode"],
  defaultQuantityId: string,
) {
  const kernel = useKernel();
  const controller = useObjectVisualizationController();
  const visualizationState = useVisualizationStateResourceSafe({
    enabled: target !== null,
  });

  const subscribeViz = useCallback(
    (onStoreChange: () => void) =>
      typeof controller?.subscribe === "function"
        ? controller.subscribe(onStoreChange)
        : () => undefined,
    [controller],
  );
  const getVizSnapshot = useCallback(
    (): ObjectVisualizationSnapshot =>
      typeof controller?.getSnapshot === "function"
        ? controller.getSnapshot()
        : EMPTY_OBJECT_VISUALIZATION_SNAPSHOT,
    [controller],
  );
  const vizSnapshot = useSyncExternalStore(
    subscribeViz,
    getVizSnapshot,
    getVizSnapshot,
  );

  const displayVisualizationState =
    visualizationState.optimisticData ?? visualizationState.data ?? null;

  const hasSnapshotDefaults = Boolean(
    vizSnapshot &&
      typeof vizSnapshot === "object" &&
      "defaults" in vizSnapshot &&
      vizSnapshot.defaults,
  );

  const targetVisualization = useMemo(
    () =>
      target && hasSnapshotDefaults
        ? resolveTargetVisualization({
            snapshot: vizSnapshot,
            target,
            visualizationState: displayVisualizationState,
          })
        : null,
    [displayVisualizationState, hasSnapshotDefaults, target, vizSnapshot],
  );

  const settings = targetVisualization?.settings ?? null;
  const isAirboxTarget = target?.kind === "airbox";

  const hydratedVizFields = useMemo<FdmTargetVizFields>(
    () => ({
      activeQuantityId: isAirboxTarget
        ? (settings?.activeQuantityId || defaultQuantityId)
        : settings?.surfaceColorSource === "solid"
          ? "solid"
          : (settings?.activeQuantityId || defaultQuantityId),
      boundsVisible: settings?.boundsVisible ?? isAirboxTarget,
      renderMode: deriveRenderModeFromVizSettings(settings, defaultMode),
      scalarColorPalette: settings?.scalarColorPalette ?? "viridis",
      surfaceOpacityPercent: settings?.surfaceOpacityPercent ?? 100,
      vectorBudget: settings?.vectorBudget ?? 1200,
      vectorsVisible: settings?.vectorsVisible ?? false,
      visible: settings?.visible ?? true,
      wireframeOpacityPercent:
        settings?.wireframeOpacityPercent ?? (isAirboxTarget ? 55 : 100),
    }),
    [defaultMode, defaultQuantityId, isAirboxTarget, settings],
  );

  const applyVizPatch = useCallback(
    (fields: FdmTargetVizFields) => {
      if (!target) return;
      const patchValue = buildTargetPatchFromVizFields(fields, isAirboxTarget);
      const targetKey = visualizationTargetKey(target);
      const baseRevision =
        visualizationState.rawData?.revision ??
        visualizationState.data?.revision ??
        0;

      if (isAirboxTarget) {
        const localPatch =
          airboxLocalVisualizationPatchFromTargetPatch(patchValue);
        if (Object.keys(localPatch).length > 0) {
          controller?.patchViewportPreferences?.(target, localPatch);
        }
        const statePatch = airboxVisualizationStatePatchFromTargetPatch(
          patchValue,
          displayVisualizationState?.overrides,
        );
        if (!hasVisualizationStatePatch(statePatch)) return;
        const receipt = kernel?.visualizationSync?.queuePatch?.(statePatch, [
          targetKey,
        ]);
        if (receipt) {
          controller?.patchTargetPending?.(
            target,
            persistentVisualizationTargetPatch(patchValue),
            baseRevision,
            receipt.transactionId,
          );
        }
        return;
      }

      const remotePatch = persistentVisualizationTargetPatch(patchValue);
      if (Object.keys(remotePatch).length === 0) return;
      const overrides = mergeVisualizationStateTargetOverride(
        displayVisualizationState?.overrides ?? [],
        target,
        remotePatch,
      );
      const receipt = kernel?.visualizationSync?.queuePatch?.(
        { overrides },
        [targetKey],
      );
      if (receipt) {
        controller?.patchTargetPending?.(
          target,
          remotePatch,
          baseRevision,
          receipt.transactionId,
        );
      }
    },
    [
      controller,
      displayVisualizationState?.overrides,
      isAirboxTarget,
      kernel?.visualizationSync,
      target,
      visualizationState.data?.revision,
      visualizationState.rawData?.revision,
    ],
  );

  const resetVizTarget = useCallback(() => {
    if (!target) return;
    const targetKey = visualizationTargetKey(target);
    const fallbackState = displayVisualizationState ?? { overrides: [] };
    if (isAirboxTarget) {
      kernel?.visualizationSync?.queuePatch?.(
        resetAirboxVisualizationState(fallbackState),
        [targetKey],
      );
      controller?.clearTarget?.(target);
      return;
    }
    kernel?.visualizationSync?.queuePatch?.(
      {
        overrides: visualizationOverridesForTargetReset(fallbackState, target),
      },
      [targetKey],
    );
    controller?.clearTarget?.(target);
  }, [
    controller,
    displayVisualizationState,
    isAirboxTarget,
    kernel?.visualizationSync,
    target,
  ]);

  return {
    applyVizPatch,
    hasPersistedOverride: Boolean(targetVisualization?.override),
    hydratedVizFields,
    isAirboxTarget,
    resetVizTarget,
  };
}
