"use client";

/**
 * Hook: fetches a 2-D slice of a field (scalar + optional arrows) without
 * transferring the full 3-D vector buffer. Uses ETag/304 for cache coherence.
 *
 * Architecture note: this hook is the canonical path for 2-D viewport rendering.
 * Never request the full 3-D field vector just to display a 2-D slice.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type { FieldBinaryResponse, FieldSliceMeta, FieldSliceQuery } from "../../api/types";
import {
  getLiveSessionClient,
  type LiveSessionClient,
} from "../../api/client/LiveSessionClient";
import { ResourceCache } from "../../api/client/cache/ResourceCache";
import { LiveApiError } from "../../api/client/errors/LiveApiError";

/** Decoded scalar raster from a 2-D slice. Row-major, shape [y_pixels × x_pixels]. */
export interface SliceScalarData {
  /** Raw f64 values (little-endian). Length = y_pixels × x_pixels. */
  values: Float64Array;
  xPixels: number;
  yPixels: number;
  min: number;
  max: number;
  /** ETag from the last successful fetch. Used to avoid redundant fetches. */
  etag: string | null;
}

/** Decoded arrow glyph positions + directions for a 2-D slice. */
export interface SliceArrowData {
  /**
   * Interleaved in-plane arrow vectors `[u, v, ...]` (FMVP v2, nComp=2).
   */
  values: Float64Array;
  arrowCount: number;
  etag: string | null;
}

export interface UseFieldSlice2DResult {
  meta: FieldSliceMeta | null;
  scalar: SliceScalarData | null;
  arrows: SliceArrowData | null;
  loading: boolean;
  error: LiveApiError | null;
}

export interface LoadedFieldSlice2D {
  meta: FieldSliceMeta;
  scalar: SliceScalarData;
  arrows: SliceArrowData | null;
}

export interface FieldSliceRequestParams {
  quantityId: string;
  fieldRevision: number;
  domainGenerationId: number;
  query: FieldSliceQuery;
}

export interface FieldSliceRequestHandle {
  key: string;
  promise: Promise<LoadedFieldSlice2D>;
  release: () => void;
}

export type FieldSliceRequestClient = Pick<
  LiveSessionClient,
  "fields" | "getCache"
>;

interface InflightFieldSliceRequest {
  consumers: number;
  controller: AbortController;
  promise: Promise<LoadedFieldSlice2D>;
}

const inflightFieldSliceRequests = new Map<string, InflightFieldSliceRequest>();

export function buildFieldSliceQueryToken(query: FieldSliceQuery): string {
  return [
    query.plane,
    query.component ?? "full",
    query.cut_world ?? "none",
    query.cut_norm ?? "none",
    query.x_size ?? "none",
    query.y_size ?? "none",
    query.max_points ?? "none",
    query.include_arrows ? "arrows" : "scalar",
    query.arrow_every ?? "none",
    query.max_arrows ?? "none",
  ].join(":");
}

export function buildFieldSliceResourceKey(params: FieldSliceRequestParams): string {
  return `${ResourceCache.fieldKey(
    params.quantityId,
    params.fieldRevision,
    params.domainGenerationId,
    params.query.component ?? "full",
  )}:slice:${buildFieldSliceQueryToken(params.query)}`;
}

export function buildFieldSliceRequestKey(params: FieldSliceRequestParams): string {
  return `field-slice:${params.quantityId}:${params.fieldRevision}:${params.domainGenerationId}:${buildFieldSliceQueryToken(params.query)}`;
}

export function getFieldSliceInflightCount(): number {
  return inflightFieldSliceRequests.size;
}

export function loadFieldSliceRequest(
  client: FieldSliceRequestClient,
  params: FieldSliceRequestParams,
): FieldSliceRequestHandle {
  const key = buildFieldSliceRequestKey(params);
  const resourceKey = buildFieldSliceResourceKey(params);
  const cached = client.getCache().get<LoadedFieldSlice2D>(resourceKey);
  if (cached && cached.revision === params.fieldRevision) {
    return {
      key,
      promise: Promise.resolve(cached.data),
      release: () => undefined,
    };
  }

  const existing = inflightFieldSliceRequests.get(key);
  if (existing) {
    existing.consumers += 1;
    return createFieldSliceRequestHandle(key, existing);
  }

  const controller = new AbortController();
  const entry: InflightFieldSliceRequest = {
    consumers: 1,
    controller,
    promise: fetchDecodeAndCacheFieldSlice(
      client,
      params,
      resourceKey,
      cached?.data ?? null,
      controller.signal,
    ),
  };
  inflightFieldSliceRequests.set(key, entry);
  void entry.promise.then(
    () => {
      if (inflightFieldSliceRequests.get(key) === entry) {
        inflightFieldSliceRequests.delete(key);
      }
    },
    () => {
      if (inflightFieldSliceRequests.get(key) === entry) {
        inflightFieldSliceRequests.delete(key);
      }
    },
  );

  return createFieldSliceRequestHandle(key, entry);
}

function createFieldSliceRequestHandle(
  key: string,
  entry: InflightFieldSliceRequest,
): FieldSliceRequestHandle {
  let released = false;
  return {
    key,
    promise: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      releaseFieldSliceRequest(key, entry);
    },
  };
}

async function fetchDecodeAndCacheFieldSlice(
  client: FieldSliceRequestClient,
  params: FieldSliceRequestParams,
  resourceKey: string,
  cached: LoadedFieldSlice2D | null,
  signal: AbortSignal,
): Promise<LoadedFieldSlice2D> {
  const meta = await client.fields.getSliceMeta(params.quantityId, params.query, {
    cache: "default",
    signal,
  });
  throwIfAborted(signal);

  const scalar = await fetchDecodeSliceScalar(
    client,
    params,
    meta,
    cached?.scalar ?? null,
    signal,
  );
  const arrows = params.query.include_arrows
    ? await fetchDecodeSliceArrows(client, params, cached?.arrows ?? null, signal)
    : null;
  throwIfAborted(signal);

  const result: LoadedFieldSlice2D = { meta, scalar, arrows };
  client.getCache().set(
    resourceKey,
    result,
    params.fieldRevision,
    params.domainGenerationId,
    scalar.etag ?? meta.etag,
  );
  return result;
}

async function fetchDecodeSliceScalar(
  client: FieldSliceRequestClient,
  params: FieldSliceRequestParams,
  meta: FieldSliceMeta,
  cached: SliceScalarData | null,
  signal: AbortSignal,
): Promise<SliceScalarData> {
  const response: FieldBinaryResponse = await client.fields.getSliceScalarResponse(
    params.quantityId,
    params.query,
    cached?.etag ?? undefined,
    { cache: "default", signal },
  );
  throwIfAborted(signal);
  if (response.status === 304 && cached) {
    return cached;
  }
  if (!response.buffer) {
    throw new Error("received slice scalar 304 without cached data");
  }
  const decoded = decodeSliceScalar(response.buffer, meta);
  return { ...decoded, etag: response.etag };
}

async function fetchDecodeSliceArrows(
  client: FieldSliceRequestClient,
  params: FieldSliceRequestParams,
  cached: SliceArrowData | null,
  signal: AbortSignal,
): Promise<SliceArrowData> {
  const response: FieldBinaryResponse = await client.fields.getSliceArrowsResponse(
    params.quantityId,
    params.query,
    cached?.etag ?? undefined,
    { cache: "default", signal },
  );
  throwIfAborted(signal);
  if (response.status === 304 && cached) {
    return cached;
  }
  if (!response.buffer) {
    throw new Error("received slice arrows 304 without cached data");
  }
  const decoded = decodeSliceArrows(response.buffer);
  return { ...decoded, etag: response.etag };
}

function releaseFieldSliceRequest(
  key: string,
  entry: InflightFieldSliceRequest,
): void {
  if (inflightFieldSliceRequests.get(key) !== entry) {
    return;
  }
  entry.consumers -= 1;
  if (entry.consumers > 0) return;
  inflightFieldSliceRequests.delete(key);
  entry.controller.abort();
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (typeof DOMException !== "undefined") {
    throw new DOMException("field slice request aborted", "AbortError");
  }
  throw new Error("field slice request aborted");
}

export function useFieldSlice2D(
  quantityId: string | null,
  fieldRevision: number | null,
  domainGenerationId: number,
  query: FieldSliceQuery | null,
): UseFieldSlice2DResult {
  const [meta, setMeta] = useState<FieldSliceMeta | null>(null);
  const [scalar, setScalar] = useState<SliceScalarData | null>(null);
  const [arrows, setArrows] = useState<SliceArrowData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<LiveApiError | null>(null);

  const fetchedKeyRef = useRef<string | null>(null);
  const activeRequestRef = useRef<string | null>(null);

  const fetchSlice = useCallback(
    (
      qId: string,
      rev: number,
      domainGenId: number,
      q: FieldSliceQuery,
    ) => {
      const params: FieldSliceRequestParams = {
        quantityId: qId,
        fieldRevision: rev,
        domainGenerationId: domainGenId,
        query: q,
      };
      const queryKey = buildFieldSliceRequestKey(params);
      if (fetchedKeyRef.current === queryKey) return () => undefined;
      activeRequestRef.current = queryKey;
      setLoading(true);
      setError(null);

      const client = getLiveSessionClient();
      const request = loadFieldSliceRequest(client, params);
      let active = true;
      request.promise
        .then((result) => {
          if (!active || activeRequestRef.current !== request.key) return;
          fetchedKeyRef.current = queryKey;
          setMeta(result.meta);
          setScalar(result.scalar);
          setArrows(result.arrows);
          setLoading(false);
        })
        .catch((err) => {
          if (!active || activeRequestRef.current !== request.key) return;
          const apiErr =
            err instanceof LiveApiError
              ? err
              : LiveApiError.networkError("field-slice-2d", err);
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
    if (!quantityId || fieldRevision == null || !query) {
      activeRequestRef.current = null;
      fetchedKeyRef.current = null;
      setMeta(null);
      setScalar(null);
      setArrows(null);
      setLoading(false);
      setError(null);
      return undefined;
    }
    return fetchSlice(quantityId, fieldRevision, domainGenerationId, query);
  }, [quantityId, fieldRevision, domainGenerationId, query, fetchSlice]);

  return { meta, scalar, arrows, loading, error };
}

// ── Binary decode helpers ────────────────────────────────────────────

/**
 * Decode a scalar slice binary buffer (FMVP v2 format, nComp=1).
 * Falls back to a plain f64 array if the magic header is absent.
 */
function decodeSliceScalar(buffer: ArrayBuffer, meta: FieldSliceMeta): SliceScalarData {
  const view = new DataView(buffer);

  // Check FMVP magic: bytes 0-3 = "FMVP"
  const hasMagic =
    view.getUint8(0) === 0x46 && // F
    view.getUint8(1) === 0x4d && // M
    view.getUint8(2) === 0x56 && // V
    view.getUint8(3) === 0x50;   // P

  let values: Float64Array;

  if (hasMagic) {
    // FMVP v2 header: 48 bytes total before payload.
    // Bytes 12-15: elementCount (u32 LE)
    const valueCount = view.getUint32(12, true);
    values = new Float64Array(buffer, 48, valueCount);
  } else {
    // Plain f64 payload.
    values = new Float64Array(buffer);
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }

  return {
    values,
    xPixels: meta.x_pixels,
    yPixels: meta.y_pixels,
    min: isFinite(min) ? min : 0,
    max: isFinite(max) ? max : 0,
    etag: null,
  };
}

/**
 * Decode arrow glyphs binary buffer in FMVP v2 format (nComp=2, f64).
 */
function decodeSliceArrows(buffer: ArrayBuffer): SliceArrowData {
  const view = new DataView(buffer);
  const hasMagic =
    view.getUint8(0) === 0x46 &&
    view.getUint8(1) === 0x4d &&
    view.getUint8(2) === 0x56 &&
    view.getUint8(3) === 0x50;

  let values: Float64Array;
  if (hasMagic) {
    const valueCount = view.getUint32(12, true);
    values = new Float64Array(buffer, 48, valueCount);
  } else {
    values = new Float64Array(buffer);
  }

  const arrowCount = Math.floor(values.length / 2);
  return { values, arrowCount, etag: null };
}

export const __fieldSliceDecodeInternals = {
  decodeSliceScalar,
  decodeSliceArrows,
};
