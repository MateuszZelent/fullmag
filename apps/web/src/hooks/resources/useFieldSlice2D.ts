"use client";

/**
 * Hook: fetches a 2-D slice of a field (scalar + optional arrows) without
 * transferring the full 3-D vector buffer. Uses ETag/304 for cache coherence.
 *
 * Architecture note: this hook is the canonical path for 2-D viewport rendering.
 * Never request the full 3-D field vector just to display a 2-D slice.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type { FieldSliceMeta, FieldSliceQuery } from "../../api/types";
import { getLiveApiClient } from "../../api/client/LiveApiClient";
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

  const prevKeyRef = useRef<string | null>(null);
  const scalarEtagRef = useRef<string | null>(null);
  const arrowEtagRef = useRef<string | null>(null);

  const fetchSlice = useCallback(
    async (
      qId: string,
      rev: number,
      domainGenId: number,
      q: FieldSliceQuery,
    ) => {
      // Stable key for dedup — include all query params that change the rendered output.
      const queryKey = JSON.stringify({
        qId, rev, domainGenId,
        plane: q.plane,
        component: q.component ?? "full",
        cut_world: q.cut_world,
        cut_norm: q.cut_norm,
        x_size: q.x_size,
        y_size: q.y_size,
        max_points: q.max_points,
        include_arrows: q.include_arrows,
        arrow_every: q.arrow_every,
        max_arrows: q.max_arrows,
      });

      if (prevKeyRef.current === queryKey) return;
      setLoading(true);
      setError(null);

      try {
        const client = getLiveApiClient();

        // 1. Fetch lightweight metadata first.
        const newMeta = await client.fields.getSliceMeta(qId, q);
        setMeta(newMeta);

        // 2. Fetch scalar buffer, conditional on ETag.
        const scalarResp = await client.fields.getSliceScalarResponse(
          qId,
          q,
          scalarEtagRef.current ?? undefined,
        );

        if (scalarResp.status === 200 && scalarResp.buffer) {
          const decoded = decodeSliceScalar(scalarResp.buffer, newMeta);
          scalarEtagRef.current = scalarResp.etag;
          setScalar({ ...decoded, etag: scalarResp.etag });
        }
        // On 304 the previous scalar state remains valid.

        // 3. Optionally fetch arrow buffer.
        if (q.include_arrows) {
          const arrowResp = await client.fields.getSliceArrowsResponse(
            qId,
            q,
            arrowEtagRef.current ?? undefined,
          );

          if (arrowResp.status === 200 && arrowResp.buffer) {
            const decoded = decodeSliceArrows(arrowResp.buffer);
            arrowEtagRef.current = arrowResp.etag;
            setArrows({ ...decoded, etag: arrowResp.etag });
          }
        } else {
          setArrows(null);
          arrowEtagRef.current = null;
        }

        prevKeyRef.current = queryKey;
        setLoading(false);
      } catch (err) {
        const apiErr =
          err instanceof LiveApiError
            ? err
            : LiveApiError.networkError("field-slice-2d", err);
        setError(apiErr);
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (quantityId && fieldRevision != null && query) {
      fetchSlice(quantityId, fieldRevision, domainGenerationId, query);
    }
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
