"use client";

import { useCallback, useEffect, useEffectEvent } from "react";
import { WORKSPACE_MATERIAL_LIBRARY_PATH } from "../api/apiPaths";
import type { MaterialLibraryResource, MaterialVersionPublishRequest, MaterialVersionUpdateRequest } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import { useResource } from "./useResource";

export const MATERIAL_LIBRARY_RESOURCE_KEY = WORKSPACE_MATERIAL_LIBRARY_PATH;
const resolveMaterialLibraryRevision = (data: MaterialLibraryResource) => data.revision;

/** Catalog lifetime follows the API client, independently of project/session scope. */
export function useMaterialLibraryResource({ enabled = true }: { enabled?: boolean } = {}) {
  const { api } = useKernel();
  const load = useCallback(({ signal }: { signal: AbortSignal }) =>
    api.workspace.listMaterials({ signal }), [api]);
  const resource = useResource<MaterialLibraryResource>({
    resourceKey: MATERIAL_LIBRARY_RESOURCE_KEY, enabled, load,
    resolveRevision: resolveMaterialLibraryRevision,
  });
  const refreshExistingCatalog = useEffectEvent(() => {
    if (resource.data !== null) resource.refetch();
  });
  useEffect(() => {
    // Reopening also observes catalog edits made in another browser/project.
    // An empty cache uses useResource's initial load, avoiding a duplicate GET.
    if (enabled) refreshExistingCatalog();
  }, [enabled, api]);
  return resource;
}

export function useMaterialLibraryVersionMutations() {
  const { api, resources } = useKernel();
  return {
    async publish(input: MaterialVersionPublishRequest) {
      const result = await api.workspace.publishMaterialVersion(input);
      resources.invalidate(MATERIAL_LIBRARY_RESOURCE_KEY, result.catalog_revision);
      return result.published;
    },
    async update(family: string, version: string, input: MaterialVersionUpdateRequest) {
      const result = await api.workspace.updateMaterialVersion(family, version, input);
      resources.invalidate(MATERIAL_LIBRARY_RESOURCE_KEY, result.catalog_revision);
      return result.published;
    },
  };
}
