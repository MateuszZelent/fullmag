"use client";

import type { components } from "@/kernel/api/generated/openapi-v2-types";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
} from "react";

import type {
  FieldVectorQuery,
  LiveStatusResource,
  MeshHistogramBinElementsResource,
  MeshRegionMembershipResource,
  MeshSharedDomainManifestResource,
  RegionListResource,
  ResourceRevision,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import type { DecodedFieldVector } from "@/kernel/api/codecs";
import type { MeshSizeHistogramHighlight } from "@/kernel/events/eventTypes";
import {
  isMagneticOnlyQuantityId,
  resolveCanonicalQuantityId,
  sameQuantityId,
} from "@/kernel/api/quantityIds";
import { useCrossSectionResource } from "@/kernel/resources/crossSectionResources";
import {
  useMeshRegionMembershipsResource,
  useModelRegionsResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { useKernel } from "@/kernel/KernelContext";
import type {
  ResourceResult,
  ResourceStatus,
} from "@/kernel/resources/resourceTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { visualizationTargetIdForSceneObject } from "@/kernel/selection/selectionTypes";
import {
  activeCrossSectionFramePreview,
  crossSectionFramePreviewEquals,
  crossSectionFramePreviewToClip,
} from "@/kernel/workspace/crossSectionWorkspace";
import { useCrossSectionWorkspaceSelector } from "@/kernel/workspace/useCrossSectionWorkspace";
import {
  AIRBOX_VISUALIZATION_TARGET,
  resolveDefaultVisualizationSettings,
  resolveGlobalObjectVisualizationSettings,
  resolveTargetVisualization,
  surfaceColorSourceToColorMode,
  visualizationTargetKey,
  type ObjectVisualizationSnapshot,
  type SurfaceColorSource,
  type VisualizationStoredTargetPatch,
  type VisualizationTargetKind,
  type VisualizationTargetRef,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
import { useObjectVisualizationSelector } from "@/kernel/visualization/useObjectVisualization";
import { useCameraRegistryCamera } from "@/kernel/visualization/useCameraRegistry";
import { useAnalysisFieldOverlay } from "@/kernel/visualization/AnalysisFieldOverlayController";
import { startAnalysisFieldOverlayPhaseAnimation } from "@/kernel/visualization/AnalysisFieldOverlayPhaseAnimation";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { resolveVisualizationEffectiveRenderMode } from "@/kernel/visualization/useVisualizationClientAck";
import { resolveCrossSectionQueryFromVisualizationState } from "@/shared/domain/mesh/crossSectionQuery";

import {
  mergeViewport3DFieldScalarColors,
  useViewport3DChunkedScalarColors,
} from "./useViewport3DChunkedScalarColors";
import {
  useViewport3DFieldRenderOptions,
  viewport3DAirboxVectorsVisible,
} from "./useViewport3DFieldRenderOptions";
import {
  FULL_FIELD_QUERY,
  resolveHysteresisStepViewportTarget,
  resolveViewport3DSelectionBounds,
  targetForFdmDomain,
  targetForMeshPart,
} from "../model/viewport3DTargets";
import {
  buildFdmCuboidInstanceModel,
  type FdmCuboidInstanceModel,
} from "../layers/FdmCuboidLayer";
import { Viewport3DScene } from "../layers/Viewport3DScene";
import { buildClipPlaneIntersectionMarkerBuffers } from "../layers/clipPlaneModel";
import {
  buildRegionOverlayModels,
  type RegionOverlayInput,
  type RegionOverlayModel,
  type RegionMeshOverlayOwnerPart,
} from "../layers/regionOverlayModel";
import {
  adaptFdmDomainMeta,
  adaptFemSharedDomainManifest,
  type Viewport3DMeshPart,
} from "../viewport3dDomainAdapter";
import {
  buildViewport3DDiagnostics,
  type Viewport3DResourceCounts,
} from "../viewport3dDiagnostics";
import { buildSampledScalarColors } from "../viewport3dFieldMapping";
import { buildViewport3DResourceFrameKey } from "../viewport3dInvalidation";
import type { Viewport3DResourceFrameState } from "../viewport3dInvalidation";
import {
  buildViewport3DMagnetizationTexturePreviewMap,
  buildViewport3DPrimitiveRenderModel,
  resolvePrimitiveSelectionBounds,
  type Viewport3DPrimitiveObject,
} from "../viewport3dPrimitiveModel";
import {
  buildMeshQualityVertexColors,
  type MeshQualityColorMetric,
} from "../viewport3dQualityMapping";
import { buildViewport3DMeshSizeHighlightModel } from "../viewport3dMeshSizeHighlight";
import {
  buildViewport3DFieldRenderModel,
  buildViewport3DTopologyRenderModel,
  combineViewport3DBounds,
  resolveDomainBounds,
  resolveTopologyBounds,
  resolveUniverseBounds,
  type Viewport3DFieldRenderOptions,
  type Viewport3DBounds,
  viewport3DFieldRenderOptionsNeedFieldData,
} from "../viewport3dRenderModel";
import {
  getViewport3DCacheStats as getCacheStats,
  resolveViewport3DFieldVectorResourceKey,
  useViewport3DAirboxFieldVectors,
  useViewport3DDomainMeta,
  useViewport3DDomainTopology,
  useViewport3DFieldVector,
  useViewport3DMeshQualityData,
  useViewport3DPartFieldVectors,
  useViewport3DQuantityFieldVectors,
  useViewport3DScene,
  useViewport3DSharedDomainManifest,
  useViewport3DUniverse,
} from "../viewport3dResources";
import { useViewport3DFieldUpdateHoldActive } from "../viewport3dFieldUpdateHold";
import type { Viewport3DFieldRefreshState } from "../viewport3dRefreshCountdown";
import {
  isViewport3DTopologyCurrent,
  isViewport3DTopologyRenderable,
  resolveViewport3DTopologyFreshnessLabel,
  resolveUnknownTopologyProvenanceRefreshKey,
  resolveViewport3DTopologyFreshness,
} from "../viewport3dTopologyStaleness";
import {
  resolveHslReferenceVisible,
  resolveViewport3DCameraOrthographicScale,
  resolveViewport3DCameraProjection,
  resolveViewport3DCameraState,
  viewport3DCameraViewSignature,
  viewport3dStore,
  type Viewport3DCommandState,
  type Viewport3DCameraProjection,
  type Viewport3DCameraState,
  type useViewport3DCommandState,
} from "../viewport3dStore";
import { getViewport3DVisualProfile } from "../viewport3dVisualProfile";

type Viewport3DSceneProps = ComponentProps<typeof Viewport3DScene>;
type JsonRecord = Record<string, unknown>;
type SceneRegionShape = components["schemas"]["SceneRegionShape"];

const EMPTY_AIRBOX_FIELD_VECTOR_PARTS: readonly { id: string }[] = [];
const VIEWPORT_3D_SCALAR_FIELD_COMPONENTS = new Set([
  "magnitude",
  "x",
  "y",
  "z",
]);

function asJsonRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sceneRegionShape(value: unknown): SceneRegionShape | null {
  const shape = asJsonRecord(value);
  if (!shape) return null;
  const kind = asNonEmptyString(shape.kind);
  if (kind === "box") {
    return isFiniteNumberVector(shape.center, 3) && isFiniteNumberVector(shape.size, 3)
      ? { center: shape.center, kind, size: shape.size }
      : null;
  }
  if (kind === "cylinder") {
    return isFiniteNumberVector(shape.axis, 3) &&
      isFiniteNumberVector(shape.center, 3) &&
      isPositiveFiniteNumber(shape.height) &&
      isPositiveFiniteNumber(shape.radius)
      ? {
          axis: shape.axis,
          center: shape.center,
          height: shape.height,
          kind,
          radius: shape.radius,
        }
      : null;
  }
  if (kind === "sphere") {
    return isFiniteNumberVector(shape.center, 3) && isPositiveFiniteNumber(shape.radius)
      ? { center: shape.center, kind, radius: shape.radius }
      : null;
  }
  return null;
}

function isFiniteNumberVector(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function resolveViewport3DRegionOverlays({
  objectTransformsById,
  realizedRegionKeys,
  regionResource,
  scene,
}: {
  objectTransformsById: ReadonlyMap<string, unknown>;
  realizedRegionKeys?: ReadonlySet<string>;
  regionResource?: RegionListResource | null;
  scene: unknown;
}): RegionOverlayInput[] {
  const overlays: RegionOverlayInput[] = [];
  const seen = new Set<string>();

  for (const region of regionResource?.regions ?? []) {
    if (region.source !== "authored_object_region") continue;
    const regionId = asNonEmptyString(region.region_id);
    const objectId = asNonEmptyString(region.owner_object_id);
    if (!regionId || !objectId) continue;
    if (realizedRegionKeys?.has(regionOverlayKey(objectId, regionId))) continue;
    seen.add(regionOverlayKey(objectId, regionId));
    overlays.push({
      enabled: region.enabled,
      frame: region.frame,
      name: region.name,
      owner_object_id: objectId,
      owner_transform: objectTransformsById.get(objectId) ?? null,
      priority: region.priority,
      region_id: regionId,
      shape: region.shape,
    });
  }

  const sceneRecord = asJsonRecord(scene);
  if (!Array.isArray(sceneRecord?.objects)) return overlays;

  for (const objectValue of sceneRecord.objects) {
    const object = asJsonRecord(objectValue);
    const objectId = asNonEmptyString(object?.id);
    if (!objectId || !Array.isArray(object?.regions)) continue;
    for (const regionValue of object.regions) {
      const region = asJsonRecord(regionValue);
      const regionId = asNonEmptyString(region?.region_id) ?? asNonEmptyString(region?.id);
      if (!regionId || seen.has(regionOverlayKey(objectId, regionId))) continue;
      if (realizedRegionKeys?.has(regionOverlayKey(objectId, regionId))) continue;
      const shape = sceneRegionShape(region?.shape);
      if (!shape) continue;
      seen.add(regionOverlayKey(objectId, regionId));
      overlays.push({
        enabled: region?.enabled !== false && object.visible !== false,
        frame: asNonEmptyString(region?.frame),
        name: asNonEmptyString(region?.name),
        owner_object_id: objectId,
        owner_transform: objectTransformsById.get(objectId) ?? asJsonRecord(object?.transform),
        priority: typeof region?.priority === "number" ? region.priority : null,
        region_id: regionId,
        shape,
      });
    }
  }

  return overlays;
}

function regionOverlayKey(objectId: string, regionId: string): string {
  return `${objectId}\u0000${regionId}`;
}

export function resolveViewport3DMeshBackedRegionKeys(
  regions: MeshSharedDomainManifestResource["regions"] | null | undefined,
): Set<string> {
  const keys = new Set<string>();
  for (const region of regions ?? []) {
    const regionId = asNonEmptyString(region.source_region_candidate_id);
    if (!regionId || !region.mesh_part_ids || region.mesh_part_ids.length === 0) {
      continue;
    }
    for (const objectId of region.source_object_ids ?? []) {
      const owner = asNonEmptyString(objectId);
      if (owner) keys.add(regionOverlayKey(owner, regionId));
    }
  }
  return keys;
}

export function filterViewport3DMeshBackedRegionOverlays(
  regions: readonly RegionOverlayInput[],
  meshBackedRegionKeys: ReadonlySet<string>,
): RegionOverlayInput[] {
  return regions.filter((region) => {
    const objectId = asNonEmptyString(region.owner_object_id);
    const regionId = asNonEmptyString(region.region_id);
    return Boolean(
      objectId &&
        regionId &&
        meshBackedRegionKeys.has(regionOverlayKey(objectId, regionId)),
    );
  });
}

export function resolveViewport3DRegionMembershipIds({
  meshBackedRegionKeys,
  regions,
}: {
  meshBackedRegionKeys: ReadonlySet<string>;
  regions: readonly RegionOverlayInput[];
}): string[] {
  const regionIds: string[] = [];
  const seen = new Set<string>();
  for (const region of regions) {
    const objectId = asNonEmptyString(region.owner_object_id);
    const regionId = asNonEmptyString(region.region_id);
    if (!objectId || !regionId || seen.has(regionId)) continue;
    if (meshBackedRegionKeys.has(regionOverlayKey(objectId, regionId))) continue;
    seen.add(regionId);
    regionIds.push(regionId);
  }
  return regionIds;
}

export function resolveViewport3DMeshBackedRegionOverlays({
  manifestRegions,
  regions,
}: {
  manifestRegions: MeshSharedDomainManifestResource["regions"] | null | undefined;
  regions: readonly RegionOverlayInput[];
}): RegionOverlayInput[] {
  const authoredByKey = new Map<string, RegionOverlayInput>();
  for (const region of regions) {
    const objectId = asNonEmptyString(region.owner_object_id);
    const regionId = asNonEmptyString(region.region_id);
    if (objectId && regionId) {
      authoredByKey.set(regionOverlayKey(objectId, regionId), region);
    }
  }

  const overlays: RegionOverlayInput[] = [];
  const seen = new Set<string>();
  for (const manifestRegion of manifestRegions ?? []) {
    const regionId = asNonEmptyString(manifestRegion.source_region_candidate_id);
    const meshPartIds = (manifestRegion.mesh_part_ids ?? [])
      .map(asNonEmptyString)
      .filter((entry): entry is string => Boolean(entry));
    if (!regionId || meshPartIds.length === 0) continue;

    for (const sourceObjectId of manifestRegion.source_object_ids ?? []) {
      const objectId = asNonEmptyString(sourceObjectId);
      if (!objectId) continue;
      const key = regionOverlayKey(objectId, regionId);
      if (seen.has(key)) continue;
      seen.add(key);

      const authored = authoredByKey.get(key);
      overlays.push({
        enabled: authored?.enabled ?? true,
        frame: authored?.frame ?? null,
        mesh_part_ids: meshPartIds,
        name: manifestRegion.name ?? authored?.name ?? regionId,
        owner_object_id: objectId,
        owner_transform: authored?.owner_transform ?? null,
        priority: authored?.priority ?? null,
        region_id: regionId,
        shape: authored?.shape ?? null,
      });
    }
  }

  return overlays;
}

export function resolveViewport3DMembershipRegionOverlays({
  memberships,
  regions,
}: {
  memberships: readonly MeshRegionMembershipResource[];
  regions: readonly RegionOverlayInput[];
}): {
  ownerParts: RegionMeshOverlayOwnerPart[];
  regions: RegionOverlayInput[];
} {
  const authoredByRegionId = new Map<string, RegionOverlayInput>();
  for (const region of regions) {
    const regionId = asNonEmptyString(region.region_id);
    if (regionId) {
      authoredByRegionId.set(regionId, region);
    }
  }

  const overlayRegions: RegionOverlayInput[] = [];
  const ownerParts: RegionMeshOverlayOwnerPart[] = [];
  const seen = new Set<string>();
  for (const membership of memberships) {
    const regionId = asNonEmptyString(membership.region_id);
    if ((membership.mesh_part_ids ?? []).some((partId) => asNonEmptyString(partId))) {
      continue;
    }
    const authored = regionId ? authoredByRegionId.get(regionId) : null;
    const objectId = asNonEmptyString(authored?.owner_object_id);
    if (!regionId || !authored || !objectId || seen.has(regionId)) {
      continue;
    }

    const syntheticPartId = `membership:${encodeURIComponent(regionId)}`;
    seen.add(regionId);
    overlayRegions.push({
      ...authored,
      mesh_part_ids: [syntheticPartId],
    });
    ownerParts.push({
      boundary_face_indices: membership.boundary_face_indices,
      element_indices: membership.element_indices,
      id: syntheticPartId,
      node_indices: membership.node_indices,
      object_id: objectId,
    });
  }

  return {
    ownerParts,
    regions: overlayRegions,
  };
}

export function resolveViewport3DRegionTargetByPartId(
  regions: MeshSharedDomainManifestResource["regions"] | null | undefined,
): Map<string, VisualizationTargetRef> {
  const targets = new Map<string, VisualizationTargetRef>();
  for (const region of regions ?? []) {
    const regionId = asNonEmptyString(region.source_region_candidate_id);
    if (!regionId || !region.mesh_part_ids || region.mesh_part_ids.length === 0) {
      continue;
    }
    const objectId = (region.source_object_ids ?? [])
      .map(asNonEmptyString)
      .find((entry): entry is string => Boolean(entry));
    if (!objectId) continue;
    const target: VisualizationTargetRef = {
      id: visualizationTargetIdForSceneObject(objectId, regionId),
      kind: "region",
      label: region.name ?? regionId,
    };
    for (const partId of region.mesh_part_ids) {
      const id = asNonEmptyString(partId);
      if (id) targets.set(id, target);
    }
  }
  return targets;
}

export function resolveViewport3DPartVisualizationSettings({
  objectVisualizationSnapshot,
  part,
  regionTarget,
  renderingState,
}: {
  objectVisualizationSnapshot: ObjectVisualizationSnapshot;
  part: Viewport3DMeshPart;
  regionTarget?: VisualizationTargetRef | null;
  renderingState?: VisualizationStateResource | null;
}): VisualizationTargetSettings {
  const objectTarget = targetForMeshPart(part);
  const objectVisualization = resolveTargetVisualization({
    snapshot: objectVisualizationSnapshot,
    target: objectTarget,
    visualizationState: renderingState,
  });
  if (!regionTarget) return objectVisualization.effectiveSettings;
  return resolveTargetVisualization({
    inheritedSettings: objectVisualization.settings,
    snapshot: objectVisualizationSnapshot,
    target: regionTarget,
    visualizationState: renderingState,
  }).effectiveSettings;
}

export function resolveViewport3DRegionSelectionBounds(
  selection: Selection,
  regions: readonly RegionOverlayInput[],
): Viewport3DBounds | null {
  const regionId =
    selection.ref?.type === "scene-object" ? selection.ref.regionId : null;
  if (!regionId) return null;
  const objectId =
    selection.ref?.type === "scene-object"
      ? selection.ref.objectId
      : selection.objectId;
  const models = buildRegionOverlayModels(regions, {
    selectedObjectId: objectId,
    selectedRegionId: regionId,
  });
  const region = models.find((entry) => entry.regionId === regionId);
  return region ? regionOverlayBounds(region) : null;
}

export function resolveViewport3DRegionSelectionScope(selection: Selection): {
  selectedObjectId: string | null;
  selectedRegionId: string | null;
} {
  if (selection.ref?.type === "scene-object") {
    return {
      selectedObjectId: selection.ref.objectId,
      selectedRegionId: selection.ref.regionId ?? null,
    };
  }

  if (selection.kind?.startsWith("object.")) {
    return {
      selectedObjectId: selection.objectId,
      selectedRegionId: null,
    };
  }

  return {
    selectedObjectId: null,
    selectedRegionId: null,
  };
}

function regionOverlayBounds(region: RegionOverlayModel): Viewport3DBounds {
  const center = transformedRegionCenter(region);
  const size = regionOverlaySize(region);
  return {
    center,
    radius: Math.max(Math.hypot(size[0], size[1], size[2]) / 2, 1e-12),
    size,
  };
}

function transformedRegionCenter(
  region: RegionOverlayModel,
): [number, number, number] {
  return [
    region.transform.position[0] + region.center[0],
    region.transform.position[1] + region.center[1],
    region.transform.position[2] + region.center[2],
  ];
}

function regionOverlaySize(region: RegionOverlayModel): [number, number, number] {
  if (region.kind === "box") {
    return [region.size[0], region.size[1], region.size[2]];
  }
  if (region.kind === "sphere") {
    const diameter = region.radius * 2;
    return [diameter, diameter, diameter];
  }
  const diameter = region.radius * 2;
  return [diameter, diameter, region.height];
}

export interface Viewport3DResourceFrameInput {
  dataAvailable: boolean;
  error?: string | null;
  id: string;
  payloadRevision: ResourceRevision | null;
  revision: ResourceRevision | null;
  status: ResourceStatus;
}

export interface Viewport3DFieldDataIssue {
  key: string;
  message: string;
  quantityId: string;
  resourceKey: string;
  retry: () => void;
}

export interface Viewport3DPrimaryFieldQueryOptions {
  fdmInstanceModelNeedsFieldVector: boolean;
  fdmSurfaceColorMode: string | null;
  fdmTopographyEnabled: boolean;
  fdmVectorsVisible: boolean;
  fieldRenderOptions: Viewport3DFieldRenderOptions;
}

export interface Viewport3DScopedPartVectorFieldRequest {
  quantityId: string;
  query: FieldVectorQuery;
}

export function resolveViewport3DVisualizationQuantityId(
  state: VisualizationStateResource | null | undefined,
): string {
  return resolveCanonicalQuantityId(
    state?.quantity?.active_quantity_id ?? state?.active_quantity_id ?? "m",
  );
}

export function resolveViewport3DSelectedSnapshotId(
  selection: Selection,
): string | null {
  const hysteresisTarget = resolveHysteresisStepViewportTarget(selection);
  if (hysteresisTarget) return hysteresisTarget.snapshotId;
  if (selection.ref?.type !== "analysis-chart-point") return null;
  return selection.ref.snapshotId ?? null;
}

export function resolveViewport3DActiveQuantityId({
  selectedSnapshotId,
  selection,
  visualizationState,
}: {
  selectedSnapshotId: string | null;
  selection: Selection;
  visualizationState: VisualizationStateResource | null | undefined;
}): string {
  if (
    selectedSnapshotId &&
    selection.ref?.type === "analysis-chart-point" &&
    selection.ref.quantity
  ) {
    const hysteresisTarget = resolveHysteresisStepViewportTarget(selection);
    return resolveCanonicalQuantityId(hysteresisTarget?.quantityId ?? selection.ref.quantity);
  }
  return resolveViewport3DVisualizationQuantityId(visualizationState);
}

export function resolveViewport3DPrimaryFieldVectorEnabled({
  fdmInstanceModelNeedsFieldVector,
  fdmSurfaceColorMode,
  fdmVectorsVisible,
  fieldRenderOptions,
  selectedSnapshotId,
}: {
  fdmInstanceModelNeedsFieldVector: boolean;
  fdmSurfaceColorMode: string | null;
  fdmVectorsVisible: boolean;
  fieldRenderOptions: Viewport3DFieldRenderOptions;
  selectedSnapshotId: string | null;
}): boolean {
  return (
    Boolean(selectedSnapshotId) ||
    viewport3DFieldRenderOptionsNeedFieldData(fieldRenderOptions) ||
    Boolean(fdmSurfaceColorMode) ||
    fdmVectorsVisible ||
    fdmInstanceModelNeedsFieldVector
  );
}

export function resolveViewport3DDisplayedLiveValue<TValue>(
  incoming: TValue,
  previousDisplayed: TValue,
  holdActive: boolean,
): TValue {
  return holdActive ? previousDisplayed : incoming;
}

export function sameViewport3DQuantityId(left: string, right: string): boolean {
  return sameQuantityId(left, right);
}

export function resolveViewport3DPrimaryFieldQuery({
  fdmInstanceModelNeedsFieldVector,
  fdmSurfaceColorMode,
  fdmTopographyEnabled,
  fdmVectorsVisible,
  fieldRenderOptions,
  snapshotId,
}: Viewport3DPrimaryFieldQueryOptions & { snapshotId?: string | null }): FieldVectorQuery {
  if (
    fdmVectorsVisible ||
    fdmTopographyEnabled ||
    viewport3DFieldRenderOptionsNeedFullVectorData(fieldRenderOptions) ||
    (fdmSurfaceColorMode && !fieldColorModeScalarComponent(fdmSurfaceColorMode))
  ) {
    return snapshotId ? { ...FULL_FIELD_QUERY, snapshot_id: snapshotId } : FULL_FIELD_QUERY;
  }

  const component =
    (fdmSurfaceColorMode
      ? fieldColorModeScalarComponent(fdmSurfaceColorMode)
      : null) ??
    firstScalarFieldComponent(fieldRenderOptions.scalarColorModes) ??
    (fdmInstanceModelNeedsFieldVector ? "magnitude" : null);

  return component
    ? {
        component,
        scope_kind: "full",
        ...(snapshotId ? { snapshot_id: snapshotId } : {}),
      }
    : (snapshotId ? { ...FULL_FIELD_QUERY, snapshot_id: snapshotId } : FULL_FIELD_QUERY);
}

export function resolveViewport3DResourceFrameState({
  dataAvailable,
  error,
  id,
  payloadRevision,
  revision,
  status,
}: Viewport3DResourceFrameInput): Viewport3DResourceFrameState {
  const visiblePayloadAvailable = dataAvailable && !error;
  return {
    error,
    id,
    revision: visiblePayloadAvailable ? payloadRevision ?? revision : revision,
    status:
      visiblePayloadAvailable && status === "stale" ? "ready" : status,
  };
}

export function resolveViewport3DTargetFieldQuery({
  surfaceColorMode,
  vectorsVisible,
}: {
  surfaceColorMode: string | null;
  vectorsVisible: boolean;
}): FieldVectorQuery {
  if (vectorsVisible) {
    return FULL_FIELD_QUERY;
  }

  const component = fieldColorModeScalarComponent(surfaceColorMode);
  return component
    ? {
        component,
        scope_kind: "full",
      }
    : FULL_FIELD_QUERY;
}

export function resolveViewport3DScopedVectorFieldQuery({
  maxSamples,
  surfaceColorMode,
  vectorsVisible,
}: {
  maxSamples: number;
  surfaceColorMode: string | null;
  vectorsVisible: boolean;
}): FieldVectorQuery {
  const query = resolveViewport3DTargetFieldQuery({
    surfaceColorMode,
    vectorsVisible,
  });
  if (!vectorsVisible || surfaceColorMode) {
    return query;
  }

  const sampleLimit = Math.max(0, Math.floor(maxSamples));
  return sampleLimit > 0
    ? {
        ...query,
        max_samples: sampleLimit,
      }
    : query;
}

export function resolveViewport3DPrimaryFieldRenderOptions({
  fieldRenderOptions,
  getPartSettings,
  magneticParts,
  quantityId,
  vectorDomain,
  scopedVectorOnlyPartIds,
}: {
  fieldRenderOptions: Viewport3DFieldRenderOptions;
  getPartSettings: (part: Viewport3DMeshPart) => {
    activeQuantityId: string;
    shaderVisible: boolean;
    surfaceColorSource: SurfaceColorSource;
    vectorBudget: number;
    vectorsVisible: boolean;
    visible: boolean;
  };
  magneticParts: readonly { part: Viewport3DMeshPart }[];
  quantityId: string;
  vectorDomain: string;
  scopedVectorOnlyPartIds?: ReadonlySet<string>;
}): Viewport3DFieldRenderOptions {
  if (magneticParts.length === 0) {
    return fieldRenderOptions;
  }

  const magneticVectorsAllowed = vectorDomain !== "airbox_only";
  const partVectorBudgets = new Map<string, number>();
  const scalarColorModes = new Set<string>();

  for (const partModel of magneticParts) {
    const settings = getPartSettings(partModel.part);
    if (
      !sameViewport3DQuantityId(settings.activeQuantityId, quantityId) ||
      !settings.visible
    ) {
      continue;
    }
    if (settings.shaderVisible) {
      const scalarColorMode = surfaceColorSourceToColorMode(
        settings.surfaceColorSource,
      );
      if (scalarColorMode) {
        scalarColorModes.add(scalarColorMode);
      }
    }
    if (
      magneticVectorsAllowed &&
      settings.vectorsVisible &&
      settings.vectorBudget > 0 &&
      !scopedVectorOnlyPartIds?.has(partModel.part.id)
    ) {
      partVectorBudgets.set(partModel.part.id, settings.vectorBudget);
    }
  }

  return {
    ...fieldRenderOptions,
    fullVectorBudget: 0,
    partVectorBudgets,
    scalarColorModes,
    scalarColorsVisible: scalarColorModes.size > 0,
  };
}

export function resolveViewport3DScopedPartVectorFieldRequests({
  getPartSettings,
  magneticParts,
  vectorDomain,
}: {
  getPartSettings: (part: Viewport3DMeshPart) => {
    activeQuantityId: string;
    shaderVisible: boolean;
    surfaceColorSource: SurfaceColorSource;
    vectorBudget: number;
    vectorsVisible: boolean;
    visible: boolean;
  };
  magneticParts: readonly { part: Viewport3DMeshPart }[];
  vectorDomain: string;
}): Map<string, Viewport3DScopedPartVectorFieldRequest> {
  if (vectorDomain === "airbox_only") {
    return new Map();
  }

  const requests = new Map<string, Viewport3DScopedPartVectorFieldRequest>();
  for (const partModel of magneticParts) {
    const settings = getPartSettings(partModel.part);
    if (
      !settings.visible ||
      !settings.vectorsVisible ||
      settings.vectorBudget <= 0
    ) {
      continue;
    }
    const surfaceColorMode = settings.shaderVisible
      ? surfaceColorSourceToColorMode(settings.surfaceColorSource)
      : null;
    if (surfaceColorMode) {
      continue;
    }
    requests.set(partModel.part.id, {
      quantityId: resolveCanonicalQuantityId(settings.activeQuantityId),
      query: resolveViewport3DScopedVectorFieldQuery({
        maxSamples: settings.vectorBudget,
        surfaceColorMode: null,
        vectorsVisible: true,
      }),
    });
  }

  return new Map(
    Array.from(requests).toSorted(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function viewport3DFieldRenderOptionsNeedFullVectorData(
  options: Viewport3DFieldRenderOptions,
): boolean {
  if ((options.fullVectorBudget ?? 0) > 0) return true;
  if (mapHasPositiveValue(options.partVectorBudgets)) return true;

  if (options.scalarColorsVisible === false) return false;
  for (const mode of options.scalarColorModes ?? []) {
    if (!fieldColorModeScalarComponent(mode)) return true;
  }

  return false;
}

function mapHasPositiveValue(
  values: ReadonlyMap<string, number> | null | undefined,
): boolean {
  if (!values) return false;
  for (const value of values.values()) {
    if (value > 0) return true;
  }
  return false;
}

function firstScalarFieldComponent(
  modes: ReadonlySet<string> | null | undefined,
): string | null {
  for (const mode of modes ?? []) {
    const component = fieldColorModeScalarComponent(mode);
    if (component) return component;
  }
  return null;
}

function fieldColorModeScalarComponent(mode: string | null | undefined): string | null {
  if (!mode) return null;
  return VIEWPORT_3D_SCALAR_FIELD_COMPONENTS.has(mode) ? mode : null;
}

function mergeViewport3DFieldQuery(
  current: FieldVectorQuery | undefined,
  next: FieldVectorQuery,
): FieldVectorQuery {
  if (!current) return next;
  if (current.component === "full" || next.component === "full") {
    return FULL_FIELD_QUERY;
  }
  return current.component === next.component ? current : FULL_FIELD_QUERY;
}

function selectViewport3DComputeRunning(
  status: ResourceResult<LiveStatusResource>,
): boolean {
  return status.data?.solver.state === "running";
}

function resolveSelectionMeshQualityMetric(
  selection: Selection,
): MeshQualityColorMetric {
  const ref = selection.ref;
  const metric =
    ref?.type === "mesh-quality-element" || ref?.type === "mesh-quality-metric"
      ? ref.metric
      : null;
  if (metric === "gamma" || metric === "sicn" || metric === "volume") {
    return metric;
  }
  return "gamma";
}

const VIEWPORT_3D_VISUALIZATION_TARGET_KINDS: readonly VisualizationTargetKind[] = [
  "airbox",
  "object",
  "part",
  "region",
];

function selectViewport3DObjectVisualizationSnapshot(
  snapshot: ObjectVisualizationSnapshot,
  targets: readonly VisualizationTargetRef[],
): ObjectVisualizationSnapshot {
  const defaults: ObjectVisualizationSnapshot["defaults"] = {};
  const overrides: ObjectVisualizationSnapshot["overrides"] = {};

  for (const kind of VIEWPORT_3D_VISUALIZATION_TARGET_KINDS) {
    const defaultPatch = snapshot.defaults[kind];
    if (defaultPatch) {
      defaults[kind] = defaultPatch;
    }
  }

  for (const target of targets) {
    const key = visualizationTargetKey(target);
    const override = snapshot.overrides[key];
    if (override) {
      overrides[key] = override;
    }
  }

  return { defaults, overrides, version: snapshot.version };
}

function viewport3DObjectVisualizationSnapshotEquals(
  previous: ObjectVisualizationSnapshot,
  next: ObjectVisualizationSnapshot,
): boolean {
  for (const kind of VIEWPORT_3D_VISUALIZATION_TARGET_KINDS) {
    if (!visualizationTargetPatchEquals(previous.defaults[kind], next.defaults[kind])) {
      return false;
    }
  }

  const overrideKeys = new Set([
    ...Object.keys(previous.overrides),
    ...Object.keys(next.overrides),
  ]);
  for (const key of overrideKeys) {
    if (!visualizationTargetPatchEquals(previous.overrides[key], next.overrides[key])) {
      return false;
    }
  }

  return true;
}

function visualizationTargetPatchEquals(
  previous: VisualizationStoredTargetPatch | undefined,
  next: VisualizationStoredTargetPatch | undefined,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;

  const keys = new Set([
    ...Object.keys(previous),
    ...Object.keys(next),
  ] as Array<keyof VisualizationStoredTargetPatch>);
  for (const key of keys) {
    if (!Object.is(previous[key], next[key])) {
      return false;
    }
  }

  return true;
}

function pushViewportVisualizationTarget(
  targets: VisualizationTargetRef[],
  seen: Set<string>,
  target: VisualizationTargetRef,
): void {
  const key = visualizationTargetKey(target);
  if (seen.has(key)) return;
  seen.add(key);
  targets.push(target);
}

export function resolveViewport3DSceneCameraView({
  cameraRegistryCamera,
  commandState,
}: {
  cameraRegistryCamera: VisualizationStateResource["camera"];
  commandState: Pick<Viewport3DCommandState, "camera" | "widgets">;
}): {
  cameraOrthographicScale: number | null;
  cameraProjection: Viewport3DCameraProjection;
  cameraResource: VisualizationStateResource["camera"];
  cameraState: Viewport3DCameraState;
} {
  return {
    cameraOrthographicScale: commandState.widgets.cameraOrthographicScale,
    cameraProjection: commandState.widgets.cameraProjection,
    cameraResource: cameraRegistryCamera,
    cameraState: commandState.camera,
  };
}

export function useViewport3DSceneModel({
  commandState,
  colors,
  meshSizeHighlight,
  meshSizeHighlightSelection,
  resourceCounts,
  selection,
}: {
  commandState: ReturnType<typeof useViewport3DCommandState>;
  colors: Viewport3DSceneProps["colors"] | null;
  meshSizeHighlight: MeshSizeHistogramHighlight | null;
  meshSizeHighlightSelection: MeshHistogramBinElementsResource | null;
  resourceCounts: Viewport3DResourceCounts;
  selection: Selection;
}) {
  const { analysisFieldOverlay } = useKernel();
  const analysisOverlay = useAnalysisFieldOverlay(analysisFieldOverlay);
  useEffect(() => {
    const handle = startAnalysisFieldOverlayPhaseAnimation(analysisFieldOverlay);
    return () => {
      handle.stop();
    };
  }, [analysisFieldOverlay]);
  const visualizationState = useVisualizationStateResource();
  const crossSectionFramePreview = useCrossSectionWorkspaceSelector(
    activeCrossSectionFramePreview,
    { isEqual: crossSectionFramePreviewEquals },
  );
  const crossSectionFrameClip = useMemo(
    () => crossSectionFramePreviewToClip(crossSectionFramePreview),
    [crossSectionFramePreview],
  );
  const cameraRegistryCamera = useCameraRegistryCamera();
  const visualProfile = getViewport3DVisualProfile(commandState.visualProfileId);
  const computeRunning = useSessionStatusSelector(selectViewport3DComputeRunning);
  const renderingState = visualizationState.data;
  const regionSelectionScope = useMemo(
    () => resolveViewport3DRegionSelectionScope(selection),
    [selection],
  );
  const { selectedObjectId, selectedRegionId } = regionSelectionScope;
  const cameraView = resolveViewport3DSceneCameraView({
    cameraRegistryCamera,
    commandState,
  });
  const cameraResource = cameraView.cameraResource;
  useViewport3DCameraRegistryStoreSync(cameraResource);
  const visualizationRevision = renderingState?.revision ?? null;
  const visualizationError = visualizationState.error?.message ?? null;
  const visualizationEffectiveRenderMode = resolveVisualizationEffectiveRenderMode({
    layers: renderingState?.layers,
  });
  const selectedSnapshotId = useMemo(
    () => resolveViewport3DSelectedSnapshotId(selection),
    [selection],
  );
  const hysteresisReplayTarget = useMemo(
    () => resolveHysteresisStepViewportTarget(selection),
    [selection],
  );
  const quantityId = resolveViewport3DActiveQuantityId({
    selectedSnapshotId,
    selection,
    visualizationState: renderingState,
  });
  const primaryFieldQuantityId = analysisOverlay?.fieldId ?? quantityId;
  const scalarColorPalette =
    renderingState?.quantity?.colormap ?? renderingState?.colormap ?? "viridis";
  const vectorStyleState = renderingState?.vector_style;
  const vectorColorMode =
    vectorStyleState?.color_mode ?? "orientation";
  const vectorLengthScale = vectorStyleState?.length_scale ?? 1;
  const vectorDomain = renderingState?.layers?.vectors?.domain ?? "auto";
  const vectorStyle = useMemo(
    () => ({
      alpha: vectorStyleState?.alpha ?? 1,
      monoColor:
        vectorStyleState?.mono_color ??
        String(colors?.field ?? "white"),
      thickness: vectorStyleState?.thickness ?? 1,
    }),
    [
      colors?.field,
      vectorStyleState?.alpha,
      vectorStyleState?.mono_color,
      vectorStyleState?.thickness,
    ],
  );
  const domainMeta = useViewport3DDomainMeta();
  const scene = useViewport3DScene();
  const modelRegions = useModelRegionsResource({
    enabled: Boolean(scene.data),
  });
  const universe = useViewport3DUniverse();
  const sharedDomainManifest = useViewport3DSharedDomainManifest();
  const unknownTopologyProvenanceRefreshRef = useRef<string | null>(null);
  const topology = useViewport3DDomainTopology();
  const fdmDomain = useMemo(
    () => adaptFdmDomainMeta(domainMeta.data, 120_000),
    [domainMeta.data],
  );
  const femDomain = useMemo(
    () => adaptFemSharedDomainManifest(sharedDomainManifest.data),
    [sharedDomainManifest.data],
  );
  const topologyRenderModel = useMemo(
    () =>
      measureViewport3DModelBuild(
        "fullmag.viewport3d.buildViewport3DTopologyRenderModel",
        () =>
          buildViewport3DTopologyRenderModel(
            topology.data,
            femDomain.magneticParts,
            femDomain.airboxParts,
            femDomain.magneticSurfacePartsByPartId,
            {
              meshGenerationId: sharedDomainManifest.data?.generation_id ?? null,
              meshRevision: sharedDomainManifest.data?.revision ?? null,
            },
          ),
      ),
    [
      femDomain.airboxParts,
      femDomain.magneticParts,
      femDomain.magneticSurfacePartsByPartId,
      sharedDomainManifest.data?.generation_id,
      sharedDomainManifest.data?.revision,
      topology.data,
    ],
  );
  const primitiveModel = useMemo(
    () =>
      buildViewport3DPrimitiveRenderModel(
        scene.data,
        sharedDomainManifest.data,
      ),
    [scene.data, sharedDomainManifest.data],
  );
  const objectTransformsById = useMemo(() => {
    const sceneRecord = asJsonRecord(scene.data);
    const transforms = new Map<string, unknown>();
    if (!sceneRecord || !Array.isArray(sceneRecord.objects)) {
      return transforms;
    }

    for (const value of sceneRecord.objects) {
      const object = asJsonRecord(value);
      const objectId = asNonEmptyString(object?.id);
      const transform = asJsonRecord(object?.transform);
      if (objectId && transform) {
        transforms.set(objectId, transform);
      }
    }

    return transforms;
  }, [scene.data]);
  const regionTargetByPartId = useMemo(() => {
    return resolveViewport3DRegionTargetByPartId(sharedDomainManifest.data?.regions);
  }, [sharedDomainManifest.data?.regions]);
  const meshBackedRegionKeys = useMemo(
    () => resolveViewport3DMeshBackedRegionKeys(sharedDomainManifest.data?.regions),
    [sharedDomainManifest.data?.regions],
  );
  const allRegionOverlays = useMemo<RegionOverlayInput[]>(
    () =>
      resolveViewport3DRegionOverlays({
        objectTransformsById,
        regionResource: modelRegions.data,
        scene: scene.data,
      }),
    [modelRegions.data, objectTransformsById, scene.data],
  );
  const topologyFreshness = useMemo(
    () =>
      resolveViewport3DTopologyFreshness(
        scene.data,
        sharedDomainManifest.data,
      ),
    [scene.data, sharedDomainManifest.data],
  );
  useEffect(() => {
    const refreshKey = resolveUnknownTopologyProvenanceRefreshKey(
      scene.data,
      sharedDomainManifest.data,
    );
    if (
      !refreshKey ||
      unknownTopologyProvenanceRefreshRef.current === refreshKey
    ) {
      return;
    }

    unknownTopologyProvenanceRefreshRef.current = refreshKey;
    sharedDomainManifest.refetch();
  }, [scene.data, sharedDomainManifest]);
  const topologyCurrent = isViewport3DTopologyCurrent(topologyFreshness);
  const topologyRenderable = isViewport3DTopologyRenderable(topologyFreshness);
  const regionMembershipIds = useMemo(
    () =>
      topologyCurrent
        ? resolveViewport3DRegionMembershipIds({
            meshBackedRegionKeys,
            regions: allRegionOverlays,
          })
        : [],
    [allRegionOverlays, meshBackedRegionKeys, topologyCurrent],
  );
  const regionMemberships = useMeshRegionMembershipsResource(regionMembershipIds, {
    enabled: Boolean(topologyCurrent && regionMembershipIds.length > 0),
  });
  const membershipRegionOverlays = useMemo(
    () =>
      topologyCurrent && regionMemberships.data
        ? resolveViewport3DMembershipRegionOverlays({
            memberships: regionMemberships.data,
            regions: allRegionOverlays,
          })
        : { ownerParts: [], regions: [] },
    [allRegionOverlays, regionMemberships.data, topologyCurrent],
  );
  const meshRegionOverlays = useMemo(
    () => {
      if (!topologyCurrent) return [];
      return [
        ...resolveViewport3DMeshBackedRegionOverlays({
          manifestRegions: sharedDomainManifest.data?.regions,
          regions: allRegionOverlays,
        }),
        ...membershipRegionOverlays.regions,
      ];
    },
    [
      allRegionOverlays,
      membershipRegionOverlays.regions,
      sharedDomainManifest.data?.regions,
      topologyCurrent,
    ],
  );
  const meshRegionOverlayParts = useMemo(
    () => [...femDomain.magneticParts, ...membershipRegionOverlays.ownerParts],
    [femDomain.magneticParts, membershipRegionOverlays.ownerParts],
  );
  const regionOverlays = allRegionOverlays;
  const currentTopologyRenderModel = topologyRenderable ? topologyRenderModel : null;
  const clipCrossSectionQuery = useMemo(() => {
    const query = resolveCrossSectionQueryFromVisualizationState(renderingState);
    return {
      ...query,
      includePolygons: true,
      includeWireframe: false,
    };
  }, [renderingState]);
  const clipCrossSection = useCrossSectionResource(clipCrossSectionQuery, {
    enabled: Boolean(renderingState?.clip?.enabled && topologyCurrent),
  });
  const clipIntersectionMarkers = useMemo(
    () => buildClipPlaneIntersectionMarkerBuffers(clipCrossSection.data),
    [clipCrossSection.data],
  );
  const meshQualityOverlayVisible =
    selection.kind === "mesh.quality" ||
    selection.ref?.type === "mesh-quality-element";
  const meshQualityMetric = resolveSelectionMeshQualityMetric(selection);
  const meshQualityData = useViewport3DMeshQualityData(
    Boolean(currentTopologyRenderModel && meshQualityOverlayVisible),
  );
  const meshQualityColors = useMemo(
    () =>
      meshQualityOverlayVisible && topologyCurrent
        ? measureViewport3DModelBuild(
            "fullmag.viewport3d.buildMeshQualityVertexColors",
            () =>
              buildMeshQualityVertexColors(
                topology.data,
                meshQualityData.data,
                meshQualityMetric,
                scalarColorPalette,
              ),
          )
        : null,
    [
      meshQualityData.data,
      meshQualityMetric,
      meshQualityOverlayVisible,
      scalarColorPalette,
      topology.data,
      topologyCurrent,
    ],
  );
  const meshSizeHighlightModel = useMemo(
    () =>
      topologyCurrent
        ? measureViewport3DModelBuild(
            "fullmag.viewport3d.buildMeshSizeHistogramHighlight",
            () =>
              buildViewport3DMeshSizeHighlightModel(
                topology.data,
                currentTopologyRenderModel,
                femDomain,
                meshSizeHighlight,
                meshSizeHighlightSelection
                  ? { elementIndices: meshSizeHighlightSelection.element_indices }
                  : null,
              ),
          )
        : null,
    [
      currentTopologyRenderModel,
      femDomain,
      meshSizeHighlight,
      meshSizeHighlightSelection,
      topology.data,
      topologyCurrent,
    ],
  );
  const magnetizationTexturePreviews = useMemo(
    () => buildViewport3DMagnetizationTexturePreviewMap(scene.data),
    [scene.data],
  );
  const primitiveBounds = useMemo(
    () =>
      combineViewport3DBounds(
        primitiveModel.objects.map((object) => object.bounds),
      ),
    [primitiveModel],
  );
  const topologyBounds = useMemo(
    () => (topologyCurrent ? resolveTopologyBounds(topology.data) : null),
    [topology.data, topologyCurrent],
  );
  const resourceBounds =
    topologyBounds ??
    resolveDomainBounds(domainMeta.data) ??
    resolveUniverseBounds(universe.data);
  const bounds =
    combineViewport3DBounds(
      [resourceBounds, primitiveBounds].filter(
        (entry): entry is NonNullable<typeof entry> => Boolean(entry),
      ),
    ) ??
    resourceBounds ??
    primitiveBounds;
  const vectorScale = Math.max(
    Math.max(...(bounds?.size ?? [1e-6, 1e-6, 1e-6])) *
      0.0105 *
      vectorLengthScale,
    1e-12,
  );
  const selectionBounds = useMemo(
    () =>
      resolveViewport3DRegionSelectionBounds(selection, allRegionOverlays) ??
      resolvePrimitiveSelectionBounds(selection, primitiveModel) ??
      resolveViewport3DSelectionBounds(selection, femDomain, bounds),
    [selection, allRegionOverlays, primitiveModel, femDomain, bounds],
  );
  const globalLayers = renderingState?.layers;
  const globalObjectBaseSettings = useMemo(
    () => resolveGlobalObjectVisualizationSettings(renderingState),
    // Explicit deps on global layer fields only; airbox sub-fields excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      globalLayers?.surface?.visible,
      globalLayers?.surface?.opacity,
      globalLayers?.wireframe?.visible,
      globalLayers?.points?.visible,
      globalLayers?.vectors?.visible,
      vectorStyleState?.alpha,
      vectorStyleState?.color_mode,
      vectorStyleState?.mono_color,
      vectorStyleState?.thickness,
      renderingState?.vector_glyphs,
      renderingState?.quantity?.active_quantity_id,
      renderingState?.active_quantity_id,
    ],
  );
  const viewportVisualizationTargets = useMemo(() => {
    const targets: VisualizationTargetRef[] = [];
    const seen = new Set<string>();
    pushViewportVisualizationTarget(
      targets,
      seen,
      AIRBOX_VISUALIZATION_TARGET,
    );

    const fdmDomainId = domainMeta.data?.domain_id ?? null;
    const fdmTarget = fdmDomain ? targetForFdmDomain(fdmDomainId) : null;
    if (fdmTarget) {
      pushViewportVisualizationTarget(targets, seen, fdmTarget);
    }

    for (const object of primitiveModel.objects) {
      pushViewportVisualizationTarget(targets, seen, {
        id: object.objectId,
        kind: "object",
        label: object.label,
      });
    }

    for (const part of femDomain.magneticParts) {
      pushViewportVisualizationTarget(targets, seen, targetForMeshPart(part));
    }
    for (const part of femDomain.airboxParts) {
      pushViewportVisualizationTarget(targets, seen, targetForMeshPart(part));
    }
    for (const region of allRegionOverlays) {
      const objectId = asNonEmptyString(region.owner_object_id);
      const regionId = asNonEmptyString(region.region_id);
      if (!objectId || !regionId) continue;
      pushViewportVisualizationTarget(targets, seen, {
        id: visualizationTargetIdForSceneObject(objectId, regionId),
        kind: "region",
        label: region.name ?? regionId,
      });
    }
    for (const target of regionTargetByPartId.values()) {
      pushViewportVisualizationTarget(targets, seen, target);
    }

    return targets;
  }, [
    domainMeta.data?.domain_id,
    fdmDomain,
    femDomain.airboxParts,
    femDomain.magneticParts,
    primitiveModel.objects,
    regionTargetByPartId,
    allRegionOverlays,
  ]);
  const selectObjectVisualizationSnapshot = useCallback(
    (snapshot: ObjectVisualizationSnapshot) =>
      selectViewport3DObjectVisualizationSnapshot(
        snapshot,
        viewportVisualizationTargets,
      ),
    [viewportVisualizationTargets],
  );
  const objectVisualizationSnapshot = useObjectVisualizationSelector(
    selectObjectVisualizationSnapshot,
    { isEqual: viewport3DObjectVisualizationSnapshotEquals },
  );
  const fallbackSettings = useMemo(
    () =>
      resolveDefaultVisualizationSettings(
        objectVisualizationSnapshot,
        "object",
        globalObjectBaseSettings,
      ),
    [globalObjectBaseSettings, objectVisualizationSnapshot],
  );
  const fdmSettings = useMemo(() => {
    const fdmDomainId = domainMeta.data?.domain_id ?? null;
    const fdmTarget = fdmDomain ? targetForFdmDomain(fdmDomainId) : null;
    if (!fdmTarget) return fallbackSettings;
    return resolveTargetVisualization({
      snapshot: objectVisualizationSnapshot,
      target: fdmTarget,
      visualizationState: renderingState,
    }).effectiveSettings;
  }, [
    domainMeta.data?.domain_id,
    fallbackSettings,
    fdmDomain,
    objectVisualizationSnapshot,
    renderingState,
  ]);
  const fdmVectorScale = vectorScale * fdmSettings.vectorLengthScale;
  const airboxSettings = useMemo(
    () =>
      resolveTargetVisualization({
        snapshot: objectVisualizationSnapshot,
        target: AIRBOX_VISUALIZATION_TARGET,
        visualizationState: renderingState,
      }).effectiveSettings,
    [objectVisualizationSnapshot, renderingState],
  );
  const airboxQuantityCompatible = !isMagneticOnlyQuantityId(
    airboxSettings.activeQuantityId,
  );
  const getPartSettings = useCallback(
    (part: Viewport3DMeshPart) =>
      resolveViewport3DPartVisualizationSettings({
        objectVisualizationSnapshot,
        part,
        regionTarget: regionTargetByPartId.get(part.id),
        renderingState,
      }),
    [objectVisualizationSnapshot, regionTargetByPartId, renderingState],
  );
  const getObjectSettings = useCallback(
    (object: Viewport3DPrimitiveObject) =>
      resolveTargetVisualization({
        snapshot: objectVisualizationSnapshot,
        target: {
          id: object.objectId,
          kind: "object",
          label: object.label,
        },
        visualizationState: renderingState,
      }).effectiveSettings,
    [objectVisualizationSnapshot, renderingState],
  );
  const getRegionSettings = useCallback(
    (region: RegionOverlayInput) => {
      const objectId = asNonEmptyString(region.owner_object_id);
      const regionId = asNonEmptyString(region.region_id);
      if (!objectId || !regionId) return fallbackSettings;
      const objectSettings = resolveTargetVisualization({
        snapshot: objectVisualizationSnapshot,
        target: {
          id: objectId,
          kind: "object",
          label: objectId,
        },
        visualizationState: renderingState,
      }).settings;
      return resolveTargetVisualization({
        inheritedSettings: objectSettings,
        snapshot: objectVisualizationSnapshot,
        target: {
          id: visualizationTargetIdForSceneObject(objectId, regionId),
          kind: "region",
          label: region.name ?? regionId,
        },
        visualizationState: renderingState,
      }).effectiveSettings;
    },
    [fallbackSettings, objectVisualizationSnapshot, renderingState],
  );
  const airboxVectorsVisible = viewport3DAirboxVectorsVisible(
    airboxSettings.visible,
    airboxSettings.vectorsVisible,
    airboxQuantityCompatible,
    vectorDomain,
  );
  const airboxSurfaceColorMode =
    airboxQuantityCompatible &&
    airboxSettings.visible &&
    airboxSettings.shaderVisible
      ? surfaceColorSourceToColorMode(airboxSettings.surfaceColorSource)
      : null;
  const airboxFieldVectorEnabled = Boolean(
    airboxVectorsVisible || airboxSurfaceColorMode,
  );
  const airboxFieldVectorParts = useMemo(
    () =>
      currentTopologyRenderModel?.airboxParts.map((partModel) => partModel.part) ??
      EMPTY_AIRBOX_FIELD_VECTOR_PARTS,
    [currentTopologyRenderModel],
  );
  const airboxFieldQuery = useMemo(
    () =>
      resolveViewport3DScopedVectorFieldQuery({
        maxSamples: airboxSettings.vectorBudget,
        surfaceColorMode: airboxSurfaceColorMode,
        vectorsVisible: airboxVectorsVisible,
      }),
    [
      airboxSettings.vectorBudget,
      airboxSurfaceColorMode,
      airboxVectorsVisible,
    ],
  );
  const fdmSurfaceColorMode =
    fdmDomain && fdmSettings.visible && fdmSettings.shaderVisible
      ? surfaceColorSourceToColorMode(fdmSettings.surfaceColorSource)
      : null;
  const magneticPartFieldQueries = useMemo(
    () =>
      resolveViewport3DScopedPartVectorFieldRequests({
        getPartSettings,
        magneticParts: currentTopologyRenderModel?.magneticParts ?? [],
        vectorDomain,
      }),
    [currentTopologyRenderModel?.magneticParts, getPartSettings, vectorDomain],
  );
  const magneticPartScopedVectorIds = useMemo(
    () => new Set(magneticPartFieldQueries.keys()),
    [magneticPartFieldQueries],
  );
  const targetQuantityFieldQueries = useMemo(() => {
    if (!currentTopologyRenderModel) return new Map<string, FieldVectorQuery>();
    const queries = new Map<string, FieldVectorQuery>();
    const setQuery = (
      targetQuantityId: string,
      query: FieldVectorQuery,
    ): void => {
      queries.set(
        targetQuantityId,
        mergeViewport3DFieldQuery(queries.get(targetQuantityId), query),
      );
    };

    for (const partModel of currentTopologyRenderModel.magneticParts) {
      if (magneticPartScopedVectorIds.has(partModel.part.id)) {
        continue;
      }
      const settings = getPartSettings(partModel.part);
      if (
        !sameViewport3DQuantityId(settings.activeQuantityId, primaryFieldQuantityId) &&
        settings.visible &&
        (settings.shaderVisible || settings.vectorsVisible)
      ) {
        setQuery(
          resolveCanonicalQuantityId(settings.activeQuantityId),
          resolveViewport3DTargetFieldQuery({
            surfaceColorMode: settings.shaderVisible
              ? surfaceColorSourceToColorMode(settings.surfaceColorSource)
              : null,
            vectorsVisible: settings.vectorsVisible,
          }),
        );
      }
    }
    if (
      !sameViewport3DQuantityId(fdmSettings.activeQuantityId, primaryFieldQuantityId) &&
      fdmSettings.visible &&
      (fdmSettings.shaderVisible || fdmSettings.vectorsVisible)
    ) {
      setQuery(
        resolveCanonicalQuantityId(fdmSettings.activeQuantityId),
        resolveViewport3DTargetFieldQuery({
          surfaceColorMode: fdmSurfaceColorMode,
          vectorsVisible: fdmSettings.vectorsVisible,
        }),
      );
    }
    return new Map(Array.from(queries).toSorted(([left], [right]) =>
      left.localeCompare(right),
    ));
  }, [
    currentTopologyRenderModel,
    fdmSettings.activeQuantityId,
    fdmSettings.shaderVisible,
    fdmSettings.vectorsVisible,
    fdmSettings.visible,
    fdmSurfaceColorMode,
    getPartSettings,
    magneticPartScopedVectorIds,
    primaryFieldQuantityId,
  ]);
  const fieldUpdateHoldActive = useViewport3DFieldUpdateHoldActive();
  const magneticPartFieldVectors = useViewport3DPartFieldVectors(
    magneticPartFieldQueries,
    magneticPartFieldQueries.size > 0,
    { pauseLoad: fieldUpdateHoldActive },
  );
  const targetQuantityFieldVectors = useViewport3DQuantityFieldVectors(
    targetQuantityFieldQueries,
    targetQuantityFieldQueries.size > 0,
    { pauseLoad: fieldUpdateHoldActive },
  );
  const airboxFieldVectors = useViewport3DAirboxFieldVectors(
    airboxSettings.activeQuantityId,
    airboxFieldVectorParts,
    airboxFieldVectorEnabled && airboxFieldVectorParts.length > 0,
    airboxFieldQuery,
    { pauseLoad: fieldUpdateHoldActive },
  );
  const fieldRenderOptions = useViewport3DFieldRenderOptions({
    airboxSettings,
    airboxQuantityCompatible,
    fallbackSettings,
    getPartSettings,
    scalarColorPalette,
    topologyRenderModel: currentTopologyRenderModel,
    vectorColorMode,
    vectorDomain,
  });
  const primaryFieldRenderOptions = useMemo(
    () =>
      resolveViewport3DPrimaryFieldRenderOptions({
        fieldRenderOptions,
        getPartSettings,
        magneticParts: currentTopologyRenderModel?.magneticParts ?? [],
        quantityId: primaryFieldQuantityId,
        scopedVectorOnlyPartIds: magneticPartScopedVectorIds,
        vectorDomain,
      }),
    [
      currentTopologyRenderModel?.magneticParts,
      fieldRenderOptions,
      getPartSettings,
      magneticPartScopedVectorIds,
      primaryFieldQuantityId,
      vectorDomain,
    ],
  );
  const resolvedFieldRenderOptions = useMemo(
    () => {
      const partFieldVectors = new Map<string, DecodedFieldVector>();
      if (targetQuantityFieldVectors.data && currentTopologyRenderModel) {
        for (const partModel of currentTopologyRenderModel.magneticParts) {
          const targetQuantityId = resolveCanonicalQuantityId(
            getPartSettings(partModel.part).activeQuantityId,
          );
          const fieldVector = targetQuantityFieldVectors.data.get(targetQuantityId);
          if (fieldVector) {
            partFieldVectors.set(partModel.part.id, fieldVector);
          }
        }
        if (airboxQuantityCompatible) {
          for (const partModel of currentTopologyRenderModel.airboxParts) {
            const fieldVector = targetQuantityFieldVectors.data.get(
              resolveCanonicalQuantityId(airboxSettings.activeQuantityId),
            );
            if (fieldVector) {
              partFieldVectors.set(partModel.part.id, fieldVector);
            }
          }
        }
      }
      if (magneticPartFieldVectors.data) {
        for (const [partId, fieldVector] of magneticPartFieldVectors.data) {
          partFieldVectors.set(partId, fieldVector);
        }
      }
      if (airboxFieldVectors.data) {
        for (const [partId, fieldVector] of airboxFieldVectors.data) {
          partFieldVectors.set(partId, fieldVector);
        }
      }
      return partFieldVectors.size > 0
        ? {
            ...fieldRenderOptions,
            partFieldVectors,
          }
        : fieldRenderOptions;
    },
    [
      airboxFieldVectors.data,
      airboxSettings.activeQuantityId,
      airboxQuantityCompatible,
      currentTopologyRenderModel,
      fieldRenderOptions,
      getPartSettings,
      magneticPartFieldVectors.data,
      targetQuantityFieldVectors.data,
    ],
  );
  const fdmVoxelMagnitudeThreshold =
    fdmDomain && fdmSettings.visible && fdmSettings.shaderVisible
      ? visualProfile.voxelMagnitudeThreshold
      : 0;
  const fdmTopographyEnabled = Boolean(
    fdmDomain &&
      fdmSettings.visible &&
      fdmSettings.shaderVisible &&
      commandState.widgets.fdmTopographyEnabled,
  );
  const fdmVoxelTopography = useMemo(
    () => ({
      amplitudeCells: commandState.widgets.fdmTopographyAmplitudeCells,
      component: commandState.widgets.fdmTopographyComponent,
      enabled: fdmTopographyEnabled,
    }),
    [
      commandState.widgets.fdmTopographyAmplitudeCells,
      commandState.widgets.fdmTopographyComponent,
      fdmTopographyEnabled,
    ],
  );
  const fdmVectorsVisible = Boolean(
    fdmDomain && fdmSettings.visible && fdmSettings.vectorsVisible,
  );
  const fdmInstanceModelEnabled = Boolean(
    fdmDomain &&
      fdmSettings.visible &&
      (fdmSettings.shaderVisible || fdmSettings.wireframeVisible || fdmVectorsVisible),
  );
  const fdmInstanceModelNeedsFieldVector =
    fdmVoxelMagnitudeThreshold > 0 || fdmTopographyEnabled;
  const fieldVectorEnabled =
    Boolean(analysisOverlay) ||
    resolveViewport3DPrimaryFieldVectorEnabled({
      fdmInstanceModelNeedsFieldVector,
      fdmSurfaceColorMode,
      fdmVectorsVisible,
      fieldRenderOptions: primaryFieldRenderOptions,
      selectedSnapshotId,
    });
  const primaryFieldQuery = useMemo(
    () => {
      if (analysisOverlay) {
        return analysisOverlay.query;
      }
      return resolveViewport3DPrimaryFieldQuery({
        fdmInstanceModelNeedsFieldVector,
        fdmSurfaceColorMode,
        fdmTopographyEnabled,
        fdmVectorsVisible,
        fieldRenderOptions: primaryFieldRenderOptions,
        snapshotId: selectedSnapshotId,
      });
    },
    [
      analysisOverlay,
      fdmInstanceModelNeedsFieldVector,
      fdmSurfaceColorMode,
      fdmTopographyEnabled,
      fdmVectorsVisible,
      primaryFieldRenderOptions,
      selectedSnapshotId,
    ],
  );
  const fieldVector = useViewport3DFieldVector(
    primaryFieldQuantityId,
    primaryFieldQuery,
    fieldVectorEnabled,
    { pauseLoad: fieldUpdateHoldActive },
  );
  const fieldVectorResourceKey = useMemo(
    () =>
      resolveViewport3DFieldVectorResourceKey(
        primaryFieldQuantityId,
        primaryFieldQuery,
      ),
    [primaryFieldQuery, primaryFieldQuantityId],
  );
  const fieldDataIssue = useMemo<Viewport3DFieldDataIssue | null>(() => {
    if (!(fieldVectorEnabled && fieldVector.error)) return null;
    const message =
      fieldVector.error.message.trim() || "Field vector resource failed to load.";
    return {
      key: `${fieldVectorResourceKey}:${fieldVector.revision ?? "none"}:${message}`,
      message,
      quantityId: primaryFieldQuantityId,
      resourceKey: fieldVectorResourceKey,
      retry: fieldVector.refetch,
    };
  }, [
    fieldVector.error,
    fieldVector.refetch,
    fieldVector.revision,
    fieldVectorEnabled,
    fieldVectorResourceKey,
    primaryFieldQuantityId,
  ]);
  const fieldRefresh = useMemo<Viewport3DFieldRefreshState>(
    () => ({
      enabled: computeRunning && fieldVectorEnabled,
      quantityId: primaryFieldQuantityId,
      resourceKey: fieldVectorResourceKey,
      revision: fieldVector.revision,
      status: fieldVector.status,
    }),
    [
      computeRunning,
      fieldVector.revision,
      fieldVector.status,
      fieldVectorEnabled,
      fieldVectorResourceKey,
      primaryFieldQuantityId,
    ],
  );
  const committedFieldVector = fieldVector.data ?? null;
  const fdmFieldVector =
    sameViewport3DQuantityId(fdmSettings.activeQuantityId, primaryFieldQuantityId)
      ? committedFieldVector
      : targetQuantityFieldVectors.data?.get(
          resolveCanonicalQuantityId(fdmSettings.activeQuantityId),
        ) ?? null;
  const fdmInstanceModelFieldVector = fdmInstanceModelNeedsFieldVector
    ? fdmFieldVector
    : null;
  const fdmInstanceModel = useMemo<
    FdmCuboidInstanceModel | null | undefined
  >(() => {
    if (!fdmInstanceModelEnabled) return undefined;
    return measureViewport3DModelBuild(
      "fullmag.viewport3d.buildFdmCuboidInstanceModel",
      () =>
        buildFdmCuboidInstanceModel(fdmDomain, {
          fieldVector: fdmInstanceModelFieldVector,
          voxelFillRatio: visualProfile.voxelFillRatio,
          voxelMagnitudeThreshold: fdmVoxelMagnitudeThreshold,
          voxelTopography: fdmVoxelTopography,
        }),
    );
  }, [
    fdmDomain,
    fdmInstanceModelEnabled,
    fdmInstanceModelFieldVector,
    fdmVoxelMagnitudeThreshold,
    fdmVoxelTopography,
    visualProfile.voxelFillRatio,
  ]);
  const fdmSurfaceColors = useMemo(() => {
    if (!fdmSurfaceColorMode) return null;
    return buildSampledScalarColors(
      fdmFieldVector,
      fdmInstanceModel?.cellIndices,
      fdmSurfaceColorMode,
      scalarColorPalette,
    );
  }, [
    fdmFieldVector,
    fdmSurfaceColorMode,
    fdmInstanceModel,
    scalarColorPalette,
  ]);
  const chunkedScalarColors = useViewport3DChunkedScalarColors({
    colorModes: fieldRenderOptions.scalarColorModes,
    colorPalette: scalarColorPalette,
    enabled: fieldRenderOptions.scalarColorsVisible !== false,
    fieldVector: committedFieldVector,
    topology: currentTopologyRenderModel,
  });
  const fieldRenderModel = useMemo(() => {
    const model = measureViewport3DModelBuild(
      "fullmag.viewport3d.buildViewport3DFieldRenderModel",
      () =>
          buildViewport3DFieldRenderModel(
          currentTopologyRenderModel,
          committedFieldVector,
          vectorScale,
          resolvedFieldRenderOptions,
        ),
    );
    return mergeViewport3DFieldScalarColors(
      model,
      chunkedScalarColors.colors,
      vectorColorMode,
    );
  }, [
    chunkedScalarColors.colors,
    committedFieldVector,
    currentTopologyRenderModel,
    resolvedFieldRenderOptions,
    vectorColorMode,
    vectorScale,
  ]);
  const selectedLabel = selection.label ?? "No selection";
  const status =
    topology.error?.message ??
    (renderingState?.clip?.enabled ? clipCrossSection.error?.message : null) ??
    (meshQualityOverlayVisible ? meshQualityData.error?.message : null) ??
    fieldVector.error?.message ??
    magneticPartFieldVectors.error?.message ??
    targetQuantityFieldVectors.error?.message ??
    airboxFieldVectors.error?.message ??
    scene.error?.message ??
    universe.error?.message ??
    domainMeta.error?.message ??
    sharedDomainManifest.error?.message ??
    visualizationState.error?.message ??
    resolveViewport3DTopologyFreshnessLabel(topologyFreshness) ??
    topology.status;
  const domainSummary = fdmDomain
    ? `${fdmDomain.displayCellCount}/${fdmDomain.totalCells}`
    : `${femDomain.magneticParts.length}+${femDomain.airboxParts.length}`;
  const diagnostics = buildViewport3DDiagnostics({
    airboxPartCount: femDomain.airboxParts.length,
    cache: getCacheStats(),
    fieldRevision: fieldVector.payloadRevision ?? fieldVector.revision,
    objectCount: femDomain.objectPartIds.size,
    quantityId: primaryFieldQuantityId,
    surfaceColorStatus: chunkedScalarColors.status,
    topologyRevision: topology.revision,
    tracker: resourceCounts,
  });
  const hslReferenceVisible = resolveHslReferenceVisible(
    commandState.widgets.hslReferenceMode,
    vectorColorMode,
  );
  const resourceFrameKey = buildViewport3DResourceFrameKey([
    {
      error: topology.error?.message,
      id: "topology",
      revision: topology.revision,
      status: topology.status,
    },
    resolveViewport3DResourceFrameState({
      dataAvailable: Boolean(fieldVector.data),
      error: fieldVector.error?.message,
      id: "field-vector",
      payloadRevision: fieldVector.payloadRevision ?? null,
      revision: fieldVector.revision,
      status: fieldVector.status,
    }),
    resolveViewport3DResourceFrameState({
      dataAvailable: Boolean(magneticPartFieldVectors.data?.size),
      error: magneticPartFieldVectors.error?.message,
      id: "magnetic-part-field-vectors",
      payloadRevision: magneticPartFieldVectors.payloadRevision ?? null,
      revision: magneticPartFieldVectors.revision,
      status: magneticPartFieldVectors.status,
    }),
    resolveViewport3DResourceFrameState({
      dataAvailable: Boolean(targetQuantityFieldVectors.data?.size),
      error: targetQuantityFieldVectors.error?.message,
      id: "target-quantity-field-vectors",
      payloadRevision: targetQuantityFieldVectors.payloadRevision ?? null,
      revision: targetQuantityFieldVectors.revision,
      status: targetQuantityFieldVectors.status,
    }),
    resolveViewport3DResourceFrameState({
      dataAvailable: Boolean(airboxFieldVectors.data?.size),
      error: airboxFieldVectors.error?.message,
      id: "airbox-field-vectors",
      payloadRevision: airboxFieldVectors.payloadRevision ?? null,
      revision: airboxFieldVectors.revision,
      status: airboxFieldVectors.status,
    }),
    {
      error: meshQualityOverlayVisible
        ? meshQualityData.error?.message
        : undefined,
      id: "mesh-quality-data",
      revision: meshQualityOverlayVisible ? meshQualityData.revision : null,
      status: meshQualityOverlayVisible ? meshQualityData.status : "idle",
    },
    {
      error: renderingState?.clip?.enabled
        ? clipCrossSection.error?.message
        : undefined,
      id: "clip-cross-section",
      revision: renderingState?.clip?.enabled ? clipCrossSection.revision : null,
      status: renderingState?.clip?.enabled ? clipCrossSection.status : "idle",
    },
    {
      error: modelRegions.error?.message,
      id: "model-regions",
      revision: modelRegions.revision,
      status: modelRegions.status,
    },
    {
      error: regionMemberships.error?.message,
      id: "region-memberships",
      revision: regionMemberships.revision,
      status: regionMemberships.status,
    },
    {
      error: scene.error?.message,
      id: "scene",
      revision: scene.revision,
      status: scene.status,
    },
    {
      error: domainMeta.error?.message,
      id: "domain-meta",
      revision: domainMeta.revision,
      status: domainMeta.status,
    },
    {
      error: sharedDomainManifest.error?.message,
      id: "shared-domain-manifest",
      revision: sharedDomainManifest.revision,
      status: sharedDomainManifest.status,
    },
    {
      error: universe.error?.message,
      id: "universe",
      revision: universe.revision,
      status: universe.status,
    },
    {
      error: visualizationState.error?.message,
      id: "visualization-state",
      revision: visualizationState.revision,
      status: visualizationState.status,
    },
  ]);

  return {
    airboxSettings,
    bounds,
    cameraOrthographicScale: cameraView.cameraOrthographicScale,
    cameraProjection: cameraView.cameraProjection,
    cameraResource,
    cameraState: cameraView.cameraState,
    clip: renderingState?.clip ?? null,
    clipFrameRotationDegrees: 0,
    clipIntersectionMarkers,
    crossSectionFrameClip,
    crossSectionFrameRotationDegrees:
      crossSectionFramePreview?.rotationDegrees ?? 0,
    diagnostics,
    domainId: domainMeta.data?.domain_id,
    domainSummary,
    fallbackSettings,
    fdmDomain,
    fdmInstanceModel: fdmInstanceModel,
    fdmSettings,
    fdmSurfaceColors,
    femDomain,
    fieldDataIssue,
    fieldRefresh,
    fieldModel: fieldRenderModel,
    fieldVector: committedFieldVector,
    getObjectSettings,
    getPartSettings,
    getRegionSettings,
    hslReferenceVisible,
    hysteresisReplayTarget,
    magnetizationTexturePreviews,
    maxVectorGlyphs: fdmSettings.vectorBudget,
    meshQualityColors,
    meshQualityMetric,
    meshQualityOverlayVisible,
    meshRegionOverlayParts,
    meshSizeHighlightModel,
    meshQualityRange: meshQualityColors?.range ?? null,
    meshRegionOverlays,
    primitiveModel,
    quantityId: primaryFieldQuantityId,
    regionOverlays,
    resourceFrameKey,
    selectedLabel,
    selectedObjectId,
    selectedRegionId,
    selectionBounds,
    scalarColorPalette,
    status,
    renderedMeshRevision: currentTopologyRenderModel?.meshRevision ?? null,
    topology: topology.data,
    topologyRevision: topology.revision,
    topologyFreshness,
    topologyModel: topologyRenderModel,
    vectorColorMode,
    vectorScale: fdmVectorScale,
    vectorStyle,
    visualizationEffectiveRenderMode,
    visualizationError,
    visualProfileId: commandState.visualProfileId,
    visualizationRevision,
  };
}

function useViewport3DCameraRegistryStoreSync(
  cameraResource: VisualizationStateResource["camera"],
) {
  const lastRemoteSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    const camera = resolveViewport3DCameraState({ camera: cameraResource });
    const projection = resolveViewport3DCameraProjection({
      camera: cameraResource,
    });
    const orthographicScale = resolveViewport3DCameraOrthographicScale({
      camera: cameraResource,
    });
    const signature = viewport3DCameraViewSignature({
      camera,
      orthographicScale,
      projection,
    });
    if (lastRemoteSignatureRef.current === signature) return;

    lastRemoteSignatureRef.current = signature;
    viewport3dStore.setCameraView({ camera, orthographicScale, projection });
  }, [cameraResource]);
}

function measureViewport3DModelBuild<T>(name: string, build: () => T): T {
  const performanceTarget =
    typeof performance !== "undefined" ? performance : null;
  if (
    !performanceTarget ||
    typeof performanceTarget.mark !== "function" ||
    typeof performanceTarget.measure !== "function"
  ) {
    return build();
  }

  const startMark = `${name}:start`;
  const endMark = `${name}:end`;
  performanceTarget.mark(startMark);
  try {
    return build();
  } finally {
    performanceTarget.mark(endMark);
    try {
      performanceTarget.measure(name, startMark, endMark);
    } catch {
      // Gracefully ignore measurement errors to prevent crashing the UI
    }
    performanceTarget.clearMarks?.(startMark);
    performanceTarget.clearMarks?.(endMark);
  }
}
