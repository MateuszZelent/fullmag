"use client";

import { useFieldSlice2D } from "./useFieldSlice2D";
import type {
  SliceArrowData,
  SliceScalarData,
  UseFieldSlice2DResult,
} from "./useFieldSlice2D";
import type { FieldSliceMeta, FieldSliceQuery } from "../../api/types";
import type { LiveApiError } from "../../api/client/errors/LiveApiError";

export interface UseSliceResourceResult {
  meta: FieldSliceMeta | null;
  scalar: SliceScalarData | null;
  vectors: SliceArrowData | null;
  arrows: SliceArrowData | null;
  loading: boolean;
  error: LiveApiError | null;
}

export function useSliceResource(
  quantityId: string | null,
  fieldRevision: number | null,
  domainGenerationId: number,
  query: FieldSliceQuery | null,
): UseSliceResourceResult {
  const result: UseFieldSlice2DResult = useFieldSlice2D(
    quantityId,
    fieldRevision,
    domainGenerationId,
    query,
  );

  return {
    meta: result.meta,
    scalar: result.scalar,
    vectors: result.arrows,
    arrows: result.arrows,
    loading: result.loading,
    error: result.error,
  };
}
