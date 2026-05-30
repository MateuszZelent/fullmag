"use client";

import { useCallback } from "react";

import {
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
  MESHING_OBJECT_QUALITY_PATH,
  MESHING_OBJECT_POLICY_PATH,
  MESHING_OBJECT_REPORT_PATH,
  MESHING_OBJECT_SIZE_FIELD_PATH,
  MESHING_OBJECT_TOPOLOGY_PATH,
  MESHING_SUMMARY_PATH,
  MESHING_UNIVERSE_POLICY_PATH,
  MESHING_UNIVERSE_QUALITY_PATH,
  MESHING_UNIVERSE_REPORT_PATH,
  MODEL_MATERIAL_PATH,
  MODEL_OBJECT_INTERACTION_PATH,
  MODEL_GEOMETRY_CAPABILITIES_PATH,
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_REGIONS_PATH,
  MODEL_SCENE_PATH,
} from "../api/apiPaths";
import type {
  GeometryDiagnosticsResource,
  GeometryCapabilitiesResource,
  GeometryValidationResource,
  MaterialResource,
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
  MeshSemanticsResource,
  MeshSharedDomainConfigResource,
  MeshSharedDomainManifestResource,
  MeshSharedDomainQualityResource,
  MeshSharedDomainReportResource,
  MeshSummaryResource,
  MeshUniverseConfigResource,
  MeshUniverseQualityResource,
  MeshUniverseReportResource,
  RegionListResource,
  ResourceRevision,
  SceneResource,
} from "../api/apiTypes";
import {
  isOptionalObjectInteractionKind,
} from "../api/apiTypes";
import type { DecodedMeshQualityData, DecodedTopology } from "../api/codecs";
import { ControlRoomApiError } from "../api/ControlRoomApi";
import { useKernel } from "../KernelContext";
export {
  VISUALIZATION_STATE_RESOURCE_KEY,
  resolveVisualizationStateRevision,
  useVisualizationStateResource,
} from "../visualization/useVisualizationStateResource";

import { useResource } from "./useResource";

interface ResourceHookOptions {
  enabled?: boolean;
}

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
export const MESH_SHARED_DOMAIN_QUALITY_GATES_RESOURCE_KEY =
  MESHING_SHARED_DOMAIN_QUALITY_GATES_PATH;
export const MESH_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_RESOURCE_KEY =
  MESHING_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_PATH;
export const MODEL_REGIONS_RESOURCE_KEY = MODEL_REGIONS_PATH;
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

export function useSceneResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.model.scene({ signal }),
    [api],
  );

  return useResource<SceneResource>({
    enabled: options.enabled,
    load,
    resolveRevision: resolveSceneResourceRevision,
    resourceKey: SCENE_RESOURCE_KEY,
  });
}

export function useGeometryDiagnosticsResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.model.geometry.diagnostics({ signal }),
    [api],
  );

  return useResource<GeometryDiagnosticsResource>({
    enabled: options.enabled,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: GEOMETRY_DIAGNOSTICS_RESOURCE_KEY,
  });
}

export function useGeometryCapabilitiesResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.model.geometry.capabilities({ signal }),
    [api],
  );

  return useResource<GeometryCapabilitiesResource>({
    enabled: options.enabled,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: GEOMETRY_CAPABILITIES_RESOURCE_KEY,
  });
}

export function useGeometryValidationResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.model.geometry.validation({ signal }),
    [api],
  );

  return useResource<GeometryValidationResource>({
    enabled: options.enabled,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: GEOMETRY_VALIDATION_RESOURCE_KEY,
  });
}

export function useMaterialResource(materialId: string | null | undefined) {
  const { api } = useKernel();
  const resourceKey = materialId
    ? resolveMaterialResourceKey(materialId)
    : MODEL_MATERIAL_PATH;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      if (!materialId) return Promise.resolve(null);
      return api.model.material(materialId, { signal });
    },
    [api, materialId],
  );

  return useResource<MaterialResource | null>({
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useModelRegionsResource() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.model.regions({ signal }),
    [api],
  );

  return useResource<RegionListResource>({
    load,
    resolveRevision: (data) =>
      data?.scene_revision ?? data?.geometry_realization_revision ?? null,
    resourceKey: MODEL_REGIONS_RESOURCE_KEY,
  });
}

export function useMeshBuildCurrent(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.meshing.builds.current({ signal }),
    [api],
  );

  return useResource<MeshActiveBuildResource>({
    enabled: options.enabled,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: MESH_BUILD_CURRENT_RESOURCE_KEY,
  });
}

export function useMeshBuildLatestSuccessful(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.meshing.builds.latestSuccessful({ signal }),
    [api],
  );

  return useResource<MeshLastSuccessfulBuildResource>({
    enabled: options.enabled,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  });
}

export function useMeshBuildHistoryResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.meshing.builds.history({ signal }),
    [api],
  );

  return useResource<MeshBuildHistoryResource>({
    enabled: options.enabled,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: MESH_BUILD_HISTORY_RESOURCE_KEY,
  });
}

export function useMeshSummaryResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.meshing.summary({ signal }),
    [api],
  );

  return useResource<MeshSummaryResource>({
    enabled: options.enabled,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: MESH_SUMMARY_RESOURCE_KEY,
  });
}

export function useMeshCapabilitiesResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.meshing.capabilities({ signal }),
    [api],
  );

  return useResource<MeshCapabilitiesResource>({
    enabled: options.enabled,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: MESH_CAPABILITIES_RESOURCE_KEY,
  });
}

export function useMeshSemanticsResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.meshing.semantics({ signal }),
    [api],
  );

  return useResource<MeshSemanticsResource>({
    enabled: options.enabled,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: MESH_SEMANTICS_RESOURCE_KEY,
  });
}

export function useMeshSharedDomainManifestResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.meshing.sharedDomain.manifest({ signal }),
    [api],
  );

  return useResource<MeshSharedDomainManifestResource | null>({
    enabled: options.enabled,
    load,
    resolveRevision: resolveMeshSharedDomainManifestRevision,
    resourceKey: MESH_SHARED_DOMAIN_MANIFEST_RESOURCE_KEY,
  });
}

export function useMeshSharedDomainPolicyResource() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.meshing.sharedDomain.policy({ signal }),
    [api],
  );

  return useResource<MeshSharedDomainConfigResource>({
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY,
  });
}

export function useMeshSharedDomainReportResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.meshing.sharedDomain.report({ signal }),
    [api],
  );

  return useResource<MeshSharedDomainReportResource>({
    enabled: options.enabled,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: MESH_SHARED_DOMAIN_REPORT_RESOURCE_KEY,
  });
}

export function useMeshSharedDomainQualityResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.meshing.sharedDomain.quality({ signal }),
    [api],
  );

  return useResource<MeshSharedDomainQualityResource>({
    enabled: options.enabled,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: MESH_SHARED_DOMAIN_QUALITY_RESOURCE_KEY,
  });
}

export function useMeshSharedDomainQualityDataResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.meshing.sharedDomain.qualityData({ signal }).then((result) => {
        if (result.status === "ready") return result.data;
        return null;
      }),
    [api],
  );

  return useResource<DecodedMeshQualityData | null>({
    enabled: options.enabled,
    load,
    resourceKey: MESH_SHARED_DOMAIN_QUALITY_DATA_RESOURCE_KEY,
  });
}

export function useMeshHistogramBinElementsResource(
  query: MeshHistogramBinElementsQuery | null,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const enabled = options.enabled !== false && query !== null;
  const resourceKey = query
    ? resolveMeshHistogramBinElementsResourceKey(query)
    : `${MESHING_HISTOGRAM_BIN_ELEMENTS_PATH}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      query
        ? api.meshing.histogramBinElements(query, { signal })
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
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.meshing.sharedDomain.qualityGates({ signal }),
    [api],
  );

  return useResource<MeshQualityGatesResource>({
    enabled: options.enabled,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: MESH_SHARED_DOMAIN_QUALITY_GATES_RESOURCE_KEY,
  });
}

export function useMeshSharedDomainRealizedSizeFieldsResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.meshing.sharedDomain.realizedSizeFields({ signal }),
    [api],
  );

  return useResource<MeshRealizedSizeFieldsResource>({
    enabled: options.enabled,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: MESH_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_RESOURCE_KEY,
  });
}

export function useMeshUniverseReportResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.meshing.universeReport({ signal }),
    [api],
  );

  return useResource<MeshUniverseReportResource>({
    enabled: options.enabled,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: MESH_UNIVERSE_REPORT_RESOURCE_KEY,
  });
}

export function useMeshUniverseQualityResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.meshing.universeQuality({ signal }),
    [api],
  );

  return useResource<MeshUniverseQualityResource>({
    enabled: options.enabled,
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: MESH_UNIVERSE_QUALITY_RESOURCE_KEY,
  });
}

export function useObjectTopologyResource(objectId: string | null | undefined) {
  const { api } = useKernel();
  const resourceKey = objectId
    ? resolveObjectTopologyResourceKey(objectId)
    : MESHING_OBJECT_TOPOLOGY_PATH;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      if (!objectId) return Promise.resolve(null);
      return api.meshing.objectTopology(objectId, { signal }).then((result) => {
        if (result.status === "ready") return result.data;
        return null;
      });
    },
    [api, objectId],
  );

  return useResource<DecodedTopology | null>({
    load,
    resourceKey,
  });
}

export function useObjectMeshReportResource(
  objectId: string | null | undefined,
) {
  const { api } = useKernel();
  const resourceKey = objectId
    ? resolveObjectMeshReportResourceKey(objectId)
    : MESHING_OBJECT_REPORT_PATH;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      if (!objectId) return Promise.resolve(null);
      return api.meshing.objectReport(objectId, { signal });
    },
    [api, objectId],
  );

  return useResource<MeshObjectReportResource | null>({
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useObjectMeshQualityResource(
  objectId: string | null | undefined,
) {
  const { api } = useKernel();
  const resourceKey = objectId
    ? resolveObjectMeshQualityResourceKey(objectId)
    : MESHING_OBJECT_QUALITY_PATH;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      if (!objectId) return Promise.resolve(null);
      return api.meshing.objectQuality(objectId, { signal });
    },
    [api, objectId],
  );

  return useResource<MeshObjectQualityResource | null>({
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useObjectMeshSizeFieldResource(
  objectId: string | null | undefined,
) {
  const { api } = useKernel();
  const resourceKey = objectId
    ? MESHING_OBJECT_SIZE_FIELD_PATH.replace(
        "{object_id}",
        encodeURIComponent(objectId),
      )
    : MESHING_OBJECT_SIZE_FIELD_PATH;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      if (!objectId) return Promise.resolve(null);
      return api.meshing.objectSizeField(objectId, { signal });
    },
    [api, objectId],
  );

  return useResource<MeshObjectSizeFieldResource | null>({
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useObjectMeshPolicyResource(
  objectId: string | null | undefined,
) {
  const { api } = useKernel();
  const resourceKey = objectId
    ? resolveObjectMeshPolicyResourceKey(objectId)
    : MESHING_OBJECT_POLICY_PATH;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      if (!objectId) return Promise.resolve(defaultObjectMeshPolicyResource(""));
      return api.meshing.objectPolicy(objectId, { signal });
    },
    [api, objectId],
  );

  return useResource<MeshObjectConfigResource>({
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey,
  });
}

export function useUniverseMeshPolicyResource() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.meshing.universePolicy({ signal }),
    [api],
  );

  return useResource<MeshUniverseConfigResource>({
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: MESH_UNIVERSE_POLICY_RESOURCE_KEY,
  });
}

export function useObjectInteractionResource(
  objectId: string | null | undefined,
  interactionKind: ObjectInteractionKind,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = objectId
    ? resolveObjectInteractionResourceKey(objectId, interactionKind)
    : MODEL_OBJECT_INTERACTION_PATH;
  const load = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      if (!objectId) {
        return defaultObjectInteractionResource("", interactionKind);
      }

      try {
        return await api.model.objectInteraction(objectId, interactionKind, {
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
    enabled: options.enabled,
    load,
    resourceKey,
  });
}

export function defaultObjectMeshPolicyResource(
  objectId: string,
): MeshObjectConfigResource {
  return {
    config: null,
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
