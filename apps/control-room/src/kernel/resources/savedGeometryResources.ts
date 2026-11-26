"use client";

import { useCallback } from "react";
import type { MaterializedDatasetResource, SavedFieldGeometryResource } from "../api/apiTypes";
import type { DecodedTopology } from "../api/codecs/types";
import { useKernel } from "../KernelContext";
import { useResource } from "./useResource";
import { canonicalSavedGeometryJson } from "../api/savedGeometryIdentity";

/** Historical identity remains independent of the active session and mesh. */
export function savedGeometryResourceKey(dataset: MaterializedDatasetResource): string {
  return `saved-field-geometry:${canonicalSavedGeometryJson(dataset)}`;
}

export function savedGeometryBinaryResourceKey(
  dataset: MaterializedDatasetResource, geometry: SavedFieldGeometryResource, kind: "topology" | "support",
): string {
  return `${savedGeometryResourceKey(dataset)}:${kind}:${canonicalSavedGeometryJson(geometry)}`;
}

export function useSavedFieldGeometryResource(
  dataset: MaterializedDatasetResource | null,
  enabled = true,
) {
  const { api } = useKernel();
  const geometryLoad = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      if (!dataset) throw new Error("Pinned materialized dataset is required.");
      return api.persistence.projects.savedFieldGeometry(dataset, { signal });
    },
    [api, dataset],
  );
  return useResource<SavedFieldGeometryResource>({
    abortStaleInflight: true,
    enabled: enabled && dataset !== null,
    load: geometryLoad,
    retryPolicy: null,
    resourceKey: dataset ? savedGeometryResourceKey(dataset) : "saved-field-geometry:idle",
    resolveRevision: (data) => data.geometry_manifest.object_ref,
  });
}

export function useSavedFieldTopologyResource(
  dataset: MaterializedDatasetResource | null,
  geometry: SavedFieldGeometryResource | null,
  enabled = true,
) {
  const { api } = useKernel();
  const topologyLoad = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      if (!dataset || !geometry) throw new Error("Pinned field geometry is required.");
      return api.persistence.projects.savedFieldTopology(dataset, geometry, { signal });
    },
    [api, dataset, geometry],
  );
  return useResource<DecodedTopology | null>({
    abortStaleInflight: true,
    enabled: enabled && dataset !== null && geometry !== null,
    load: topologyLoad,
    retryPolicy: null,
    resourceKey: dataset && geometry
      ? savedGeometryBinaryResourceKey(dataset, geometry, "topology")
      : "saved-field-topology:idle",
    resolveRevision: (data) => data ? geometry?.topology_binary_sha256 ?? null : null,
  });
}
