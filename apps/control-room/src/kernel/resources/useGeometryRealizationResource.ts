"use client";

import { useCallback } from "react";

import { MODEL_GEOMETRY_REALIZATION_CURRENT_PATH } from "../api/apiPaths";
import type { GeometryRealizationResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import { useResource } from "./useResource";
import { useSessionScopedResourceKey } from "./useSessionScopedResourceKey";

/** Authoring bounds, not solver topology or proof that a backend supports the scene. */
export function useGeometryRealizationResource(enabled: boolean) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MODEL_GEOMETRY_REALIZATION_CURRENT_PATH,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.model.geometry.realization({ sessionScopeKey, signal }),
    [api],
  );
  return useResource<GeometryRealizationResource>({
    enabled: enabled && sessionIdentity !== null,
    load,
    resolveRevision: (data) => data.source_scene_revision,
    resourceKey,
  });
}
