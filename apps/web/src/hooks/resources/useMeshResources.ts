"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  BinaryResourceResponse,
  JsonResourceResponse,
  MeshActiveBuildResource,
  MeshBuildHistoryResource,
  MeshCapabilitiesResource,
  MeshInterfaceConfigReplaceRequest,
  MeshInterfaceConfigResource,
  MeshInterfaceQualityResource,
  MeshInterfaceReportResource,
  MeshLastSuccessfulBuildResource,
  MeshObjectConfigReplaceRequest,
  MeshObjectConfigResource,
  MeshObjectQualityResource,
  MeshObjectReportResource,
  MeshObjectSizeFieldResource,
  MeshSharedDomainConfigReplaceRequest,
  MeshSharedDomainConfigResource,
  MeshSharedDomainManifestResource,
  MeshSharedDomainQualityResource,
  MeshSharedDomainReportResource,
  MeshSummaryResource,
  MeshUniverseConfigReplaceRequest,
  MeshUniverseConfigResource,
  MeshUniverseQualityResource,
  MeshUniverseReportResource,
} from "../../api/types";
import { getLiveApiClient } from "../../api/client/LiveApiClient";
import type { RequestOptions } from "../../api/client/LiveApiClient";
import { ResourceCache } from "../../api/client/cache/ResourceCache";
import { LiveApiError } from "../../api/client/errors/LiveApiError";
import { normalizeMeshWorkspace } from "@/lib/session/normalize";
import type { MeshWorkspaceState } from "@/lib/session/types";

interface MeshHookOptions {
  enabled?: boolean;
  sessionKey?: string | null;
  revision?: number | null;
}

interface MeshResourceResult<T> {
  data: T | null;
  loading: boolean;
  error: LiveApiError | null;
  refresh: () => Promise<void>;
}

interface MeshMutableResourceResult<T, R> extends MeshResourceResult<T> {
  replace: (request: R) => Promise<T | null>;
}

interface MeshBinaryResourceResult {
  data: ArrayBuffer | null;
  loading: boolean;
  error: LiveApiError | null;
  refresh: () => Promise<void>;
}

function useMeshJsonResource<T>(
  resourceName: string,
  fetcher: () => Promise<T>,
  options?: MeshHookOptions,
  responseFetcher?: (opts?: RequestOptions) => Promise<JsonResourceResponse<T>>,
): MeshResourceResult<T> {
  const enabled = options?.enabled ?? true;
  const sessionKey = options?.sessionKey ?? null;
  const revision = options?.revision ?? null;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<LiveApiError | null>(null);
  const mountedRef = useRef(true);
  const lastFetchKeyRef = useRef<string | null>(null);
  const fetchKey = `${sessionKey ?? "no-session"}:${resourceName}:${revision ?? "no-revision"}`;
  const cacheKey = `mesh-json:${fetchKey}`;
  const cacheRevision = revision ?? 0;

  const refresh = useCallback(async () => {
    if (!enabled || !sessionKey) {
      if (mountedRef.current) {
        setData(null);
        setError(null);
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    try {
      const client = getLiveApiClient();
      const cached = client.getCache().get<T>(cacheKey);
      if (cached && cached.revision === cacheRevision) {
        lastFetchKeyRef.current = fetchKey;
        setData(cached.data);
        setError(null);
        setLoading(false);
        return;
      }

      let nextData: T;
      if (responseFetcher) {
        const response = await responseFetcher({
          cache: "default",
          headers:
            cached?.eTag != null
              ? {
                  "If-None-Match": cached.eTag,
                }
              : undefined,
        });
        nextData =
          response.status === 304 && cached
            ? cached.data
            : (response.data as T);
        if (response.data == null && !(response.status === 304 && cached)) {
          nextData = await fetcher();
        }
        if (response.status !== 304 && response.data != null) {
          client.getCache().set(
            cacheKey,
            response.data,
            cacheRevision,
            0,
            response.headers.get("etag"),
          );
        }
      } else {
        nextData = await fetcher();
      }
      if (!mountedRef.current) {
        return;
      }
      lastFetchKeyRef.current = fetchKey;
      setData(nextData);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      const apiError =
        err instanceof LiveApiError
          ? err
          : LiveApiError.networkError(resourceName, err);
      if (apiError.status === 404 || apiError.status === 204) {
        lastFetchKeyRef.current = fetchKey;
        setData(null);
        setError(null);
        setLoading(false);
        return;
      }
      setError(apiError);
      setLoading(false);
    }
  }, [cacheKey, cacheRevision, enabled, fetchKey, fetcher, resourceName, responseFetcher, sessionKey]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled || !sessionKey) {
      lastFetchKeyRef.current = null;
      setData(null);
      setError(null);
      setLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }

    if (lastFetchKeyRef.current !== fetchKey) {
      void refresh();
    }

    return () => {
      mountedRef.current = false;
    };
  }, [enabled, fetchKey, refresh, sessionKey]);

  return { data, loading, error, refresh };
}

function useMeshBinaryResource(
  resourceName: string,
  fetcher: (opts?: RequestOptions) => Promise<BinaryResourceResponse>,
  options?: MeshHookOptions,
): MeshBinaryResourceResult {
  const enabled = options?.enabled ?? true;
  const sessionKey = options?.sessionKey ?? null;
  const revision = options?.revision ?? null;
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<LiveApiError | null>(null);
  const mountedRef = useRef(true);
  const lastFetchKeyRef = useRef<string | null>(null);
  const fetchKey = `${sessionKey ?? "no-session"}:${resourceName}:${revision ?? "no-revision"}`;
  const cacheKey = `mesh-binary:${fetchKey}`;
  const cacheRevision = revision ?? 0;

  const refresh = useCallback(async () => {
    if (!enabled || !sessionKey) {
      if (mountedRef.current) {
        setData(null);
        setError(null);
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    try {
      const client = getLiveApiClient();
      const cached = client.getCache().get<ArrayBuffer>(cacheKey);
      if (cached && cached.revision === cacheRevision) {
        lastFetchKeyRef.current = fetchKey;
        setData(cached.data);
        setError(null);
        setLoading(false);
        return;
      }

      const response = await fetcher({
        cache: "default",
        headers:
          cached?.eTag != null
            ? {
                "If-None-Match": cached.eTag,
              }
            : undefined,
      });
      const nextData =
        response.status === 304 && cached ? cached.data : response.buffer;
      if (response.status !== 304) {
        client.getCache().set(
          cacheKey,
          nextData,
          cacheRevision,
          0,
          response.headers.get("etag"),
        );
      }
      if (!mountedRef.current) {
        return;
      }
      lastFetchKeyRef.current = fetchKey;
      setData(nextData);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      const apiError =
        err instanceof LiveApiError
          ? err
          : LiveApiError.networkError(resourceName, err);
      if (apiError.status === 404 || apiError.status === 204) {
        lastFetchKeyRef.current = fetchKey;
        setData(null);
        setError(null);
        setLoading(false);
        return;
      }
      setError(apiError);
      setLoading(false);
    }
  }, [cacheKey, cacheRevision, enabled, fetchKey, fetcher, resourceName, sessionKey]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled || !sessionKey) {
      lastFetchKeyRef.current = null;
      setData(null);
      setError(null);
      setLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }

    if (lastFetchKeyRef.current !== fetchKey) {
      void refresh();
    }

    return () => {
      mountedRef.current = false;
    };
  }, [enabled, fetchKey, refresh, sessionKey]);

  return { data, loading, error, refresh };
}

function useMeshMutableJsonResource<T, R>(
  resourceName: string,
  fetcher: () => Promise<T>,
  replacer: (request: R) => Promise<T>,
  options?: MeshHookOptions,
): MeshMutableResourceResult<T, R> {
  const enabled = options?.enabled ?? true;
  const sessionKey = options?.sessionKey ?? null;
  const resource = useMeshJsonResource(resourceName, fetcher, options);
  const [data, setData] = useState<T | null>(null);

  useEffect(() => {
    setData(resource.data);
  }, [resource.data]);

  const replace = useCallback(
    async (request: R): Promise<T | null> => {
      if (!enabled || !sessionKey) {
        return null;
      }
      try {
        const nextData = await replacer(request);
        setData(nextData);
        return nextData;
      } catch (err) {
        throw (
          err instanceof LiveApiError
            ? err
            : LiveApiError.networkError(resourceName, err)
        );
      }
    },
    [enabled, replacer, resourceName, sessionKey],
  );

  return {
    data,
    loading: resource.loading,
    error: resource.error,
    refresh: resource.refresh,
    replace,
  };
}

export function useMeshSummary(options?: MeshHookOptions) {
  const resource = useMeshJsonResource<MeshSummaryResource>(
    "mesh-summary",
    () => getLiveApiClient().mesh.getSummary(),
    options,
  );
  return { summary: resource.data, ...resource };
}

export function useMeshCapabilities(options?: MeshHookOptions) {
  const resource = useMeshJsonResource<MeshCapabilitiesResource>(
    "mesh-capabilities",
    () => getLiveApiClient().mesh.getCapabilities(),
    options,
  );
  return { capabilities: resource.data, ...resource };
}

export function useMeshBuilds(options?: {
  enabled?: boolean;
  sessionKey?: string | null;
  revision?: number | null;
}) {
  const active = useMeshJsonResource<MeshActiveBuildResource>(
    "mesh-builds-active",
    () => getLiveApiClient().mesh.getActiveBuild(),
    options,
    (opts) => getLiveApiClient().mesh.getActiveBuildResponse(opts),
  );
  const history = useMeshJsonResource<MeshBuildHistoryResource>(
    "mesh-builds-history",
    () => getLiveApiClient().mesh.getBuildHistory(),
    options,
    (opts) => getLiveApiClient().mesh.getBuildHistoryResponse(opts),
  );
  const lastSuccess = useMeshJsonResource<MeshLastSuccessfulBuildResource>(
    "mesh-builds-last-success",
    () => getLiveApiClient().mesh.getLastSuccessfulBuild(),
    options,
    (opts) => getLiveApiClient().mesh.getLastSuccessfulBuildResponse(opts),
  );

  const refresh = useCallback(async () => {
    await Promise.all([active.refresh(), history.refresh(), lastSuccess.refresh()]);
  }, [active, history, lastSuccess]);

  return {
    activeBuild: active.data,
    history: history.data,
    lastSuccess: lastSuccess.data,
    loading: active.loading || history.loading || lastSuccess.loading,
    error: active.error ?? history.error ?? lastSuccess.error,
    refresh,
  };
}

export function useMeshUniverseConfig(options?: MeshHookOptions) {
  const resource = useMeshMutableJsonResource<
    MeshUniverseConfigResource,
    MeshUniverseConfigReplaceRequest
  >(
    "mesh-universe-config",
    () => getLiveApiClient().mesh.getUniverseConfig(),
    (request) => getLiveApiClient().mesh.replaceUniverseConfig(request),
    options,
  );
  return { config: resource.data, ...resource };
}

export function useMeshUniverseReport(options?: MeshHookOptions) {
  const resource = useMeshJsonResource<MeshUniverseReportResource>(
    "mesh-universe-report",
    () => getLiveApiClient().mesh.getUniverseReport(),
    options,
  );
  return { report: resource.data, ...resource };
}

export function useMeshUniverseQuality(options?: MeshHookOptions) {
  const resource = useMeshJsonResource<MeshUniverseQualityResource>(
    "mesh-universe-quality",
    () => getLiveApiClient().mesh.getUniverseQuality(),
    options,
  );
  return { quality: resource.data, ...resource };
}

export function useMeshSharedDomainConfig(options?: MeshHookOptions) {
  const resource = useMeshMutableJsonResource<
    MeshSharedDomainConfigResource,
    MeshSharedDomainConfigReplaceRequest
  >(
    "mesh-shared-domain-config",
    () => getLiveApiClient().mesh.getSharedDomainConfig(),
    (request) => getLiveApiClient().mesh.replaceSharedDomainConfig(request),
    options,
  );
  return { config: resource.data, ...resource };
}

export function useMeshSharedDomainReport(options?: MeshHookOptions) {
  const resource = useMeshJsonResource<MeshSharedDomainReportResource>(
    "mesh-shared-domain-report",
    () => getLiveApiClient().mesh.getSharedDomainReport(),
    options,
  );
  return { report: resource.data, ...resource };
}

export function useMeshSharedDomainQuality(options?: MeshHookOptions) {
  const resource = useMeshJsonResource<MeshSharedDomainQualityResource>(
    "mesh-shared-domain-quality",
    () => getLiveApiClient().mesh.getSharedDomainQuality(),
    options,
  );
  return { quality: resource.data, ...resource };
}

export function useMeshSharedDomainManifest(options?: MeshHookOptions) {
  const resource = useMeshJsonResource<MeshSharedDomainManifestResource>(
    "mesh-shared-domain-manifest",
    () => getLiveApiClient().mesh.getSharedDomainManifest(),
    options,
  );
  return { manifest: resource.data, ...resource };
}

export function useMeshSharedDomainTopology(options?: MeshHookOptions) {
  return useMeshBinaryResource(
    "mesh-shared-domain-topology",
    (requestOptions) =>
      getLiveApiClient().mesh.getSharedDomainTopologyResponse(requestOptions),
    options,
  );
}

export function useMeshObjectConfig(
  objectId: string | null | undefined,
  options?: MeshHookOptions,
) {
  const enabled = (options?.enabled ?? true) && Boolean(objectId);
  const resource = useMeshMutableJsonResource<
    MeshObjectConfigResource,
    MeshObjectConfigReplaceRequest
  >(
    `mesh-object-config:${objectId ?? "none"}`,
    () => getLiveApiClient().mesh.getObjectConfig(objectId ?? ""),
    (request) => getLiveApiClient().mesh.replaceObjectConfig(objectId ?? "", request),
    { ...options, enabled },
  );
  return { config: resource.data, ...resource };
}

export function useMeshObjectReport(
  objectId: string | null | undefined,
  options?: MeshHookOptions,
) {
  const enabled = (options?.enabled ?? true) && Boolean(objectId);
  const resource = useMeshJsonResource<MeshObjectReportResource>(
    `mesh-object-report:${objectId ?? "none"}`,
    () => getLiveApiClient().mesh.getObjectReport(objectId ?? ""),
    { ...options, enabled },
  );
  return { report: resource.data, ...resource };
}

export function useMeshObjectQuality(
  objectId: string | null | undefined,
  options?: MeshHookOptions,
) {
  const enabled = (options?.enabled ?? true) && Boolean(objectId);
  const resource = useMeshJsonResource<MeshObjectQualityResource>(
    `mesh-object-quality:${objectId ?? "none"}`,
    () => getLiveApiClient().mesh.getObjectQuality(objectId ?? ""),
    { ...options, enabled },
  );
  return { quality: resource.data, ...resource };
}

export function useMeshObjectSizeField(
  objectId: string | null | undefined,
  options?: MeshHookOptions,
) {
  const enabled = (options?.enabled ?? true) && Boolean(objectId);
  const resource = useMeshJsonResource<MeshObjectSizeFieldResource>(
    `mesh-object-size-field:${objectId ?? "none"}`,
    () => getLiveApiClient().mesh.getObjectSizeField(objectId ?? ""),
    { ...options, enabled },
  );
  return { sizeField: resource.data, ...resource };
}

export function useMeshObjectTopology(
  objectId: string | null | undefined,
  options?: MeshHookOptions,
) {
  const enabled = (options?.enabled ?? true) && Boolean(objectId);
  return useMeshBinaryResource(
    `mesh-object-topology:${objectId ?? "none"}`,
    (requestOptions) =>
      getLiveApiClient().mesh.getObjectTopologyResponse(
        objectId ?? "",
        requestOptions,
      ),
    { ...options, enabled },
  );
}

export function useMeshInterfaceConfig(
  interfaceId: string | null | undefined,
  options?: MeshHookOptions,
) {
  const enabled = (options?.enabled ?? true) && Boolean(interfaceId);
  const resource = useMeshMutableJsonResource<
    MeshInterfaceConfigResource,
    MeshInterfaceConfigReplaceRequest
  >(
    `mesh-interface-config:${interfaceId ?? "none"}`,
    () => getLiveApiClient().mesh.getInterfaceConfig(interfaceId ?? ""),
    (request) => getLiveApiClient().mesh.replaceInterfaceConfig(interfaceId ?? "", request),
    { ...options, enabled },
  );
  return { config: resource.data, ...resource };
}

export function useMeshInterfaceReport(
  interfaceId: string | null | undefined,
  options?: MeshHookOptions,
) {
  const enabled = (options?.enabled ?? true) && Boolean(interfaceId);
  const resource = useMeshJsonResource<MeshInterfaceReportResource>(
    `mesh-interface-report:${interfaceId ?? "none"}`,
    () => getLiveApiClient().mesh.getInterfaceReport(interfaceId ?? ""),
    { ...options, enabled },
  );
  return { report: resource.data, ...resource };
}

export function useMeshInterfaceQuality(
  interfaceId: string | null | undefined,
  options?: MeshHookOptions,
) {
  const enabled = (options?.enabled ?? true) && Boolean(interfaceId);
  const resource = useMeshJsonResource<MeshInterfaceQualityResource>(
    `mesh-interface-quality:${interfaceId ?? "none"}`,
    () => getLiveApiClient().mesh.getInterfaceQuality(interfaceId ?? ""),
    { ...options, enabled },
  );
  return { quality: resource.data, ...resource };
}

export function useMeshWorkspaceResourceState(options?: {
  enabled?: boolean;
  sessionKey?: string | null;
  meshRevision?: number | null;
  meshBuildRevision?: number | null;
}) {
  const summary = useMeshSummary({
    enabled: options?.enabled,
    sessionKey: options?.sessionKey,
    revision: options?.meshRevision,
  });
  const capabilities = useMeshCapabilities({
    enabled: options?.enabled,
    sessionKey: options?.sessionKey,
    revision: options?.meshRevision,
  });
  const builds = useMeshBuilds({
    enabled: options?.enabled,
    sessionKey: options?.sessionKey,
    revision: options?.meshBuildRevision,
  });

  const rawMeshWorkspace = useMemo(() => {
    if (
      !summary.summary &&
      !capabilities.capabilities &&
      !builds.activeBuild &&
      !builds.history &&
      !builds.lastSuccess
    ) {
      return null;
    }
    return {
      mesh_summary: summary.summary?.mesh_summary ?? null,
      mesh_quality_summary: summary.summary?.mesh_quality_summary ?? null,
      effective_airbox_target:
        builds.activeBuild?.effective_airbox_target ??
        builds.lastSuccess?.effective_airbox_target ??
        summary.summary?.effective_airbox_target ??
        null,
      effective_per_object_targets:
        builds.activeBuild?.effective_per_object_targets ??
        builds.lastSuccess?.effective_per_object_targets ??
        summary.summary?.effective_per_object_targets ??
        null,
      mesh_pipeline_status: builds.activeBuild?.mesh_pipeline_status ?? [],
      mesh_capabilities: capabilities.capabilities?.mesh_capabilities ?? null,
      mesh_adaptivity_state: capabilities.capabilities?.mesh_adaptivity_state ?? null,
      mesh_history: builds.history?.history ?? [],
      active_build: builds.activeBuild?.active_build ?? null,
      last_build_summary:
        builds.activeBuild?.last_build_summary ??
        builds.lastSuccess?.last_success ??
        null,
      last_build_error:
        builds.activeBuild?.last_build_error ??
        builds.lastSuccess?.last_build_error ??
        null,
    };
  }, [
    builds.activeBuild,
    builds.history,
    builds.lastSuccess,
    capabilities.capabilities,
    summary.summary,
  ]);

  const meshWorkspace = useMemo<MeshWorkspaceState | null>(
    () => normalizeMeshWorkspace(rawMeshWorkspace),
    [rawMeshWorkspace],
  );

  const refresh = useCallback(async () => {
    await Promise.all([summary.refresh(), capabilities.refresh(), builds.refresh()]);
  }, [builds, capabilities, summary]);

  return {
    meshWorkspace,
    summary: summary.summary,
    capabilities: capabilities.capabilities,
    activeBuild: builds.activeBuild,
    buildHistory: builds.history,
    lastSuccessfulBuild: builds.lastSuccess,
    loading: summary.loading || capabilities.loading || builds.loading,
    error: summary.error ?? capabilities.error ?? builds.error,
    refresh,
  };
}
