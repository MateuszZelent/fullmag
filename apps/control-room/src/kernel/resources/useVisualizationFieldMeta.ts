"use client";

import { useMemo } from "react";
import type { FieldMetaQuery } from "../api/apiTypes";
import { artifactInspectorMetadataMatchesBinding, type ArtifactInspectorFieldBinding } from "../visualization/artifactFieldSelection";
import { useFieldMetaResource } from "./studyRuntimeResources";

/** One metadata reader; immutable inspection data never falls back to live ranges. */
export function useVisualizationFieldMeta({ binding, ...options }: FieldMetaQuery & {
  binding?: ArtifactInspectorFieldBinding;
  enabled: boolean;
  quantityId: string;
}): ReturnType<typeof useFieldMetaResource> {
  const enabled = options.enabled && (!binding?.historical || Boolean(binding.query));
  const resource = useFieldMetaResource({ ...options, ...binding?.query, enabled, strictErrors: binding?.historical });
  const ownerError = useMemo(() => enabled && binding?.historical && resource.data && !artifactInspectorMetadataMatchesBinding(resource.data, binding)
    ? new Error("Field metadata differs from the selected immutable inspection result.") : null,
  [enabled, binding, resource.data]);
  if (!binding?.historical) return resource;
  if (!enabled) return { ...resource, data: null, status: "idle", error: null, refreshError: null };
  const error = ownerError ?? resource.error ?? resource.refreshError;
  return error ? { ...resource, data: null, status: "error", error } : resource;
}
