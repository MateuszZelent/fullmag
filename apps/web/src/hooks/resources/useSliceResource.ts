"use client";

import { useMemo } from "react";

import { useFieldSlice2D } from "./useFieldSlice2D";
import type {
  SliceArrowData,
  SliceScalarData,
  UseFieldSlice2DResult,
} from "./useFieldSlice2D";
import type {
  CapabilityMap,
  DisplaySelection,
  FieldSliceMeta,
  FieldSliceQuery,
  ResourceRevisionMap,
} from "../../api/types";
import type { LiveApiError } from "../../api/client/errors/LiveApiError";
import {
  buildSlice2DModel,
} from "../../features/slice2d";
import type { Slice2DModel } from "../../features/slice2d";
import type { slicePlaneFromDisplay } from "../../features/workspaceSync/contracts";

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

export function useSlice2DModel(args: {
  display: DisplaySelection;
  resources?: Partial<ResourceRevisionMap> | null;
  capabilities?: CapabilityMap | null;
  adapterKind: "fdm" | "fem";
  planeOptions?: Parameters<typeof slicePlaneFromDisplay>[1];
}): Slice2DModel {
  return useMemo(
    () =>
      buildSlice2DModel({
        display: args.display,
        resources: args.resources,
        capabilities: args.capabilities,
        adapterKind: args.adapterKind,
        planeOptions: args.planeOptions,
      }),
    [
      args.adapterKind,
      args.capabilities,
      args.display,
      args.planeOptions,
      args.resources,
    ],
  );
}
