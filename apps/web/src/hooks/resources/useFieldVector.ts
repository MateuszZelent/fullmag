"use client";

/**
 * Hook: fetches field vector when field_revision or component changes.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type { DecodedFieldVector } from "../../api/codecs/types";
import type {
  FieldBinaryResponse,
  FieldComponent,
  FieldSampleScopeKind,
} from "../../api/types";
import { decodeFieldVectorOffThread } from "../../api/codecs/decodeOffThread";
import {
  getLiveSessionClient,
  type LiveSessionClient,
} from "../../api/client/LiveSessionClient";
import { ResourceCache } from "../../api/client/cache/ResourceCache";
import { LiveApiError } from "../../api/client/errors/LiveApiError";

interface UseFieldVectorOptions {
  /** Component to request from the server. Defaults to "full". */
  component?: FieldComponent;
  /** Domain generation ID for cache disambiguation. */
  domainGenerationId?: number;
  /** Optional server-side scope for sampled vector payloads. */
  scopeKind?: FieldSampleScopeKind;
  scopeId?: string | null;
}

interface UseFieldVectorResult {
  field: DecodedFieldVector | null;
  loading: boolean;
  error: LiveApiError | null;
}

export interface FieldVectorRequestParams {
  quantityId: string;
  revision: number;
  component: FieldComponent;
  domainGenerationId: number;
  scopeKind: FieldSampleScopeKind;
  scopeId: string | null;
}

export interface FieldVectorRequestHandle {
  key: string;
  promise: Promise<DecodedFieldVector>;
  release: () => void;
}

export type FieldVectorRequestClient = Pick<
  LiveSessionClient,
  "fields" | "getCache"
>;

interface InflightFieldVectorRequest {
  consumers: number;
  controller: AbortController;
  promise: Promise<DecodedFieldVector>;
}

const inflightFieldVectorRequests = new Map<string, InflightFieldVectorRequest>();

export function buildFieldVectorScopeToken(
  scopeKind: FieldSampleScopeKind,
  scopeId: string | null,
): string {
  return `${scopeKind}:${scopeId ?? "none"}`;
}

export function buildFieldVectorResourceKey(params: FieldVectorRequestParams): string {
  return `${ResourceCache.fieldKey(
    params.quantityId,
    params.revision,
    params.domainGenerationId,
    params.component,
  )}:${buildFieldVectorScopeToken(params.scopeKind, params.scopeId)}`;
}

export function buildFieldVectorRequestKey(params: FieldVectorRequestParams): string {
  return `field-vector:${params.quantityId}:${params.revision}:${params.domainGenerationId}:${params.component}:${buildFieldVectorScopeToken(
    params.scopeKind,
    params.scopeId,
  )}`;
}

/** Returns the number of in-progress field vector fetches across all hook instances. */
export function getFieldVectorInflightCount(): number {
  return inflightFieldVectorRequests.size;
}

export function loadFieldVectorRequest(
  client: FieldVectorRequestClient,
  params: FieldVectorRequestParams,
): FieldVectorRequestHandle {
  const key = buildFieldVectorRequestKey(params);
  const resourceKey = buildFieldVectorResourceKey(params);
  const cached = client.getCache().get<DecodedFieldVector>(resourceKey);
  if (cached && cached.revision === params.revision) {
    return {
      key,
      promise: Promise.resolve(cached.data),
      release: () => undefined,
    };
  }

  const existing = inflightFieldVectorRequests.get(key);
  if (existing) {
    existing.consumers += 1;
    return createFieldVectorRequestHandle(key, existing);
  }

  const controller = new AbortController();
  const entry: InflightFieldVectorRequest = {
    consumers: 1,
    controller,
    promise: fetchDecodeAndCacheFieldVector(
      client,
      params,
      resourceKey,
      cached?.eTag ?? undefined,
      controller.signal,
    ),
  };
  inflightFieldVectorRequests.set(key, entry);
  void entry.promise.then(
    () => {
      if (inflightFieldVectorRequests.get(key) === entry) {
        inflightFieldVectorRequests.delete(key);
      }
    },
    () => {
      if (inflightFieldVectorRequests.get(key) === entry) {
        inflightFieldVectorRequests.delete(key);
      }
    },
  );

  return createFieldVectorRequestHandle(key, entry);
}

function createFieldVectorRequestHandle(
  key: string,
  entry: InflightFieldVectorRequest,
): FieldVectorRequestHandle {
  let released = false;
  return {
    key,
    promise: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      releaseFieldVectorRequest(key, entry);
    },
  };
}

async function fetchDecodeAndCacheFieldVector(
  client: FieldVectorRequestClient,
  params: FieldVectorRequestParams,
  resourceKey: string,
  eTag: string | undefined,
  signal: AbortSignal,
): Promise<DecodedFieldVector> {
  const response: FieldBinaryResponse = await client.fields.getVectorResponse(
    params.quantityId,
    {
      component: params.component,
      scope_kind: params.scopeKind,
      scope_id: params.scopeId ?? undefined,
      etag: eTag,
    },
    { cache: "default", signal },
  );
  throwIfAborted(signal);

  const cached = client.getCache().get<DecodedFieldVector>(resourceKey);
  if (response.status === 304 && cached) {
    return cached.data;
  }

  if (!response.buffer) {
    throw new Error("received 304 without cached data");
  }

  const result = await decodeFieldVectorOffThread(response.buffer, {
    transferInput: true,
  });
  throwIfAborted(signal);
  client.getCache().set(
    resourceKey,
    result,
    params.revision,
    params.domainGenerationId,
    response.etag,
  );
  return result;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (typeof DOMException !== "undefined") {
    throw new DOMException("field vector request aborted", "AbortError");
  }
  throw new Error("field vector request aborted");
}

function releaseFieldVectorRequest(
  key: string,
  entry: InflightFieldVectorRequest,
): void {
  if (inflightFieldVectorRequests.get(key) !== entry) {
    return;
  }
  entry.consumers -= 1;
  if (entry.consumers > 0) return;
  inflightFieldVectorRequests.delete(key);
  entry.controller.abort();
}

export function useFieldVector(
  quantityId: string | null,
  fieldRevision: number | null,
  options?: UseFieldVectorOptions,
): UseFieldVectorResult {
  const component = options?.component ?? "full";
  const domainGenerationId = options?.domainGenerationId ?? 0;
  const scopeKind = options?.scopeKind ?? "full";
  const scopeId = options?.scopeId ?? null;

  const [field, setField] = useState<DecodedFieldVector | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<LiveApiError | null>(null);
  const fetchedRevRef = useRef<string | null>(null);
  const activeRequestRef = useRef<string | null>(null);

  const fetchField = useCallback(
    (
      qId: string,
      rev: number,
      comp: FieldComponent,
      domainGenId: number,
      scopedKind: FieldSampleScopeKind,
      scopedId: string | null,
    ) => {
      const params: FieldVectorRequestParams = {
        quantityId: qId,
        revision: rev,
        component: comp,
        domainGenerationId: domainGenId,
        scopeKind: scopedKind,
        scopeId: scopedId,
      };
      const cacheKey = buildFieldVectorRequestKey(params);
      if (fetchedRevRef.current === cacheKey) return;
      activeRequestRef.current = cacheKey;
      setLoading(true);
      setError(null);

      const client = getLiveSessionClient();
      const request = loadFieldVectorRequest(client, params);
      let active = true;
      request.promise
        .then((result) => {
          if (!active || activeRequestRef.current !== request.key) return;
          fetchedRevRef.current = cacheKey;
          setField(result);
          setLoading(false);
        })
        .catch((err) => {
          if (!active || activeRequestRef.current !== request.key) return;
          const apiErr =
            err instanceof LiveApiError
              ? err
              : LiveApiError.networkError("field-vector", err);
          setError(apiErr);
          setLoading(false);
        });

      return () => {
        active = false;
        request.release();
      };
    },
    [],
  );

  useEffect(() => {
    if (quantityId && fieldRevision != null) {
      return fetchField(
        quantityId,
        fieldRevision,
        component,
        domainGenerationId,
        scopeKind,
        scopeId,
      );
    }
    fetchedRevRef.current = null;
    activeRequestRef.current = null;
    setField(null);
    setLoading(false);
    setError(null);
  }, [
    quantityId,
    fieldRevision,
    component,
    domainGenerationId,
    scopeKind,
    scopeId,
    fetchField,
  ]);

  return { field, loading, error };
}
