"use client";

import {
  Activity,
  Atom,
  Box,
  Compass,
  Eye,
  Grid3x3,
  History,
  Layers,
  RefreshCw,
  Ruler,
  ShieldCheck,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  DATA_DOMAIN_META_PATH,
  DATA_FIELDS_PATH,
} from "@/kernel/api/apiPaths";
import type {
  DomainMetaResource,
  FdmMultilayerLayoutResource,
  FdmRegionMembershipResource,
  RegionDiagnosticsResource,
  RegionListResource,
  SceneResource,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";

type FdmLayerLayoutResource = NonNullable<
  FdmMultilayerLayoutResource["layers"]
>[number];
import type { DecodedFdmRegionMembership } from "@/kernel/api/codecs/fdmRegionMembershipCodec";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  fdmCellCenter,
  useFdmCellPhysicsResource,
  type FdmCellPhysicsTarget,
  type FdmCellQuantitySample,
} from "@/kernel/resources/fdmCellPhysicsResources";
import * as geometryLifecycleResources from "@/kernel/resources/geometryLifecycleResources";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import type {
  FdmCellMaskState,
  FdmDomainSelectionScope,
  Selection,
  SelectionRef,
} from "@/kernel/selection/selectionTypes";
import {
  AIRBOX_VISUALIZATION_TARGET,
  airboxLocalVisualizationPatchFromTargetPatch,
  airboxVisualizationStatePatchFromTargetPatch,
  hasVisualizationStatePatch,
  mergeVisualizationStateTargetOverride,
  persistentVisualizationTargetPatch,
  resetAirboxVisualizationState,
  resolveTargetVisualization,
  resolveVisualizationTargetFromSelection,
  targetForFdmNativeLayer,
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
  FMRM_INACTIVE_REGION_ID,
  resolveFdmCellState,
} from "@/shared/domain/mesh/domainPresentation";
import { resolveFdmDisplaySampling } from "@/shared/domain/mesh/fdmDisplaySampling";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type {
  InspectorActionContext,
  InspectorNotice,
  InspectorRowSpec,
  InspectorSpec,
  InspectorTone,
} from "../../template";
import {
  scalarColorPalettePatch,
  visualizationOverridesForTargetReset,
} from "../ObjectVisualizationPanelModel";
import { SpecInspectorHost } from "../mesh-details/SpecInspectorHost";
import type { FdmGridLegendEntry } from "./fdmGridInspectorModel";

const ELEMENTARY_CHARGE_J = 1.602176634e-19;

type LengthDisplayUnit = "nm" | "µm" | "mm" | "m";

const UNIT_SCALE: Readonly<Record<LengthDisplayUnit, number>> = {
  m: 1,
  mm: 1e3,
  nm: 1e9,
  "µm": 1e6,
};

// Safe optional resource hook accessors for partial test harnesses
const useDomainMetaResourceSafe =
  geometryLifecycleResources.useDomainMetaResource;
const useFdmMultilayerLayoutResourceSafe =
  geometryLifecycleResources.useFdmMultilayerLayoutResource;
const useFdmRegionMembershipResourceSafe =
  geometryLifecycleResources.useFdmRegionMembershipResource;
const useFdmRegionMembershipBinaryResourceSafe =
  geometryLifecycleResources.useFdmRegionMembershipBinaryResource ??
  (() => ({
    availability: { reason: "loading" as const, status: "pending" as const },
    data: null,
    error: null,
    refetch: () => undefined,
    revision: null,
    status: "idle" as const,
  }));
const useFdmMultilayerLayerActiveMasksResourceSafe =
  geometryLifecycleResources.useFdmMultilayerLayerActiveMasksResource ??
  (() => ({
    data: null,
    error: null,
    refetch: () => undefined,
    revision: null,
    status: "idle" as const,
  }));
const useSceneResourceSafe =
  geometryLifecycleResources.useSceneResource ??
  ((): ResourceResult<SceneResource> & { sessionScopeKey: string | null } => ({
    data: null,
    error: null,
    refetch: () => undefined,
    revision: null,
    sessionScopeKey: null,
    status: "idle" as const,
  }));
const useModelRegionsResourceSafe =
  geometryLifecycleResources.useModelRegionsResource ??
  ((): ResourceResult<RegionListResource> => ({
    data: null,
    error: null,
    refetch: () => undefined,
    revision: null,
    status: "idle" as const,
  }));
const useModelRegionDiagnosticsResourceSafe =
  geometryLifecycleResources.useModelRegionDiagnosticsResource ??
  ((): ResourceResult<RegionDiagnosticsResource> => ({
    data: null,
    error: null,
    refetch: () => undefined,
    revision: null,
    status: "idle" as const,
  }));
const useVisualizationStateResourceSafe =
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

function fmtTuple3(
  tuple: readonly [number, number, number] | readonly number[],
  unit: LengthDisplayUnit,
): string {
  const mult = UNIT_SCALE[unit];
  const a = Number(((tuple[0] ?? 0) * mult).toFixed(3));
  const b = Number(((tuple[1] ?? 0) * mult).toFixed(3));
  const c = Number(((tuple[2] ?? 0) * mult).toFixed(3));
  return `${a} × ${b} × ${c} ${unit}`;
}

function fmtCoord3(
  tuple: readonly [number, number, number] | readonly number[],
  unit: LengthDisplayUnit,
): string {
  const mult = UNIT_SCALE[unit];
  const a = Number(((tuple[0] ?? 0) * mult).toFixed(2));
  const b = Number(((tuple[1] ?? 0) * mult).toFixed(2));
  const c = Number(((tuple[2] ?? 0) * mult).toFixed(2));
  return `(${a}, ${b}, ${c}) ${unit}`;
}

function tuple3OrNull(
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

function sameTupleApprox(
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

function sanitizeDisplayReason(raw: string | null | undefined, fallback: string): string {
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

interface FdmTargetVizFields {
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

const FDM_VIZ_FIELD_KEYS = new Set<string>([
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

function hasVizDraftChanges(a: FdmTargetVizFields, b: FdmTargetVizFields): boolean {
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

function useSafeFdmTargetVisualization(
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

// ============================================================================
// 1. mesh.grid — FdmGridInspectorSpecPanel (Consolidates 10 grid sub-routes)
// ============================================================================

interface FdmGridDraft extends FdmTargetVizFields {
  displayUnit: LengthDisplayUnit;
}

interface ValidatedSupportSummary {
  activeCellCount: number;
  activeAssignedCellCount: number;
  activeUnassignedCellCount: number;
  inactiveCellCount: number;
  boundsMinM: [number, number, number];
  boundsMaxM: [number, number, number];
}

function resolveValidatedMagneticSupport(
  membership: FdmRegionMembershipResource | null | undefined,
): ValidatedSupportSummary | null {
  const support = membership?.magnetic_support;
  if (!membership || !support) return null;
  if (
    support.semantic_role !== "magnetic-support" ||
    support.grid_fingerprint !== membership.grid_fingerprint
  ) {
    return null;
  }
  const boundsMinM = tuple3OrNull(support.bounds_min_m);
  const boundsMaxM = tuple3OrNull(support.bounds_max_m);
  if (
    !boundsMinM ||
    !boundsMaxM ||
    boundsMinM.some((val, idx) => val > boundsMaxM[idx])
  ) {
    return null;
  }
  if (
    !Number.isSafeInteger(support.active_cell_count) ||
    support.active_cell_count < 0 ||
    !Number.isSafeInteger(support.active_unassigned_cell_count) ||
    support.active_unassigned_cell_count < 0 ||
    !Number.isSafeInteger(support.inactive_cell_count) ||
    support.inactive_cell_count < 0 ||
    support.active_unassigned_cell_count > support.active_cell_count
  ) {
    return null;
  }
  if (
    typeof membership.cell_count === "number" &&
    support.active_cell_count + support.inactive_cell_count !==
      membership.cell_count
  ) {
    return null;
  }
  return {
    activeAssignedCellCount: Math.max(
      0,
      support.active_cell_count - support.active_unassigned_cell_count,
    ),
    activeCellCount: support.active_cell_count,
    activeUnassignedCellCount: support.active_unassigned_cell_count,
    boundsMaxM,
    boundsMinM,
    inactiveCellCount: support.inactive_cell_count,
  };
}

function checkFdmMembershipCompatible(
  domain: DomainMetaResource | null | undefined,
  membership: FdmRegionMembershipResource | null | undefined,
  shape: readonly [number, number, number],
  origin: readonly [number, number, number],
  spacing: readonly [number, number, number],
  totalCells: number,
): boolean {
  if (!membership) return false;
  if ((membership.freshness ?? "current").trim().toLowerCase() !== "current") {
    return false;
  }
  if (
    domain?.generation_id &&
    membership.domain_generation_id &&
    membership.domain_generation_id !== domain.generation_id
  ) {
    return false;
  }
  if (
    Array.isArray(membership.counts) &&
    (membership.counts.length < 3 ||
      membership.counts[0] !== shape[0] ||
      membership.counts[1] !== shape[1] ||
      membership.counts[2] !== shape[2])
  ) {
    return false;
  }
  if (
    typeof membership.cell_count === "number" &&
    totalCells > 0 &&
    membership.cell_count !== totalCells
  ) {
    return false;
  }
  if (
    Array.isArray(membership.origin_m) &&
    !sameTupleApprox(membership.origin_m, origin)
  ) {
    return false;
  }
  if (
    Array.isArray(membership.cell_m) &&
    !sameTupleApprox(membership.cell_m, spacing)
  ) {
    return false;
  }
  return true;
}

function resolveGridSubScope(selection: Selection): {
  scope: FdmDomainSelectionScope;
  regionId: string | null;
  ownerObjectId: string | null;
} {
  const ref = selection.ref;
  if (ref?.type === "fdm-domain") {
    const scope =
      ref.kind === "mesh.grid.common" ? "common" : ref.scope;
    return {
      ownerObjectId: ref.objectId?.trim() || selection.objectId?.trim() || null,
      regionId: ref.regionId?.trim() || null,
      scope,
    };
  }
  const kind = selection.kind ?? "";
  if (kind === "mesh.grid.universe-outside-support" || selection.nodeId?.endsWith(":universe-outside-support")) {
    return { ownerObjectId: null, regionId: null, scope: "universe-outside-support" };
  }
  if (kind === "mesh.grid.common" || selection.nodeId?.endsWith(":common")) {
    return { ownerObjectId: null, regionId: null, scope: "common" };
  }
  if (kind === "mesh.grid.magnetic-support" || selection.nodeId?.endsWith(":magnetic-support")) {
    return { ownerObjectId: null, regionId: null, scope: "magnetic-support" };
  }
  if (kind === "mesh.grid.active-unassigned" || selection.nodeId?.endsWith(":active-unassigned")) {
    return { ownerObjectId: null, regionId: null, scope: "active-unassigned" };
  }
  if (kind === "mesh.grid.mask" || selection.nodeId?.endsWith(":mask")) {
    return { ownerObjectId: null, regionId: null, scope: "mask" };
  }
  if (kind === "mesh.grid.provenance" || selection.nodeId?.endsWith(":provenance")) {
    return { ownerObjectId: null, regionId: null, scope: "provenance" };
  }
  if (kind === "mesh.grid.descriptor" || selection.nodeId?.endsWith(":descriptor")) {
    return { ownerObjectId: null, regionId: null, scope: "descriptor" };
  }
  if (kind === "mesh.grid.layers" || selection.nodeId?.endsWith(":layers")) {
    return { ownerObjectId: null, regionId: null, scope: "layers" };
  }
  const genericRef = (ref ?? null) as {
    objectId?: string;
    regionId?: string;
    scope?: FdmDomainSelectionScope;
  } | null;
  if (kind === "mesh.grid.region" || genericRef?.regionId || selection.nodeId?.includes(":region:")) {
    const parsedFromNode = selection.nodeId?.includes(":region:")
      ? decodeURIComponent(selection.nodeId.split(":region:")[1] ?? "")
      : null;
    return {
      ownerObjectId:
        genericRef?.objectId?.trim() || selection.objectId?.trim() || null,
      regionId: genericRef?.regionId?.trim() || parsedFromNode || null,
      scope: "region",
    };
  }
  return {
    ownerObjectId: genericRef?.objectId?.trim() || selection.objectId?.trim() || null,
    regionId: genericRef?.regionId?.trim() || null,
    scope: genericRef?.scope ?? "domain",
  };
}

function resolveGridVisualizationTarget(
  selection: Selection,
  scope: FdmDomainSelectionScope,
): VisualizationTargetRef | null {
  if (scope === "common") {
    return null;
  }
  if (scope === "universe-outside-support") {
    return AIRBOX_VISUALIZATION_TARGET;
  }
  const fromSelection = resolveVisualizationTargetFromSelection(selection);
  if (fromSelection) {
    return fromSelection;
  }
  return {
    id: "fdm-domain",
    kind: "fdm-domain",
    label: selection.label || "Structured Grid",
  };
}

export function FdmGridInspectorSpecPanel({ selection }: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const domainMeta = useDomainMetaResourceSafe();
  const membershipRes = useFdmRegionMembershipResourceSafe({ enabled: true });
  const multilayerRes = useFdmMultilayerLayoutResourceSafe();
  const [buildFeedback, setBuildFeedback] = useState<{
    tone: "info" | "warn" | "err";
    text: string;
  } | null>(null);

  const { ownerObjectId, regionId, scope } = useMemo(
    () => resolveGridSubScope(selection),
    [selection],
  );

  const vizTarget = useMemo(
    () => resolveGridVisualizationTarget(selection, scope),
    [scope, selection],
  );

  const {
    applyVizPatch,
    hasPersistedOverride,
    hydratedVizFields,
    isAirboxTarget,
    resetVizTarget,
  } = useSafeFdmTargetVisualization(
    vizTarget,
    "wireframe",
    scope === "universe-outside-support" ? "H_demag" : "m",
  );

  const baseline = useMemo<FdmGridDraft>(
    () => ({
      ...hydratedVizFields,
      displayUnit: "nm",
    }),
    [hydratedVizFields],
  );

  const executeBuildFdmGrid = useCallback(async () => {
    if (!kernel?.commands?.execute) return;
    try {
      const result = await kernel.commands.execute(
        "grid.build-fdm",
        createCommandContext("inspector", kernel, {
          resourceData: domainMeta.data
            ? { [DATA_DOMAIN_META_PATH]: domainMeta.data }
            : undefined,
          sourceDetail: "mesh.grid",
        }),
      );
      if (result && typeof result === "object" && "status" in result) {
        const status = String(result.status);
        const msg =
          typeof result.message === "string" && result.message.trim()
            ? sanitizeDisplayReason(result.message, "FDM grid build submitted.")
            : status === "completed"
              ? "FDM grid refresh completed."
              : status === "failed"
                ? "FDM grid refresh failed."
                : "FDM grid refresh submitted.";
        setBuildFeedback({
          text: msg,
          tone:
            status === "failed"
              ? "err"
              : status === "completed"
                ? "info"
                : "warn",
        });
      }
    } catch (error) {
      setBuildFeedback({
        text:
          error instanceof Error
            ? sanitizeDisplayReason(error.message, "FDM grid refresh failed.")
            : "FDM grid refresh failed.",
        tone: "err",
      });
    }
  }, [domainMeta.data, kernel]);

  const shape: [number, number, number] = useMemo(() => {
    const raw = domainMeta.data?.grid?.shape ?? [0, 0, 0];
    return [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0];
  }, [domainMeta.data?.grid?.shape]);

  const spacing: [number, number, number] = useMemo(() => {
    const raw = domainMeta.data?.grid?.spacing ?? [0, 0, 0];
    return [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0];
  }, [domainMeta.data?.grid?.spacing]);

  const origin: [number, number, number] = useMemo(() => {
    const raw = domainMeta.data?.grid?.origin ?? [0, 0, 0];
    return [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0];
  }, [domainMeta.data?.grid?.origin]);

  const totalCells = shape[0] * shape[1] * shape[2];
  const voxelVolumeM3 = spacing[0] * spacing[1] * spacing[2];
  const displaySampling = useMemo(
    () => (totalCells > 0 ? resolveFdmDisplaySampling(totalCells) : null),
    [totalCells],
  );

  const membership = membershipRes.data ?? null;
  const isMembershipCompatible = useMemo(
    () =>
      checkFdmMembershipCompatible(
        domainMeta.data,
        membership,
        shape,
        origin,
        spacing,
        totalCells,
      ),
    [domainMeta.data, membership, origin, shape, spacing, totalCells],
  );

  const validatedSupport = useMemo(
    () =>
      membership && isMembershipCompatible
        ? resolveValidatedMagneticSupport(membership)
        : null,
    [isMembershipCompatible, membership],
  );

  const legend = useMemo<readonly (FdmGridLegendEntry & { id: string })[]>(() => {
    const raw = membership?.region_legend;
    if (!Array.isArray(raw)) return [];
    return raw.map((entry, idx) => ({
      id: `${entry.object_id}:${entry.region_id}:${idx}`,
      numericId: entry.numeric_id,
      objectId: entry.object_id,
      priority: entry.priority,
      regionId: entry.region_id,
    }));
  }, [membership?.region_legend]);

  const selectedRegion = useMemo<FdmGridLegendEntry | null>(() => {
    if (!regionId) return null;
    const candidates = legend.filter((entry) => entry.regionId === regionId);
    if (ownerObjectId) {
      return candidates.find((entry) => entry.objectId === ownerObjectId) ?? null;
    }
    return candidates.length === 1 ? (candidates[0] ?? null) : null;
  }, [legend, ownerObjectId, regionId]);

  const isMultilayer = Boolean(multilayerRes.data?.available);
  const commonLayout = multilayerRes.data?.common_transform_layout ?? null;

  const mlLayers = useMemo(
    () =>
      multilayerRes.data?.available
        ? multilayerRes.data.layers.map((layer) => ({
            gridText: layer.native_grid.join(" × "),
            id: layer.layer_id,
            magnetName: layer.magnet_name,
            objectId: layer.object_id,
            transfer: layer.transfer_kind,
            zMinNm: Number(((layer.native_origin[2] ?? 0) * 1e9).toFixed(2)),
          }))
        : [],
    [multilayerRes.data],
  );

  const handleAfterFieldChange = useCallback(
    <K extends keyof FdmGridDraft & string>(
      key: K,
      value: FdmGridDraft[K],
      helpers: { draft: FdmGridDraft },
    ) => {
      if (!FDM_VIZ_FIELD_KEYS.has(key)) return;
      const nextDraft: FdmGridDraft = { ...helpers.draft, [key]: value };
      applyVizPatch(nextDraft);
    },
    [applyVizPatch],
  );

  const spec = useMemo<InspectorSpec<FdmGridDraft>>(() => {
    const isStale =
      domainMeta.status === "stale" ||
      membershipRes.status === "stale" ||
      (Boolean(membership) && !isMembershipCompatible) ||
      (scope === "region" && Boolean(membership) && selectedRegion === null);

    const statePill = (): { label: string; tone: InspectorTone } => {
      if (domainMeta.status === "error" || membershipRes.status === "error") {
        return { label: "Error", tone: "err" };
      }
      if (isStale) {
        return { label: "Stale", tone: "stale" };
      }
      if (membership && isMembershipCompatible) {
        return { label: "Materialized", tone: "ok" };
      }
      if (isMultilayer) {
        return { label: "Multilayer", tone: "ok" };
      }
      return { label: "Authoring grid", tone: "neutral" };
    };

    const titleText =
      scope === "universe-outside-support"
        ? "FDM Airbox Outside-Support"
        : scope === "common"
          ? "Common Convolution FFT Grid"
          : scope === "region" && regionId
            ? `FDM Region · ${regionId}`
            : "Structured FDM Grid";

    const supportVisualizationRows: InspectorRowSpec<FdmGridDraft>[] = vizTarget
      ? [
          {
            key: "visible",
            label: isAirboxTarget
              ? "Show Airbox outside-support in 3D"
              : "Show structured grid in 3D",
            type: "switch",
          },
          {
            key: "boundsVisible",
            label: isAirboxTarget
              ? "Show Airbox extent bounds"
              : "Show domain bounds",
            type: "switch",
          },
          {
            key: "renderMode",
            label: "3D render mode",
            options: isAirboxTarget
              ? [
                  { label: "Wireframe", value: "wireframe" },
                  { label: "Points", value: "points" },
                  { label: "Off", value: "off" },
                ]
              : [
                  { label: "Shaded", value: "surface" },
                  { label: "Edges", value: "surface+edges" },
                  { label: "Wireframe", value: "wireframe" },
                  { label: "Points", value: "points" },
                  { label: "Off", value: "off" },
                ],
            type: "segmented",
          },
          {
            key: "wireframeOpacityPercent",
            label: "Grid wireframe opacity",
            max: 100,
            min: 0,
            step: 5,
            type: "range",
            unitSuffix: "%",
          },
          ...(isAirboxTarget
            ? []
            : ([
                {
                  key: "surfaceOpacityPercent",
                  label: "Surface opacity",
                  max: 100,
                  min: 0,
                  step: 5,
                  type: "range",
                  unitSuffix: "%",
                },
              ] satisfies InspectorRowSpec<FdmGridDraft>[])),
          {
            key: "activeQuantityId",
            label: isAirboxTarget ? "Observation quantity" : "Field quantity",
            options: isAirboxTarget
              ? [
                  { label: "Demagnetizing field H_demag", value: "H_demag" },
                  { label: "Magnetic flux density B_demag", value: "B_demag" },
                  { label: "Effective field H_eff", value: "H_eff" },
                  { label: "Antenna Oersted field H_ant", value: "H_ant" },
                ]
              : [
                  { label: "Magnetization m", value: "m" },
                  { label: "Demagnetizing field H_demag", value: "H_demag" },
                  { label: "Effective field H_eff", value: "H_eff" },
                  { label: "Uniform solid tint", value: "solid" },
                ],
            type: "select",
          },
          ...(isAirboxTarget
            ? []
            : ([
                {
                  key: "scalarColorPalette",
                  label: "Scalar colormap",
                  options: [
                    { label: "Viridis", value: "viridis" },
                    { label: "Coolwarm", value: "coolwarm" },
                    { label: "Inferno", value: "inferno" },
                    { label: "Magma", value: "magma" },
                    { label: "Cividis", value: "cividis" },
                  ],
                  type: "select",
                },
              ] satisfies InspectorRowSpec<FdmGridDraft>[])),
          {
            key: "vectorsVisible",
            label: "Show 3D field vectors",
            type: "switch",
          },
          {
            integer: true,
            key: "vectorBudget",
            label: "Vector glyph budget",
            max: 50000,
            min: 50,
            showWhen: (d) => d.vectorsVisible,
            type: "number",
          },
        ]
      : [];

    return {
      id: "mesh.grid",
      header: {
        breadcrumbs: [
          {
            id: "mesh",
            label: "Mesh",
            selection: {
              kind: "mesh.root",
              label: "Mesh",
              nodeId: "model:mesh",
              objectId: null,
              ref: null,
            },
          },
          ...(scope === "domain" || scope === "descriptor"
            ? [{ id: "grid", label: "Structured Grid" }]
            : [
                {
                  id: "grid",
                  label: "Structured Grid",
                  selection: {
                    kind: "mesh.grid",
                    label: "Structured Grid",
                    nodeId: "model:mesh:grid",
                    objectId: null,
                    ref: null,
                  },
                },
                {
                  id: "subscope",
                  label:
                    scope === "universe-outside-support"
                      ? "Airbox Outside-Support"
                      : scope === "common"
                        ? "Common FFT Grid"
                        : scope === "region"
                          ? (regionId ?? "Region")
                          : scope,
                },
              ]),
        ],
        canFitView: true,
        extraMenuActions: [
          {
            icon: Ruler,
            id: "edit-cell-size",
            label: "Edit Cell Size…",
            onSelect: (ctx) => {
              ctx.selectNode({
                kind: "mesh.root",
                label: "Mesh",
                nodeId: "model:mesh",
                objectId: null,
                ref: null,
              });
            },
          },
        ],
        primaryHeaderAction: {
          icon: RefreshCw,
          label: "Build FDM Grid",
          onRun: () => executeBuildFdmGrid(),
        },
      },
      identity: {
        domain: "mesh",
        entityId:
          scope === "universe-outside-support"
            ? "airbox"
            : scope === "region" && regionId
              ? `fdm:region:${regionId}`
              : "model:mesh:grid",
        icon: Grid3x3,
        kindLabel:
          scope === "universe-outside-support"
            ? "FDM outside-support Airbox carrier & 3D display"
            : scope === "common"
              ? "Diagnostic multilayer FFT convolution scratch grid"
              : isMultilayer
                ? "Multilayer Z-stack FDM discretization"
                : "Regular Cartesian voxel discretization",
        statePill,
        title: () => titleText,
      },
      facts: (d) => [
        {
          id: "shape",
          label: "Shape",
          value: totalCells > 0 ? shape.join(" × ") : null,
        },
        {
          id: "cell",
          label: "Cell size",
          value: totalCells > 0 ? fmtTuple3(spacing, d.displayUnit) : null,
        },
        {
          id: "fill",
          label: "Active fill",
          value:
            validatedSupport && totalCells > 0
              ? `${((validatedSupport.activeCellCount / totalCells) * 100).toFixed(1)}%`
              : null,
        },
        {
          id: "regions",
          label: "Regions",
          value: membership ? `${legend.length} numeric` : null,
        },
      ],
      notices: () => {
        const list: InspectorNotice<FdmGridDraft>[] = [];
        if (buildFeedback) {
          list.push({
            id: "fdm-grid-build-feedback",
            text: buildFeedback.text,
            tone: buildFeedback.tone,
          });
        }
        if (domainMeta.status === "error" || membershipRes.status === "error") {
          const errMsg = sanitizeDisplayReason(
            membershipRes.error?.message ?? domainMeta.error?.message,
            "FDM grid resources could not be loaded.",
          );
          list.push({
            id: "fdm-grid-error",
            quickFix: {
              label: "Build FDM Grid",
              onApply: () => executeBuildFdmGrid(),
            },
            text: errMsg,
            title: "Grid resource error",
            tone: "err",
          });
        } else if (membership && !isMembershipCompatible) {
          list.push({
            id: "fdm-membership-stale",
            quickFix: {
              label: "Build FDM Grid",
              onApply: () => executeBuildFdmGrid(),
            },
            text: "FDM region membership is stale or no longer matches the structured grid.",
            title: "Stale membership mask",
            tone: "warn",
          });
        } else if (
          !membership &&
          !isMultilayer &&
          domainMeta.status === "ready"
        ) {
          list.push({
            id: "fdm-membership-missing",
            quickFix: {
              label: "Build FDM Grid",
              onApply: () => executeBuildFdmGrid(),
            },
            text: "FDM region membership is not materialized yet; build the FDM grid to classify magnetic support.",
            title: "Membership not materialized",
            tone: "warn",
          });
        }
        if (
          (scope === "magnetic-support" ||
            scope === "active-unassigned" ||
            scope === "universe-outside-support") &&
          membership &&
          !validatedSupport
        ) {
          list.push({
            id: "support-summary-withheld",
            text: "The canonical magnetic-support summary is not published or does not match the current grid; support facts are withheld.",
            title: "Support summary withheld",
            tone: "warn",
          });
        }
        if (scope === "region" && membership && !selectedRegion) {
          list.push({
            id: "selected-region-missing",
            text: "The selected FDM region is not present in the current membership legend.",
            title: "Region not in current legend",
            tone: "warn",
          });
        }
        if (scope === "common") {
          list.push({
            id: "common-fft-scratch-notice",
            text: "Diagnostic FFT scratch layout; the common convolution grid is not a physical material mesh.",
            title: "FFT scratch carrier",
            tone: "info",
          });
        }
        if (
          validatedSupport &&
          validatedSupport.activeUnassignedCellCount > 0
        ) {
          list.push({
            id: "unassigned-voxels",
            quickFix: {
              label: "Build FDM Grid",
              onApply: () => executeBuildFdmGrid(),
            },
            text: `${validatedSupport.activeUnassignedCellCount.toLocaleString("en-US")} active magnetic cells have no semantic sub-region assigned.`,
            title: "Unassigned active voxels",
            tone: "warn",
          });
        }
        return list;
      },
      sections: [
        ...(scope === "region" || regionId !== null
          ? [
              {
                defaultOpen: true,
                icon: ShieldCheck,
                id: "selected-region",
                rows: [
                  {
                    format: () => selectedRegion?.regionId ?? regionId ?? "Not resolved",
                    label: "Selected region ID",
                    mono: true,
                    type: "readonly" as const,
                  },
                  {
                    format: () =>
                      selectedRegion
                        ? `#${selectedRegion.numericId}`
                        : "Not in current legend",
                    label: "Numeric region ID",
                    mono: true,
                    type: "readonly" as const,
                  },
                  {
                    format: () =>
                      selectedRegion?.objectId ?? ownerObjectId ?? "Not resolved",
                    label: "Owner object",
                    mono: true,
                    type: "readonly" as const,
                  },
                  {
                    format: () =>
                      selectedRegion ? String(selectedRegion.priority) : "—",
                    label: "Overlap priority",
                    mono: true,
                    type: "readonly" as const,
                  },
                ],
                title: "Selected FDM region",
              },
            ]
          : []),
        {
          defaultOpen: true,
          icon: Ruler,
          id: "dimensions",
          live: true,
          rows: [
            {
              key: "displayUnit",
              label: "Display length unit",
              options: [
                { label: "nm", value: "nm" },
                { label: "µm", value: "µm" },
                { label: "mm", value: "mm" },
                { label: "m", value: "m" },
              ],
              type: "segmented",
            },
            {
              format: () =>
                `${shape.join(" × ")} (${totalCells.toLocaleString("en-US")} voxels)`,
              label: "Grid shape",
              symbol: <>N</>,
              type: "readonly",
            },
            {
              format: (d) => fmtTuple3(spacing, d.displayUnit),
              label: "Cell spacing",
              symbol: <>&Delta;</>,
              type: "readonly",
            },
            {
              format: (d) => fmtCoord3(origin, d.displayUnit),
              label: "Grid origin",
              symbol: (
                <>
                  r<sub>0</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: (d) =>
                fmtTuple3(
                  [
                    shape[0] * spacing[0],
                    shape[1] * spacing[1],
                    shape[2] * spacing[2],
                  ],
                  d.displayUnit,
                ),
              label: "Physical span",
              symbol: <>L</>,
              type: "readonly",
            },
            {
              format: () => `${(voxelVolumeM3 * 1e27).toFixed(2)} nm³`,
              label: "Voxel volume",
              symbol: (
                <>
                  V<sub>cell</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () =>
                displaySampling
                  ? displaySampling.displaySamples.toLocaleString("en-US")
                  : "Pending grid",
              label: "Display samples",
              type: "readonly",
            },
            {
              format: () =>
                displaySampling
                  ? displaySampling.stride.toLocaleString("en-US")
                  : "Pending grid",
              label: "Display stride",
              type: "readonly",
            },
            {
              format: () =>
                displaySampling
                  ? displaySampling.budget.toLocaleString("en-US")
                  : "Pending grid",
              label: "Display budget",
              type: "readonly",
            },
          ],
          summary: () => shape.join(" × "),
          title: "Grid dimensions & cell size",
        },
        {
          defaultOpen: true,
          icon: vizTarget ? Eye : ShieldCheck,
          id: "support-mask",
          live: true,
          rows: [
            ...supportVisualizationRows,
            {
              format: (d) =>
                validatedSupport
                  ? fmtCoord3(validatedSupport.boundsMinM, d.displayUnit)
                  : membership
                    ? "Withheld (support summary not published)"
                    : "Not materialized",
              label: "Support bounds min",
              type: "readonly",
            },
            {
              format: (d) =>
                validatedSupport
                  ? fmtCoord3(validatedSupport.boundsMaxM, d.displayUnit)
                  : membership
                    ? "Withheld (support summary not published)"
                    : "Not materialized",
              label: "Support bounds max",
              type: "readonly",
            },
            {
              format: () =>
                membership?.encoding
                  ? String(membership.encoding)
                  : "Not materialized",
              label: "Mask encoding",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                !membership
                  ? "Not materialized"
                  : isMembershipCompatible
                    ? "Verified compatible with current grid"
                    : "Incompatible or stale vs current grid",
              label: "Grid-mask compatibility",
              type: "readonly",
            },
            {
              columns: [
                {
                  header: "ID",
                  id: "id",
                  mono: true,
                  renderCell: (r) => `#${(r as (typeof legend)[number]).numericId}`,
                },
                {
                  header: "Object / Region",
                  id: "owner",
                  renderCell: (r) => {
                    const row = r as (typeof legend)[number];
                    return `${row.objectId} / ${row.regionId}`;
                  },
                },
                {
                  align: "right",
                  header: "Priority",
                  id: "prio",
                  mono: true,
                  renderCell: (r) => String((r as (typeof legend)[number]).priority),
                },
              ],
              label: "Region membership legend",
              onSelectRow: (r, ctx) => {
                const row = r as (typeof legend)[number];
                ctx.selectNode({
                  kind: "object.region",
                  label: row.regionId,
                  nodeId: `model:object:${row.objectId}:region:${row.regionId}`,
                  objectId: row.objectId,
                  ref: null,
                });
              },
              rowKey: (r) => (r as (typeof legend)[number]).id,
              rows: () => legend,
              showWhen: () => legend.length > 0,
              type: "table",
              wide: true,
            },
          ],
          summary: () => `${legend.length} regions`,
          title:
            scope === "universe-outside-support"
              ? "Airbox outside-support visualization & mask"
              : "Magnetic support & 3D display",
        },
        {
          defaultOpen:
            scope === "magnetic-support" ||
            scope === "active-unassigned" ||
            scope === "universe-outside-support" ||
            Boolean(validatedSupport && validatedSupport.activeUnassignedCellCount > 0),
          icon: Box,
          id: "active-unassigned",
          rows: [
            {
              format: () =>
                validatedSupport
                  ? validatedSupport.activeCellCount.toLocaleString("en-US")
                  : membership
                    ? "Withheld"
                    : "Not materialized",
              label: "Active magnetic voxels",
              symbol: (
                <>
                  N<sub>act</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () =>
                validatedSupport
                  ? validatedSupport.activeAssignedCellCount.toLocaleString("en-US")
                  : membership
                    ? "Withheld"
                    : "Not materialized",
              label: "Active assigned voxels",
              symbol: (
                <>
                  N<sub>reg</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () =>
                validatedSupport
                  ? validatedSupport.activeUnassignedCellCount.toLocaleString("en-US")
                  : membership
                    ? "Withheld"
                    : "Not materialized",
              label: "Active unassigned voxels",
              symbol: (
                <>
                  N<sub>unass</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () =>
                validatedSupport
                  ? validatedSupport.inactiveCellCount.toLocaleString("en-US")
                  : membership
                    ? "Withheld"
                    : "Not materialized",
              label: "Inactive vacuum voxels",
              symbol: (
                <>
                  N<sub>vac</sub>
                </>
              ),
              type: "readonly",
            },
          ],
          summary: () =>
            validatedSupport
              ? `${validatedSupport.activeUnassignedCellCount.toLocaleString("en-US")} unassigned`
              : "Not materialized",
          title: "Active / unassigned cells",
        },
        {
          defaultOpen: true,
          icon: Layers,
          id: "multilayer-stack",
          rows: [
            {
              format: () =>
                commonLayout
                  ? `${commonLayout.shape.join(" × ")} (FFT scratch only — not a material carrier)`
                  : "Not published",
              label: "Common convolution FFT grid",
              symbol: (
                <>
                  N<sub>FFT</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: (d) =>
                commonLayout?.cell_size
                  ? fmtTuple3(commonLayout.cell_size, d.displayUnit)
                  : "Not published",
              label: "Common cell size",
              showWhen: () => Boolean(commonLayout),
              type: "readonly",
            },
            {
              format: (d) =>
                commonLayout?.origin
                  ? fmtCoord3(commonLayout.origin, d.displayUnit)
                  : "Not published",
              label: "Common grid origin",
              showWhen: () => Boolean(commonLayout),
              type: "readonly",
            },
            {
              format: () =>
                commonLayout?.fft_shape
                  ? commonLayout.fft_shape.join(" × ")
                  : "Not published",
              label: "FFT transform shape",
              mono: true,
              showWhen: () => Boolean(commonLayout),
              type: "readonly",
            },
            {
              format: () =>
                commonLayout
                  ? commonLayout.is_physical_mesh
                    ? "Yes"
                    : "No (FFT scratch layout)"
                  : "Not published",
              label: "Physical mesh carrier",
              showWhen: () => Boolean(commonLayout),
              type: "readonly",
            },
            {
              copyText: () => commonLayout?.provenance ?? null,
              format: () => commonLayout?.provenance || "Not published",
              label: "Common grid provenance",
              mono: true,
              showWhen: () => Boolean(commonLayout),
              type: "readonly",
            },
            {
              columns: [
                {
                  header: "Magnet layer",
                  id: "name",
                  renderCell: (r) => (r as (typeof mlLayers)[number]).magnetName,
                },
                {
                  header: "Native grid",
                  id: "grid",
                  mono: true,
                  renderCell: (r) => (r as (typeof mlLayers)[number]).gridText,
                },
                {
                  align: "right",
                  header: "Transfer",
                  id: "transfer",
                  mono: true,
                  renderCell: (r) => (r as (typeof mlLayers)[number]).transfer,
                },
              ],
              label: "Multilayer Z-stack slices",
              onSelectRow: (r, ctx) => {
                const row = r as (typeof mlLayers)[number];
                ctx.selectNode({
                  kind: "mesh.grid.layer",
                  label: row.magnetName,
                  nodeId: `model:mesh:grid:layer:${encodeURIComponent(row.id)}`,
                  objectId: row.objectId,
                  ref: {
                    kind: "mesh.grid.layer",
                    layerId: row.id,
                    nodeId: `model:mesh:grid:layer:${encodeURIComponent(row.id)}`,
                    objectId: row.objectId,
                    scope: "layer",
                    type: "fdm-domain",
                    visualizationTargetId: `fdm-native-layer:${encodeURIComponent(row.id)}`,
                  },
                });
              },
              rowKey: (r) => (r as (typeof mlLayers)[number]).id,
              rows: () => mlLayers,
              showWhen: () => mlLayers.length > 0,
              type: "table",
              wide: true,
            },
          ],
          showWhen: () => isMultilayer || scope === "common",
          summary: () => `${mlLayers.length} Z-layers`,
          title: "Multilayer Z-stack overview",
        },
        {
          defaultOpen: scope === "provenance",
          icon: History,
          id: "provenance",
          rows: [
            {
              copyText: () => domainMeta.data?.domain_id ?? null,
              format: () => domainMeta.data?.domain_id ?? "Pending domain",
              label: "Domain ID",
              mono: true,
              type: "readonly",
            },
            {
              copyText: () => domainMeta.data?.generation_id ?? null,
              format: () => domainMeta.data?.generation_id ?? "Pending generation",
              label: "Domain generation ID",
              mono: true,
              type: "readonly",
            },
            {
              copyText: () => membership?.grid_fingerprint ?? null,
              format: () =>
                membership?.grid_fingerprint
                  ? String(membership.grid_fingerprint)
                  : "Pending materialization",
              label: "Grid fingerprint",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                typeof membership?.mesh_revision === "number"
                  ? String(membership.mesh_revision)
                  : "Not materialized",
              label: "Mesh revision",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                typeof membership?.region_membership_revision === "number"
                  ? String(membership.region_membership_revision)
                  : "Not materialized",
              label: "Membership revision",
              mono: true,
              type: "readonly",
            },
          ],
          summary: () =>
            membership?.grid_fingerprint
              ? String(membership.grid_fingerprint)
              : "Recorded",
          title: "Provenance",
        },
      ],
      commitBar: vizTarget
        ? {
            hasOverrides: (d, b) =>
              hasPersistedOverride || hasVizDraftChanges(d, b),
            mode: "liveViewport",
            onResetDisplay: resetVizTarget,
            statusMessage:
              scope === "universe-outside-support"
                ? "Live Airbox outside-support 3D display"
                : "Live structured-grid 3D display · Edit cell size in Mesh",
          }
        : {
            mode: "readOnly",
            statusMessage: () =>
              "Diagnostic FFT scratch grid · Not a physical render carrier",
          },
    };
  }, [
    buildFeedback,
    commonLayout,
    displaySampling,
    domainMeta.data?.domain_id,
    domainMeta.data?.generation_id,
    domainMeta.error?.message,
    domainMeta.status,
    executeBuildFdmGrid,
    hasPersistedOverride,
    isAirboxTarget,
    isMembershipCompatible,
    isMultilayer,
    legend,
    membership,
    membershipRes.error?.message,
    membershipRes.status,
    mlLayers,
    origin,
    ownerObjectId,
    regionId,
    resetVizTarget,
    scope,
    selectedRegion,
    shape,
    spacing,
    totalCells,
    validatedSupport,
    vizTarget,
    voxelVolumeM3,
  ]);

  return (
    <SpecInspectorHost
      baseline={baseline}
      selection={selection}
      spec={spec}
      onAfterFieldChange={handleAfterFieldChange}
    />
  );
}

// ============================================================================
// 2. mesh.grid.layer — FdmGridLayerInspectorSpecPanel (Consolidates 4 children)
// ============================================================================

interface FdmGridLayerDraft extends FdmTargetVizFields {
  displayUnit: LengthDisplayUnit;
}

interface LayerSummaryRecord {
  layer_id?: string;
  object_id?: string;
  active_cell_count?: number;
  active_cells?: number;
  inactive_cell_count?: number;
  inactive_cells?: number;
  dominant_object_id?: string;
  dominant_object?: string;
}

function resolveLayerSummaryFromMembership(
  membership: FdmRegionMembershipResource | null | undefined,
  layer: FdmLayerLayoutResource | null,
  layerId: string,
): LayerSummaryRecord | null {
  if (!membership) return null;
  const raw = (membership as unknown as { layer_summaries?: unknown }).layer_summaries;
  if (!Array.isArray(raw)) return null;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as LayerSummaryRecord;
    if (
      (rec.layer_id && (rec.layer_id === layer?.layer_id || rec.layer_id === layerId)) ||
      (layer?.object_id && rec.object_id === layer.object_id)
    ) {
      return rec;
    }
  }
  return null;
}

function extractLayerIdFromSelection(selection: Selection): string {
  const ref = selection.ref;
  if (ref?.type === "fdm-domain") {
    if (ref.layerId) return ref.layerId;
    if (ref.visualizationTargetId.startsWith("fdm-native-layer:")) {
      return decodeURIComponent(
        ref.visualizationTargetId.slice("fdm-native-layer:".length),
      );
    }
  }
  const genericLayerId = (ref as { layerId?: string } | null)?.layerId;
  if (genericLayerId) return genericLayerId;
  const rawNodeSuffix = selection.nodeId?.split(":layer:")[1]?.split(":")[0] ?? "";
  return rawNodeSuffix ? decodeURIComponent(rawNodeSuffix) : "";
}

export function FdmGridLayerInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const domainMeta = useDomainMetaResourceSafe();
  const multilayerRes = useFdmMultilayerLayoutResourceSafe();
  const membershipRes = useFdmRegionMembershipResourceSafe({ enabled: true });
  const activeMasksRes = useFdmMultilayerLayerActiveMasksResourceSafe(
    multilayerRes.data,
  );
  const sceneRes = useSceneResourceSafe();

  const layerId = useMemo(
    () => extractLayerIdFromSelection(selection),
    [selection],
  );

  const layer = useMemo<FdmLayerLayoutResource | null>(
    () =>
      multilayerRes.data?.layers.find(
        (candidate) =>
          candidate.layer_id === layerId ||
          (Boolean(selection.objectId) &&
            candidate.object_id === selection.objectId),
      ) ??
      (layerId ? null : (multilayerRes.data?.layers[0] ?? null)),
    [layerId, multilayerRes.data?.layers, selection.objectId],
  );

  const resolvedLayerId = layer?.layer_id ?? layerId;

  const layerVizTarget = useMemo<VisualizationTargetRef | null>(() => {
    const fromSelection = resolveVisualizationTargetFromSelection(selection);
    if (fromSelection?.kind === "fdm-native-layer") {
      return fromSelection;
    }
    if (resolvedLayerId) {
      return targetForFdmNativeLayer(
        resolvedLayerId,
        layer?.magnet_name ?? selection.label,
      );
    }
    return null;
  }, [layer?.magnet_name, resolvedLayerId, selection]);

  const {
    applyVizPatch,
    hasPersistedOverride,
    hydratedVizFields,
    resetVizTarget,
  } = useSafeFdmTargetVisualization(layerVizTarget, "surface", "m");

  const baseline = useMemo<FdmGridLayerDraft>(
    () => ({
      ...hydratedVizFields,
      displayUnit: "nm",
    }),
    [hydratedVizFields],
  );

  const handleAfterFieldChange = useCallback(
    <K extends keyof FdmGridLayerDraft & string>(
      key: K,
      value: FdmGridLayerDraft[K],
      helpers: { draft: FdmGridLayerDraft },
    ) => {
      if (!FDM_VIZ_FIELD_KEYS.has(key)) return;
      const nextDraft: FdmGridLayerDraft = { ...helpers.draft, [key]: value };
      applyVizPatch(nextDraft);
    },
    [applyVizPatch],
  );

  const executeBuildFdmGrid = useCallback(async () => {
    if (!kernel?.commands?.execute) return;
    await kernel.commands.execute(
      "grid.build-fdm",
      createCommandContext("inspector", kernel, {
        resourceData: domainMeta.data
          ? { [DATA_DOMAIN_META_PATH]: domainMeta.data }
          : undefined,
        sourceDetail: "mesh.grid.layer",
      }),
    );
  }, [domainMeta.data, kernel]);

  const layerMetrics = useMemo(() => {
    const summary = resolveLayerSummaryFromMembership(
      membershipRes.data,
      layer,
      resolvedLayerId,
    );
    const decodedMask = resolvedLayerId
      ? activeMasksRes.data?.masks?.get(resolvedLayerId) ?? null
      : null;

    let maskActiveCount: number | null = null;
    let maskInactiveCount: number | null = null;
    if (decodedMask) {
      let count = 0;
      for (let i = 0; i < decodedMask.activeMask.length; i += 1) {
        if (decodedMask.activeMask[i] !== 0) count += 1;
      }
      maskActiveCount = count;
      maskInactiveCount = Math.max(0, decodedMask.cellCount - count);
    }

    const activeCells =
      summary?.active_cell_count ??
      summary?.active_cells ??
      maskActiveCount ??
      layer?.active_cell_count ??
      null;
    const inactiveCells =
      summary?.inactive_cell_count ??
      summary?.inactive_cells ??
      maskInactiveCount ??
      layer?.inactive_cell_count ??
      null;

    const ownerId =
      summary?.dominant_object_id ??
      summary?.dominant_object ??
      layer?.object_id ??
      selection.objectId ??
      null;
    const matchedObject = ownerId
      ? sceneRes.data?.objects?.find((obj) => obj.id === ownerId) ?? null
      : null;
    const dominantObject = matchedObject?.name
      ? `${matchedObject.name} (${matchedObject.id})`
      : layer?.magnet_name && layer?.object_id && layer.magnet_name !== layer.object_id
        ? `${layer.magnet_name} (${layer.object_id})`
        : (ownerId ?? layer?.magnet_name ?? "Not published");

    return {
      activeCells,
      dominantObject,
      inactiveCells,
      ownerId,
    };
  }, [
    activeMasksRes.data?.masks,
    layer,
    membershipRes.data,
    resolvedLayerId,
    sceneRes.data?.objects,
    selection.objectId,
  ]);

  const spec = useMemo<InspectorSpec<FdmGridLayerDraft>>(() => {
    const layoutData: FdmMultilayerLayoutResource | null =
      multilayerRes.data ?? null;
    return {
      id: "mesh.grid.layer",
      header: {
        breadcrumbs: [
          {
            id: "mesh",
            label: "Mesh",
            selection: {
              kind: "mesh.root",
              label: "Mesh",
              nodeId: "model:mesh",
              objectId: null,
              ref: null,
            },
          },
          {
            id: "grid",
            label: "Structured Grid",
            selection: {
              kind: "mesh.grid",
              label: "Structured Grid",
              nodeId: "model:mesh:grid",
              objectId: null,
              ref: null,
            },
          },
          { id: "layer", label: layer?.magnet_name ?? selection.label ?? "Layer" },
        ],
        canFitView: true,
        extraMenuActions: [
          ...(layer?.object_id
            ? [
                {
                  icon: Box,
                  id: "open-magnet-object",
                  label: "Open magnet object",
                  onSelect: (ctx: InspectorActionContext<FdmGridLayerDraft>) =>
                    ctx.selectNode({
                      kind: "object.root",
                      label: layer.magnet_name,
                      nodeId: `model:object:${layer.object_id}`,
                      objectId: layer.object_id,
                      ref: null,
                    }),
                },
              ]
            : []),
          {
            icon: RefreshCw,
            id: "rebuild-fdm-grid",
            label: "Build FDM Grid",
            onSelect: () => executeBuildFdmGrid(),
          },
        ],
      },
      identity: {
        domain: "mesh",
        entityId: resolvedLayerId || undefined,
        icon: Layers,
        kindLabel: "FDM multilayer Z-slice carrier",
        statePill: () =>
          layer
            ? { label: "Realized", tone: "ok" }
            : { label: "Not found", tone: "warn" },
        title: () => layer?.magnet_name ?? selection.label ?? "FDM Z-Layer",
      },
      facts: (d) => [
        {
          id: "grid",
          label: "Native grid",
          value: layer ? layer.native_grid.join(" × ") : null,
        },
        {
          id: "cell",
          label: "Cell size",
          value: layer ? fmtTuple3(layer.native_cell_size, d.displayUnit) : null,
        },
        { id: "transfer", label: "Transfer", value: layer?.transfer_kind ?? null },
        {
          id: "active",
          label: "Active cells",
          value:
            layerMetrics.activeCells !== null
              ? layerMetrics.activeCells.toLocaleString("en-US")
              : null,
        },
      ],
      notices: () =>
        !layoutData || !layoutData.available
          ? [
              {
                id: "multilayer-not-published",
                text: sanitizeDisplayReason(
                  layoutData?.unavailable_reason,
                  "Native multilayer layout is not published for the current session.",
                ),
                title: "Multilayer layout not active",
                tone: "warn",
              },
            ]
          : !layer
            ? [
                {
                  id: "layer-not-found",
                  text: "The selected native Z-layer is not present in the current multilayer layout.",
                  title: "Layer not found",
                  tone: "warn",
                },
              ]
            : [],
      sections: [
        {
          defaultOpen: true,
          icon: Grid3x3,
          id: "native-grid",
          live: true,
          rows: [
            {
              key: "displayUnit",
              label: "Display length unit",
              options: [
                { label: "nm", value: "nm" },
                { label: "µm", value: "µm" },
                { label: "mm", value: "mm" },
                { label: "m", value: "m" },
              ],
              type: "segmented",
            },
            {
              format: () => layerMetrics.dominantObject,
              label: "Dominant object",
              type: "readonly",
            },
            {
              format: () => (layer ? layer.native_grid.join(" × ") : "—"),
              label: "Native grid shape",
              symbol: <>N</>,
              type: "readonly",
            },
            {
              format: (d) =>
                layer ? fmtTuple3(layer.native_cell_size, d.displayUnit) : "—",
              label: "Native cell spacing",
              symbol: <>&Delta;</>,
              type: "readonly",
            },
            {
              format: (d) =>
                layer ? fmtCoord3(layer.native_origin, d.displayUnit) : "—",
              label: "Layer origin",
              symbol: (
                <>
                  r<sub>0</sub>
                </>
              ),
              type: "readonly",
            },
          ],
          title: "Native layer grid & Z-span",
        },
        ...(layerVizTarget
          ? [
              {
                defaultOpen: true,
                icon: Eye,
                id: "layer-visualization",
                live: true,
                rows: [
                  {
                    key: "visible" as const,
                    label: "Show layer carrier in 3D",
                    type: "switch" as const,
                  },
                  {
                    key: "boundsVisible" as const,
                    label: "Show layer bounds",
                    type: "switch" as const,
                  },
                  {
                    key: "renderMode" as const,
                    label: "3D render mode",
                    options: [
                      { label: "Shaded", value: "surface" },
                      { label: "Edges", value: "surface+edges" },
                      { label: "Wireframe", value: "wireframe" },
                      { label: "Points", value: "points" },
                      { label: "Off", value: "off" },
                    ],
                    type: "segmented" as const,
                  },
                  {
                    key: "surfaceOpacityPercent" as const,
                    label: "Surface opacity",
                    max: 100,
                    min: 0,
                    step: 5,
                    type: "range" as const,
                    unitSuffix: "%",
                  },
                  {
                    key: "wireframeOpacityPercent" as const,
                    label: "Wireframe opacity",
                    max: 100,
                    min: 0,
                    step: 5,
                    type: "range" as const,
                    unitSuffix: "%",
                  },
                  {
                    key: "activeQuantityId" as const,
                    label: "Field quantity",
                    options: [
                      { label: "Magnetization m", value: "m" },
                      { label: "Demagnetizing field H_demag", value: "H_demag" },
                      { label: "Effective field H_eff", value: "H_eff" },
                      { label: "Uniform solid tint", value: "solid" },
                    ],
                    type: "select" as const,
                  },
                  {
                    key: "scalarColorPalette" as const,
                    label: "Scalar colormap",
                    options: [
                      { label: "Viridis", value: "viridis" },
                      { label: "Coolwarm", value: "coolwarm" },
                      { label: "Inferno", value: "inferno" },
                      { label: "Magma", value: "magma" },
                      { label: "Cividis", value: "cividis" },
                    ],
                    type: "select" as const,
                  },
                  {
                    key: "vectorsVisible" as const,
                    label: "Show layer field vectors",
                    type: "switch" as const,
                  },
                  {
                    integer: true,
                    key: "vectorBudget" as const,
                    label: "Vector glyph budget",
                    max: 50000,
                    min: 50,
                    showWhen: (d: FdmGridLayerDraft) => d.vectorsVisible,
                    type: "number" as const,
                  },
                ],
                title: "3D layer visualization",
              },
            ]
          : []),
        {
          defaultOpen: true,
          icon: ShieldCheck,
          id: "layer-mask",
          rows: [
            {
              format: () =>
                layer?.active_mask_present
                  ? "Explicit binary mask"
                  : "Dense implicit full-box",
              label: "Mask representation",
              type: "readonly",
            },
            {
              format: () =>
                layerMetrics.activeCells !== null
                  ? layerMetrics.activeCells.toLocaleString("en-US")
                  : "Not published",
              label: "Active cells",
              type: "readonly",
            },
            {
              format: () =>
                layerMetrics.inactiveCells !== null
                  ? layerMetrics.inactiveCells.toLocaleString("en-US")
                  : "Not published",
              label: "Inactive cells",
              type: "readonly",
            },
            {
              copyText: () => layer?.mask_provenance ?? null,
              format: () =>
                layer?.mask_provenance ?? "Implicit dense carrier",
              label: "Mask provenance",
              mono: true,
              type: "readonly",
            },
          ],
          title: "Layer active mask",
        },
        {
          defaultOpen: true,
          icon: Activity,
          id: "transfer",
          rows: [
            {
              format: () => layer?.transfer_kind ?? "identity",
              label: "Convolution transfer operator",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                layer?.convolution_grid
                  ? layer.convolution_grid.join(" × ")
                  : "Not published",
              label: "Convolution grid",
              mono: true,
              type: "readonly",
            },
            {
              format: (d) =>
                layer?.convolution_cell_size
                  ? fmtTuple3(layer.convolution_cell_size, d.displayUnit)
                  : "Not published",
              label: "Convolution cell size",
              type: "readonly",
            },
          ],
          title: "Interlayer convolution transfer",
        },
        {
          defaultOpen: true,
          icon: History,
          id: "provenance",
          rows: [
            {
              copyText: () => layer?.layer_id ?? null,
              format: () => layer?.layer_id ?? "Not published",
              label: "Layer ID",
              mono: true,
              type: "readonly",
            },
            {
              copyText: () => layer?.object_id ?? null,
              format: () => layer?.object_id ?? "Not published",
              label: "Object ID",
              mono: true,
              type: "readonly",
            },
            {
              copyText: () => layer?.native_grid_fingerprint ?? null,
              format: () => layer?.native_grid_fingerprint ?? "Not published",
              label: "Native grid fingerprint",
              mono: true,
              type: "readonly",
            },
            {
              copyText: () => layoutData?.layout_fingerprint ?? null,
              format: () => layoutData?.layout_fingerprint ?? "Not published",
              label: "Multilayer layout fingerprint",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                layoutData?.layout_revision != null
                  ? String(layoutData.layout_revision)
                  : "Not published",
              label: "Layout revision",
              mono: true,
              type: "readonly",
            },
          ],
          title: "Provenance",
        },
      ],
      commitBar: layerVizTarget
        ? {
            hasOverrides: (d, b) =>
              hasPersistedOverride || hasVizDraftChanges(d, b),
            mode: "liveViewport",
            onResetDisplay: resetVizTarget,
            statusMessage: "Live multilayer Z-slice 3D display",
          }
        : {
            mode: "readOnly",
            statusMessage: () => "Multilayer Z-slice execution carrier",
          },
    };
  }, [
    executeBuildFdmGrid,
    hasPersistedOverride,
    layer,
    layerMetrics.activeCells,
    layerMetrics.dominantObject,
    layerMetrics.inactiveCells,
    layerVizTarget,
    multilayerRes.data,
    resetVizTarget,
    resolvedLayerId,
    selection.label,
  ]);

  return (
    <SpecInspectorHost
      baseline={baseline}
      selection={selection}
      spec={spec}
      onAfterFieldChange={handleAfterFieldChange}
    />
  );
}

// ============================================================================
// 3. fdm.cell — FdmCellInspectorSpecPanel (Embedded in InspectorTemplate)
// ============================================================================

interface FdmCellDraft {
  energyUnitMode: "density_jm3" | "cell_ev" | "cell_aj";
}

type SelectionPanelSelection = InspectorPanelProps["selection"];

const MATERIAL_ORDER: Readonly<Record<string, number>> = {
  mat_aex: 1,
  mat_alpha: 2,
  mat_ms: 0,
};

const MATERIAL_SHORT_LABELS: Readonly<Record<string, string>> = {
  mat_aex: "Aex",
  mat_alpha: "α",
  mat_ms: "Ms",
};

const ENERGY_ORDER: Readonly<Record<string, number>> = {
  eden_ani: 2,
  eden_demag: 1,
  eden_dmi: 3,
  eden_ex: 0,
  eden_ext: 4,
  eden_total: 5,
};

const ENERGY_SHORT_LABELS: Readonly<Record<string, string>> = {
  eden_ani: "Anisotropy",
  eden_demag: "Demagnetizing",
  eden_dmi: "DMI",
  eden_ex: "Exchange",
  eden_ext: "Zeeman",
  eden_total: "Total",
};

const cellNumberFormatter = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 6,
});

function formatCellScalar(value: number): string {
  if (!Number.isFinite(value)) return "Not published";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs < 1e-3 || abs >= 1e6) return value.toExponential(3);
  return cellNumberFormatter.format(value);
}

function isSupportedEnergyDensityUnit(unit: string): boolean {
  const clean = unit.trim();
  return clean === "J/m³" || clean === "J/m^3";
}

function formatSampleSourceProvenance(row: FdmCellQuantitySample): string | null {
  const parts: string[] = [];
  if (row.sourceStep !== null && Number.isFinite(row.sourceStep)) {
    parts.push(`step ${row.sourceStep.toLocaleString("en-US")}`);
  }
  if (row.sourceTimeSeconds !== null && Number.isFinite(row.sourceTimeSeconds)) {
    parts.push(`t = ${formatCellScalar(row.sourceTimeSeconds)} s`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function quantityShortLabel(row: FdmCellQuantitySample): string {
  if (row.group === "material") {
    return MATERIAL_SHORT_LABELS[row.id] ?? row.label;
  }
  if (row.group === "energy") {
    return ENERGY_SHORT_LABELS[row.id] ?? row.label;
  }
  return "m";
}

function parseNonNegativeSafeInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}

export interface ResolvedFdmSelectedCell {
  ordinal: number;
  cellOrdinal: string;
  ijk: [number, number, number];
  maskState: FdmCellMaskState | null;
  numericRegionId: number | null;
  regionId: string | null;
  membershipRevision: string;
  gridFingerprint: string;
  verificationStatus: "verified" | "stale" | "pending";
  notice: string | null;
  target: FdmCellPhysicsTarget | null;
}

/**
 * Resolves a picked 3D FDM voxel (`ref.cellOrdinal: string`) or unit-test cell
 * (`ref.ordinal: number`), validates it against the decoded binary FMRM mask
 * and multilayer/vacuum guards, and constructs `FdmCellPhysicsTarget` when valid.
 */
export function resolveFdmSelectedCell({
  selection,
  shape,
  origin,
  spacing,
  generationId,
  membership,
  binaryData,
  binaryStatus,
  binaryHookAvailable,
  isMultilayer,
  multilayerReady,
}: {
  selection: SelectionPanelSelection;
  shape: readonly [number, number, number];
  origin: readonly [number, number, number];
  spacing: readonly [number, number, number];
  generationId: string;
  membership: FdmRegionMembershipResource | null;
  binaryData: DecodedFdmRegionMembership | null;
  binaryStatus: string;
  binaryHookAvailable: boolean;
  isMultilayer: boolean;
  multilayerReady: boolean;
}): ResolvedFdmSelectedCell {
  const ref = selection.ref as Record<string, unknown> | null;
  const nx = Math.max(1, shape[0] || 1);
  const ny = Math.max(1, shape[1] || 1);

  const nodeOrdinal = selection.nodeId?.startsWith("fdm:cell:")
    ? parseNonNegativeSafeInt(selection.nodeId.slice("fdm:cell:".length))
    : null;
  const parsedOrdinal =
    parseNonNegativeSafeInt(ref?.cellOrdinal) ??
    parseNonNegativeSafeInt(ref?.ordinal) ??
    nodeOrdinal ??
    0;

  const expectedIjkFromOrdinal: [number, number, number] = [
    parsedOrdinal % nx,
    Math.floor(parsedOrdinal / nx) % ny,
    Math.floor(parsedOrdinal / (nx * ny)),
  ];

  const rawIjk = tuple3OrNull(
    Array.isArray(ref?.ijk) ? (ref.ijk as readonly number[]) : null,
  );
  const ijk: [number, number, number] = rawIjk
    ? [Math.trunc(rawIjk[0]), Math.trunc(rawIjk[1]), Math.trunc(rawIjk[2])]
    : expectedIjkFromOrdinal;

  const expectedMembershipRevision =
    membership &&
    typeof membership.mesh_revision === "number" &&
    typeof membership.region_membership_revision === "number"
      ? `${membership.mesh_revision}:${membership.region_membership_revision}`
      : String(ref?.membershipRevision ?? "1:1");

  const gridFingerprint = String(
    membership?.grid_fingerprint ?? ref?.gridFingerprint ?? "",
  );
  const refGridFingerprint =
    typeof ref?.gridFingerprint === "string" ? ref.gridFingerprint : "";
  const refMembershipRevision =
    typeof ref?.membershipRevision === "string" ? ref.membershipRevision : "";
  const refMaskState =
    ref?.maskState === "inactive" ||
    ref?.maskState === "active-unassigned" ||
    ref?.maskState === "region"
      ? ref.maskState
      : null;
  const refNumericRegionId =
    typeof ref?.numericRegionId === "number" ? ref.numericRegionId : null;
  const refRegionId =
    typeof ref?.regionId === "string" ? ref.regionId : null;

  if (!ref) {
    return {
      cellOrdinal: String(parsedOrdinal),
      gridFingerprint,
      ijk,
      maskState: null,
      membershipRevision: expectedMembershipRevision,
      notice: "Select a current FDM cell to inspect its published physics.",
      numericRegionId: null,
      ordinal: parsedOrdinal,
      regionId: null,
      target: null,
      verificationStatus: "pending",
    };
  }

  // Multilayer guard: common convolution grid is FFT scratch, not a physical cell carrier
  if (isMultilayer) {
    return {
      cellOrdinal: String(parsedOrdinal),
      gridFingerprint: refGridFingerprint || gridFingerprint,
      ijk,
      maskState: refMaskState,
      membershipRevision: refMembershipRevision || expectedMembershipRevision,
      notice:
        "Cell physics requires a physical single-grid FDM cell; the common multilayer grid is not a material carrier.",
      numericRegionId: refNumericRegionId,
      ordinal: parsedOrdinal,
      regionId: refRegionId,
      target: null,
      verificationStatus: "pending",
    };
  }

  let resolvedMaskState: FdmCellMaskState | null = refMaskState;
  let resolvedNumericId: number | null = refNumericRegionId;
  let resolvedRegionId: string | null = refRegionId;
  let verificationStatus: ResolvedFdmSelectedCell["verificationStatus"] = "pending";

  // Binary FMRM decoding & canonical identity verification
  if (binaryStatus === "ready" && binaryData && membership) {
    if (
      binaryData.semanticStatus !== "canonical" ||
      (membership.grid_fingerprint &&
        binaryData.gridFingerprint !== membership.grid_fingerprint) ||
      (refGridFingerprint &&
        membership.grid_fingerprint &&
        refGridFingerprint !== membership.grid_fingerprint) ||
      (refMembershipRevision &&
        typeof membership.mesh_revision === "number" &&
        refMembershipRevision !== expectedMembershipRevision) ||
      parsedOrdinal < 0 ||
      parsedOrdinal >= binaryData.cellCount
    ) {
      return {
        cellOrdinal: String(parsedOrdinal),
        gridFingerprint: refGridFingerprint || gridFingerprint,
        ijk,
        maskState: refMaskState,
        membershipRevision: refMembershipRevision || expectedMembershipRevision,
        notice:
          "The selected FDM cell identity does not match the current grid or membership resource.",
        numericRegionId: refNumericRegionId,
        ordinal: parsedOrdinal,
        regionId: refRegionId,
        target: null,
        verificationStatus: "stale",
      };
    }

    const decodedNumeric = binaryData.regionIds[parsedOrdinal];
    if (decodedNumeric === undefined) {
      return {
        cellOrdinal: String(parsedOrdinal),
        gridFingerprint,
        ijk,
        maskState: refMaskState,
        membershipRevision: expectedMembershipRevision,
        notice: "The selected FDM cell is absent from the current mask.",
        numericRegionId: null,
        ordinal: parsedOrdinal,
        regionId: null,
        target: null,
        verificationStatus: "stale",
      };
    }

    const state = resolveFdmCellState(decodedNumeric, membership);
    const binNx = Math.max(1, binaryData.counts[0] || nx);
    const binNy = Math.max(1, binaryData.counts[1] || ny);
    const expectedBinIjk: [number, number, number] = [
      parsedOrdinal % binNx,
      Math.floor(parsedOrdinal / binNx) % binNy,
      Math.floor(parsedOrdinal / (binNx * binNy)),
    ];

    if (
      (rawIjk &&
        expectedBinIjk.some((val, idx) => val !== ijk[idx])) ||
      (refMaskState !== null && refMaskState !== state.kind) ||
      (ref?.numericRegionId !== undefined &&
        refNumericRegionId !== state.numericRegionId) ||
      (ref?.regionId !== undefined && refRegionId !== state.regionId)
    ) {
      return {
        cellOrdinal: String(parsedOrdinal),
        gridFingerprint: refGridFingerprint || gridFingerprint,
        ijk,
        maskState: refMaskState,
        membershipRevision: refMembershipRevision || expectedMembershipRevision,
        notice:
          "The selected FDM cell details do not match the current membership mask.",
        numericRegionId: refNumericRegionId,
        ordinal: parsedOrdinal,
        regionId: refRegionId,
        target: null,
        verificationStatus: "stale",
      };
    }

    resolvedMaskState = state.kind;
    resolvedNumericId = state.numericRegionId;
    resolvedRegionId = state.regionId;
    verificationStatus = "verified";
  } else if (
    membership &&
    ((refGridFingerprint &&
      membership.grid_fingerprint &&
      refGridFingerprint !== membership.grid_fingerprint) ||
      (refMembershipRevision &&
        typeof membership.mesh_revision === "number" &&
        refMembershipRevision !== expectedMembershipRevision))
  ) {
    return {
      cellOrdinal: String(parsedOrdinal),
      gridFingerprint: refGridFingerprint || gridFingerprint,
      ijk,
      maskState: refMaskState,
      membershipRevision: refMembershipRevision || expectedMembershipRevision,
      notice:
        "The selected FDM cell identity does not match the current grid or membership resource.",
      numericRegionId: refNumericRegionId,
      ordinal: parsedOrdinal,
      regionId: refRegionId,
      target: null,
      verificationStatus: "stale",
    };
  } else if (binaryHookAvailable && binaryStatus === "loading") {
    return {
      cellOrdinal: String(parsedOrdinal),
      gridFingerprint,
      ijk,
      maskState: resolvedMaskState,
      membershipRevision: expectedMembershipRevision,
      notice:
        "Waiting for current FDM grid classification before reading cell physics.",
      numericRegionId: resolvedNumericId,
      ordinal: parsedOrdinal,
      regionId: resolvedRegionId,
      target: null,
      verificationStatus: "pending",
    };
  } else if (binaryHookAvailable && binaryStatus === "error") {
    return {
      cellOrdinal: String(parsedOrdinal),
      gridFingerprint,
      ijk,
      maskState: resolvedMaskState,
      membershipRevision: expectedMembershipRevision,
      notice: "FDM binary region membership could not be verified for this cell.",
      numericRegionId: resolvedNumericId,
      ordinal: parsedOrdinal,
      regionId: resolvedRegionId,
      target: null,
      verificationStatus: "stale",
    };
  } else if (!multilayerReady && binaryHookAvailable) {
    return {
      cellOrdinal: String(parsedOrdinal),
      gridFingerprint,
      ijk,
      maskState: resolvedMaskState,
      membershipRevision: expectedMembershipRevision,
      notice:
        "Waiting for current FDM grid classification before reading cell physics.",
      numericRegionId: resolvedNumericId,
      ordinal: parsedOrdinal,
      regionId: resolvedRegionId,
      target: null,
      verificationStatus: "pending",
    };
  }

  // Vacuum / outside-support guard: inactive voxels have no magnetic state
  if (resolvedMaskState === "inactive") {
    return {
      cellOrdinal: String(parsedOrdinal),
      gridFingerprint,
      ijk,
      maskState: "inactive",
      membershipRevision: expectedMembershipRevision,
      notice: "This cell is outside the magnetic support.",
      numericRegionId: null,
      ordinal: parsedOrdinal,
      regionId: null,
      target: null,
      verificationStatus,
    };
  }

  const refCellSize = tuple3OrNull(
    Array.isArray(ref.cellSizeM) ? (ref.cellSizeM as readonly number[]) : null,
  );
  const cellSizeM: [number, number, number] = refCellSize ?? [
    spacing[0] || 2e-9,
    spacing[1] || 2e-9,
    spacing[2] || 2e-9,
  ];
  const refCenter = tuple3OrNull(
    Array.isArray(ref.centerM) ? (ref.centerM as readonly number[]) : null,
  );
  const centerM: [number, number, number] =
    refCenter ?? fdmCellCenter(origin, cellSizeM, ijk);

  const meshRevision =
    typeof membership?.mesh_revision === "number"
      ? membership.mesh_revision
      : (parseNonNegativeSafeInt(ref.meshRevision) ?? 1);

  return {
    cellOrdinal: String(parsedOrdinal),
    gridFingerprint,
    ijk,
    maskState: resolvedMaskState,
    membershipRevision: expectedMembershipRevision,
    notice: null,
    numericRegionId: resolvedNumericId,
    ordinal: parsedOrdinal,
    regionId: resolvedRegionId,
    target: {
      cellSizeM,
      centerM,
      generationId: String(ref.generationId ?? generationId),
      gridFingerprint,
      membershipRevision: expectedMembershipRevision,
      meshRevision,
      ordinal: parsedOrdinal,
    },
    verificationStatus,
  };
}

function resolveBoundaryInterfaceClassification(
  ijk: readonly [number, number, number],
  shape: readonly [number, number, number],
  ordinal: number,
  binaryData: DecodedFdmRegionMembership | null,
  membership: FdmRegionMembershipResource | null,
): string {
  const [ix, iy, iz] = ijk;
  const [nx, ny, nz] = shape;
  const boundaryFaces: string[] = [];
  if (ix <= 0) boundaryFaces.push("−X");
  if (ix >= nx - 1) boundaryFaces.push("+X");
  if (iy <= 0) boundaryFaces.push("−Y");
  if (iy >= ny - 1) boundaryFaces.push("+Y");
  if (iz <= 0) boundaryFaces.push("−Z");
  if (iz >= nz - 1) boundaryFaces.push("+Z");

  if (!binaryData || ordinal < 0 || ordinal >= binaryData.cellCount) {
    return boundaryFaces.length > 0
      ? `Outer grid boundary (${boundaryFaces.join(", ")})`
      : "Interior lattice coordinate";
  }

  const centerId = binaryData.regionIds[ordinal];
  const deltas: readonly (readonly [number, number, number])[] = [
    [-1, 0, 0],
    [1, 0, 0],
    [0, -1, 0],
    [0, 1, 0],
    [0, 0, -1],
    [0, 0, 1],
  ];

  let touchesVacuum = false;
  const adjacentRegions = new Set<string>();

  for (const [dx, dy, dz] of deltas) {
    const ni = ix + dx;
    const nj = iy + dy;
    const nk = iz + dz;
    if (ni < 0 || ni >= nx || nj < 0 || nj >= ny || nk < 0 || nk >= nz) {
      continue;
    }
    const nOrd = ni + nj * nx + nk * nx * ny;
    const neighborId = binaryData.regionIds[nOrd];
    if (neighborId === undefined || neighborId === centerId) continue;
    if (
      neighborId === FMRM_INACTIVE_REGION_ID ||
      centerId === FMRM_INACTIVE_REGION_ID
    ) {
      touchesVacuum = true;
    } else {
      const nbState = resolveFdmCellState(neighborId, membership);
      adjacentRegions.add(
        nbState.kind === "active-unassigned"
          ? "unassigned support"
          : (nbState.regionId ?? `numeric #${nbState.numericRegionId ?? neighborId}`),
      );
    }
  }

  const tags: string[] = [];
  if (adjacentRegions.size > 0) {
    tags.push(`Region interface (${[...adjacentRegions].join(", ")})`);
  }
  if (touchesVacuum) {
    tags.push("Support–vacuum boundary");
  }
  if (boundaryFaces.length > 0) {
    tags.push(`Outer grid boundary (${boundaryFaces.join(", ")})`);
  }
  return tags.length > 0 ? tags.join(" · ") : "Interior voxel (homogeneous 6-stencil)";
}

function formatEnergyRowValue(
  row: FdmCellQuantitySample,
  volumeM3: number,
  mode: FdmCellDraft["energyUnitMode"],
): string {
  if (
    row.status !== "ready" ||
    !isSupportedEnergyDensityUnit(row.unit) ||
    row.scalar === null ||
    !Number.isFinite(row.scalar)
  ) {
    return "Not published";
  }
  if (mode === "density_jm3") {
    const cellJoules = row.scalar * volumeM3;
    const cellPart = Number.isFinite(cellJoules)
      ? ` (${formatCellScalar(cellJoules)} J)`
      : "";
    return `${formatCellScalar(row.scalar)} J/m³${cellPart}`;
  }
  const joules = row.scalar * volumeM3;
  if (!Number.isFinite(joules)) return "Not published";
  if (mode === "cell_ev") {
    return `${(joules / ELEMENTARY_CHARGE_J).toFixed(4)} eV`;
  }
  return `${(joules * 1e18).toFixed(4)} aJ`;
}

function SixNeighborStencil({
  binaryData,
  ctx,
  gridFingerprint,
  ijk,
  membership,
  membershipRevision,
  shape,
}: {
  binaryData: DecodedFdmRegionMembership | null;
  ctx: InspectorActionContext<FdmCellDraft>;
  gridFingerprint: string;
  ijk: readonly [number, number, number];
  membership: FdmRegionMembershipResource | null;
  membershipRevision: string;
  shape: readonly [number, number, number];
}): ReactNode {
  const [ix, iy, iz] = ijk;
  const [nx, ny, nz] = shape;
  const neighbors = [
    { delta: [-1, 0, 0] as const, id: "-x", label: "−X" },
    { delta: [1, 0, 0] as const, id: "+x", label: "+X" },
    { delta: [0, -1, 0] as const, id: "-y", label: "−Y" },
    { delta: [0, 1, 0] as const, id: "+y", label: "+Y" },
    { delta: [0, 0, -1] as const, id: "-z", label: "−Z" },
    { delta: [0, 0, 1] as const, id: "+z", label: "+Z" },
  ];

  return (
    <div className="fm-fdm-neighbor-grid" role="group" aria-label="6-neighbor voxel stencil">
      {neighbors.map((nb) => {
        const ni = ix + nb.delta[0];
        const nj = iy + nb.delta[1];
        const nk = iz + nb.delta[2];
        const inBounds = ni >= 0 && ni < nx && nj >= 0 && nj < ny && nk >= 0 && nk < nz;
        const nextOrdinal = ni + nj * nx + nk * nx * ny;
        return (
          <Button
            key={nb.id}
            className="fm-fdm-neighbor-grid__cell"
            disabled={!inBounds}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => {
              if (!inBounds) return;
              const rawNeighborId =
                binaryData && nextOrdinal >= 0 && nextOrdinal < binaryData.cellCount
                  ? binaryData.regionIds[nextOrdinal]
                  : undefined;
              const neighborState =
                rawNeighborId !== undefined
                  ? resolveFdmCellState(rawNeighborId, membership)
                  : {
                      kind: "active-unassigned" as const,
                      numericRegionId: 0,
                      regionId: null,
                    };
              const cellRef: Extract<SelectionRef, { type: "fdm-cell" }> = {
                cellOrdinal: String(nextOrdinal),
                gridFingerprint,
                ijk: [ni, nj, nk],
                kind: "fdm.cell",
                maskState: neighborState.kind,
                membershipRevision,
                nodeId: "model:mesh:grid",
                numericRegionId: neighborState.numericRegionId,
                regionId: neighborState.regionId,
                type: "fdm-cell",
                visualizationTargetId: "fdm-domain",
              };
              ctx.selectNode({
                kind: "fdm.cell",
                label: `FDM Voxel (${ni}, ${nj}, ${nk})`,
                nodeId: `fdm:cell:${nextOrdinal}`,
                objectId: null,
                ref: cellRef,
              });
            }}
          >
            <span>{nb.label}</span>
            <span>{inBounds ? `(${ni}, ${nj}, ${nk})` : "Boundary"}</span>
          </Button>
        );
      })}
    </div>
  );
}

export function FdmCellInspectorSpecPanel({ selection }: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const domainMeta = useDomainMetaResourceSafe();
  const multilayerRes = useFdmMultilayerLayoutResourceSafe();
  const membershipRes = useFdmRegionMembershipResourceSafe({ enabled: true });
  const sceneRes = useSceneResourceSafe();
  const regionsRes = useModelRegionsResourceSafe();
  const regionDiagnosticsRes = useModelRegionDiagnosticsResourceSafe();

  const isMultilayer = Boolean(multilayerRes.data?.available);
  const membership = membershipRes.data ?? null;
  const membershipRevisionToken =
    membership &&
    typeof membership.mesh_revision === "number" &&
    typeof membership.region_membership_revision === "number"
      ? `${membership.mesh_revision}:${membership.region_membership_revision}`
      : null;

  const binaryHookAvailable = Boolean(
    geometryLifecycleResources.useFdmRegionMembershipBinaryResource,
  );
  const binaryRes = useFdmRegionMembershipBinaryResourceSafe(null, {
    enabled: !isMultilayer,
    revision: membershipRevisionToken,
  });

  const shape: [number, number, number] = useMemo(() => {
    const raw = domainMeta.data?.grid?.shape ?? [1, 1, 1];
    return [raw[0] ?? 1, raw[1] ?? 1, raw[2] ?? 1];
  }, [domainMeta.data?.grid?.shape]);

  const spacing: [number, number, number] = useMemo(() => {
    const raw = domainMeta.data?.grid?.spacing ?? [2e-9, 2e-9, 2e-9];
    return [raw[0] ?? 2e-9, raw[1] ?? 2e-9, raw[2] ?? 2e-9];
  }, [domainMeta.data?.grid?.spacing]);

  const origin: [number, number, number] = useMemo(() => {
    const raw = domainMeta.data?.grid?.origin ?? [0, 0, 0];
    return [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0];
  }, [domainMeta.data?.grid?.origin]);

  const resolvedCell = useMemo(
    () =>
      resolveFdmSelectedCell({
        binaryData: binaryRes.data,
        binaryHookAvailable,
        binaryStatus: binaryRes.status,
        generationId: domainMeta.data?.generation_id ?? "gen",
        isMultilayer,
        membership,
        multilayerReady:
          multilayerRes.status === "ready" || multilayerRes.status === "error" || !binaryHookAvailable,
        origin,
        selection,
        shape,
        spacing,
      }),
    [
      binaryHookAvailable,
      binaryRes.data,
      binaryRes.status,
      domainMeta.data?.generation_id,
      isMultilayer,
      membership,
      multilayerRes.status,
      origin,
      selection,
      shape,
      spacing,
    ],
  );

  const { ijk, target } = resolvedCell;

  const cellPhysics = useFdmCellPhysicsResource(target);
  const snapshot =
    target !== null && cellPhysics.status === "ready" ? cellPhysics.data : null;

  const rows = useMemo(() => snapshot?.rows ?? [], [snapshot?.rows]);
  const materialRows = useMemo(
    () =>
      rows
        .filter((r) => r.group === "material")
        .sort(
          (a, b) =>
            (MATERIAL_ORDER[a.id] ?? 100) - (MATERIAL_ORDER[b.id] ?? 100) ||
            a.id.localeCompare(b.id),
        ),
    [rows],
  );
  const magRow = useMemo(
    () => rows.find((r) => r.group === "magnetization") ?? null,
    [rows],
  );
  const energyRows = useMemo(
    () =>
      rows
        .filter((r) => r.group === "energy")
        .sort(
          (a, b) =>
            (ENERGY_ORDER[a.id] ?? 100) - (ENERGY_ORDER[b.id] ?? 100) ||
            a.id.localeCompare(b.id),
        ),
    [rows],
  );
  const sourcedRows = useMemo(
    () =>
      rows.flatMap((row) => {
        if (row.status !== "ready") return [];
        const provenance = formatSampleSourceProvenance(row);
        return provenance
          ? [{ id: row.id, label: `${quantityShortLabel(row)} source`, provenance }]
          : [];
      }),
    [rows],
  );

  const volumeM3 = snapshot?.volumeM3 ?? spacing[0] * spacing[1] * spacing[2];

  const handleRetryCellPhysics = useCallback(() => {
    kernel?.resources?.invalidate?.(DATA_FIELDS_PATH, Date.now());
    cellPhysics.refetch?.();
  }, [cellPhysics, kernel?.resources]);

  const cellProvenance = useMemo(() => {
    const rawRef = (selection.ref ?? {}) as Record<string, unknown>;
    const legendList = membership?.region_legend ?? [];
    const matchedLegend =
      resolvedCell.numericRegionId != null
        ? (legendList.find(
            (entry) => entry.numeric_id === resolvedCell.numericRegionId,
          ) ?? null)
        : resolvedCell.regionId
          ? (legendList.find(
              (entry) => entry.region_id === resolvedCell.regionId,
            ) ?? null)
          : null;

    const ownerId =
      matchedLegend?.object_id ??
      (membership?.object_ids?.length === 1 ? membership.object_ids[0] : null) ??
      selection.objectId ??
      null;
    const ownerObject = ownerId
      ? (sceneRes.data?.objects?.find((obj) => obj.id === ownerId) ?? null)
      : null;

    const authoredRegion =
      resolvedCell.regionId && regionsRes.data?.regions
        ? (regionsRes.data.regions.find(
            (reg) =>
              reg.region_id === resolvedCell.regionId &&
              (!ownerId || !reg.owner_object_id || reg.owner_object_id === ownerId),
          ) ?? null)
        : null;

    const regionSource =
      typeof rawRef.regionSource === "string" && rawRef.regionSource.trim()
        ? rawRef.regionSource.trim()
        : authoredRegion?.source
          ? authoredRegion.source
          : resolvedCell.maskState === "region"
            ? "Explicit sub-object region mask (FMRM v2)"
            : resolvedCell.maskState === "active-unassigned"
              ? "Object magnetic support (unassigned)"
              : resolvedCell.maskState === "inactive"
                ? "Outside magnetic support (Airbox)"
                : "Pending canonical FMRM verification";

    const dominantObjectRegion =
      typeof rawRef.dominantObjectRegion === "string" &&
      rawRef.dominantObjectRegion.trim()
        ? rawRef.dominantObjectRegion.trim()
        : matchedLegend
          ? `${ownerObject?.name ? `${ownerObject.name} (${matchedLegend.object_id})` : matchedLegend.object_id} / ${matchedLegend.region_id} (priority ${matchedLegend.priority})`
          : resolvedCell.maskState === "inactive"
            ? "None (outside magnetic support)"
            : ownerObject
              ? `${ownerObject.name || ownerObject.id} (unassigned support)`
              : membership?.object_ids?.length
                ? membership.object_ids.join(", ")
                : "Active magnetic support";

    const materialAssignment =
      typeof rawRef.materialAssignment === "string" &&
      rawRef.materialAssignment.trim()
        ? rawRef.materialAssignment.trim()
        : resolvedCell.maskState === "inactive"
          ? "Vacuum (μ₀)"
          : authoredRegion?.material_ref
            ? `${authoredRegion.material_ref}${authoredRegion.material_overrides?.length ? ` (${authoredRegion.material_overrides.length} override(s))` : ""}`
            : ownerObject?.material_ref
              ? `${ownerObject.material_ref} (inherited from ${ownerObject.name || ownerObject.id})`
              : materialRows.some((r) => r.status === "ready")
                ? "Published cell coefficients"
                : "Default object material";

    const boundaryInterface =
      typeof rawRef.boundaryInterface === "string" &&
      rawRef.boundaryInterface.trim()
        ? rawRef.boundaryInterface.trim()
        : resolveBoundaryInterfaceClassification(
            ijk,
            shape,
            resolvedCell.ordinal,
            binaryRes.data,
            membership,
          );

    const siblingLegendEntries = matchedLegend
      ? legendList.filter(
          (entry) =>
            entry.object_id === matchedLegend.object_id &&
            entry.numeric_id !== matchedLegend.numeric_id,
        )
      : [];
    const competingRegions =
      typeof rawRef.competingRegions === "string" &&
      rawRef.competingRegions.trim()
        ? rawRef.competingRegions.trim()
        : Array.isArray(rawRef.competingRegions) && rawRef.competingRegions.length > 0
          ? rawRef.competingRegions.map(String).join(", ")
          : siblingLegendEntries.length > 0
            ? `${siblingLegendEntries
                .map((s) => `${s.region_id} (priority ${s.priority})`)
                .join(", ")} — resolved by priority ${matchedLegend?.priority ?? 0}`
            : "None";

    const matchedClipDiag =
      resolvedCell.regionId && regionDiagnosticsRes.data?.diagnostics
        ? (regionDiagnosticsRes.data.diagnostics.find(
            (diag) =>
              diag.region_id === resolvedCell.regionId &&
              (!ownerId || diag.owner_object_id === ownerId) &&
              /clip|bound|outside|truncat/i.test(`${diag.code} ${diag.message}`),
          ) ?? null)
        : null;
    const clippedReason =
      typeof rawRef.clippedReason === "string" && rawRef.clippedReason.trim()
        ? rawRef.clippedReason.trim()
        : matchedClipDiag
          ? sanitizeDisplayReason(matchedClipDiag.message, matchedClipDiag.code)
          : resolvedCell.maskState === "region"
            ? "Bounded to parent magnetic support mask"
            : resolvedCell.maskState === "inactive"
              ? "Excluded outside magnetic support"
              : "None (unclipped voxel)";

    const genLabel = domainMeta.data?.generation_id ?? "pending";
    const fpLabel = resolvedCell.gridFingerprint || "pending";
    const activeGridProvenance = `${genLabel} · ${fpLabel} · rev ${resolvedCell.membershipRevision}`;

    return {
      activeGridProvenance,
      boundaryInterface,
      clippedReason,
      competingRegions,
      dominantObjectRegion,
      materialAssignment,
      regionSource,
    };
  }, [
    binaryRes.data,
    domainMeta.data?.generation_id,
    ijk,
    materialRows,
    membership,
    regionDiagnosticsRes.data,
    regionsRes.data,
    resolvedCell.gridFingerprint,
    resolvedCell.maskState,
    resolvedCell.membershipRevision,
    resolvedCell.numericRegionId,
    resolvedCell.ordinal,
    resolvedCell.regionId,
    sceneRes.data?.objects,
    selection.objectId,
    selection.ref,
    shape,
  ]);

  const baseline = useMemo<FdmCellDraft>(
    () => ({ energyUnitMode: "density_jm3" }),
    [],
  );

  const spec = useMemo<InspectorSpec<FdmCellDraft>>(() => {
    const vec =
      magRow?.status === "ready" &&
      magRow.vector?.length === 3 &&
      magRow.vector.every(Number.isFinite)
        ? magRow.vector
        : null;
    const norm = vec ? Math.hypot(vec[0]!, vec[1]!, vec[2]!) : null;

    const maskStateDisplay =
      resolvedCell.verificationStatus === "stale"
        ? "Withheld (stale cell snapshot)"
        : resolvedCell.maskState === "region"
          ? "Active region (region)"
          : resolvedCell.maskState === "active-unassigned"
            ? "Active unassigned (active-unassigned)"
            : resolvedCell.maskState === "inactive"
              ? "Inactive outside support (inactive)"
              : "Pending membership mask";

    return {
      id: "fdm.cell",
      header: {
        breadcrumbs: [
          {
            id: "grid",
            label: "Structured Grid",
            selection: {
              kind: "mesh.grid",
              label: "Structured Grid",
              nodeId: "model:mesh:grid",
              objectId: null,
              ref: null,
            },
          },
          { id: "cell", label: `Voxel (${ijk.join(", ")})` },
        ],
        canFitView: true,
        extraMenuActions: target
          ? [
              {
                icon: RefreshCw,
                id: "refresh-cell-physics",
                label: "Refresh cell physics",
                onSelect: () => handleRetryCellPhysics(),
              },
            ]
          : undefined,
      },
      identity: {
        domain: "physics",
        entityId: `cell:${resolvedCell.cellOrdinal}`,
        icon: Compass,
        kindLabel: "Interactive FDM voxel readout",
        statePill: () =>
          resolvedCell.verificationStatus === "stale"
            ? { label: "Stale", tone: "stale" }
            : target && cellPhysics.status === "error"
              ? { label: "Read error", tone: "err" }
              : target && cellPhysics.status === "stale"
                ? { label: "Refreshing", tone: "stale" }
                : snapshot
                  ? { label: "Current", tone: "live" }
                  : { label: "Waiting", tone: "neutral" },
        title: () => `FDM Voxel (${ijk.join(", ")})`,
      },
      facts: () => [
        { id: "ijk", label: "Indices (i,j,k)", value: `(${ijk.join(", ")})` },
        {
          id: "ordinal",
          label: "Linear index",
          value: resolvedCell.ordinal.toLocaleString("en-US"),
        },
        {
          id: "norm",
          label: "|m|",
          value: norm !== null && Number.isFinite(norm) ? norm.toFixed(4) : null,
        },
        {
          id: "vol",
          label: "Cell volume",
          value: `${(volumeM3 * 1e27).toFixed(2)} nm³`,
        },
      ],
      modeTabs: [
        { id: "physics", label: "Physics" },
        { id: "neighbors", label: "Grid & 6-Neighbors" },
      ],
      notices: () => {
        const list: InspectorNotice<FdmCellDraft>[] = [];
        if (resolvedCell.notice) {
          list.push({
            id: "cell-selection-notice",
            text: resolvedCell.notice,
            title:
              resolvedCell.verificationStatus === "stale"
                ? "Stale cell selection"
                : "Cell physics notice",
            tone: resolvedCell.verificationStatus === "stale" ? "warn" : "info",
          });
        }
        if (target && cellPhysics.status === "error") {
          list.push({
            id: "cell-physics-read-error",
            quickFix: {
              label: "Retry cell physics read",
              onApply: () => handleRetryCellPhysics(),
            },
            text: sanitizeDisplayReason(
              cellPhysics.error?.message,
              "The current cell fields could not be read.",
            ),
            title: "Cell physics read error",
            tone: "err",
          });
        } else if (target && cellPhysics.status === "stale") {
          list.push({
            id: "cell-physics-refreshing",
            text: "Refreshing current fields. Previous values are hidden.",
            title: "Refreshing cell physics",
            tone: "info",
          });
        } else if (target && cellPhysics.status === "loading") {
          list.push({
            id: "cell-physics-loading",
            text: "Reading published fields for this cell.",
            title: "Loading cell physics",
            tone: "info",
          });
        }
        return list;
      },
      sections: [
        {
          defaultOpen: true,
          icon: ShieldCheck,
          id: "cell-membership",
          rows: [
            {
              format: () => maskStateDisplay,
              label: "Mask state",
              type: "readonly",
            },
            {
              format: () =>
                resolvedCell.numericRegionId != null
                  ? String(resolvedCell.numericRegionId)
                  : "None",
              label: "Numeric region",
              mono: true,
              type: "readonly",
            },
            {
              format: () => resolvedCell.regionId ?? "None",
              label: "Semantic region",
              mono: true,
              type: "readonly",
            },
            {
              format: () => resolvedCell.membershipRevision,
              label: "Membership revision",
              mono: true,
              type: "readonly",
            },
            {
              format: () => cellProvenance.regionSource,
              label: "Region source",
              type: "readonly",
            },
            {
              format: () => cellProvenance.dominantObjectRegion,
              label: "Dominant object/region",
              type: "readonly",
            },
            {
              format: () => cellProvenance.materialAssignment,
              label: "Material assignment",
              type: "readonly",
            },
            {
              format: () => cellProvenance.boundaryInterface,
              label: "Boundary/interface",
              type: "readonly",
            },
            {
              format: () => cellProvenance.competingRegions,
              label: "Competing regions",
              type: "readonly",
            },
            {
              format: () => cellProvenance.clippedReason,
              label: "Clipped reason",
              type: "readonly",
            },
            {
              copyText: () => cellProvenance.activeGridProvenance,
              format: () => cellProvenance.activeGridProvenance,
              label: "Active grid provenance",
              mono: true,
              type: "readonly",
            },
          ],
          title: "Cell membership & region provenance",
        },
        {
          defaultOpen: true,
          icon: Atom,
          id: "material-params",
          modeTabId: "physics",
          rows:
            snapshot && materialRows.length > 0
              ? materialRows.map((row) => {
                  const usable =
                    row.status === "ready" &&
                    row.scalar !== null &&
                    Number.isFinite(row.scalar);
                  const cleanUnit =
                    row.unit === "1" ||
                    row.unit.toLowerCase() === "dimensionless"
                      ? ""
                      : row.unit.trim();
                  return {
                    format: () =>
                      usable
                        ? `${formatCellScalar(row.scalar!)}${cleanUnit ? ` ${cleanUnit}` : ""}`
                        : "Not published",
                    hint: usable
                      ? undefined
                      : sanitizeDisplayReason(
                          row.reason,
                          "No current coefficient is published for this cell.",
                        ),
                    label: row.label,
                    symbol:
                      row.id === "mat_ms" ? (
                        <>
                          M<sub>s</sub>
                        </>
                      ) : row.id === "mat_aex" ? (
                        <>
                          A<sub>ex</sub>
                        </>
                      ) : row.id === "mat_alpha" ? (
                        <>&alpha;</>
                      ) : undefined,
                    type: "readonly" as const,
                  };
                })
              : [
                  {
                    format: () =>
                      snapshot
                        ? "No material coefficients published for this voxel"
                        : target
                          ? "Current values appear when the read completes"
                          : "Select an active single-grid FDM cell",
                    label: "Material coefficients",
                    type: "readonly",
                  },
                ],
          title: "Material coefficients",
        },
        {
          defaultOpen: true,
          icon: Compass,
          id: "magnetization",
          modeTabId: "physics",
          rows: [
            {
              format: () =>
                vec
                  ? `(${vec[0]!.toFixed(4)}, ${vec[1]!.toFixed(4)}, ${vec[2]!.toFixed(4)})`
                  : "Not published",
              hint:
                snapshot && magRow && !vec
                  ? sanitizeDisplayReason(
                      magRow.reason,
                      "Three finite components are not published for this cell.",
                    )
                  : undefined,
              label: "Reduced magnetization",
              symbol: <>m</>,
              type: "readonly",
            },
            {
              format: () => (norm !== null ? norm.toFixed(6) : "Not published"),
              label: "Vector norm",
              symbol: <>|m|</>,
              type: "readonly",
            },
          ],
          title: "Magnetization vector",
        },
        {
          defaultOpen: true,
          icon: Zap,
          id: "energies",
          live: true,
          modeTabId: "physics",
          rows: [
            {
              key: "energyUnitMode",
              label: "Energy quantity",
              options: [
                { label: "Density [J/m³]", value: "density_jm3" },
                { label: "Voxel [eV]", value: "cell_ev" },
                { label: "Voxel [aJ]", value: "cell_aj" },
              ],
              type: "segmented",
            },
            ...(snapshot && energyRows.length > 0
              ? energyRows.map((row) => {
                  const supportedUnit = isSupportedEnergyDensityUnit(row.unit);
                  const usable =
                    row.status === "ready" &&
                    supportedUnit &&
                    row.scalar !== null &&
                    Number.isFinite(row.scalar);
                  const rowReason = !supportedUnit
                    ? `Cannot interpret ${row.unit || "an unspecified unit"} as energy density in J/m³.`
                    : sanitizeDisplayReason(
                        row.reason,
                        "This energy density is not currently published for this cell.",
                      );
                  return {
                    format: (d: FdmCellDraft) =>
                      formatEnergyRowValue(row, volumeM3, d.energyUnitMode),
                    hint: usable ? undefined : rowReason,
                    label: row.label,
                    type: "readonly" as const,
                  };
                })
              : [
                  {
                    format: () =>
                      snapshot
                        ? "No local energy fields published for this cell"
                        : target
                          ? "Current values appear when the read completes"
                          : "Select an active single-grid FDM cell",
                    label: "Local energy terms",
                    type: "readonly" as const,
                  },
                ]),
          ],
          title: "Cell energies",
        },
        {
          defaultOpen: true,
          icon: History,
          id: "field-sources",
          modeTabId: "physics",
          rows:
            snapshot && sourcedRows.length > 0
              ? sourcedRows.map((entry) => ({
                  format: () => entry.provenance,
                  label: entry.label,
                  mono: true,
                  type: "readonly" as const,
                }))
              : [
                  {
                    format: () =>
                      snapshot
                        ? "No current sample provenance"
                        : "Shown when current values are published",
                    label: "Field sources",
                    type: "readonly" as const,
                  },
                ],
          title: "Per-field sample provenance",
        },
        {
          defaultOpen: true,
          icon: Grid3x3,
          id: "stencil",
          modeTabId: "neighbors",
          rows: [
            {
              format: () =>
                fmtCoord3(
                  target?.centerM ?? fdmCellCenter(origin, spacing, ijk),
                  "nm",
                ),
              label: "Voxel center",
              symbol: (
                <>
                  r<sub>c</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () => fmtTuple3(target?.cellSizeM ?? spacing, "nm"),
              label: "Voxel size",
              symbol: <>&Delta;</>,
              type: "readonly",
            },
            {
              label: "6-neighbor stencil",
              render: (ctx) => (
                <SixNeighborStencil
                  binaryData={binaryRes.data}
                  ctx={ctx}
                  gridFingerprint={resolvedCell.gridFingerprint}
                  ijk={ijk}
                  membership={membership}
                  membershipRevision={resolvedCell.membershipRevision}
                  shape={shape}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Voxel coordinates & 6-neighbor stencil",
        },
      ],
      details: () => [
        { label: "Run ID", mono: true, value: snapshot?.runId ?? null },
        {
          label: "Grid fingerprint",
          mono: true,
          value: resolvedCell.gridFingerprint || null,
        },
        ...sourcedRows.map((entry) => ({
          label: entry.label,
          mono: true,
          value: entry.provenance,
        })),
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () =>
          "Live FDM voxel probe · Click a neighbor to step through the grid",
      },
    };
  }, [
    binaryRes.data,
    cellPhysics.error?.message,
    cellPhysics.status,
    cellProvenance,
    energyRows,
    handleRetryCellPhysics,
    ijk,
    magRow,
    materialRows,
    membership,
    origin,
    resolvedCell,
    shape,
    snapshot,
    sourcedRows,
    spacing,
    target,
    volumeM3,
  ]);

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
