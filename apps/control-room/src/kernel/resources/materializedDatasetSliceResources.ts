"use client";

import { useCallback } from "react";

import type { MaterializedDatasetResource } from "../api/apiTypes";
import type { DecodedMaterializedDatasetSlice, MaterializedDatasetSliceRange } from "../api/codecs/materializedDatasetSliceCodec";
import { useKernel } from "../KernelContext";

import { useResource } from "./useResource";

/** Include the expected descriptor in the key so cache hits cannot bypass its validation. */
export function materializedDatasetSliceResourceKey(
  dataset: MaterializedDatasetResource,
  range: MaterializedDatasetSliceRange,
): string {
  return `materialized-dataset-slice:${JSON.stringify([
    dataset.project_id, dataset.run_id, dataset.solution_set_id,
    dataset.containing_solution_revision, dataset.member_id, dataset.artifact_id,
    dataset.manifest_object_ref, dataset.manifest_byte_length, dataset.source,
    dataset.dataset.dataset_id, dataset.dataset.revision,
    dataset.sample_id, dataset.item_id, dataset.field_id,
    dataset.field.descriptor, dataset.field.coverage,
    range.elementOffset, range.elementCount, range.maxResponseBytes,
  ])}`;
}

export function useMaterializedDatasetSliceResource(
  dataset: MaterializedDatasetResource,
  range: MaterializedDatasetSliceRange,
  enabled = true,
) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.persistence.projects.materializedDatasetSlice(dataset, range, { signal }),
    [api, dataset, range],
  );
  return useResource<DecodedMaterializedDatasetSlice>({
    abortStaleInflight: true,
    enabled,
    load,
    retryPolicy: null,
    resourceKey: materializedDatasetSliceResourceKey(dataset, range),
    resolveRevision: (data) => data.metadata.manifest_object_ref,
  });
}
