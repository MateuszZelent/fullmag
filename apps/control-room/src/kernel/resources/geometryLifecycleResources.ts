"use client";

import { useCallback, useMemo } from "react";

import {
  DATA_FDM_REGION_MEMBERSHIP_BINARY_PATH,
  DATA_FDM_REGION_MEMBERSHIP_SCOPED_PATH,
  DATA_FDM_REGION_MEMBERSHIPS_PATH,
  DATA_DOMAIN_META_PATH,
  DATA_DOMAIN_FDM_MULTILAYER_LAYOUT_PATH,
  DATA_DOMAIN_FDM_MULTILAYER_LAYER_ACTIVE_MASK_PATH,
  DATA_MESH_REGION_MEMBERSHIP_PATH,
  DATA_MESH_REGION_MEMBERSHIPS_PATH,
  MESHING_CAPABILITIES_PATH,
  MESHING_BUILDS_PATH,
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_HISTOGRAM_BIN_ELEMENTS_PATH,
  MESHING_SEMANTICS_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_SHARED_DOMAIN_POLICY_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_GATES_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_PATH,
  MESHING_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_PATH,
  MESHING_SHARED_DOMAIN_REPORT_PATH,
  MESHING_SHARED_DOMAIN_TOPOLOGY_PATH,
  MESHING_OBJECT_QUALITY_PATH,
  MESHING_OBJECT_POLICY_PATH,
  MESHING_OBJECT_REPORT_PATH,
  MESHING_OBJECT_SIZE_FIELD_PATH,
  MESHING_OBJECT_TOPOLOGY_PATH,
  MESHING_REGION_QUALITY_PATH,
  MESHING_SUMMARY_PATH,
  MESHING_UNIVERSE_POLICY_PATH,
  MESHING_UNIVERSE_QUALITY_PATH,
  MESHING_UNIVERSE_REPORT_PATH,
  MODEL_MATERIAL_PATH,
  MODEL_MATERIAL_FIELDS_PATH,
  MODEL_COUPLINGS_PATH,
  MODEL_OBJECT_INTERACTION_PATH,
  MODEL_GEOMETRY_CAPABILITIES_PATH,
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_MAGNETIZATION_ASSET_PATH,
  MODEL_REALIZED_REGIONS_PATH,
  MODEL_REGION_DIAGNOSTICS_PATH,
  MODEL_REGIONS_PATH,
  MODEL_SCENE_PATH,
} from "../api/apiPaths";
import type {
  DomainMetaResource,
  FdmMultilayerLayoutResource,
  GeometryDiagnosticsResource,
  GeometryCapabilitiesResource,
  GeometryValidationResource,
  CouplingListResource,
  MaterialResource,
  MaterialParameterFieldListResource,
  MagnetizationAssetResource,
  ObjectInteractionKind,
  ObjectInteractionResource,
  MeshActiveBuildResource,
  MeshBuildHistoryResource,
  MeshCapabilitiesResource,
  MeshHistogramBinElementsResource,
  MeshHistogramBinMetric,
  MeshLastSuccessfulBuildResource,
  MeshObjectConfigResource,
  MeshObjectQualityResource,
  MeshObjectReportResource,
  MeshObjectSizeFieldResource,
  MeshQualityGatesResource,
  MeshRealizedSizeFieldsResource,
  MeshRegionMembershipListResource,
  MeshRegionMembershipResource,
  FdmRegionMembershipResource,
  PendingJsonResourceResult,
  MeshRegionQualityResource,
  MeshSemanticsResource,
  MeshSharedDomainConfigResource,
  MeshSharedDomainManifestResource,
  MeshSharedDomainQualityResource,
  MeshSharedDomainReportResource,
  MeshSummaryResource,
  MeshUniverseConfigResource,
  MeshUniverseQualityResource,
  MeshUniverseReportResource,
  RegionDiagnosticsResource,
  RegionListResource,
  ResourceRevision,
  SceneResource,
} from "../api/apiTypes";
import {
  isOptionalObjectInteractionKind,
} from "../api/apiTypes";
import {
  decodeFdmRegionMembership,
  decodeFdmMultilayerActiveMask,
  FMBM_HEADER_LEN,
  validateFdmMultilayerActiveMaskContract,
  type DecodedFdmMultilayerActiveMask,
  FMRM_HEADER_LEN,
  validateFdmRegionMembershipContract,
  type DecodedFdmRegionMembership,
  type FdmRegionMembershipContractResult,
  type DecodedMeshQualityData,
  type DecodedTopology,
} from "../api/codecs";
import { ControlRoomApiError } from "../api/ControlRoomApi";
import { useKernel } from "../KernelContext";
import type { ResourceInvalidationController } from "./ResourceInvalidationController";
import {
  sharedResourceRuntimeStore,
  type ResourceRuntimeStore,
} from "./ResourceRuntimeStore";
import { ResourceCache } from "./ResourceCache";
export {
  VISUALIZATION_STATE_RESOURCE_KEY,
  resolveVisualizationStateRevision,
  useVisualizationStateResource,
} from "../visualization/useVisualizationStateResource";

import { useResource } from "./useResource";
import { sessionScopedResourceKey } from "./sessionResourceIdentity";
import { useSessionScopedResourceKey } from "./useSessionScopedResourceKey";
import type { ResourceResult, ResourceStatus } from "./resourceTypes";

interface ResourceHookOptions {
  enabled?: boolean;
  revision?: ResourceRevision | null;
}

/** Single-grid membership is incompatible with a resolved FDM multilayer plan. */
export function shouldLoadSingleGridFdmResources(
  fdmLaneActive: boolean,
  multilayerLayoutStatus: ResourceStatus,
  multilayerLayout:
    | Pick<FdmMultilayerLayoutResource, "available">
    | null
    | undefined,
): boolean {
  return (
    fdmLaneActive &&
    (multilayerLayoutStatus === "ready" || multilayerLayoutStatus === "error") &&
    multilayerLayout?.available !== true
  );
}

interface FdmMembershipBinaryResourceOptions extends ResourceHookOptions {
  expectedGenerationId?: string | null;
  expectedGridFingerprint?: string | null;
  ownerObjectId?: string | null;
}

export type FdmRegionMembershipAvailability =
  | { reason: "loading" | "not-materialized"; status: "pending" }
  | { reason: string; status: "incompatible" }
  | {
      generationId: string;
      gridFingerprint: string;
      legendFingerprint: string | null;
      status: "ready";
    };

export interface FdmRegionMembershipDescriptorResult
  extends ResourceResult<FdmRegionMembershipResource> {
  availability: FdmRegionMembershipAvailability;
}

type FdmRegionMembershipBinaryLoadResult =
  | { reason: "not-materialized"; status: "pending" }
  | Extract<FdmRegionMembershipContractResult, { status: "incompatible" }>
  | (Extract<FdmRegionMembershipContractResult, { status: "ready" }> & {
      data: DecodedFdmRegionMembership;
    });

export interface FdmRegionMembershipBinaryResult
  extends ResourceResult<DecodedFdmRegionMembership> {
  availability: FdmRegionMembershipAvailability;
}

const fdmRegionMembershipBinaryCache = new ResourceCache<DecodedFdmRegionMembership>({
  maxBytes: 128 * 1024 * 1024,
});

const fdmMultilayerActiveMaskCache =
  new ResourceCache<DecodedFdmMultilayerActiveMask>({
    maxBytes: 128 * 1024 * 1024,
  });

export const SCENE_RESOURCE_KEY = MODEL_SCENE_PATH;
export const GEOMETRY_CAPABILITIES_RESOURCE_KEY =
  MODEL_GEOMETRY_CAPABILITIES_PATH;
export const GEOMETRY_VALIDATION_RESOURCE_KEY =
  MODEL_GEOMETRY_VALIDATION_PATH;
export const GEOMETRY_DIAGNOSTICS_RESOURCE_KEY =
  MODEL_GEOMETRY_DIAGNOSTICS_PATH;
export const MESH_BUILD_CURRENT_RESOURCE_KEY = MESHING_BUILDS_CURRENT_PATH;
export const MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY =
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH;
export const MESH_SUMMARY_RESOURCE_KEY = MESHING_SUMMARY_PATH;
export const MESH_CAPABILITIES_RESOURCE_KEY = MESHING_CAPABILITIES_PATH;
export const MESH_SEMANTICS_RESOURCE_KEY = MESHING_SEMANTICS_PATH;
export const MESH_UNIVERSE_POLICY_RESOURCE_KEY =
  MESHING_UNIVERSE_POLICY_PATH;
export const MESH_UNIVERSE_REPORT_RESOURCE_KEY =
  MESHING_UNIVERSE_REPORT_PATH;
export const MESH_UNIVERSE_QUALITY_RESOURCE_KEY =
  MESHING_UNIVERSE_QUALITY_PATH;
export const MESH_SHARED_DOMAIN_MANIFEST_RESOURCE_KEY =
  MESHING_SHARED_DOMAIN_MANIFEST_PATH;
export const MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY =
  MESHING_SHARED_DOMAIN_POLICY_PATH;
export const MESH_SHARED_DOMAIN_REPORT_RESOURCE_KEY =
  MESHING_SHARED_DOMAIN_REPORT_PATH;
export const MESH_SHARED_DOMAIN_QUALITY_RESOURCE_KEY =
  MESHING_SHARED_DOMAIN_QUALITY_PATH;
export const MESH_SHARED_DOMAIN_QUALITY_DATA_RESOURCE_KEY =
  MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH;
export const MESH_SHARED_DOMAIN_TOPOLOGY_RESOURCE_KEY =
  MESHING_SHARED_DOMAIN_TOPOLOGY_PATH;
export const MESH_SHARED_DOMAIN_QUALITY_GATES_RESOURCE_KEY =
  MESHING_SHARED_DOMAIN_QUALITY_GATES_PATH;
export const MESH_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_RESOURCE_KEY =
  MESHING_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_PATH;

/** Invalidate every resource published by an FDM grid/membership replan. */
export function invalidateFdmGridResources(
  resources: Pick<ResourceInvalidationController, "invalidate">,
  revision: ResourceRevision,
): void {
  for (const resourceKey of [
    MESHING_BUILDS_PATH,
    MESHING_BUILDS_CURRENT_PATH,
    MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
    MESHING_SUMMARY_PATH,
    MESHING_SEMANTICS_PATH,
    MESHING_SHARED_DOMAIN_MANIFEST_PATH,
    MESHING_SHARED_DOMAIN_REPORT_PATH,
    MESHING_SHARED_DOMAIN_QUALITY_PATH,
    MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH,
    MESHING_SHARED_DOMAIN_QUALITY_GATES_PATH,
    MESHING_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_PATH,
  ]) {
    resources.invalidate(resourceKey, revision);
  }
}

export const FDM_REGION_MEMBERSHIPS_RESOURCE_KEY =
  DATA_FDM_REGION_MEMBERSHIPS_PATH;
export const FDM_REGION_MEMBERSHIP_BINARY_RESOURCE_KEY =
  DATA_FDM_REGION_MEMBERSHIP_BINARY_PATH;
export const resolveFdmRegionMembershipBinaryResourceKey = (
  regionId?: string | null,
  revision?: ResourceRevision | null,
  ownerObjectId?: string | null,
) => {
  const baseKey = regionId
    ? ownerObjectId
      ? `${DATA_FDM_REGION_MEMBERSHIP_SCOPED_PATH}:owner:${encodeURIComponent(ownerObjectId)}:region:${encodeURIComponent(regionId)}`
      : `${DATA_FDM_REGION_MEMBERSHIP_SCOPED_PATH}:${encodeURIComponent(regionId)}`
    : DATA_FDM_REGION_MEMBERSHIP_BINARY_PATH;
  return revision == null
    ? baseKey
    : `${baseKey}#revision=${encodeURIComponent(String(revision))}`;
};
export const meshRegionMembershipResourceKey = (
  ownerObjectId: string,
  regionId: string,
) =>
  `${DATA_MESH_REGION_MEMBERSHIP_PATH}:owner:${encodeURIComponent(ownerObjectId)}:region:${encodeURIComponent(regionId)}`;
export const resolveMeshRegionMembershipsResourceKey = (
  regionIds: readonly string[],
) => {
  const encodedIds = normalizeMeshRegionMembershipIds(regionIds).map((regionId) =>
    encodeURIComponent(regionId),
  );
  return `${DATA_MESH_REGION_MEMBERSHIP_PATH}:batch:${
    encodedIds.length > 0 ? encodedIds.join("|") : "none"
  }`;
};
export const MESH_REGION_MEMBERSHIPS_RESOURCE_KEY =
  DATA_MESH_REGION_MEMBERSHIPS_PATH;
export const MODEL_REGIONS_RESOURCE_KEY = MODEL_REGIONS_PATH;
export const MODEL_REALIZED_REGIONS_RESOURCE_KEY =
  MODEL_REALIZED_REGIONS_PATH;
export const MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY =
  MODEL_REGION_DIAGNOSTICS_PATH;
export const MODEL_MATERIAL_FIELDS_RESOURCE_KEY = MODEL_MATERIAL_FIELDS_PATH;
export const MODEL_COUPLINGS_RESOURCE_KEY = MODEL_COUPLINGS_PATH;
export const MESH_BUILD_HISTORY_RESOURCE_KEY = MESHING_BUILDS_PATH;

export interface MeshHistogramBinElementsQuery {
  binIndex: number;
  meshId: string;
  metric: MeshHistogramBinMetric;
  partId: string;
}

export function resolveMeshHistogramBinElementsResourceKey(
  query: MeshHistogramBinElementsQuery,
): string {
  return MESHING_HISTOGRAM_BIN_ELEMENTS_PATH.replace(
    "{mesh_id}",
    encodeURIComponent(query.meshId),
  )
    .replace("{part_id}", encodeURIComponent(query.partId))
    .replace("{metric}", encodeURIComponent(query.metric))
    .replace("{bin_index}", encodeURIComponent(String(query.binIndex)));
}

export function resolveObjectTopologyResourceKey(objectId: string): string {
  return MESHING_OBJECT_TOPOLOGY_PATH.replace(
    "{object_id}",
    encodeURIComponent(objectId),
  );
}

export function resolveObjectMeshReportResourceKey(objectId: string): string {
  return MESHING_OBJECT_REPORT_PATH.replace(
    "{object_id}",
    encodeURIComponent(objectId),
  );
}

export function resolveObjectMeshQualityResourceKey(objectId: string): string {
  return MESHING_OBJECT_QUALITY_PATH.replace(
    "{object_id}",
    encodeURIComponent(objectId),
  );
}

export function resolveMeshRegionQualityResourceKey(regionId: string): string {
  return MESHING_REGION_QUALITY_PATH.replace(
    "{region_id}",
    encodeURIComponent(regionId),
  );
}

export function resolveObjectMeshPolicyResourceKey(objectId: string): string {
  return MESHING_OBJECT_POLICY_PATH.replace(
    "{object_id}",
    encodeURIComponent(objectId),
  );
}

export function resolveObjectInteractionResourceKey(
  objectId: string,
  interactionKind: ObjectInteractionKind,
): string {
  return MODEL_OBJECT_INTERACTION_PATH.replace(
    "{object_id}",
    encodeURIComponent(objectId),
  ).replace("{interaction_kind}", interactionKind);
}

export function resolveMaterialResourceKey(materialId: string): string {
  return MODEL_MATERIAL_PATH.replace(
    "{material_id}",
    encodeURIComponent(materialId),
  );
}

export function resolveMagnetizationAssetResourceKey(assetId: string): string {
  return MODEL_MAGNETIZATION_ASSET_PATH.replace(
    "{asset_id}",
    encodeURIComponent(assetId),
  );
}

export function resolveSceneResourceRevision(
  scene: SceneResource | null | undefined,
): ResourceRevision | null {
  return (
    resolveRevisionProperty(scene, "revision") ??
    resolveRevisionProperty(scene, "scene_revision")
  );
}

export function resolveJsonResourceRevision(
  data: unknown,
): ResourceRevision | null {
  return resolveRevisionProperty(data, "revision");
}

export function resolveRegionCoefficientsRevision(
  data: { region_coefficients_revision?: number | null } | null | undefined,
): ResourceRevision | null {
  return data?.region_coefficients_revision ?? null;
}

export function resolveMagnetizationAssetResourceRevision(
  data:
    | {
        scene_revision?: number | null;
        region_initial_state_revision?: number | null;
      }
    | null
    | undefined,
): ResourceRevision | null {
  if (!data) return null;
  const sceneRevision = data.scene_revision ?? null;
  const initialStateRevision = data.region_initial_state_revision ?? null;
  if (sceneRevision === null && initialStateRevision === null) return null;
  return `${sceneRevision ?? "unknown"}:${initialStateRevision ?? "unknown"}`;
}

export function resolveRegionRealizationRevision(
  data:
    | {
        region_topology_revision?: number | null;
        region_membership_revision?: number | null;
        region_coefficients_revision?: number | null;
        region_initial_state_revision?: number | null;
      }
    | null
    | undefined,
): ResourceRevision | null {
  if (!data) return null;
  const revisions = [
    data.region_topology_revision,
    data.region_membership_revision,
    data.region_coefficients_revision,
    data.region_initial_state_revision,
  ];
  return revisions.some((revision) => revision !== null && revision !== undefined)
    ? revisions.map((revision) => revision ?? "unknown").join(":")
    : null;
}

export function resolveMeshSharedDomainManifestRevision(
  manifest: MeshSharedDomainManifestResource | null | undefined,
): ResourceRevision | null {
  const revision = resolveJsonResourceRevision(manifest);
  if (revision === null) return null;

  return [
    revision,
    manifest?.source_scene_revision ?? "unknown",
    manifest?.geometry_realization_revision ?? "unknown",
  ].join(":");
}

export function resolveFdmRegionMembershipRevision(
  resource: FdmRegionMembershipResource | null | undefined,
): ResourceRevision | null {
  if (!resource) return null;
  return [
    resource.schema_version,
    resource.domain_generation_id,
    resource.mesh_revision,
    resource.region_membership_revision,
    resource.grid_fingerprint,
    resource.region_legend_fingerprint ?? "unknown",
  ].join(":");
}

/**
 * Stable identity for the domain presentation adapter. The generation id
 * anchors the structured grid while the optional realized-resource suffix
 * identifies the current FDM mask or FEM shared-domain manifest.
 */
export function resolveDomainPresentationRevision(
  domain: DomainMetaResource | null | undefined,
  options: {
    fdmMembership?: FdmRegionMembershipResource | null;
    femManifest?: MeshSharedDomainManifestResource | null;
  } = {},
): ResourceRevision | null {
  if (!domain) return null;
  if (domain.discretization.toLowerCase() === "fdm") {
    const membershipRevision = resolveFdmRegionMembershipRevision(
      options.fdmMembership,
    );
    return membershipRevision == null
      ? domain.generation_id
      : `${domain.generation_id}:${membershipRevision}`;
  }
  const manifestRevision = resolveMeshSharedDomainManifestRevision(
    options.femManifest,
  );
  return manifestRevision == null
    ? domain.generation_id
    : `${domain.generation_id}:${manifestRevision}`;
}

export function resolveMeshRegionMembershipRevision(
  membership: MeshRegionMembershipResource | null | undefined,
): ResourceRevision | null {
  if (!membership) return null;
  return [
    membership.mesh_id,
    membership.mesh_revision,
    membership.region_membership_revision,
    membership.owner_object_id,
    membership.region_id,
    membership.source,
  ].join(":");
}

export function resolveMeshRegionMembershipsRevision(
  memberships: readonly MeshRegionMembershipResource[] | null | undefined,
): ResourceRevision | null {
  if (!memberships || memberships.length === 0) return null;
  return memberships
    .flatMap((membership) => {
      const revision = resolveMeshRegionMembershipRevision(membership);
      return revision === null ? [] : [revision];
    })
    .sort()
    .join("|");
}

export function resolveMeshRegionMembershipListRevision(
  resource: MeshRegionMembershipListResource | null | undefined,
): ResourceRevision | null {
  if (!resource) return null;
  const membershipsRevision = resolveMeshRegionMembershipsRevision(
    resource.memberships,
  );
  return [
    resource.mesh_id,
    resource.mesh_revision,
    membershipsRevision ?? "empty",
    (resource.unresolved_regions ?? [])
      .map((region) => `${region.owner_object_id}\u0000${region.region_id}`)
      .toSorted()
      .join(","),
  ].join(":");
}

export function publishCommittedSceneResource(
  resources: ResourceInvalidationController,
  scene: SceneResource,
  revision: ResourceRevision,
  runtimeStore: ResourceRuntimeStore<SceneResource> =
    sharedResourceRuntimeStore as ResourceRuntimeStore<SceneResource>,
  invalidate = true,
  sessionScopeKey?: string | null,
): void {
  runtimeStore.updateData(SCENE_RESOURCE_KEY, scene, revision);
  // A response without an owner may update the legacy alias, but it must not
  // become the in-memory value for an arbitrary session. Canonical invalidation
  // fans out to observed scoped subscribers so each owner can refetch safely.
  if (sessionScopeKey) {
    runtimeStore.updateData(
      `${sessionScopeKey}|${SCENE_RESOURCE_KEY}`,
      scene,
      revision,
    );
  }
  if (invalidate) {
    if (sessionScopeKey) {
      resources.invalidate(
        `${sessionScopeKey}|${SCENE_RESOURCE_KEY}`,
        revision,
      );
    } else {
      resources.invalidate(SCENE_RESOURCE_KEY, revision);
    }
  }
}

export function useSceneResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    SCENE_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => api.model.scene({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<SceneResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveSceneResourceRevision,
    resourceKey,
  });
}

export function useGeometryDiagnosticsResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    GEOMETRY_DIAGNOSTICS_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.model.geometry.diagnostics({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<GeometryDiagnosticsResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useGeometryCapabilitiesResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    GEOMETRY_CAPABILITIES_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.model.geometry.capabilities({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<GeometryCapabilitiesResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useGeometryValidationResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    GEOMETRY_VALIDATION_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.model.geometry.validation({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<GeometryValidationResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveSceneResourceRevision,
    resourceKey,
  });
}

export function useMaterialResource(materialId: string | null | undefined) {
  const { api } = useKernel();
  const unscopedResourceKey = materialId
    ? resolveMaterialResourceKey(materialId)
    : MODEL_MATERIAL_PATH;
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    unscopedResourceKey,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => {
      if (!materialId) return Promise.resolve(null);
      return api.model.material(materialId, { sessionScopeKey, signal });
    },
    [api, materialId],
  );

  return useResource<MaterialResource | null>({
    enabled: Boolean(materialId) && sessionIdentity !== null,
    load,
    resolveRevision: resolveRegionCoefficientsRevision,
    resourceKey,
  });
}

export function useMagnetizationAssetResource(
  assetId: string | null | undefined,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const unscopedResourceKey = assetId
    ? resolveMagnetizationAssetResourceKey(assetId)
    : MODEL_MAGNETIZATION_ASSET_PATH;
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    unscopedResourceKey,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => {
      if (!assetId) return Promise.resolve(null);
      return api.model.magnetizationAsset(assetId, { sessionScopeKey, signal });
    },
    [api, assetId],
  );

  return useResource<MagnetizationAssetResource | null>({
    enabled:
      options.enabled !== false &&
      Boolean(assetId) &&
      sessionIdentity !== null,
    load,
    resolveRevision: resolveMagnetizationAssetResourceRevision,
    resourceKey,
  });
}

export function useModelRegionsResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MODEL_REGIONS_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => api.model.regions({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<RegionListResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveRegionRealizationRevision,
    resourceKey,
  });
}

export function useModelRealizedRegionsResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MODEL_REALIZED_REGIONS_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.model.realizedRegions({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<RegionListResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveRegionRealizationRevision,
    resourceKey,
  });
}

export function useModelRegionDiagnosticsResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.model.regionDiagnostics({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<RegionDiagnosticsResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveRegionRealizationRevision,
    resourceKey,
  });
}

export function useModelMaterialFieldsResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MODEL_MATERIAL_FIELDS_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.model.materialFields({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<MaterialParameterFieldListResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveRegionCoefficientsRevision,
    resourceKey,
  });
}

export function useModelCouplingsResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MODEL_COUPLINGS_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => api.model.couplings({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<CouplingListResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: (data) => data?.scene_revision ?? null,
    resourceKey,
  });
}

export function useMeshBuildCurrent(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MESH_BUILD_CURRENT_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.meshing.builds.current({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<MeshActiveBuildResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useMeshBuildLatestSuccessful(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.meshing.builds.latestSuccessful({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<MeshLastSuccessfulBuildResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useMeshBuildHistoryResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MESH_BUILD_HISTORY_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.meshing.builds.history({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<MeshBuildHistoryResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useMeshSummaryResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MESH_SUMMARY_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => api.meshing.summary({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<MeshSummaryResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useMeshCapabilitiesResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MESH_CAPABILITIES_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.meshing.capabilities({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<MeshCapabilitiesResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useMeshSemanticsResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MESH_SEMANTICS_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.meshing.semantics({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<MeshSemanticsResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useMeshSharedDomainManifestResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MESH_SHARED_DOMAIN_MANIFEST_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.meshing.sharedDomain.manifest({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<MeshSharedDomainManifestResource | null>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveMeshSharedDomainManifestRevision,
    resourceKey,
  });
}

export function useMeshSharedDomainPolicyResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.meshing.sharedDomain.policy({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<MeshSharedDomainConfigResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useMeshSharedDomainReportResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MESH_SHARED_DOMAIN_REPORT_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.meshing.sharedDomain.report({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<MeshSharedDomainReportResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useMeshSharedDomainQualityResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MESH_SHARED_DOMAIN_QUALITY_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.meshing.sharedDomain.quality({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<MeshSharedDomainQualityResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useMeshSharedDomainQualityDataResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MESH_SHARED_DOMAIN_QUALITY_DATA_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.meshing.sharedDomain.qualityData({ sessionScopeKey, signal }).then((result) => {
        if (result.status === "ready") return result.data;
        return null;
      }),
    [api],
  );

  return useResource<DecodedMeshQualityData | null>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resourceKey,
  });
}

export function useMeshSharedDomainTopologyResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MESH_SHARED_DOMAIN_TOPOLOGY_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.meshing.sharedDomain.topology({ sessionScopeKey, signal }).then((result) => {
        if (result.status === "ready") return result.data;
        return null;
      }),
    [api],
  );

  return useResource<DecodedTopology | null>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resourceKey,
  });
}

export function useMeshHistogramBinElementsResource(
  query: MeshHistogramBinElementsQuery | null,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const unscopedResourceKey = query
    ? resolveMeshHistogramBinElementsResourceKey(query)
    : `${MESHING_HISTOGRAM_BIN_ELEMENTS_PATH}:none`;
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    unscopedResourceKey,
  );
  const enabled =
    options.enabled !== false &&
    query !== null &&
    sessionIdentity !== null;
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      query
        ? api.meshing.histogramBinElements(query, { sessionScopeKey, signal })
        : Promise.resolve(null),
    [api, query],
  );

  return useResource<MeshHistogramBinElementsResource | null>({
    enabled,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useMeshSharedDomainQualityGatesResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MESH_SHARED_DOMAIN_QUALITY_GATES_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.meshing.sharedDomain.qualityGates({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<MeshQualityGatesResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useMeshSharedDomainRealizedSizeFieldsResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MESH_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.meshing.sharedDomain.realizedSizeFields({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<MeshRealizedSizeFieldsResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useMeshRegionMembershipResource(
  ownerObjectId: string | null | undefined,
  regionId: string | null | undefined,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const unscopedResourceKey = ownerObjectId && regionId
    ? meshRegionMembershipResourceKey(ownerObjectId, regionId)
    : `${DATA_MESH_REGION_MEMBERSHIP_PATH}:none`;
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    unscopedResourceKey,
  );
  const enabled =
    options.enabled !== false &&
    Boolean(ownerObjectId && regionId) &&
    sessionIdentity !== null;
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      ownerObjectId && regionId
        ? api.data.meshRegionMembership(ownerObjectId, regionId, { sessionScopeKey, signal })
        : Promise.resolve(null),
    [api, ownerObjectId, regionId],
  );

  return useResource<MeshRegionMembershipResource | null>({
    enabled,
    load,
    resolveRevision: resolveMeshRegionMembershipRevision,
    resourceKey,
  });
}

export function useMeshRegionMembershipsResource(
  regionIds: readonly string[],
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const normalizedRegionIds = useMemo(
    () => normalizeMeshRegionMembershipIds(regionIds),
    [regionIds],
  );
  const unscopedResourceKey = resolveMeshRegionMembershipsResourceKey(
    normalizedRegionIds,
  );
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    unscopedResourceKey,
  );
  const enabled =
    options.enabled !== false &&
    normalizedRegionIds.length > 0 &&
    sessionIdentity !== null;
  const load = useCallback(
    async ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => {
      if (normalizedRegionIds.length === 0) return [];
      const regionIdSet = new Set(normalizedRegionIds);
      const memberships = await api.data.meshRegionMemberships({ sessionScopeKey, signal });
      return memberships.memberships.filter((membership) =>
        regionIdSet.has(membership.region_id),
      );
    },
    [api, normalizedRegionIds],
  );

  return useResource<readonly MeshRegionMembershipResource[]>({
    enabled,
    load,
    resolveRevision: resolveMeshRegionMembershipsRevision,
    resourceKey,
  });
}

export function useFdmRegionMembershipResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    FDM_REGION_MEMBERSHIPS_RESOURCE_KEY,
  );
  const multilayerLayout = useFdmMultilayerLayoutResource({
    enabled: options.enabled,
  });
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.data.fdmRegionMemberships({ sessionScopeKey, signal }),
    [api],
  );

  const resource = useResource<PendingJsonResourceResult<FdmRegionMembershipResource>>({
    enabled: shouldLoadSingleGridFdmResources(
      options.enabled === true,
      multilayerLayout.status,
      multilayerLayout.data,
    ) && sessionIdentity !== null,
    load,
    resolveRevision: (result) =>
      result.status === "ready"
        ? resolveFdmRegionMembershipRevision(result.data)
        : null,
    resourceKey,
  });

  return resolveFdmRegionMembershipDescriptorResult(resource);
}

export function resolveFdmRegionMembershipDescriptorResult(
  resource: ResourceResult<PendingJsonResourceResult<FdmRegionMembershipResource>>,
): FdmRegionMembershipDescriptorResult {
  if (resource.error || resource.status === "error") {
    return {
      ...resource,
      availability: { reason: "request-error", status: "incompatible" },
      data: null,
    };
  }
  if (resource.status !== "ready") {
    return {
      ...resource,
      availability: { reason: "loading", status: "pending" },
      data: null,
    };
  }
  if (!resource.data) {
    return {
      ...resource,
      availability: { reason: "loading", status: "pending" },
      data: null,
    };
  }
  if (resource.data.status === "pending") {
    return {
      ...resource,
      availability: { reason: "not-materialized", status: "pending" },
      data: null,
    };
  }
  if (resource.data.data.freshness.trim().toLowerCase() !== "current") {
    return {
      ...resource,
      availability: { reason: "stale-descriptor", status: "incompatible" },
      data: null,
    };
  }
  return {
    ...resource,
    availability: {
      generationId: resource.data.data.domain_generation_id,
      gridFingerprint: resource.data.data.grid_fingerprint,
      legendFingerprint: resource.data.data.region_legend_fingerprint ?? null,
      status: "ready",
    },
    data: resource.data.data,
  };
}

function resolveDomainMetaRevision(meta: DomainMetaResource | null): ResourceRevision | null {
  return meta?.generation_id ?? null;
}

/** Shared DomainMeta ownership for Explorer and other non-viewport consumers. */
export function useDomainMetaResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    DATA_DOMAIN_META_PATH,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => api.data.domain.meta({ sessionScopeKey, signal }),
    [api],
  );
  return useResource<DomainMetaResource | null>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveDomainMetaRevision,
    resourceKey,
  });
}

function resolveFdmMultilayerLayoutRevision(
  layout: FdmMultilayerLayoutResource | null,
): ResourceRevision | null {
  if (!layout) return null;
  return `${layout.layout_revision}:${layout.layout_fingerprint ?? "unfingerprinted"}`;
}

/** Native per-layer carriers and the common FFT scratch layout. */
export function useFdmMultilayerLayoutResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    DATA_DOMAIN_FDM_MULTILAYER_LAYOUT_PATH,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.data.domain.fdmMultilayerLayout({ sessionScopeKey, signal }),
    [api],
  );
  return useResource<FdmMultilayerLayoutResource | null>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveFdmMultilayerLayoutRevision,
    resourceKey,
  });
}

export interface FdmMultilayerLayerActiveMasksData {
  incompatibleLayerIds: readonly string[];
  masks: ReadonlyMap<string, DecodedFdmMultilayerActiveMask>;
}

function fdmMultilayerLayerActiveMaskResourceKey(
  layerId: string,
  layoutRevision: ResourceRevision,
  maskHash: string,
): string {
  return `${DATA_DOMAIN_FDM_MULTILAYER_LAYER_ACTIVE_MASK_PATH}:${encodeURIComponent(layerId)}#layout=${encodeURIComponent(String(layoutRevision))}:mask=${encodeURIComponent(maskHash)}`;
}

/** Loads only the optional native masks declared by the revisioned layout. */
export function useFdmMultilayerLayerActiveMasksResource(
  layout: FdmMultilayerLayoutResource | null | undefined,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const maskedLayers = useMemo(
    () =>
      layout?.available
        ? layout.layers.filter((layer) => layer.active_mask_present)
        : [],
    [layout],
  );
  const unscopedResourceKey = useMemo(
    () =>
      `${DATA_DOMAIN_FDM_MULTILAYER_LAYER_ACTIVE_MASK_PATH}:layout:${layout?.layout_revision ?? "none"}:${maskedLayers.map((layer) => `${layer.layer_id}:${layer.active_mask_hash ?? "missing"}`).join("|")}`,
    [layout?.layout_revision, maskedLayers],
  );
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    unscopedResourceKey,
  );
  const load = useCallback(
    async ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => {
      if (!layout?.available) {
        return {
          incompatibleLayerIds: [] as string[],
          masks: new Map<string, DecodedFdmMultilayerActiveMask>(),
        };
      }
      const masks = new Map<string, DecodedFdmMultilayerActiveMask>();
      const incompatibleLayerIds: string[] = [];
      await Promise.all(
        maskedLayers.map(async (layer) => {
          if (!layer.mask_ref || !layer.active_mask_hash) {
            incompatibleLayerIds.push(layer.layer_id);
            return;
          }
          const unscopedCacheKey = fdmMultilayerLayerActiveMaskResourceKey(
            layer.layer_id,
            layout.layout_revision,
            layer.active_mask_hash,
          );
          const cacheKey = sessionIdentity
            ? sessionScopedResourceKey(sessionIdentity, unscopedCacheKey)
            : unscopedCacheKey;
          const cached = fdmMultilayerActiveMaskCache.peek(cacheKey);
          const response = await api.data.domain.fdmMultilayerLayerActiveMaskBytes(
            layer.layer_id,
            { etag: cached?.etag, sessionScopeKey, signal },
          );
          let decoded: DecodedFdmMultilayerActiveMask;
          if (response.status === "not-modified") {
            if (!cached) {
              incompatibleLayerIds.push(layer.layer_id);
              return;
            }
            decoded = cached.data;
          } else if (response.status === "ready") {
            decoded = decodeFdmMultilayerActiveMask(response.data);
          } else {
            incompatibleLayerIds.push(layer.layer_id);
            fdmMultilayerActiveMaskCache.delete(cacheKey);
            return;
          }
          const contract = await validateFdmMultilayerActiveMaskContract(
            decoded,
            layout,
            layer,
          );
          if (contract.status !== "ready") {
            incompatibleLayerIds.push(layer.layer_id);
            fdmMultilayerActiveMaskCache.delete(cacheKey);
            return;
          }
          fdmMultilayerActiveMaskCache.set(cacheKey, {
            byteLength:
              response.status === "ready"
                ? response.byteLength
                : decoded.packedMask.byteLength + FMBM_HEADER_LEN,
            data: decoded,
            etag: response.etag ?? cached?.etag ?? null,
          });
          masks.set(layer.layer_id, decoded);
        }),
      );
      return { incompatibleLayerIds, masks };
    },
    [api, layout, maskedLayers, sessionIdentity],
  );
  return useResource<FdmMultilayerLayerActiveMasksData>({
    abortStaleInflight: true,
    enabled:
      options.enabled !== false &&
      Boolean(layout?.available) &&
      maskedLayers.length > 0 &&
      sessionIdentity !== null,
    load,
    resolveRevision: () => layout?.layout_revision ?? null,
    resourceKey,
  });
}

export function useFdmRegionMembershipBinaryResource(
  regionId?: string | null,
  options: FdmMembershipBinaryResourceOptions = {},
) {
  const { api } = useKernel();
  const descriptor = useFdmRegionMembershipResource({ enabled: options.enabled });
  const domain = useDomainMetaResource({ enabled: options.enabled });
  const normalizedRegionId = regionId?.trim() || null;
  const normalizedOwnerObjectId = options.ownerObjectId?.trim() || null;
  const contractRevision =
    descriptor.data && domain.data
      ? [
          domain.data.generation_id,
          resolveFdmRegionMembershipRevision(descriptor.data),
          options.expectedGenerationId ?? "current",
          options.expectedGridFingerprint ?? "descriptor",
        ].join(":")
      : options.revision;
  const unscopedResourceKey = resolveFdmRegionMembershipBinaryResourceKey(
    normalizedRegionId,
    contractRevision,
    normalizedOwnerObjectId,
  );
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    unscopedResourceKey,
  );
  const prerequisite: FdmRegionMembershipAvailability =
    descriptor.availability.status !== "ready"
      ? descriptor.availability
      : domain.status !== "ready" || !domain.data
        ? { reason: "loading", status: "pending" }
        : descriptor.data?.domain_generation_id !== domain.data.generation_id
          ? { reason: "generation-mismatch", status: "incompatible" }
          : options.expectedGenerationId != null &&
            options.expectedGenerationId !== domain.data.generation_id
          ? { reason: "generation-mismatch", status: "incompatible" }
          : options.expectedGridFingerprint != null &&
              options.expectedGridFingerprint !== descriptor.data?.grid_fingerprint
            ? { reason: "grid-fingerprint-mismatch", status: "incompatible" }
            : {
                generationId: domain.data.generation_id,
                gridFingerprint: descriptor.data?.grid_fingerprint ?? "",
                legendFingerprint:
                  descriptor.data?.region_legend_fingerprint ?? null,
                status: "ready",
              };
  const contractReady = prerequisite.status === "ready";
  const load = useCallback(
    async ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => {
      if (!descriptor.data || !domain.data) {
        return { reason: "not-materialized", status: "pending" } as const;
      }
      const cached = fdmRegionMembershipBinaryCache.peek(resourceKey);
      const result = await (normalizedRegionId
        ? api.data.fdmRegionMembershipRegionBytes(normalizedOwnerObjectId, normalizedRegionId, {
            etag: cached?.etag,
            sessionScopeKey,
            signal,
          })
        : api.data.fdmRegionMembershipBytes({
            etag: cached?.etag,
            sessionScopeKey,
            signal,
          }));

      if (result.status === "not-applicable") {
        fdmRegionMembershipBinaryCache.delete(resourceKey);
        return { reason: "not-materialized", status: "pending" } as const;
      }
      let decoded: DecodedFdmRegionMembership;
      if (result.status === "not-modified") {
        if (!cached) {
          throw new Error(
            `FDM region membership ${resourceKey} returned 304 without cache entry`,
          );
        }
        decoded = cached.data;
      } else {
        decoded = decodeFdmRegionMembership(result.data);
      }

      const contract = await validateFdmRegionMembershipContract(
        decoded,
        descriptor.data,
        domain.data,
        {
          expectedGenerationId: options.expectedGenerationId,
          expectedGridFingerprint: options.expectedGridFingerprint,
        },
      );
      if (contract.status === "incompatible") {
        fdmRegionMembershipBinaryCache.delete(resourceKey);
        return contract;
      }
      fdmRegionMembershipBinaryCache.set(resourceKey, {
        byteLength:
          result.status === "ready"
            ? result.byteLength
            : decoded.regionIds.byteLength + FMRM_HEADER_LEN,
        data: decoded,
        etag: result.etag ?? cached?.etag ?? null,
      });
      return { ...contract, data: decoded };
    },
    [
      api,
      descriptor.data,
      domain.data,
      normalizedRegionId,
      normalizedOwnerObjectId,
      options.expectedGenerationId,
      options.expectedGridFingerprint,
      resourceKey,
    ],
  );
  const resolveRevision = useCallback(
    () => fdmRegionMembershipBinaryCache.peek(resourceKey)?.etag ?? null,
    [resourceKey],
  );

  const resource = useResource<FdmRegionMembershipBinaryLoadResult>({
    abortStaleInflight: true,
    enabled:
      options.enabled !== false &&
      contractReady &&
      sessionIdentity !== null,
    load,
    resolveRevision,
    resourceKey,
  });

  return resolveFdmRegionMembershipBinaryResult(
    resource,
    prerequisite,
  );
}

export function resolveFdmRegionMembershipBinaryResult(
  resource: ResourceResult<FdmRegionMembershipBinaryLoadResult>,
  prerequisite: FdmRegionMembershipAvailability,
): FdmRegionMembershipBinaryResult {
  if (prerequisite.status !== "ready") {
    return { ...resource, availability: prerequisite, data: null };
  }
  if (resource.error || resource.status === "error") {
    return {
      ...resource,
      availability: { reason: "request-error", status: "incompatible" },
      data: null,
    };
  }
  if (!resource.data) {
    return {
      ...resource,
      availability: { reason: "loading", status: "pending" },
      data: null,
    };
  }
  if (resource.data.status !== "ready") {
    return { ...resource, availability: resource.data, data: null };
  }
  return {
    ...resource,
    availability: {
      generationId: resource.data.generationId,
      gridFingerprint: resource.data.gridFingerprint,
      legendFingerprint: resource.data.legendFingerprint,
      status: "ready",
    },
    data: resource.data.data,
  };
}

function normalizeMeshRegionMembershipIds(regionIds: readonly string[]): string[] {
  return Array.from(
    new Set(regionIds.filter((regionId) => regionId.length > 0)),
  ).toSorted();
}

export function useMeshUniverseReportResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MESH_UNIVERSE_REPORT_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.meshing.universeReport({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<MeshUniverseReportResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useMeshUniverseQualityResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MESH_UNIVERSE_QUALITY_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.meshing.universeQuality({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<MeshUniverseQualityResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useObjectTopologyResource(
  objectId: string | null | undefined,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const unscopedResourceKey = objectId
    ? resolveObjectTopologyResourceKey(objectId)
    : MESHING_OBJECT_TOPOLOGY_PATH;
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    unscopedResourceKey,
  );
  const enabled =
    options.enabled !== false &&
    Boolean(objectId) &&
    sessionIdentity !== null;
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => {
      if (!objectId) return Promise.resolve(null);
      return api.meshing.objectTopology(objectId, { sessionScopeKey, signal }).then((result) => {
        if (result.status === "ready") return result.data;
        return null;
      });
    },
    [api, objectId],
  );

  return useResource<DecodedTopology | null>({
    enabled,
    load,
    resourceKey,
  });
}

export function useObjectMeshReportResource(
  objectId: string | null | undefined,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const unscopedResourceKey = objectId
    ? resolveObjectMeshReportResourceKey(objectId)
    : MESHING_OBJECT_REPORT_PATH;
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    unscopedResourceKey,
  );
  const enabled =
    options.enabled !== false &&
    Boolean(objectId) &&
    sessionIdentity !== null;
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => {
      if (!objectId) return Promise.resolve(null);
      return api.meshing.objectReport(objectId, { sessionScopeKey, signal });
    },
    [api, objectId],
  );

  return useResource<MeshObjectReportResource | null>({
    enabled,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useObjectMeshQualityResource(
  objectId: string | null | undefined,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const unscopedResourceKey = objectId
    ? resolveObjectMeshQualityResourceKey(objectId)
    : MESHING_OBJECT_QUALITY_PATH;
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    unscopedResourceKey,
  );
  const enabled =
    options.enabled !== false &&
    Boolean(objectId) &&
    sessionIdentity !== null;
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => {
      if (!objectId) return Promise.resolve(null);
      return api.meshing.objectQuality(objectId, { sessionScopeKey, signal });
    },
    [api, objectId],
  );

  return useResource<MeshObjectQualityResource | null>({
    enabled,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useMeshRegionQualityResource(
  regionId: string | null | undefined,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const unscopedResourceKey = regionId
    ? resolveMeshRegionQualityResourceKey(regionId)
    : MESHING_REGION_QUALITY_PATH;
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    unscopedResourceKey,
  );
  const enabled =
    options.enabled !== false &&
    Boolean(regionId) &&
    sessionIdentity !== null;
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => {
      if (!regionId) return Promise.resolve(null);
      return api.meshing.regionQuality(regionId, { sessionScopeKey, signal });
    },
    [api, regionId],
  );

  return useResource<MeshRegionQualityResource | null>({
    enabled,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useObjectMeshSizeFieldResource(
  objectId: string | null | undefined,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const unscopedResourceKey = objectId
    ? MESHING_OBJECT_SIZE_FIELD_PATH.replace(
        "{object_id}",
        encodeURIComponent(objectId),
      )
    : MESHING_OBJECT_SIZE_FIELD_PATH;
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    unscopedResourceKey,
  );
  const enabled =
    options.enabled !== false &&
    Boolean(objectId) &&
    sessionIdentity !== null;
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => {
      if (!objectId) return Promise.resolve(null);
      return api.meshing.objectSizeField(objectId, { sessionScopeKey, signal });
    },
    [api, objectId],
  );

  return useResource<MeshObjectSizeFieldResource | null>({
    enabled,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useObjectMeshPolicyResource(
  objectId: string | null | undefined,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const unscopedResourceKey = objectId
    ? resolveObjectMeshPolicyResourceKey(objectId)
    : MESHING_OBJECT_POLICY_PATH;
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    unscopedResourceKey,
  );
  const enabled =
    options.enabled !== false &&
    Boolean(objectId) &&
    sessionIdentity !== null;
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => {
      if (!objectId) return Promise.resolve(defaultObjectMeshPolicyResource(""));
      return api.meshing.objectPolicy(objectId, { sessionScopeKey, signal });
    },
    [api, objectId],
  );

  return useResource<MeshObjectConfigResource>({
    enabled,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useUniverseMeshPolicyResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MESH_UNIVERSE_POLICY_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.meshing.universePolicy({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<MeshUniverseConfigResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useObjectInteractionResource(
  objectId: string | null | undefined,
  interactionKind: ObjectInteractionKind,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const unscopedResourceKey = objectId
    ? resolveObjectInteractionResourceKey(objectId, interactionKind)
    : MODEL_OBJECT_INTERACTION_PATH;
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    unscopedResourceKey,
  );
  const load = useCallback(
    async ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => {
      if (!objectId) {
        return defaultObjectInteractionResource("", interactionKind);
      }

      try {
        return await api.model.objectInteraction(objectId, interactionKind, {
          sessionScopeKey,
          signal,
        });
      } catch (error) {
        if (
          error instanceof ControlRoomApiError &&
          error.status === 404 &&
          isOptionalObjectInteractionKind(interactionKind)
        ) {
          return defaultObjectInteractionResource(objectId, interactionKind);
        }
        throw error;
      }
    },
    [api, interactionKind, objectId],
  );

  return useResource<ObjectInteractionResource>({
    enabled:
      options.enabled !== false &&
      Boolean(objectId) &&
      sessionIdentity !== null,
    load,
    resourceKey,
  });
}

export function defaultObjectMeshPolicyResource(
  objectId: string,
): MeshObjectConfigResource {
  return {
    config: null,
    effective_config: null,
    object_id: objectId,
    revision: 0,
  };
}

function defaultObjectInteractionResource(
  objectId: string,
  interactionKind: ObjectInteractionKind,
): ObjectInteractionResource {
  return {
    enabled: false,
    interaction_kind: interactionKind,
    object_id: objectId,
    params: {},
    present: false,
    scene_revision: 0,
  };
}

function resolveRevisionProperty(
  data: unknown,
  property: string,
): ResourceRevision | null {
  if (!data || typeof data !== "object" || !(property in data)) {
    return null;
  }

  const revision = (data as Record<string, unknown>)[property];
  if (typeof revision === "number" || typeof revision === "string") {
    return revision;
  }

  return null;
}
