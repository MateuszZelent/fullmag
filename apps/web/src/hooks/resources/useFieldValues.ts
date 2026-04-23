"use client";

import { useFieldVector } from "./useFieldVector";
import type { DecodedFieldVector } from "../../api/codecs/types";
import type { FieldComponent } from "../../api/types";
import type { LiveApiError } from "../../api/client/errors/LiveApiError";

export interface UseFieldValuesOptions {
  component: FieldComponent;
  domainGenerationId?: number;
}

export interface UseFieldValuesResult {
  values: DecodedFieldVector | null;
  loading: boolean;
  error: LiveApiError | null;
}

export function useFieldValues(
  quantityId: string | null,
  fieldRevision: number | null,
  options: UseFieldValuesOptions,
): UseFieldValuesResult {
  const { field, loading, error } = useFieldVector(quantityId, fieldRevision, {
    component: options.component,
    domainGenerationId: options.domainGenerationId,
  });

  return {
    values: field,
    loading,
    error,
  };
}
