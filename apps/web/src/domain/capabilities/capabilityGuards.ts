import type { CapabilityMap } from "../../api/contracts";

export function shouldFetchTopology(caps: CapabilityMap): boolean {
  return caps.explicit_topology;
}

export function canShowWireframe(caps: CapabilityMap): boolean {
  return caps.explicit_topology;
}

export function canShowGridDimensions(caps: CapabilityMap): boolean {
  return caps.structured_grid;
}

export function getAvailableAlgorithms(caps: CapabilityMap): string[] {
  return caps.algorithms_available;
}

/**
 * Semantic replacement for a raw FEM/FDM discretization boolean.
 * Returns true when the domain uses explicit (unstructured) topology,
 * which is the defining characteristic of a FEM discretization.
 */
export function isFemDiscretization(caps: CapabilityMap): boolean {
  return caps.explicit_topology;
}

/**
 * Returns true when the domain uses a structured grid (FDM discretization).
 */
export function isFdmDiscretization(caps: CapabilityMap): boolean {
  return caps.structured_grid;
}

/**
 * Transitional bridge for callers that already have canonical capabilities
 * but still need a plain discretization fallback.
 */
export function resolveFemDiscretization(
  caps: CapabilityMap | null | undefined,
  fallbackFemDiscretization = false,
): boolean {
  return caps ? isFemDiscretization(caps) : fallbackFemDiscretization;
}
