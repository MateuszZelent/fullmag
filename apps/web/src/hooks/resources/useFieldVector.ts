"use client";

/**
 * Hook: fetches field vector when field_revision changes.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type { DecodedFieldVector } from "../../api/codecs/types";
import { decodeFieldVectorOffThread } from "../../api/codecs/decodeOffThread";
import { getLiveApiClient } from "../../api/client/LiveApiClient";
import { ResourceCache } from "../../api/client/cache/ResourceCache";
import { LiveApiError } from "../../api/client/errors/LiveApiError";

interface UseFieldVectorResult {
  field: DecodedFieldVector | null;
  loading: boolean;
  error: LiveApiError | null;
}

export function useFieldVector(
  quantityId: string | null,
  fieldRevision: number | null,
): UseFieldVectorResult {
  const [field, setField] = useState<DecodedFieldVector | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<LiveApiError | null>(null);
  const fetchedRevRef = useRef<string | null>(null);

  const fetchField = useCallback(
    async (qId: string, rev: number) => {
      const cacheKey = `${qId}:${rev}`;
      if (fetchedRevRef.current === cacheKey) return;
      setLoading(true);
      setError(null);

      try {
        const client = getLiveApiClient();
        const resourceKey = ResourceCache.fieldKey(qId, rev, 0);
        const cached = client.getCache().get<DecodedFieldVector>(resourceKey);
        if (cached && cached.revision === rev) {
          fetchedRevRef.current = cacheKey;
          setField(cached.data);
          setLoading(false);
          return;
        }

        const response = await client.fields.getVectorResponse(qId, {
          cache: "default",
          headers:
            cached?.eTag != null
              ? {
                  "If-None-Match": cached.eTag,
                }
              : undefined,
        });
        if (response.status === 304 && cached) {
          fetchedRevRef.current = cacheKey;
          setField(cached.data);
          setLoading(false);
          return;
        }
        const result = await decodeFieldVectorOffThread(response.buffer);
        client.getCache().set(
          resourceKey,
          result,
          rev,
          0,
          response.headers.get("etag"),
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
      fetchField(quantityId, fieldRevision);
    }
  }, [quantityId, fieldRevision, fetchField]);

  return { field, loading, error };
}
