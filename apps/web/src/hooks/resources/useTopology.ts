"use client";

import { useDomainResource } from "./useDomainResource";
import type { SpatialDomainAdapter } from "../../domain/adapters/SpatialDomainAdapter";
import type { LiveApiError } from "../../api/client/errors/LiveApiError";

export interface UseTopologyResult {
  topology: SpatialDomainAdapter | null;
  loading: boolean;
  error: LiveApiError | null;
}

export function useTopology(
  domainGenerationId: number | null,
): UseTopologyResult {
  const { adapter, loading, error } = useDomainResource(domainGenerationId);

  return {
    topology: adapter,
    loading,
    error,
  };
}
