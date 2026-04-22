"use client";

/**
 * Hook: fetches field vector when field_revision or component changes.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type { DecodedFieldVector } from "../../api/codecs/types";
import type { FieldComponent } from "../../api/types";
import { decodeFieldVectorOffThread } from "../../api/codecs/decodeOffThread";
import { getLiveApiClient } from "../../api/client/LiveApiClient";
import { ResourceCache } from "../../api/client/cache/ResourceCache";
import { LiveApiError } from "../../api/client/errors/LiveApiError";

interface UseFieldVectorOptions {
  /** Component to request from the server. Defaults to "full". */
  component?: FieldComponent;
  /** Domain generation ID for cache disambiguation. */
  domainGenerationId?: number;
}

interface UseFieldVectorResult {
  field: DecodedFieldVector | null;
  loading: boolean;
  error: LiveApiError | null;
}

export function useFieldVector(
  quantityId: string | null,
  fieldRevision: number | null,
  options?: UseFieldVectorOptions,
): UseFieldVectorResult {
  const component = options?.component ?? "full";
  const domainGenerationId = options?.domainGenerationId ?? 0;

  const [field, setField] = useState<DecodedFieldVector | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<LiveApiError | null>(null);
  const fetchedRevRef = useRef<string | null>(null);

  const fetchField = useCallback(
    async (qId: string, rev: number, comp: FieldComponent, domainGenId: number) => {
      const cacheKey = `field-vector:${qId}:${rev}:${domainGenId}:${comp}`;
      if (fetchedRevRef.current === cacheKey) return;
      setLoading(true);
      setError(null);

      try {
        const client = getLiveApiClient();
        const resourceKey = ResourceCache.fieldKey(qId, rev, domainGenId, comp);
        const cached = client.getCache().get<DecodedFieldVector>(resourceKey);
        if (cached && cached.revision === rev) {
          fetchedRevRef.current = cacheKey;
          setField(cached.data);
          setLoading(false);
          return;
        }

        const response = await client.fields.getVectorResponse(
          qId,
          { component: comp, etag: cached?.eTag ?? undefined },
          { cache: "default" },
        );

        if (response.status === 304 && cached) {
          fetchedRevRef.current = cacheKey;
          setField(cached.data);
          setLoading(false);
          return;
        }

        if (!response.buffer) {
          throw new Error("received 304 without cached data");
        }

        const result = await decodeFieldVectorOffThread(response.buffer);
        client.getCache().set(
          resourceKey,
          result,
          rev,
          domainGenId,
          response.etag,
        );
        fetchedRevRef.current = cacheKey;
        setField(result);
        setLoading(false);
      } catch (err) {
        const apiErr =
          err instanceof LiveApiError
            ? err
            : LiveApiError.networkError("field-vector", err);
        setError(apiErr);
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (quantityId && fieldRevision != null) {
      fetchField(quantityId, fieldRevision, component, domainGenerationId);
    }
  }, [quantityId, fieldRevision, component, domainGenerationId, fetchField]);

  return { field, loading, error };
}
