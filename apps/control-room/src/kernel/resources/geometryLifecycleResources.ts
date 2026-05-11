"use client";

import { useCallback } from "react";

import {
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_OBJECT_QUALITY_PATH,
  MESHING_OBJECT_REPORT_PATH,
  MESHING_OBJECT_TOPOLOGY_PATH,
  MODEL_GEOMETRY_CAPABILITIES_PATH,
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_SCENE_PATH,
} from "../api/apiPaths";
import type {
  GeometryDiagnosticsResource,
  GeometryCapabilitiesResource,
  GeometryValidationResource,
  MeshActiveBuildResource,
  MeshLastSuccessfulBuildResource,
  MeshObjectQualityResource,
  MeshObjectReportResource,
  ResourceRevision,
  SceneResource,
} from "../api/apiTypes";
import type { DecodedTopology } from "../api/codecs";
import { useKernel } from "../KernelContext";
export {
  VISUALIZATION_STATE_RESOURCE_KEY,
  resolveVisualizationStateRevision,
  useVisualizationStateResource,
} from "../visualization/useVisualizationStateResource";

import { useResource } from "./useResource";

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

export function useSceneResource() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.model.scene({ signal }),
    [api],
  );

  return useResource<SceneResource>({
    load,
    resolveRevision: resolveSceneResourceRevision,
    resourceKey: SCENE_RESOURCE_KEY,
  });
}

export function useGeometryDiagnosticsResource() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.model.geometry.diagnostics({ signal }),
    [api],
  );

  return useResource<GeometryDiagnosticsResource>({
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: GEOMETRY_DIAGNOSTICS_RESOURCE_KEY,
  });
}

export function useGeometryCapabilitiesResource() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.model.geometry.capabilities({ signal }),
    [api],
  );

  return useResource<GeometryCapabilitiesResource>({
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: GEOMETRY_CAPABILITIES_RESOURCE_KEY,
  });
}

export function useGeometryValidationResource() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.model.geometry.validation({ signal }),
    [api],
  );

  return useResource<GeometryValidationResource>({
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: GEOMETRY_VALIDATION_RESOURCE_KEY,
  });
}

export function useMeshBuildCurrent() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.meshing.builds.current({ signal }),
    [api],
  );

  return useResource<MeshActiveBuildResource>({
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: MESH_BUILD_CURRENT_RESOURCE_KEY,
  });
}

export function useMeshBuildLatestSuccessful() {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.meshing.builds.latestSuccessful({ signal }),
    [api],
  );

  return useResource<MeshLastSuccessfulBuildResource>({
    load,
    resolveRevision: resolveJsonResourceRevision,
    resourceKey: MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
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
