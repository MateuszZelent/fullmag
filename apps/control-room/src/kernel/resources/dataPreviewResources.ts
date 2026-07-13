"use client";

import { useCallback, useMemo } from "react";

import type {
  BinaryResourceResult,
  FieldVectorQuery,
} from "@/kernel/api/apiTypes";
import {
  canonicalFieldVectorQuery,
  serializeCanonicalFieldVectorResourceKey,
} from "@/kernel/api/fieldQueryIdentity";
import type { DecodedFieldVector } from "@/kernel/api/codecs";
import { normalizeQuantityIdOrDefault } from "@/kernel/api/quantityIds";
import { useKernel } from "@/kernel/KernelContext";

import { ResourceCache } from "./ResourceCache";
import { useResource } from "./useResource";

interface DataPreviewFieldVectorRequest {
  component: string;
  maxSamples: number;
  phaseRad?: number | null;
  quantityId: string;
  view?: string | null;
}

const dataPreviewFieldVectorCache = new ResourceCache<DecodedFieldVector>({
  maxBytes: 8 * 1024 * 1024,
});

export function resolveDataPreviewFieldVectorResourceKey({
  component,
  maxSamples,
  phaseRad,
  quantityId,
  view,
}: DataPreviewFieldVectorRequest): string {
  const resolvedQuantityId = normalizeQuantityIdOrDefault(quantityId);
  return serializeCanonicalFieldVectorResourceKey(
    canonicalFieldVectorQuery(resolvedQuantityId, {
      component: component || "full",
      max_samples: maxSamples,
      phase_rad: phaseRad != null && Number.isFinite(phaseRad) ? phaseRad : undefined,
      view: view ?? undefined,
    }),
  );
}

export function useDataPreviewFieldVector({
  component,
  enabled,
  maxSamples,
  phaseRad,
  quantityId,
  view,
}: DataPreviewFieldVectorRequest & { enabled: boolean }) {
  const { api, resources } = useKernel();
  const resolvedQuantityId = useMemo(
    () => normalizeQuantityIdOrDefault(quantityId),
    [quantityId],
  );
  const query = useMemo<FieldVectorQuery>(
    () => ({
      component: component || "full",
      max_samples: maxSamples,
      phase_rad:
        phaseRad != null && Number.isFinite(phaseRad) ? phaseRad : undefined,
      view: view ?? undefined,
    }),
    [component, maxSamples, phaseRad, view],
  );
  const resourceKey = useMemo(
    () =>
      resolveDataPreviewFieldVectorResourceKey({
        component,
        maxSamples,
        phaseRad,
        quantityId: resolvedQuantityId,
        view,
      }),
    [component, maxSamples, phaseRad, resolvedQuantityId, view],
  );
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      loadCachedDataPreviewFieldVector(resourceKey, (etag) =>
        api.data.fields.vector(resolvedQuantityId, query, { etag, signal }),
      ),
    [api, query, resolvedQuantityId, resourceKey],
  );
  const resolveRevision = useCallback(
    () => dataPreviewFieldVectorCache.peek(resourceKey)?.etag ?? null,
    [resourceKey],
  );

  return {
    resource: useResource({
      enabled,
      load,
      resolveRevision,
      resourceKey,
    }),
    resourceKey,
    resourceRevision: resources.getRevision(resourceKey),
  };
}

async function loadCachedDataPreviewFieldVector(
  resourceKey: string,
  request: (
    etag?: string | null,
  ) => Promise<BinaryResourceResult<DecodedFieldVector>>,
): Promise<DecodedFieldVector | null> {
  const cached = dataPreviewFieldVectorCache.get(resourceKey);
  const result = await request(cached?.etag);
  if (result.status === "not-modified") {
    if (!cached) {
      throw new Error(`Data preview ${resourceKey} returned 304 without cache`);
    }
    return cached.data;
  }
  if (result.status === "not-applicable") {
    return null;
  }

  dataPreviewFieldVectorCache.set(resourceKey, {
    byteLength: result.byteLength,
    data: result.data,
    etag: result.etag,
  });
  return result.data;
}
