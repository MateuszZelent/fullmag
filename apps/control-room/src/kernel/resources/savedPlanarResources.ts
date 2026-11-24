"use client";

import { useCallback } from "react";
import type { MaterializedDatasetResource, SavedFieldGeometryResource, SavedPlanarQuery } from "../api/apiTypes";
import type { ControlRoomApi } from "../api/ControlRoomApi";
import { canonicalSavedGeometryJson } from "../api/savedGeometryIdentity";
import { useKernel } from "../KernelContext";
import { useResource } from "./useResource";

export type SavedPlanarData = Awaited<ReturnType<ControlRoomApi["persistence"]["projects"]["savedPlanar"]>> & { queryKey: string };
export const savedPlanarQueryKey = (query: SavedPlanarQuery) => canonicalSavedGeometryJson(query);

export function useSavedPlanarResource(
  dataset: MaterializedDatasetResource | null,
  geometry: SavedFieldGeometryResource | null,
  query: SavedPlanarQuery | null,
) {
  const { api } = useKernel();
  const load = useCallback(async ({ signal }: { signal: AbortSignal }) => {
    if (!dataset || !geometry || !query) throw new Error("Pinned planar source is required.");
    return { ...await api.persistence.projects.savedPlanar(dataset, geometry, query, { signal }), queryKey: savedPlanarQueryKey(query) };
  }, [api, dataset, geometry, query]);
  return useResource<SavedPlanarData>({
    enabled: Boolean(dataset && geometry && query), abortStaleInflight: true,
    load, retryPolicy: null,
    resourceKey: `saved-planar:${canonicalSavedGeometryJson({ dataset, geometry, query })}`,
    resolveRevision: data => data.meta.request_identity,
  });
}
