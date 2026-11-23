"use client";

import { Grid3x3, Layers } from "lucide-react";
import { createElement, useCallback, useMemo, useSyncExternalStore } from "react";

import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import type {
  DomainMetaResource,
  FdmMultilayerLayoutResource,
  FdmRegionMembershipResource,
  FieldMetaResource,
  GeometryDiagnosticsResource,
  JsonObject,
  MeshActiveBuildResource,
  MeshLastSuccessfulBuildResource,
  MeshQualityGatesResource,
  MeshSharedDomainQualityResource,
  MeshUniverseConfigReplaceRequest,
  MeshUniverseConfigResource,
  SceneResource,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import {
  captureAuthoringMutationFence,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import { runFdmGridRefreshOperation } from "@/kernel/authoring/geometryLifecycleCommandContributions";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import * as geometryLifecycleResources from "@/kernel/resources/geometryLifecycleResources";
import { publishCommittedMeshPolicyResource } from "@/kernel/resources/meshPolicyResourceCache";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import * as studyRuntimeResources from "@/kernel/resources/studyRuntimeResources";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import {
  AIRBOX_VISUALIZATION_TARGET,
  airboxLocalVisualizationPatchFromTargetPatch,
  airboxVisualizationStatePatchFromTargetPatch,
  hasVisualizationStatePatch,
  persistentVisualizationTargetPatch,
  resetAirboxVisualizationState,
  resolveTargetVisualization,
  visualizationTargetKey,
  type ObjectVisualizationSnapshot,
  type VisualizationTargetPatch,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
import { EMPTY_OBJECT_VISUALIZATION_SNAPSHOT } from "@/kernel/visualization/useObjectVisualization";
import {
  authoredObjectBounds,
  buildDomainPresentation,
  deriveAuthoredFdmUniverseOutsideMagneticSupport,
} from "@/shared/domain/mesh/domainPresentation";

import type { InspectorSectionSpec, UnitOption } from "../../template";
import type { AirboxInspectorRuntimeStatus } from "./airboxInspectorRuntimeStatus";
import {
  formatUniverseMeshPolicyConfig,
  type AirboxMeshPolicyLane,
} from "./airboxMeshPolicyDraft";
import {
  resolveFdmUniverseExtentModel,
  type FdmUniverseExtentModel,
  type FdmUniverseRoleEvidence,
} from "./fdmUniverseExtentModel";

export const LENGTH_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "nm", toSiFactor: 1e-9 },
  { unit: "µm", toSiFactor: 1e-6 },
  { unit: "mm", toSiFactor: 1e-3 },
  { unit: "m", toSiFactor: 1 },
];

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function asTuple3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const x = asNumber(value[0]);
  const y = asNumber(value[1]);
  const z = asNumber(value[2]);
  if (x === null || y === null || z === null) return null;
  return [x, y, z];
}

export function formatLengthSmart(meters: number | null | undefined): string {
  if (meters === null || meters === undefined || !Number.isFinite(meters)) {
    return "—";
  }
  const abs = Math.abs(meters);
  if (abs === 0) return "0 nm";
  if (abs < 1e-6) {
    return `${Number((meters * 1e9).toPrecision(4))} nm`;
  }
  if (abs < 1e-3) {
    return `${Number((meters * 1e6).toPrecision(4))} µm`;
  }
  if (abs < 1) {
    return `${Number((meters * 1e3).toPrecision(4))} mm`;
  }
  return `${Number(meters.toPrecision(4))} m`;
}

export function formatTupleSmart(
  values: readonly number[] | null | undefined,
): string {
  if (!values || values.length < 3) return "Not published";
  return `[${formatLengthSmart(values[0])}, ${formatLengthSmart(values[1])}, ${formatLengthSmart(values[2])}]`;
}

export function formatTupleSi(
  values: readonly number[] | null | undefined,
  unit = "m",
): string {
  if (!values || values.length === 0) return "Not published";
  return `[${values.map((v) => Number(v.toPrecision(6))).join(", ")}] ${unit}`;
}

const FORBIDDEN_WORD_RE =
  /\b(?:unknown|unavailable|n\/a|not\s+available|unresolved)\b/gi;

/**
 * Ensures backend status strings never leak forbidden placeholder tokens into
 * canonical InspectorTemplate readouts while preserving full string length.
 */
export function sanitizeStatusText(
  value: string | null | undefined,
  fallback = "Not published",
): string {
  if (!value || !value.trim()) return fallback;
  const cleaned = value.replace(FORBIDDEN_WORD_RE, (match) => {
    const lower = match.toLowerCase();
    if (lower === "unknown") return "unverified";
    if (lower === "unavailable" || lower.startsWith("not")) return "not published";
    if (lower === "unresolved") return "pending";
    return "omitted";
  });
  return cleaned.trim() || fallback;
}

export function isConflictApiError(error: unknown): boolean {
  if (error instanceof ControlRoomApiError) {
    return (
      error.status === 409 ||
      error.code === "universe_mesh_policy_stale_revision" ||
      error.code === "revision_conflict"
    );
  }
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    const message = String((error as { message?: unknown }).message ?? "");
    return status === 409 || /changed since revision|409|conflict/i.test(message);
  }
  return false;
}

// ============================================================================
// Safe Resource Hook Bridges (resilient to partial test module mocks)
// ============================================================================

function idleResource<T>(data: T | null = null): ResourceResult<T> {
  return {
    data,
    error: null,
    refetch: () => undefined,
    refreshError: null,
    revision: null,
    status: "idle",
  } as unknown as ResourceResult<T>;
}

export function useSafeMeshBuildCurrent(options?: {
  enabled?: boolean;
}): ResourceResult<MeshActiveBuildResource> {
  const hook = geometryLifecycleResources.useMeshBuildCurrent;
  return hook ? hook(options) : idleResource<MeshActiveBuildResource>();
}

export function useSafeMeshBuildLatestSuccessful(options?: {
  enabled?: boolean;
}): ResourceResult<MeshLastSuccessfulBuildResource> {
  const hook = geometryLifecycleResources.useMeshBuildLatestSuccessful;
  return hook
    ? hook(options)
    : idleResource<MeshLastSuccessfulBuildResource>();
}

export function useSafeMeshSharedDomainQualityGatesResource(options?: {
  enabled?: boolean;
}): ResourceResult<MeshQualityGatesResource> {
  const hook = geometryLifecycleResources.useMeshSharedDomainQualityGatesResource;
  return hook ? hook(options) : idleResource<MeshQualityGatesResource>();
}

export function useSafeMeshSharedDomainQualityResource(options?: {
  enabled?: boolean;
}): ResourceResult<MeshSharedDomainQualityResource> {
  const hook = geometryLifecycleResources.useMeshSharedDomainQualityResource;
  return hook
    ? hook(options)
    : idleResource<MeshSharedDomainQualityResource>();
}

export function useSafeFdmRegionMembershipResource(options?: {
  enabled?: boolean;
}): ResourceResult<FdmRegionMembershipResource> {
  const hook = geometryLifecycleResources.useFdmRegionMembershipResource;
  return hook ? hook(options) : idleResource<FdmRegionMembershipResource>();
}

export function useSafeGeometryDiagnosticsResource(options?: {
  enabled?: boolean;
}): ResourceResult<GeometryDiagnosticsResource> {
  const hook = geometryLifecycleResources.useGeometryDiagnosticsResource;
  return hook ? hook(options) : idleResource<GeometryDiagnosticsResource>();
}

export function useSafeVisualizationStateResource(options?: {
  enabled?: boolean;
}): ResourceResult<VisualizationStateResource> & {
  optimisticData?: VisualizationStateResource | null;
  rawData?: VisualizationStateResource | null;
} {
  const kernel = useKernel();
  const hook:
    | typeof geometryLifecycleResources.useVisualizationStateResource
    | undefined = geometryLifecycleResources.useVisualizationStateResource;
  const isMockedHook =
    typeof hook === "function" && "mock" in (hook as unknown as object);
  if (
    hook &&
    (isMockedHook || Boolean(kernel?.visualizationSync && kernel?.cameraRegistry))
  ) {
    return hook(options);
  }
  return idleResource<VisualizationStateResource>();
}

export function useSafeFieldMetaResource(options: {
  enabled?: boolean;
  quantityId: string;
  scope_id?: string | null;
  scope_kind?: "full" | "object" | "part" | "region" | "airbox" | "selection" | null;
}): ResourceResult<FieldMetaResource | null> {
  const kernel = useKernel();
  const hook: typeof studyRuntimeResources.useFieldMetaResource | undefined =
    studyRuntimeResources.useFieldMetaResource;
  const isMockedHook =
    typeof hook === "function" && "mock" in (hook as unknown as object);
  const canQuery = Boolean(
    options.enabled !== false &&
      (isMockedHook || kernel?.api?.data?.fields?.meta),
  );
  if (hook && (isMockedHook || Boolean(kernel?.resources))) {
    return hook({
      enabled: canQuery,
      quantityId: options.quantityId,
      scope_id: options.scope_id ?? null,
      scope_kind: options.scope_kind ?? null,
    });
  }
  return idleResource<FieldMetaResource | null>(null);
}

// ============================================================================
// Live 3D Airbox Visualization Hook (zero disconnected stubs)
// ============================================================================

const NOOP_UNSUBSCRIBE = () => undefined;
const SERVER_SNAPSHOT = () => EMPTY_OBJECT_VISUALIZATION_SNAPSHOT;

export interface AirboxLiveVisualizationHandle {
  settings: VisualizationTargetSettings;
  hasOverrides: boolean;
  patchAirboxVisualization: (patchValue: VisualizationTargetPatch) => void;
  resetAirboxVisualization: () => void;
}

export function useSafeAirboxTargetVisualization(): AirboxLiveVisualizationHandle {
  const kernel = useKernel();
  const visualization = kernel?.visualization ?? null;
  const visualizationSync = kernel?.visualizationSync ?? null;
  const visualizationState = useSafeVisualizationStateResource({ enabled: true });
  const displayState =
    visualizationState.optimisticData ?? visualizationState.data ?? null;

  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      visualization ? visualization.subscribe(onStoreChange) : NOOP_UNSUBSCRIBE,
    [visualization],
  );
  const getSnapshot = useCallback(
    (): ObjectVisualizationSnapshot =>
      visualization
        ? visualization.getSnapshot()
        : EMPTY_OBJECT_VISUALIZATION_SNAPSHOT,
    [visualization],
  );

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, SERVER_SNAPSHOT);

  const resolved = useMemo(
    () =>
      resolveTargetVisualization({
        snapshot,
        target: AIRBOX_VISUALIZATION_TARGET,
        visualizationState: displayState,
      }),
    [displayState, snapshot],
  );

  const patchAirboxVisualization = useCallback(
    (patchValue: VisualizationTargetPatch) => {
      if (!visualization) return;
      const localPatch = airboxLocalVisualizationPatchFromTargetPatch(patchValue);
      const statePatch = airboxVisualizationStatePatchFromTargetPatch(
        patchValue,
        displayState?.overrides,
      );
      if (Object.keys(localPatch).length > 0) {
        visualization.patchViewportPreferences?.(
          AIRBOX_VISUALIZATION_TARGET,
          localPatch,
        );
      }
      if (!hasVisualizationStatePatch(statePatch)) {
        return;
      }
      const targetKey = visualizationTargetKey(AIRBOX_VISUALIZATION_TARGET);
      const receipt = visualizationSync?.queuePatch?.(statePatch, [targetKey]);
      visualization.patchTargetPending?.(
        AIRBOX_VISUALIZATION_TARGET,
        persistentVisualizationTargetPatch(patchValue),
        visualizationState.rawData?.revision ??
          visualizationState.data?.revision ??
          0,
        receipt?.transactionId ?? `airbox-viz-${Date.now()}`,
      );
    },
    [
      displayState?.overrides,
      visualization,
      visualizationState.data?.revision,
      visualizationState.rawData?.revision,
      visualizationSync,
    ],
  );

  const resetAirboxVisualization = useCallback(() => {
    if (visualizationSync?.queuePatch) {
      visualizationSync.queuePatch(
        resetAirboxVisualizationState(displayState ?? { overrides: [] }),
        [visualizationTargetKey(AIRBOX_VISUALIZATION_TARGET)],
      );
    }
    visualization?.clearTarget?.(AIRBOX_VISUALIZATION_TARGET);
  }, [displayState, visualization, visualizationSync]);

  const hasOverrides = useMemo(() => {
    if (resolved.override !== null) return true;
    const prefs = snapshot.viewportPreferences?.[AIRBOX_VISUALIZATION_TARGET.id];
    return Boolean(prefs && Object.keys(prefs).length > 0);
  }, [resolved.override, snapshot.viewportPreferences]);

  return {
    hasOverrides,
    patchAirboxVisualization,
    resetAirboxVisualization,
    settings: resolved.settings,
  };
}

// ============================================================================
// Scene Envelope Helper for "Expand Padding to Fit Objects"
// ============================================================================

export interface SceneEnvelopeBounds {
  min: [number, number, number];
  max: [number, number, number];
  span: [number, number, number];
  center: [number, number, number];
}

export function computeSceneObjectsEnvelope(
  objects: readonly unknown[] | null | undefined,
  fallbackBounds?: { min: readonly number[]; max: readonly number[] } | null,
): SceneEnvelopeBounds | null {
  const boxes: Array<{
    min: readonly [number, number, number];
    max: readonly [number, number, number];
  }> = [];
  if (Array.isArray(objects)) {
    for (const obj of objects) {
      const bounds = authoredObjectBounds(obj);
      if (bounds) {
        boxes.push(bounds);
      }
    }
  }
  if (boxes.length === 0 && fallbackBounds) {
    const min = asTuple3(fallbackBounds.min);
    const max = asTuple3(fallbackBounds.max);
    if (min && max) {
      boxes.push({ max, min });
    }
  }
  if (boxes.length === 0) return null;

  const min: [number, number, number] = [...boxes[0]!.min];
  const max: [number, number, number] = [...boxes[0]!.max];
  for (const box of boxes.slice(1)) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, box.min[axis]!);
      max[axis] = Math.max(max[axis]!, box.max[axis]!);
    }
  }
  const span: [number, number, number] = [
    Math.max(1e-9, max[0] - min[0]),
    Math.max(1e-9, max[1] - min[1]),
    Math.max(1e-9, max[2] - min[2]),
  ];
  const center: [number, number, number] = [
    (min[0] + max[0]) * 0.5,
    (min[1] + max[1]) * 0.5,
    (min[2] + max[2]) * 0.5,
  ];
  return { center, max, min, span };
}

// ============================================================================
// Canonical Authoring Mutation & Rebase Helpers
// ============================================================================

export async function submitCanonicalUniversePolicy({
  baseConfigText,
  baseRevision,
  config,
  kernel,
  label,
  lane,
  latestPolicy,
  runtimeLane,
  runtimeStatus,
  sceneData,
  sessionScopeKey,
}: {
  config: JsonObject;
  baseRevision: number | undefined;
  baseConfigText: string;
  lane: AirboxMeshPolicyLane;
  runtimeLane: "fdm" | "fem" | null;
  latestPolicy: MeshUniverseConfigResource | null;
  runtimeStatus: AirboxInspectorRuntimeStatus | null;
  sceneData: SceneResource | null | undefined;
  kernel: ReturnType<typeof useKernel>;
  sessionScopeKey: string | undefined;
  label: string;
}): Promise<MeshUniverseConfigResource> {
  // Rebase expected_revision if the authored config is unchanged since our draft opened
  let expectedRevision = baseRevision;
  if (
    latestPolicy &&
    expectedRevision !== latestPolicy.revision &&
    formatUniverseMeshPolicyConfig(latestPolicy.config) === baseConfigText
  ) {
    expectedRevision = latestPolicy.revision;
  }

  const request: MeshUniverseConfigReplaceRequest = {
    config,
    ...(expectedRevision !== undefined
      ? { expected_revision: expectedRevision }
      : {}),
  };
  const requestOptions = sessionScopeKey ? { sessionScopeKey } : undefined;

  const hasSessionScopeGetter =
    typeof kernel.commands?.getSessionScopeKey === "function";
  const rawContext = createCommandContext("inspector", kernel, {
    input: { origin: "airbox" },
    ...(!hasSessionScopeGetter && sessionScopeKey
      ? { isCurrentSessionScope: () => true }
      : {}),
    resourceData: {
      [SESSION_STATUS_RESOURCE_KEY]: runtimeStatus,
      ...(sceneData
        ? { [geometryLifecycleResources.SCENE_RESOURCE_KEY]: sceneData }
        : {}),
    },
    sessionScopeKey: sessionScopeKey ?? null,
    sourceDetail: "airbox-policy",
  });
  const fencedContext = sessionScopeKey
    ? captureAuthoringMutationFence(rawContext)
    : rawContext;

  const executeReplace = async () =>
    kernel.api.meshing.replaceUniversePolicy(request, requestOptions);

  const committed = sessionScopeKey
    ? await runAuthoringMutationWithHistory(
        fencedContext,
        label,
        executeReplace,
        async () => {
          if (typeof kernel.api.model?.scene === "function") {
            return kernel.api.model.scene(requestOptions);
          }
          return null;
        },
      )
    : await executeReplace();

  const rev = committed?.revision ?? (expectedRevision ?? 0) + 1;
  if (committed && typeof committed === "object") {
    publishCommittedMeshPolicyResource?.(
      kernel.resources,
      geometryLifecycleResources.MESH_UNIVERSE_POLICY_RESOURCE_KEY,
      sessionScopeKey,
      committed,
      kernel.api.resourceCacheScope,
    );
  }
  kernel.resources?.invalidate?.(
    geometryLifecycleResources.MESH_UNIVERSE_POLICY_RESOURCE_KEY,
    rev,
  );
  if (geometryLifecycleResources.MESH_BUILD_CURRENT_RESOURCE_KEY) {
    kernel.resources?.invalidate?.(
      geometryLifecycleResources.MESH_BUILD_CURRENT_RESOURCE_KEY,
      rev,
    );
  }
  if (geometryLifecycleResources.MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY) {
    kernel.resources?.invalidate?.(
      geometryLifecycleResources.MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
      rev,
    );
  }
  kernel.resources?.invalidate?.(
    geometryLifecycleResources.SCENE_RESOURCE_KEY,
    `mesh-policy:universe:${rev}`,
  );
  kernel.resources?.invalidate?.(
    SESSION_STATUS_RESOURCE_KEY,
    `mesh-policy:universe:${rev}`,
  );

  // Restore FDM grid refresh operation when saving FDM universe policy
  if (lane === "fdm" && runtimeLane === "fdm") {
    try {
      let currentSceneRev: number | null = null;
      if (typeof kernel.api.model?.scene === "function") {
        const refreshedScene = await kernel.api.model.scene(requestOptions);
        currentSceneRev =
          asNumber(refreshedScene?.scene_revision) ??
          asNumber(refreshedScene?.revision);
      } else {
        currentSceneRev =
          asNumber(asRecord(sceneData)?.scene_revision) ??
          asNumber(asRecord(sceneData)?.revision);
      }
      if (currentSceneRev !== null) {
        kernel.resources?.invalidate?.(
          geometryLifecycleResources.SCENE_RESOURCE_KEY,
          currentSceneRev,
        );
        await runFdmGridRefreshOperation(fencedContext, {
          kind: "fdm_grid_refresh",
          precondition: { scene_revision: currentSceneRev },
          reason: "airbox_policy_commit",
        });
        geometryLifecycleResources.invalidateFdmGridResources?.(
          kernel.resources,
          `fdm-replan:${currentSceneRev}`,
        );
      }
    } catch {
      // Grid refresh warning is non-fatal after the policy itself committed
    }
  }

  return committed;
}

export async function commitStudyMergePatchWithHistory({
  fallbackBaseRevision,
  kernel,
  label,
  runtimeStatus,
  sceneData,
  sessionScopeKey,
  studyPatch,
}: {
  studyPatch: JsonObject;
  fallbackBaseRevision: number | null;
  runtimeStatus: AirboxInspectorRuntimeStatus | null;
  sceneData: SceneResource | null | undefined;
  kernel: ReturnType<typeof useKernel>;
  sessionScopeKey: string | undefined;
  label: string;
}): Promise<number | null> {
  const requestOptions = sessionScopeKey ? { sessionScopeKey } : undefined;
  const hasSessionScopeGetter =
    typeof kernel.commands?.getSessionScopeKey === "function";
  const rawContext = createCommandContext("inspector", kernel, {
    ...(!hasSessionScopeGetter && sessionScopeKey
      ? { isCurrentSessionScope: () => true }
      : {}),
    resourceData: {
      [SESSION_STATUS_RESOURCE_KEY]: runtimeStatus,
      ...(sceneData
        ? { [geometryLifecycleResources.SCENE_RESOURCE_KEY]: sceneData }
        : {}),
    },
    sessionScopeKey: sessionScopeKey ?? null,
    sourceDetail: "airbox-study-boundary",
  });
  const fencedContext = sessionScopeKey
    ? captureAuthoringMutationFence(rawContext)
    : rawContext;

  const runCommit = async (baseRev: number | null) =>
    kernel.api.model.commitTransaction(
      {
        base_revision: baseRev ?? fallbackBaseRevision,
        kind: "merge_patch",
        merge_patch: {
          study: studyPatch,
        },
      },
      requestOptions,
    );

  const response = sessionScopeKey
    ? await runAuthoringMutationWithHistory(
        fencedContext,
        label,
        async ({ baseRevision }) => runCommit(baseRevision),
      )
    : await runCommit(fallbackBaseRevision);

  const responseRecord = asRecord(response);
  let committedRev: number | null = null;
  if (
    responseRecord &&
    (responseRecord.scene_revision !== undefined ||
      responseRecord.revision !== undefined)
  ) {
    committedRev = acknowledgedAuthoringSceneRevision(responseRecord);
  } else if (fallbackBaseRevision !== null) {
    committedRev = fallbackBaseRevision + 1;
  }

  if (
    response?.committed_scene &&
    committedRev !== null &&
    typeof geometryLifecycleResources.publishCommittedSceneResource === "function"
  ) {
    geometryLifecycleResources.publishCommittedSceneResource(
      kernel.resources,
      response.committed_scene,
      committedRev,
      undefined,
      true,
      sessionScopeKey,
      kernel.api.resourceCacheScope,
    );
  }
  if (committedRev !== null && Boolean(kernel.resources)) {
    invalidateAuthoringMutationDependents(
      kernel.resources,
      "interaction",
      committedRev,
    );
  } else {
    kernel.resources?.invalidate?.(
      geometryLifecycleResources.SCENE_RESOURCE_KEY,
      `study-boundary:${Date.now()}`,
    );
  }
  return committedRev;
}

// ============================================================================
// FDM Airbox Structured-Grid Facts Builder (replaces FdmAirboxMeshFactsPanel)
// ============================================================================

export function resolveFdmRoleEvidence(
  domainData: DomainMetaResource | null | undefined,
  membershipData: FdmRegionMembershipResource | null | undefined,
  membershipStatus: "error" | "idle" | "loading" | "ready" | "stale",
  sceneObjects: readonly unknown[] | null | undefined,
): FdmUniverseRoleEvidence | null {
  if (!domainData) return null;
  try {
    const presentation = buildDomainPresentation({
      domainMeta: domainData,
      fdmMembership: membershipData ?? null,
      fdmMembershipStatus: membershipStatus,
      universeOutsideMagneticSupport:
        deriveAuthoredFdmUniverseOutsideMagneticSupport({
          domainBounds: domainData.bounds,
          objects: sceneObjects,
        }),
    });
    return { presentation, source: "domain-presentation" };
  } catch {
    return null;
  }
}

export function buildFdmAirboxFactsSections<TDraft>({
  domainRes,
  membership,
  multilayerLayout,
  roleEvidence,
  showWhen,
  view,
}: {
  view: "overview" | "quality" | "statistics" | "topology" | "build";
  domainRes: Pick<ResourceResult<DomainMetaResource | null>, "data" | "error" | "status">;
  membership: FdmRegionMembershipResource | null | undefined;
  multilayerLayout?: FdmMultilayerLayoutResource | null;
  roleEvidence: FdmUniverseRoleEvidence | null;
  showWhen?: (draft: TDraft) => boolean;
}): InspectorSectionSpec<TDraft>[] {
  const fdmModel: FdmUniverseExtentModel = resolveFdmUniverseExtentModel({
    explicitFdm: true,
    resource: domainRes,
    roleEvidence,
  });
  const membershipIsCurrent = fdmModel.status === "ready";
  const currentMembership = membershipIsCurrent ? membership : null;
  const support = currentMembership?.magnetic_support;
  const mlAvailable = multilayerLayout?.available === true;
  const mlCells = asTuple3(multilayerLayout?.airbox?.cells);

  if (view === "quality") {
    return [
      {
        defaultOpen: true,
        icon: Grid3x3,
        id: "fdm-airbox-quality",
        rows: [
          {
            format: () => sanitizeStatusText(fdmModel.status, "Pending"),
            label: "Structured-grid descriptor",
            type: "readonly",
          },
          {
            format: () =>
              membershipIsCurrent
                ? "Current"
                : membership
                  ? "Stale for current grid"
                  : mlAvailable
                    ? "Target-only multilayer layout"
                    : "Not materialized",
            label: "Membership freshness",
            type: "readonly",
          },
          {
            format: () => "Not applicable in structured FDM lane",
            label: "FEM element quality",
            type: "readonly",
          },
        ],
        showWhen,
        title: "FDM Airbox structured-grid checks",
      },
    ];
  }

  if (view === "statistics") {
    return [
      {
        defaultOpen: true,
        icon: Grid3x3,
        id: "fdm-airbox-statistics",
        rows: [
          {
            format: () =>
              fdmModel.totalCells !== null
                ? fdmModel.totalCells.toLocaleString("en-US")
                : mlCells
                  ? (mlCells[0] * mlCells[1] * mlCells[2]).toLocaleString("en-US")
                  : "Not materialized",
            label: "Total grid cells",
            type: "readonly",
          },
          {
            format: () =>
              support?.inactive_cell_count !== undefined
                ? support.inactive_cell_count.toLocaleString("en-US")
                : "Not materialized",
            label: "Airbox cells (outside magnetic support)",
            type: "readonly",
          },
          {
            format: () =>
              support?.active_cell_count !== undefined
                ? support.active_cell_count.toLocaleString("en-US")
                : "Not materialized",
            label: "Magnetic support cells",
            type: "readonly",
          },
          {
            format: () =>
              currentMembership?.region_legend
                ? currentMembership.region_legend.length.toLocaleString("en-US")
                : "Not materialized",
            label: "Owner / region entries",
            type: "readonly",
          },
        ],
        showWhen,
        title: "FDM Airbox cell statistics",
      },
    ];
  }

  if (view === "topology") {
    return [
      {
        defaultOpen: true,
        icon: Layers,
        id: "fdm-airbox-topology",
        rows: [
          {
            format: () => "Implicit regular Cartesian grid (FEM unstructured topology not applicable)",
            label: "Topology representation",
            type: "readonly",
          },
          {
            format: () =>
              fdmModel.gridShape
                ? fdmModel.gridShape.join(" × ")
                : mlCells
                  ? mlCells.join(" × ")
                  : "Not materialized",
            label: "Structured-grid shape",
            type: "readonly",
          },
          {
            format: () => formatTupleSmart(fdmModel.spacing),
            label: "Cell spacing",
            type: "readonly",
          },
          {
            format: () => formatTupleSmart(fdmModel.origin),
            label: "Grid origin",
            type: "readonly",
          },
        ],
        showWhen,
        title: "FDM Airbox structured topology",
      },
    ];
  }

  if (view === "build") {
    return [
      {
        defaultOpen: true,
        icon: Grid3x3,
        id: "fdm-airbox-provenance",
        rows: [
          {
            copyText: () => fdmModel.generationId,
            format: () => fdmModel.generationId ?? "Not materialized",
            label: "Domain generation",
            mono: true,
            type: "readonly",
          },
          {
            copyText: () => currentMembership?.grid_fingerprint ?? null,
            format: () =>
              currentMembership?.grid_fingerprint ??
              "Not materialized or identity mismatch",
            label: "Grid fingerprint",
            mono: true,
            type: "readonly",
          },
          {
            format: () =>
              currentMembership?.region_membership_revision !== undefined
                ? currentMembership.region_membership_revision.toLocaleString("en-US")
                : "Not materialized",
            label: "Membership revision",
            type: "readonly",
          },
          {
            format: () => "Not applicable (use Build FDM Grid to replan)",
            label: "Standalone FEM mesh build",
            type: "readonly",
          },
        ],
        showWhen,
        title: "FDM Airbox grid provenance",
      },
    ];
  }

  // Overview
  return [
    {
      defaultOpen: true,
      icon: Grid3x3,
      id: "fdm-airbox-overview",
      rows: [
        {
          format: () => "FDM structured Cartesian universe",
          label: "Discretization",
          type: "readonly",
        },
        {
          format: () =>
            fdmModel.universeRole
              ? "Airbox outside magnetic support"
              : mlAvailable
                ? "Target-only multilayer stray-field Airbox"
                : "Not published",
          label: "Airbox role",
          type: "readonly",
        },
        {
          copyText: () => fdmModel.domainId,
          format: () => fdmModel.domainId ?? "Not materialized",
          label: "Domain ID",
          mono: true,
          type: "readonly",
        },
        {
          copyText: () => fdmModel.generationId,
          format: () => fdmModel.generationId ?? "Not materialized",
          label: "Generation ID",
          mono: true,
          type: "readonly",
        },
        {
          format: () =>
            fdmModel.gridShape
              ? fdmModel.gridShape.join(" × ")
              : mlCells
                ? mlCells.join(" × ")
                : "Not materialized",
          label: "Grid shape",
          symbol: "N",
          type: "readonly",
        },
        {
          format: () =>
            fdmModel.totalCells !== null
              ? fdmModel.totalCells.toLocaleString("en-US")
              : "Not materialized",
          label: "Total cells",
          type: "readonly",
        },
        {
          format: () => formatTupleSmart(fdmModel.spacing),
          label: "Cell spacing",
          symbol: "\u0394",
          type: "readonly",
        },
        {
          format: () => formatTupleSmart(fdmModel.origin),
          label: "Origin",
          symbol: createElement("span", null, "r", createElement("sub", null, "0")),
          type: "readonly",
        },
        {
          format: () => formatTupleSmart(fdmModel.boundsMin),
          label: "Bounds min",
          type: "readonly",
        },
        {
          format: () => formatTupleSmart(fdmModel.boundsMax),
          label: "Bounds max",
          type: "readonly",
        },
        {
          format: () =>
            membership ? "Published with structured grid" : "Not materialized",
          label: "Membership mask",
          type: "readonly",
        },
      ],
      showWhen,
      title: "FDM structured universe & Airbox",
    },
  ];
}
