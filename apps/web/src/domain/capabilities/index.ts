export type { CapabilityMap } from "./CapabilityMap";
export {
  shouldFetchTopology,
  canShowWireframe,
  canShowGridDimensions,
  getAvailableAlgorithms,
  synthesizeCapabilitiesFromDiscretization,
  isFemDiscretization,
  isFdmDiscretization,
  resolveFemDiscretization,
} from "./capabilityGuards";
