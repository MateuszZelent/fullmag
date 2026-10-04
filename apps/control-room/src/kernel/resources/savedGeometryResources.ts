"use client";

import { useCallback } from "react";
import type { MaterializedDatasetResource, SavedFieldGeometryResource } from "../api/apiTypes";
import type { DecodedTopology } from "../api/codecs/types";
import type { DecodedSavedSupport } from "../api/codecs/savedSupportCodec";
import { canonicalSavedGeometryJson } from "../api/savedGeometryIdentity";
import { useKernel } from "../KernelContext";
import { useResource } from "./useResource";

/** Historical identity remains independent of the active session and mesh. */
export function savedGeometryResourceKey(dataset: MaterializedDatasetResource): string {
  return `saved-field-geometry:${canonicalSavedGeometryJson(dataset)}`;
}

export function savedGeometryBinaryResourceKey(
  dataset: MaterializedDatasetResource, geometry: SavedFieldGeometryResource, kind: "topology" | "support",
): string {
  return `${savedGeometryResourceKey(dataset)}:${kind}:${canonicalSavedGeometryJson(geometry)}`;
}

export function useSavedFieldGeometryResource(dataset: MaterializedDatasetResource, enabled = true) {
  const { api } = useKernel();
  const load = useCallback(({ signal }: { signal: AbortSignal }) =>
    api.persistence.projects.savedFieldGeometry(dataset, { signal }), [api, dataset]);
  return useResource<SavedFieldGeometryResource>({
    enabled, abortStaleInflight: true, load, retryPolicy: null,
    resourceKey: savedGeometryResourceKey(dataset),
    resolveRevision: (data) => data.geometry_manifest.object_ref,
  });
}

export function useSavedFieldTopologyResource(
  dataset: MaterializedDatasetResource, geometry: SavedFieldGeometryResource | null, enabled = true,
) {
  const { api } = useKernel();
  const load = useCallback(({ signal }: { signal: AbortSignal }) => {
    if (geometry === null) throw new Error("Pinned geometry metadata is required.");
    return api.persistence.projects.savedFieldTopology(dataset, geometry, { signal });
  }, [api, dataset, geometry]);
  return useResource<DecodedTopology | null>({
    enabled: enabled && geometry !== null, abortStaleInflight: true, load, retryPolicy: null,
    resourceKey: geometry === null ? `${savedGeometryResourceKey(dataset)}:topology:unavailable` : savedGeometryBinaryResourceKey(dataset, geometry, "topology"),
    resolveRevision: () => geometry?.topology_binary_sha256 ?? null,
  });
}

export function useSavedFieldSupportResource(
  dataset: MaterializedDatasetResource, geometry: SavedFieldGeometryResource | null, enabled = true,
) {
  const { api } = useKernel();
  const load = useCallback(({ signal }: { signal: AbortSignal }) => {
    if (geometry === null) throw new Error("Pinned geometry metadata is required.");
    return api.persistence.projects.savedFieldSupport(dataset, geometry, { signal });
  }, [api, dataset, geometry]);
  return useResource<DecodedSavedSupport | null>({
    enabled: enabled && geometry !== null, abortStaleInflight: true, load, retryPolicy: null,
    resourceKey: geometry === null ? `${savedGeometryResourceKey(dataset)}:support:unavailable` : savedGeometryBinaryResourceKey(dataset, geometry, "support"),
    resolveRevision: () => geometry?.support_binary_sha256 ?? null,
  });
}
