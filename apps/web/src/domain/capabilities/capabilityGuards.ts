import type { CapabilityMap } from "../../api/generated/openapi-types";

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
 * Transitional fallback for legacy snapshot paths that only expose
 * discretization semantics, not a canonical resource-first capability map.
 */
export function synthesizeCapabilitiesFromDiscretization(
  femDiscretization: boolean,
): CapabilityMap {
  return {
    structured_grid: !femDiscretization,
    explicit_topology: femDiscretization,
    binary_fields: true,
    cell_fields: !femDiscretization,
    node_fields: femDiscretization,
    scalar_history: true,
    eigen_modes: false,
    gpu_telemetry: false,
    preview_2d: true,
    preview_3d: true,
    algorithms_available: [],
  };
}

/**
 * Semantic replacement for the legacy FEM/FDM snapshot boolean.
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
 * but still need to tolerate legacy snapshot paths.
 */
export function resolveFemDiscretization(
  caps: CapabilityMap | null | undefined,
  legacyFemBackend = false,
): boolean {
  return caps ? isFemDiscretization(caps) : legacyFemBackend;
}
