import {
  MODEL_MATERIAL_FIELDS_PATH,
  MODEL_REALIZED_REGIONS_PATH,
  MODEL_REGION_DIAGNOSTICS_PATH,
  MODEL_REGIONS_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import type {
  AuthoringTransactionRequest,
  CouplingListResource,
  DomainMetaResource,
  FdmRegionMembershipResource,
  FrozenSpinsSelectionExpression,
  MaterialParameterFieldListResource,
  MeshActiveBuildResource,
  MeshRegionMembershipResource,
  MeshRegionQualityResource,
  RegionDiagnosticsResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type { DecodedFdmRegionMembership } from "@/kernel/api/codecs/fdmRegionMembershipCodec";
import type { components } from "@/kernel/api/generated/openapi-v2-types";
import {
  authoringWriteOptions,
  captureAuthoringMutationFence,
  runAuthoringMutationWithHistory,
  type AuthoringMutationPreparation,
} from "@/kernel/authoring/authoringHistoryMutation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import * as geometryLifecycleResources from "@/kernel/resources/geometryLifecycleResources";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionScopedResourceKey } from "@/kernel/resources/useSessionScopedResourceKey";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";

import { syncAuthoringScriptBestEffort } from "../ObjectMagneticTexturePanelViewModel";
import {
  clampObjectRegionDraftShapeToOwnerBounds,
  ownerBoundsForObject,
  resolveRegionCouplingDependencies,
  type ObjectRegionDiagnosticItem,
  type RegionCouplingDependency,
  type RegionOwnerBounds,
} from "../ObjectRegionsPanelModel";
import {
  fallbackRevision,
  normalizeVector3,
} from "../model-roots/SpecInspectorHost";
import { publishRegionAuthoringScene } from "../regionAuthoringInvalidation";
import { buildNewRegionPayload } from "../RegionsListPanelModel";
import {
  materialFieldDraftFromAssignment,
  materialFieldFromDraft,
  materialFieldRealizationRows,
  materialFunctionFieldSummary,
  type MaterialFunctionFieldSummary,
  type SceneRegionConflictPolicy,
} from "./ObjectRegionMaterialFieldsModel";
import { resolveRegionDiagnosticsForLane } from "./regionDiagnosticPresentation";

export type SceneMaterialParameterAssignment = Extract<
  AuthoringTransactionRequest,
  { kind: "patch_object_material_fields" }
>["fields"][number];
export type SceneMaterialParameterName = SceneMaterialParameterAssignment["parameter"];
export type SceneObjectRegion = Extract<
  AuthoringTransactionRequest,
  { kind: "create_object_region" }
>["region"];
export type SceneRegionShape = SceneObjectRegion["shape"];
export type SceneObjectRegionPatch = Extract<
  AuthoringTransactionRequest,
  { kind: "patch_object_region" }
>["patch"];
export type SceneRegionMaterialOverride = components["schemas"]["SceneRegionMaterialOverride"];
export type SceneMaterialTransition = components["schemas"]["SceneMaterialTransition"];
export type SceneMaterialTransitionScope = components["schemas"]["SceneMaterialTransitionScope"];
export type SceneRegionFrame = components["schemas"]["SceneRegionFrame"];
export type SceneRegionRealizationPolicy = components["schemas"]["SceneRegionRealizationPolicy"];

export type CanonicalRegionMeshLane = "fem" | "fdm" | "pending";

export function resolveCanonicalRegionMeshLane(
  lane: string | null | undefined,
  scene: SceneResource | null | undefined,
): {
  lane: CanonicalRegionMeshLane;
  factValue: string | null;
  diagnosticLabel: string;
} {
  const studyDiscretization = (
    (scene?.study ?? null) as Record<string, unknown> | null
  )?.discretization;
  const resolved = lane ?? (typeof studyDiscretization === "string" ? studyDiscretization : null);
  if (resolved === "fem") {
    return {
      lane: "fem",
      factValue: "FEM conformal / projected",
      diagnosticLabel: "FEM tetrahedral support",
    };
  }
  if (resolved === "fdm") {
    return {
      lane: "fdm",
      factValue: "FDM voxel mask",
      diagnosticLabel: "FDM voxel support",
    };
  }
  return {
    lane: "pending",
    factValue: null,
    diagnosticLabel: "Pending study discretization",
  };
}

/* ── Selection Target Extraction (supports `selection.ref` + `:regions:` & `:region:`) ── */

const REGION_CHILD_SUFFIXES = [
  ":magnetic-parameters",
  ":material",
  ":mesh",
  ":texture",
  ":visualization",
  ":geometry",
  ":shape",
  ":diagnostics",
] as const;

function stripRegionChildSuffix(rawTail: string): string {
  for (const suffix of REGION_CHILD_SUFFIXES) {
    if (rawTail.endsWith(suffix)) {
      return rawTail.slice(0, -suffix.length);
    }
  }
  if (rawTail.endsWith(":regions") && rawTail.length > ":regions".length) {
    return rawTail.slice(0, -":regions".length);
  }
  return rawTail;
}

export function extractSelectionTarget(selection: Selection): {
  objectId: string;
  regionId: string;
} {
  const refRec = selection.ref as { objectId?: unknown; regionId?: unknown } | null | undefined;
  const refObjectId =
    selection.ref?.type === "scene-object"
      ? selection.ref.objectId
      : typeof refRec?.objectId === "string" && refRec.objectId.length > 0
        ? refRec.objectId
        : "";
  const refRegionId =
    selection.ref?.type === "scene-object"
      ? (selection.ref.regionId ?? "")
      : typeof refRec?.regionId === "string"
        ? refRec.regionId
        : "";

  if (refObjectId && refRegionId) {
    return { objectId: refObjectId, regionId: refRegionId };
  }

  let objectId = refObjectId || selection.objectId || "";
  const nodeId = selection.nodeId ?? "";

  let afterObject = "";
  if (objectId && nodeId.startsWith(`model:object:${objectId}:`)) {
    afterObject = nodeId.slice(`model:object:${objectId}:`.length);
  } else {
    const modelObjectMatch = /^model:object:([^:]+):(.*)$/.exec(nodeId);
    if (modelObjectMatch) {
      if (!objectId) {
        objectId = modelObjectMatch[1] ?? "";
      }
      afterObject = modelObjectMatch[2] ?? "";
    } else {
      const regionsIdx = nodeId.indexOf(":regions:");
      const regionIdx = nodeId.indexOf(":region:");
      if (regionsIdx >= 0 && (regionIdx < 0 || regionsIdx <= regionIdx)) {
        afterObject = nodeId.slice(regionsIdx + 1);
      } else if (regionIdx >= 0) {
        afterObject = nodeId.slice(regionIdx + 1);
      }
    }
  }

  if (afterObject === "regions" || afterObject === "region") {
    return { objectId, regionId: refRegionId };
  }
  if (afterObject.startsWith("regions:")) {
    return {
      objectId,
      regionId: stripRegionChildSuffix(afterObject.slice("regions:".length)),
    };
  }
  if (afterObject.startsWith("region:")) {
    return {
      objectId,
      regionId: stripRegionChildSuffix(afterObject.slice("region:".length)),
    };
  }

  return { objectId, regionId: refRegionId };
}

/* ── Safe Resource Hook Wrappers (graceful when partial test mocks omit optional hooks) ── */

function idleResourceResult<T>(): ResourceResult<T> {
  return {
    data: null,
    error: null,
    refetch: () => undefined,
    revision: null,
    status: "idle",
  };
}

function readOptionalLifecycleExport<T>(name: string): T | undefined {
  try {
    const rec = geometryLifecycleResources as Record<string, unknown>;
    return name in rec ? (rec[name] as T) : undefined;
  } catch {
    return undefined;
  }
}

export function useModelCouplingsResourceSafe(): ResourceResult<CouplingListResource> {
  const hook = readOptionalLifecycleExport<() => ResourceResult<CouplingListResource>>(
    "useModelCouplingsResource",
  );
  return typeof hook === "function" ? hook() : idleResourceResult<CouplingListResource>();
}

export function useModelMaterialFieldsResourceSafe(): ResourceResult<MaterialParameterFieldListResource> {
  const hook = readOptionalLifecycleExport<
    () => ResourceResult<MaterialParameterFieldListResource>
  >("useModelMaterialFieldsResource");
  return typeof hook === "function"
    ? hook()
    : idleResourceResult<MaterialParameterFieldListResource>();
}

export function useMeshRegionMembershipResourceSafe(
  objectId: string | null | undefined,
  regionId: string | null | undefined,
  options: { enabled?: boolean } = {},
): ResourceResult<MeshRegionMembershipResource> {
  const hook = readOptionalLifecycleExport<
    (
      o: string | null | undefined,
      r: string | null | undefined,
      opts?: { enabled?: boolean },
    ) => ResourceResult<MeshRegionMembershipResource>
  >("useMeshRegionMembershipResource");
  return typeof hook === "function"
    ? hook(objectId, regionId, options)
    : idleResourceResult<MeshRegionMembershipResource>();
}

export function useMeshBuildCurrentSafe(
  options: { enabled?: boolean } = {},
): ResourceResult<MeshActiveBuildResource> {
  const hook = readOptionalLifecycleExport<
    (opts?: { enabled?: boolean }) => ResourceResult<MeshActiveBuildResource>
  >("useMeshBuildCurrent");
  return typeof hook === "function"
    ? hook(options)
    : idleResourceResult<MeshActiveBuildResource>();
}

export function useMeshRegionQualityResourceSafe(
  regionId: string | null | undefined,
  options: { enabled?: boolean } = {},
): ResourceResult<MeshRegionQualityResource> {
  const hook = readOptionalLifecycleExport<
    (
      r: string | null | undefined,
      opts?: { enabled?: boolean },
    ) => ResourceResult<MeshRegionQualityResource>
  >("useMeshRegionQualityResource");
  return typeof hook === "function"
    ? hook(regionId, options)
    : idleResourceResult<MeshRegionQualityResource>();
}

export function useDomainMetaResourceSafe(
  options: { enabled?: boolean } = {},
): ResourceResult<DomainMetaResource> {
  const hook = readOptionalLifecycleExport<
    (opts?: { enabled?: boolean }) => ResourceResult<DomainMetaResource>
  >("useDomainMetaResource");
  return typeof hook === "function" ? hook(options) : idleResourceResult<DomainMetaResource>();
}

export function useFdmRegionMembershipResourceSafe(
  options: { enabled?: boolean } = {},
): ResourceResult<FdmRegionMembershipResource> {
  const hook = readOptionalLifecycleExport<
    (opts?: { enabled?: boolean }) => ResourceResult<FdmRegionMembershipResource>
  >("useFdmRegionMembershipResource");
  return typeof hook === "function"
    ? hook(options)
    : idleResourceResult<FdmRegionMembershipResource>();
}

export function useFdmRegionMembershipBinaryResourceSafe(
  regionId?: string | null,
  options: { enabled?: boolean; ownerObjectId?: string | null } = {},
): ResourceResult<DecodedFdmRegionMembership | null> {
  const hook = readOptionalLifecycleExport<
    (
      r?: string | null,
      opts?: { enabled?: boolean; ownerObjectId?: string | null },
    ) => ResourceResult<DecodedFdmRegionMembership | null>
  >("useFdmRegionMembershipBinaryResource");
  return typeof hook === "function"
    ? hook(regionId, options)
    : idleResourceResult<DecodedFdmRegionMembership | null>();
}

/* ── Authoring Mutation + History + Session Scope + Resource Invalidation ── */

export function useRegionSessionScopeKey(kernel: KernelApi): string | null {
  const { sessionIdentity } = useSessionScopedResourceKey(MODEL_SCENE_PATH);
  const identityKey = sessionRequestScopeKey(sessionIdentity);
  const commandKey = kernel.commands?.getSessionScopeKey?.() ?? null;
  return commandKey ?? identityKey ?? null;
}

function toNumericRevision(value: number | string | null | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export async function executeRegionMutationWithHistory<T>({
  kernel,
  label,
  mutation,
  sceneData,
  sessionScopeKey,
  sourceDetail,
}: {
  kernel: KernelApi;
  label: string;
  mutation: (
    preparation: AuthoringMutationPreparation,
    writeOptions: { baseRevision?: number; sessionScopeKey?: string } | undefined,
  ) => Promise<T>;
  sceneData: SceneResource | null | undefined;
  sessionScopeKey: string | null;
  sourceDetail: string;
}): Promise<T> {
  const safeSelection =
    typeof kernel.selection?.get === "function" ? kernel.selection : undefined;

  const baseContext = createCommandContext("inspector", kernel, {
    resourceData: { [MODEL_SCENE_PATH]: sceneData ?? null },
    sessionScopeKey: sessionScopeKey ?? undefined,
    isCurrentSessionScope: sessionScopeKey
      ? () => {
          const live = kernel.commands?.getSessionScopeKey?.() ?? sessionScopeKey;
          return live === sessionScopeKey;
        }
      : undefined,
    sourceDetail,
  });

  const fencedContext = sessionScopeKey
    ? {
        ...captureAuthoringMutationFence(baseContext),
        selection: safeSelection,
      }
    : {
        api: kernel.api,
        authoringHistory: kernel.authoringHistory,
        resourceData: baseContext.resourceData,
        selection: safeSelection,
      };

  const numericSceneRev = toNumericRevision(sceneData?.revision);

  const result = await runAuthoringMutationWithHistory<T>(
    fencedContext,
    label,
    async (preparation) => {
      const effectiveBaseRevision = preparation.baseRevision ?? numericSceneRev;
      const writeOpts = authoringWriteOptions(effectiveBaseRevision, sessionScopeKey);
      return mutation(preparation, writeOpts);
    },
    undefined,
    { expectedSceneRevision: numericSceneRev },
  );

  return result;
}

export async function finalizeRegionAuthoringCommit({
  committedScene,
  fallbackRev,
  kernel,
  sceneRevision,
  sessionScopeKey,
}: {
  committedScene: SceneResource | null | undefined;
  fallbackRev?: number | string | null;
  kernel: KernelApi;
  sceneRevision?: number | string | null;
  sessionScopeKey: string | null;
}): Promise<void> {
  const numericRev = toNumericRevision(sceneRevision) ?? toNumericRevision(fallbackRev);
  const resolvedRev = fallbackRevision(numericRev);
  const sceneKey = readOptionalLifecycleExport<string>("SCENE_RESOURCE_KEY");
  if (committedScene && typeof sceneKey === "string") {
    publishRegionAuthoringScene(
      kernel.resources,
      committedScene,
      numericRev ?? 0,
      undefined,
      sessionScopeKey,
      kernel.api.resourceCacheScope,
    );
  } else {
    if (committedScene) {
      geometryLifecycleResources.publishCommittedSceneResource(
        kernel.resources,
        committedScene,
        resolvedRev,
      );
    }
    kernel.resources.invalidate(MODEL_SCENE_PATH, resolvedRev);
    kernel.resources.invalidate(MODEL_REGIONS_PATH, resolvedRev);
    kernel.resources.invalidate(MODEL_REALIZED_REGIONS_PATH, resolvedRev);
    kernel.resources.invalidate(MODEL_REGION_DIAGNOSTICS_PATH, resolvedRev);
    kernel.resources.invalidate(MODEL_MATERIAL_FIELDS_PATH, resolvedRev);
  }

  if (typeof kernel.api.model?.syncAuthoringScript === "function") {
    await syncAuthoringScriptBestEffort(kernel.api, sessionScopeKey);
  }
}

/* ── Shape Modes, Starters, `ownerBounds`, & Lossless Round-Trip ── */

export type RegionShapeMode =
  | "box"
  | "cylinder"
  | "sphere"
  | "through_disk"
  | "layer_z_slice"
  | "half_space"
  | "boolean_expr";

export const REGION_SHAPE_STARTERS: readonly {
  kind: RegionShapeMode;
  label: string;
}[] = [
  { kind: "box", label: "Box Sub-volume" },
  { kind: "cylinder", label: "Cylinder / Pillar" },
  { kind: "sphere", label: "Sphere Sub-volume" },
  { kind: "through_disk", label: "Through Disk" },
  { kind: "layer_z_slice", label: "Layer Z-Slice" },
  { kind: "half_space", label: "Half-Space" },
  { kind: "boolean_expr", label: "Boolean Selector" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readV3(
  value: unknown,
  fallback: readonly [number, number, number],
): [number, number, number] {
  if (Array.isArray(value) && value.length >= 3) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    const z = Number(value[2]);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      return [x, y, z];
    }
  }
  return [fallback[0], fallback[1], fallback[2]];
}

function readPositiveNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readFiniteNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function resolveOwnerBoundsForSceneObject(
  sceneObj: unknown,
): RegionOwnerBounds | null {
  if (!isRecord(sceneObj)) return null;
  const fromModel = ownerBoundsForObject(sceneObj);
  if (fromModel) return fromModel;

  const geometry = isRecord(sceneObj.geometry) ? sceneObj.geometry : null;
  if (!geometry) return null;
  const kind = String(geometry.kind ?? "").toLowerCase();
  const center = isRecord(geometry) && Array.isArray(geometry.center)
    ? readV3(geometry.center, [0, 0, 0])
    : ([0, 0, 0] as [number, number, number]);
  if (kind === "box" && Array.isArray(geometry.size) && geometry.size.length === 3) {
    const size = readV3(geometry.size, [0, 0, 0]);
    if (size.every((v) => v > 0)) {
      return { center, size };
    }
  }
  if (kind === "cylinder") {
    const r = readPositiveNumber(geometry.radius, 0);
    const h = readPositiveNumber(geometry.height, 0);
    if (r > 0 && h > 0) {
      return { center, size: [r * 2, r * 2, h] };
    }
  }
  if (kind === "sphere") {
    const r = readPositiveNumber(geometry.radius, 0);
    if (r > 0) {
      return { center, size: [r * 2, r * 2, r * 2] };
    }
  }
  return null;
}

export function formatRegionShapeKindLabel(rawShape: unknown): string {
  const shape = isRecord(rawShape) ? rawShape : null;
  const csgExpr =
    shape?.kind === "csg" && isRecord(shape.expression) ? shape.expression : null;
  const rawKind =
    typeof csgExpr?.kind === "string"
      ? csgExpr.kind
      : typeof shape?.kind === "string"
        ? shape.kind
        : "box";
  return rawKind.replace(/_/g, " ");
}

export function buildStarterRegionPayload({
  customName,
  existingCount,
  objectId,
  ownerBounds,
  priority,
  starterKind,
}: {
  customName?: string;
  existingCount: number;
  objectId: string;
  ownerBounds: RegionOwnerBounds | null;
  priority?: number;
  starterKind: RegionShapeMode;
}): SceneObjectRegion {
  const index = existingCount + 1;
  const regionId = `reg-${starterKind.replace(/_/g, "-")}-${index}`;
  const trimmedName = customName?.trim() ?? "";
  const resolvedName = trimmedName.length > 0 ? trimmedName : `Region ${index}`;
  const resolvedPriority =
    typeof priority === "number" && Number.isFinite(priority) ? Math.trunc(priority) : 0;

  if (starterKind === "box" || starterKind === "cylinder" || starterKind === "sphere") {
    const base = buildNewRegionPayload(
      {
        name: resolvedName,
        priority: resolvedPriority,
        shapeKind: starterKind,
      },
      ownerBounds,
    );
    return {
      ...base,
      region_id: regionId,
    };
  }

  const center: [number, number, number] = ownerBounds
    ? [...ownerBounds.center]
    : [0, 0, 0];
  const ownerSize: [number, number, number] = ownerBounds
    ? [...ownerBounds.size]
    : [100e-9, 100e-9, 20e-9];

  let shape: SceneRegionShape;
  switch (starterKind) {
    case "through_disk": {
      const radius = Math.max(Math.min(ownerSize[0], ownerSize[1]) * 0.25, 1e-12);
      const height = Math.max(ownerSize[2], 1e-12);
      shape = {
        kind: "csg",
        expression: {
          kind: "through_disk",
          axis: [0, 0, 1],
          center,
          radius,
          height,
        },
      };
      break;
    }
    case "layer_z_slice": {
      const zMin = center[2] - ownerSize[2] * 0.25;
      const zMax = center[2] + ownerSize[2] * 0.25;
      shape = {
        kind: "csg",
        expression: {
          kind: "layer_z_slice",
          z_min: zMin,
          z_max: zMax,
          center: [center[0], center[1], (zMin + zMax) * 0.5],
          size: [ownerSize[0], ownerSize[1], Math.max(zMax - zMin, 1e-12)],
        },
      };
      break;
    }
    case "half_space":
      shape = {
        kind: "csg",
        expression: {
          kind: "half_space",
          origin: center,
          normal: [1, 0, 0],
        },
      };
      break;
    case "boolean_expr":
      shape = {
        kind: "csg",
        expression: {
          kind: "boolean_expr",
          selector: { kind: "in_object", object_id: objectId },
        },
      };
      break;
  }

  return {
    region_id: regionId,
    name: resolvedName,
    enabled: true,
    frame: "object",
    priority: resolvedPriority,
    realization_policy: "inherit",
    shape,
  };
}

export interface ParsedRegionShapeState {
  shapeMode: RegionShapeMode;
  axis: readonly [number, number, number];
  center: readonly [number, number, number];
  size: readonly [number, number, number];
  radius: number;
  height: number;
  zMin: number;
  zMax: number;
  halfSpaceOrigin: readonly [number, number, number];
  halfSpaceNormal: readonly [number, number, number];
  selectorExpr: FrozenSpinsSelectionExpression;
  preservedCsgExpression: Record<string, unknown> | null;
}

export function parseRegionShapeState(
  rawShape: unknown,
  objectId: string,
  ownerBounds: RegionOwnerBounds | null,
): ParsedRegionShapeState {
  const shape = isRecord(rawShape) ? rawShape : null;
  const csgExpr =
    shape?.kind === "csg" && isRecord(shape.expression) ? shape.expression : null;
  const rawKind =
    typeof csgExpr?.kind === "string"
      ? csgExpr.kind
      : typeof shape?.kind === "string"
        ? shape.kind
        : "box";

  const isEditablePrimitiveMode = (value: string): value is "box" | "cylinder" | "sphere" =>
    value === "box" || value === "cylinder" || value === "sphere";
  const isEditableCsgMode = (
    value: string,
  ): value is "through_disk" | "layer_z_slice" | "half_space" | "boolean_expr" =>
    value === "through_disk" ||
    value === "layer_z_slice" ||
    value === "half_space" ||
    value === "boolean_expr";

  const csgKind = typeof csgExpr?.kind === "string" ? csgExpr.kind : "";
  const shapeMode: RegionShapeMode =
    shape?.kind === "csg"
      ? isEditableCsgMode(csgKind)
        ? csgKind
        : "box"
      : isEditablePrimitiveMode(rawKind) || isEditableCsgMode(rawKind)
        ? rawKind
        : "box";
  const preservedCsgExpression =
    shape?.kind === "csg" && csgExpr && !isEditableCsgMode(csgKind)
      ? structuredClone(csgExpr)
      : null;

  const defaultCenter: [number, number, number] = ownerBounds
    ? [...ownerBounds.center]
    : [0, 0, 0];
  const defaultSize: [number, number, number] = ownerBounds
    ? [ownerBounds.size[0] * 0.5, ownerBounds.size[1] * 0.5, ownerBounds.size[2] * 0.5]
    : [50e-9, 50e-9, 10e-9];
  const defaultRadius = Math.max(Math.min(defaultSize[0], defaultSize[1]) * 0.5, 25e-9);
  const defaultHeight = Math.max(defaultSize[2], 10e-9);
  const defaultZMin = defaultCenter[2] - defaultHeight * 0.5;
  const defaultZMax = defaultCenter[2] + defaultHeight * 0.5;

  const selectorCandidate = csgExpr?.selector ?? shape?.selector;
  const selectorExpr: FrozenSpinsSelectionExpression = isRecord(selectorCandidate) &&
    typeof selectorCandidate.kind === "string"
    ? (structuredClone(selectorCandidate) as unknown as FrozenSpinsSelectionExpression)
    : { kind: "in_object", object_id: objectId || "object" };

  return {
    shapeMode,
    axis: readV3(csgExpr?.axis ?? shape?.axis, [0, 0, 1]),
    center: readV3(csgExpr?.center ?? shape?.center, defaultCenter),
    size: readV3(csgExpr?.size ?? shape?.size, defaultSize),
    radius: readPositiveNumber(csgExpr?.radius ?? shape?.radius, defaultRadius),
    height: readPositiveNumber(csgExpr?.height ?? shape?.height, defaultHeight),
    zMin: readFiniteNumber(csgExpr?.z_min ?? shape?.z_min, defaultZMin),
    zMax: readFiniteNumber(csgExpr?.z_max ?? shape?.z_max, defaultZMax),
    halfSpaceOrigin: readV3(csgExpr?.origin ?? shape?.origin, defaultCenter),
    halfSpaceNormal: readV3(csgExpr?.normal ?? shape?.normal, [1, 0, 0]),
    selectorExpr,
    preservedCsgExpression,
  };
}

export function serializeRegionShapeState(
  draft: ParsedRegionShapeState & { frame: SceneRegionFrame },
  ownerBounds: RegionOwnerBounds | null,
  baselineShapeMode?: RegionShapeMode,
): SceneRegionShape {
  if (
    draft.preservedCsgExpression &&
    draft.shapeMode === (baselineShapeMode ?? draft.shapeMode)
  ) {
    return {
      kind: "csg",
      expression: structuredClone(draft.preservedCsgExpression),
    };
  }

  if (
    draft.shapeMode === "box" ||
    draft.shapeMode === "cylinder" ||
    draft.shapeMode === "sphere"
  ) {
    const normalizedAxis = normalizeVector3(draft.axis, [0, 0, 1]);
    const clamped = clampObjectRegionDraftShapeToOwnerBounds(
      {
        kind: draft.shapeMode,
        axis: normalizedAxis,
        center: [...draft.center],
        size: [...draft.size],
        radius: draft.radius,
        height: draft.height,
      },
      ownerBounds,
      draft.frame,
    );
    if (draft.shapeMode === "sphere") {
      return {
        kind: "sphere",
        center: [...clamped.center],
        radius: clamped.radius,
      };
    }
    if (draft.shapeMode === "cylinder") {
      return {
        kind: "cylinder",
        axis: normalizeVector3(clamped.axis, [0, 0, 1]),
        center: [...clamped.center],
        radius: clamped.radius,
        height: clamped.height,
      };
    }
    return {
      kind: "box",
      center: [...clamped.center],
      size: [...clamped.size],
    };
  }

  if (draft.shapeMode === "through_disk") {
    const clampedCyl = clampObjectRegionDraftShapeToOwnerBounds(
      {
        kind: "cylinder",
        axis: [0, 0, 1],
        center: [...draft.center],
        size: [...draft.size],
        radius: draft.radius,
        height: ownerBounds?.size[2] ?? draft.height,
      },
      ownerBounds,
      draft.frame,
    );
    return {
      kind: "csg",
      expression: {
        kind: "through_disk",
        axis: [0, 0, 1],
        center: [clampedCyl.center[0], clampedCyl.center[1], draft.center[2]],
        radius: clampedCyl.radius,
        height: ownerBounds?.size[2] ?? draft.height,
      },
    };
  }

  if (draft.shapeMode === "layer_z_slice") {
    let zMin = draft.zMin;
    let zMax = draft.zMax;
    if (draft.frame === "object" && ownerBounds) {
      const ownerZMin = -ownerBounds.size[2] * 0.5;
      const ownerZMax = ownerBounds.size[2] * 0.5;
      zMin = Math.max(ownerZMin, Math.min(ownerZMax, zMin));
      zMax = Math.max(ownerZMin, Math.min(ownerZMax, zMax));
      if (zMax <= zMin) {
        zMax = Math.min(ownerZMax, zMin + Math.max(ownerBounds.size[2] * 1e-6, 1e-12));
      }
    }
    const cx = draft.frame === "object" ? 0 : (ownerBounds?.center[0] ?? 0);
    const cy = draft.frame === "object" ? 0 : (ownerBounds?.center[1] ?? 0);
    const sx = ownerBounds?.size[0] ?? draft.size[0];
    const sy = ownerBounds?.size[1] ?? draft.size[1];
    return {
      kind: "csg",
      expression: {
        kind: "layer_z_slice",
        z_min: zMin,
        z_max: zMax,
        center: [cx, cy, (zMin + zMax) * 0.5],
        size: [sx, sy, Math.max(zMax - zMin, 1e-12)],
      },
    };
  }

  if (draft.shapeMode === "half_space") {
    return {
      kind: "csg",
      expression: {
        kind: "half_space",
        origin: [...draft.halfSpaceOrigin],
        normal: normalizeVector3(draft.halfSpaceNormal, [1, 0, 0]),
      },
    };
  }

  return {
    kind: "csg",
    expression: {
      kind: "boolean_expr",
      selector: structuredClone(draft.selectorExpr),
    },
  };
}

export function validateShapeAgainstOwnerBounds(
  draft: ParsedRegionShapeState & { frame: SceneRegionFrame },
  ownerBounds: RegionOwnerBounds | null,
): string | null {
  if (draft.frame !== "object" || !ownerBounds || draft.preservedCsgExpression) return null;
  const [ox, oy, oz] = ownerBounds.size;
  const minZ = -oz * 0.5;
  const maxZ = oz * 0.5;

  if (draft.shapeMode === "box") {
    if (
      draft.size[0] > ox * (1 + 1e-9) ||
      draft.size[1] > oy * (1 + 1e-9) ||
      draft.size[2] > oz * (1 + 1e-9)
    ) {
      return "Box extents exceed object bounds and will be clamped to the parent object on apply.";
    }
  } else if (draft.shapeMode === "sphere") {
    const maxR = Math.min(ox, oy, oz) * 0.5;
    if (draft.radius > maxR * (1 + 1e-9)) {
      return "Sphere radius exceeds half the smallest object dimension and will be clamped on apply.";
    }
  } else if (draft.shapeMode === "layer_z_slice") {
    if (draft.zMin < minZ - 1e-15 || draft.zMax > maxZ + 1e-15) {
      return "Z-slice bounds extend outside the parent object Z span and will be clamped on apply.";
    }
  }
  return null;
}

/* ── Diagnostics, Texture Override Detection, Coupling Guard, & Deep-Clone Duplicate ── */

export function hasRegionTextureOverride(
  rec: Record<string, unknown> | null | undefined,
): boolean {
  if (!rec) return false;
  const texOverride = rec.texture_override;
  if (isRecord(texOverride)) {
    if (
      texOverride.initial_magnetization !== undefined &&
      texOverride.initial_magnetization !== null
    ) {
      return true;
    }
    if (Object.keys(texOverride).length > 0) {
      return true;
    }
  }
  return Boolean(rec.initial_magnetization || rec.magnetization_ref);
}

export function extractRegionDiagnosticsForTarget(
  data: RegionDiagnosticsResource | null | undefined,
  objectId: string,
  regionId: string,
  meshLane: CanonicalRegionMeshLane,
): ObjectRegionDiagnosticItem[] {
  const rawRecord = data as unknown as Record<string, unknown> | null | undefined;
  const rawList: readonly Record<string, unknown>[] = Array.isArray(data?.diagnostics)
    ? (data.diagnostics as unknown as readonly Record<string, unknown>[])
    : Array.isArray(rawRecord?.items)
      ? (rawRecord.items as readonly Record<string, unknown>[])
      : [];

  const matched = rawList
    .filter((entry) => {
      const entryRegionId = typeof entry.region_id === "string" ? entry.region_id : "";
      const entryOwnerId =
        typeof entry.owner_object_id === "string"
          ? entry.owner_object_id
          : typeof entry.owner_object === "string"
            ? entry.owner_object
            : "";
      return entryRegionId === regionId && (!entryOwnerId || entryOwnerId === objectId);
    })
    .map<ObjectRegionDiagnosticItem>((entry, idx) => ({
      capabilityGate:
        typeof entry.capability_gate === "string" ? entry.capability_gate : null,
      code: typeof entry.code === "string" ? entry.code : "region_diagnostic",
      diagnosticId:
        typeof entry.diagnostic_id === "string"
          ? entry.diagnostic_id
          : `region:${regionId}:diag:${idx}`,
      message: typeof entry.message === "string" ? entry.message : "",
      realizationStatus:
        typeof entry.realization_status === "string"
          ? entry.realization_status
          : typeof entry.status === "string"
            ? entry.status
            : null,
      severity: typeof entry.severity === "string" ? entry.severity : "info",
    }));

  return resolveRegionDiagnosticsForLane(
    matched,
    meshLane === "pending" ? "unknown" : meshLane,
  );
}

export function formatRegionCapabilityLabel(gate: string): string {
  switch (gate) {
    case "regions.conformal_or_projected_boundary":
      return "region boundary realization";
    case "regions.material_override":
      return "region material overrides";
    case "regions.mesh_policy":
      return "region mesh policy";
    case "regions.realized_materialization":
      return "realized region materialization";
    default:
      return gate;
  }
}

export function formatDiagnosticNoticeText(diag: ObjectRegionDiagnosticItem): string {
  const base = diag.message ? `${diag.code}: ${diag.message}` : diag.code;
  if (!diag.capabilityGate) return base;
  return `${base} (Requires ${formatRegionCapabilityLabel(diag.capabilityGate)})`;
}

function endpointReferencesTargetRegion(
  endpoint: unknown,
  objectId: string,
  regionId: string,
): boolean {
  if (!isRecord(endpoint)) return false;
  if (endpoint.kind === "region") {
    return endpoint.object === objectId && endpoint.region_id === regionId;
  }
  if (!endpoint.kind && endpoint.region_id === regionId) {
    return !endpoint.object || endpoint.object === objectId;
  }
  return false;
}

export function resolveCouplingDependenciesForRegion(
  objectId: string,
  regionId: string,
  sceneCouplings: readonly unknown[] | undefined,
  couplingsResource?: CouplingListResource | null,
): RegionCouplingDependency[] {
  if (!objectId || !regionId) return [];
  const results = resolveRegionCouplingDependencies(objectId, regionId, couplingsResource);
  const seen = new Set(results.map((item) => `${item.couplingId}:${item.endpointRole}`));

  for (const raw of sceneCouplings ?? []) {
    if (!isRecord(raw)) continue;
    if (raw.enabled === false) continue;
    const couplingId =
      typeof raw.coupling_id === "string" && raw.coupling_id.length > 0
        ? raw.coupling_id
        : "coupling";
    const kind =
      typeof raw.coupling_kind === "string"
        ? raw.coupling_kind
        : typeof raw.kind === "string"
          ? raw.kind
          : "coupling";
    const status =
      typeof raw.realization_status === "string" ? raw.realization_status : "authored";

    const sourceEndpoint = raw.source ?? raw.endpoint_a ?? raw.side_a;
    const targetEndpoint = raw.target ?? raw.endpoint_b ?? raw.side_b;

    if (
      endpointReferencesTargetRegion(sourceEndpoint, objectId, regionId) &&
      !seen.has(`${couplingId}:source`)
    ) {
      seen.add(`${couplingId}:source`);
      results.push({ couplingId, endpointRole: "source", kind, status });
    }
    if (
      endpointReferencesTargetRegion(targetEndpoint, objectId, regionId) &&
      !seen.has(`${couplingId}:target`)
    ) {
      seen.add(`${couplingId}:target`);
      results.push({ couplingId, endpointRole: "target", kind, status });
    }
  }

  return results;
}

export function cloneRegionForDuplicate(
  sourceRegion: SceneObjectRegion | undefined,
  copyId: string,
  copyName: string,
  fallbackEnabled = true,
): SceneObjectRegion {
  if (sourceRegion) {
    const cloned = structuredClone(sourceRegion);
    return {
      ...cloned,
      region_id: copyId,
      name: copyName,
    };
  }
  return {
    region_id: copyId,
    name: copyName,
    enabled: fallbackEnabled,
    frame: "object",
    priority: 0,
    realization_policy: "inherit",
    shape: { kind: "box", center: [0, 0, 0], size: [50e-9, 50e-9, 10e-9] },
  };
}

/* ── Magnetic Parameters: Constitutive `material_overrides`, `material_transition`, & Spatial Fields ── */

export type RegionFieldProfileMode =
  | "inherited"
  | "constant"
  | "linear_gradient"
  | "radial"
  | "function";

export type RegionScalarParamKey =
  | "ms"
  | "aex"
  | "alpha"
  | "ku1"
  | "ku2"
  | "dind"
  | "dbulk";

export const REGION_SCALAR_PARAM_KEYS: readonly RegionScalarParamKey[] = [
  "ms",
  "aex",
  "alpha",
  "ku1",
  "ku2",
  "dind",
  "dbulk",
];

export const REGION_SCALAR_UNITS: Readonly<Record<RegionScalarParamKey, string>> = {
  ms: "A/m",
  aex: "J/m",
  alpha: "",
  ku1: "J/m^3",
  ku2: "J/m^3",
  dind: "J/m^2",
  dbulk: "J/m^2",
};

export interface RegionConstitutiveOverrideDraft {
  rowId: string;
  parameter: SceneMaterialParameterName;
  value: number;
  vectorValue: readonly [number, number, number];
  unit: string;
  priority: number;
  conflictPolicy: SceneRegionConflictPolicy;
  preservedOverride?: SceneRegionMaterialOverride;
}

export function parseRegionConstitutiveOverrides(
  rawOverrides: readonly SceneRegionMaterialOverride[] | undefined,
  defaultPriority: number,
): RegionConstitutiveOverrideDraft[] {
  if (!Array.isArray(rawOverrides)) return [];
  return rawOverrides.map((override, idx) => {
    const param = override.parameter;
    const priority =
      typeof override.priority === "number" && Number.isFinite(override.priority)
        ? Math.trunc(override.priority)
        : defaultPriority;
    const conflictPolicy: SceneRegionConflictPolicy =
      override.conflict_policy === "error" ||
      override.conflict_policy === "min_mesh_size_wins"
        ? override.conflict_policy
        : "higher_priority_wins";
    const defaultUnit =
      param in REGION_SCALAR_UNITS
        ? REGION_SCALAR_UNITS[param as RegionScalarParamKey]
        : "1";

    if (override.value.kind !== "constant") {
      return {
        rowId: `ovr-${idx}-${param}`,
        parameter: param,
        value: 0,
        vectorValue: [0, 0, 1],
        unit: defaultUnit,
        priority,
        conflictPolicy,
        preservedOverride: structuredClone(override),
      };
    }

    if (Array.isArray(override.value.value)) {
      return {
        rowId: `ovr-${idx}-${param}`,
        parameter: param,
        value: 0,
        vectorValue: readV3(override.value.value, [0, 0, 1]),
        unit: override.value.unit ?? "1",
        priority,
        conflictPolicy,
      };
    }

    return {
      rowId: `ovr-${idx}-${param}`,
      parameter: param,
      value: typeof override.value.value === "number" ? override.value.value : 0,
      vectorValue: [0, 0, 1],
      unit: override.value.unit ?? defaultUnit,
      priority,
      conflictPolicy,
    };
  });
}

export function serializeRegionConstitutiveOverrides(
  drafts: readonly RegionConstitutiveOverrideDraft[],
  femLane: boolean,
): SceneRegionMaterialOverride[] {
  return drafts.map((item) => {
    if (item.preservedOverride) {
      return structuredClone(item.preservedOverride);
    }
    const conflictPolicy: SceneRegionConflictPolicy =
      !femLane && item.conflictPolicy === "min_mesh_size_wins"
        ? "higher_priority_wins"
        : item.conflictPolicy;

    if (item.parameter === "anisotropy_axis") {
      return {
        parameter: "anisotropy_axis",
        priority: Math.trunc(item.priority),
        conflict_policy: conflictPolicy,
        value: {
          kind: "constant",
          unit: null,
          value: normalizeVector3(item.vectorValue, [0, 0, 1]),
        },
      };
    }

    const resolvedUnit =
      item.parameter in REGION_SCALAR_UNITS
        ? REGION_SCALAR_UNITS[item.parameter as RegionScalarParamKey]
        : item.unit;

    return {
      parameter: item.parameter,
      priority: Math.trunc(item.priority),
      conflict_policy: conflictPolicy,
      value: {
        kind: "constant",
        unit: resolvedUnit || null,
        value: item.value,
      },
    };
  });
}

export function parseRegionMaterialTransition(raw: unknown): {
  hadAuthoredTransition: boolean;
  transitionKind: "sharp" | "metric" | "mesh_relative";
  transitionWidth: number;
  transitionCells: number;
  transitionScope: SceneMaterialTransitionScope;
} {
  if (!isRecord(raw)) {
    return {
      hadAuthoredTransition: false,
      transitionKind: "sharp",
      transitionWidth: 5e-9,
      transitionCells: 2,
      transitionScope: "boundary",
    };
  }
  const scope: SceneMaterialTransitionScope =
    raw.scope === "inside" || raw.scope === "outside" ? raw.scope : "boundary";
  if (raw.kind === "metric" || raw.kind === "metric_width") {
    return {
      hadAuthoredTransition: true,
      transitionKind: "metric",
      transitionWidth: readPositiveNumber(raw.width, 5e-9),
      transitionCells: 2,
      transitionScope: scope,
    };
  }
  if (raw.kind === "mesh_relative") {
    const rawCells = typeof raw.cells === "number" ? Math.round(raw.cells) : 2;
    return {
      hadAuthoredTransition: true,
      transitionKind: "mesh_relative",
      transitionWidth: 5e-9,
      transitionCells: Math.max(1, Number.isFinite(rawCells) ? rawCells : 2),
      transitionScope: scope,
    };
  }
  return {
    hadAuthoredTransition: true,
    transitionKind: "sharp",
    transitionWidth: 5e-9,
    transitionCells: 2,
    transitionScope: scope,
  };
}

export function serializeRegionMaterialTransition(draft: {
  transitionKind: "sharp" | "metric" | "mesh_relative";
  transitionWidth: number;
  transitionCells: number;
  transitionScope: SceneMaterialTransitionScope;
}): SceneMaterialTransition {
  if (draft.transitionKind === "metric") {
    return {
      kind: "metric",
      width: draft.transitionWidth,
      scope: draft.transitionScope,
    };
  }
  if (draft.transitionKind === "mesh_relative") {
    return {
      kind: "mesh_relative",
      cells: Math.max(1, Math.round(draft.transitionCells)),
      scope: draft.transitionScope,
    };
  }
  return { kind: "sharp" };
}

export function resolveRegionGeometryDefaults(
  regionRec: Record<string, unknown> | null | undefined,
  ownerBounds: RegionOwnerBounds | null,
): {
  defaultCenter: [number, number, number];
  defaultRadius: number;
  defaultSpan: [number, number, number];
} {
  const shape = isRecord(regionRec?.shape) ? regionRec.shape : null;
  const csgExpr =
    shape?.kind === "csg" && isRecord(shape.expression) ? shape.expression : null;
  const fallbackCenter: [number, number, number] = ownerBounds
    ? [...ownerBounds.center]
    : [0, 0, 0];
  const fallbackSpan: [number, number, number] = ownerBounds
    ? [...ownerBounds.size]
    : [50e-9, 50e-9, 10e-9];
  const center = readV3(csgExpr?.center ?? shape?.center, fallbackCenter);

  if (shape?.kind === "box") {
    const size = readV3(shape.size, fallbackSpan);
    const radius = Math.max(Math.min(size[0], size[1]) * 0.5, 1e-12);
    return { defaultCenter: center, defaultRadius: radius, defaultSpan: size };
  }
  if (shape?.kind === "cylinder" || csgExpr?.kind === "through_disk") {
    const r = readPositiveNumber(csgExpr?.radius ?? shape?.radius, 25e-9);
    const h = readPositiveNumber(csgExpr?.height ?? shape?.height, fallbackSpan[2]);
    return {
      defaultCenter: center,
      defaultRadius: r,
      defaultSpan: [r * 2, r * 2, h],
    };
  }
  if (shape?.kind === "sphere") {
    const r = readPositiveNumber(shape.radius, 25e-9);
    return {
      defaultCenter: center,
      defaultRadius: r,
      defaultSpan: [r * 2, r * 2, r * 2],
    };
  }
  return {
    defaultCenter: center,
    defaultRadius: Math.max(Math.min(fallbackSpan[0], fallbackSpan[1]) * 0.25, 25e-9),
    defaultSpan: fallbackSpan,
  };
}

export function resolveDirectionalSpanMeters(
  span: readonly [number, number, number],
  dir: readonly [number, number, number],
): number {
  const unit = normalizeVector3(dir, [1, 0, 0]);
  const projected =
    Math.abs(unit[0]) * Math.max(span[0], 1e-12) +
    Math.abs(unit[1]) * Math.max(span[1], 1e-12) +
    Math.abs(unit[2]) * Math.max(span[2], 1e-12);
  return projected > 1e-15 ? projected : 50e-9;
}

export interface ParsedScalarFieldParam {
  assignmentId: string;
  mode: RegionFieldProfileMode;
  value: number;
  endValue: number;
  spanM: number;
  direction: [number, number, number];
  radialCenter: [number, number, number];
  radialRadius: number;
  frame: SceneRegionFrame;
  priority: number;
  conflictPolicy: SceneRegionConflictPolicy;
  rawFunction: SceneMaterialParameterAssignment | null;
  functionSummary: MaterialFunctionFieldSummary | null;
}

export function parseRegionScalarFieldParam({
  assignments,
  defaultCenter,
  defaultPriority,
  defaultRadius,
  defaultSpan,
  fallbackValue,
  paramName,
  regionId,
}: {
  assignments: readonly SceneMaterialParameterAssignment[];
  defaultCenter: readonly [number, number, number];
  defaultPriority: number;
  defaultRadius: number;
  defaultSpan: readonly [number, number, number];
  fallbackValue: number;
  paramName: RegionScalarParamKey;
  regionId: string;
}): ParsedScalarFieldParam {
  const defaultAssignmentId = `field-${regionId}-${paramName}`;
  const found = assignments.find(
    (f) => f.region_id === regionId && f.parameter === paramName,
  );
  const baseSpanM = resolveDirectionalSpanMeters(defaultSpan, [1, 0, 0]);

  if (!found) {
    return {
      assignmentId: defaultAssignmentId,
      mode: "inherited",
      value: fallbackValue,
      endValue: fallbackValue,
      spanM: baseSpanM,
      direction: [1, 0, 0],
      radialCenter: [defaultCenter[0], defaultCenter[1], defaultCenter[2]],
      radialRadius: defaultRadius,
      frame: "object",
      priority: defaultPriority,
      conflictPolicy: "higher_priority_wins",
      rawFunction: null,
      functionSummary: null,
    };
  }

  const assignmentId = found.assignment_id || defaultAssignmentId;
  const priority =
    typeof found.priority === "number" && Number.isFinite(found.priority)
      ? Math.trunc(found.priority)
      : defaultPriority;
  const conflictPolicy: SceneRegionConflictPolicy =
    found.conflict_policy === "error" || found.conflict_policy === "min_mesh_size_wins"
      ? found.conflict_policy
      : "higher_priority_wins";

  if (found.value.kind === "function") {
    return {
      assignmentId,
      mode: "function",
      value: fallbackValue,
      endValue: fallbackValue,
      spanM: baseSpanM,
      direction: [1, 0, 0],
      radialCenter: [defaultCenter[0], defaultCenter[1], defaultCenter[2]],
      radialRadius: defaultRadius,
      frame: found.value.frame === "world" ? "world" : "object",
      priority,
      conflictPolicy,
      rawFunction: structuredClone(found),
      functionSummary: materialFunctionFieldSummary(found),
    };
  }

  const parsed = materialFieldDraftFromAssignment(found);
  if (!parsed) {
    return {
      assignmentId,
      mode: "inherited",
      value: fallbackValue,
      endValue: fallbackValue,
      spanM: baseSpanM,
      direction: [1, 0, 0],
      radialCenter: [defaultCenter[0], defaultCenter[1], defaultCenter[2]],
      radialRadius: defaultRadius,
      frame: "object",
      priority,
      conflictPolicy,
      rawFunction: null,
      functionSummary: null,
    };
  }

  if (parsed.kind === "linear") {
    const [gx, gy, gz] = parsed.gradient;
    const mag = Math.hypot(gx, gy, gz);
    let direction: [number, number, number] = [1, 0, 0];
    let signedSlope = 0;

    if (mag > 1e-30) {
      if (gy === 0 && gz === 0) {
        direction = [1, 0, 0];
        signedSlope = gx;
      } else if (gx === 0 && gz === 0) {
        direction = [0, 1, 0];
        signedSlope = gy;
      } else if (gx === 0 && gy === 0) {
        direction = [0, 0, 1];
        signedSlope = gz;
      } else {
        direction = [gx / mag, gy / mag, gz / mag];
        signedSlope = mag;
      }
    }

    const spanM = resolveDirectionalSpanMeters(defaultSpan, direction);
    return {
      assignmentId: parsed.assignmentId,
      mode: "linear_gradient",
      value: parsed.base,
      endValue: parsed.base + signedSlope * spanM,
      spanM,
      direction,
      radialCenter: [defaultCenter[0], defaultCenter[1], defaultCenter[2]],
      radialRadius: defaultRadius,
      frame: parsed.frame,
      priority: parsed.priority,
      conflictPolicy: parsed.conflictPolicy,
      rawFunction: null,
      functionSummary: null,
    };
  }

  if (parsed.kind === "radial") {
    return {
      assignmentId: parsed.assignmentId,
      mode: "radial",
      value: parsed.inside,
      endValue: parsed.outside,
      spanM: baseSpanM,
      direction: [1, 0, 0],
      radialCenter: [...parsed.center],
      radialRadius: parsed.radius > 0 ? parsed.radius : defaultRadius,
      frame: parsed.frame,
      priority: parsed.priority,
      conflictPolicy: parsed.conflictPolicy,
      rawFunction: null,
      functionSummary: null,
    };
  }

  return {
    assignmentId: parsed.assignmentId,
    mode: "constant",
    value: parsed.scalar,
    endValue: parsed.scalar,
    spanM: baseSpanM,
    direction: [1, 0, 0],
    radialCenter: [defaultCenter[0], defaultCenter[1], defaultCenter[2]],
    radialRadius: defaultRadius,
    frame: parsed.frame,
    priority: parsed.priority,
    conflictPolicy: parsed.conflictPolicy,
    rawFunction: null,
    functionSummary: null,
  };
}

export function serializeRegionScalarFieldParam({
  assignmentId,
  conflictPolicy,
  direction,
  endValue,
  femLane,
  frame,
  mode,
  objectId,
  paramName,
  priority,
  radialCenter,
  radialRadius,
  rawFunction,
  regionId,
  spanM,
  value,
}: {
  assignmentId: string;
  conflictPolicy: SceneRegionConflictPolicy;
  direction: readonly [number, number, number];
  endValue: number;
  femLane: boolean;
  frame: SceneRegionFrame;
  mode: RegionFieldProfileMode;
  objectId: string;
  paramName: RegionScalarParamKey;
  priority: number;
  radialCenter: readonly [number, number, number];
  radialRadius: number;
  rawFunction: SceneMaterialParameterAssignment | null;
  regionId: string;
  spanM: number;
  value: number;
}): SceneMaterialParameterAssignment | null {
  if (mode === "inherited") return null;
  if (mode === "function") {
    return rawFunction ? structuredClone(rawFunction) : null;
  }

  const unit = REGION_SCALAR_UNITS[paramName];
  const safeSpanM = Math.max(spanM, 1e-15);
  const unitDir = normalizeVector3(direction, [1, 0, 0]);
  const slopePerMeter = (endValue - value) / safeSpanM;
  const gradient: [number, number, number] = [
    unitDir[0] * slopePerMeter || 0,
    unitDir[1] * slopePerMeter || 0,
    unitDir[2] * slopePerMeter || 0,
  ];

  return materialFieldFromDraft(
    {
      assignmentId: assignmentId || `field-${regionId}-${paramName}`,
      base: value,
      center: [radialCenter[0], radialCenter[1], radialCenter[2]],
      conflictPolicy,
      frame,
      gradient,
      inside: value,
      kind: mode === "linear_gradient" ? "linear" : mode === "radial" ? "radial" : "constant",
      outside: endValue,
      parameter: paramName,
      priority: Math.trunc(priority),
      radius: Math.max(radialRadius, 1e-15),
      scalar: value,
      unit,
    },
    { objectId, regionId },
    { meshPolicyLane: femLane ? "fem" : "unknown" },
  );
}

export { materialFieldRealizationRows };
