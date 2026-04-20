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
