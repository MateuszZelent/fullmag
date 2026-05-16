import type {
  ArrowSamplingMode,
  FemVectorDomainFilter,
} from "./femMeshTypes";

export interface AirboxVectorScopeLayer {
  part: {
    role?: string | null;
  };
  viewState: {
    vectorsScope?: "surface" | "full" | null;
  };
}

export function resolveAirboxArrowSamplingMode({
  resolvedVectorDomain,
  arrowSamplingMode,
  visibleLayers,
}: {
  resolvedVectorDomain: FemVectorDomainFilter;
  arrowSamplingMode: ArrowSamplingMode;
  visibleLayers: readonly AirboxVectorScopeLayer[];
}): ArrowSamplingMode {
  if (resolvedVectorDomain !== "airbox_only") {
    return arrowSamplingMode;
  }

  const airLayer = visibleLayers.find(
    (layer) => layer.part.role === "air" || layer.part.role === "outer_boundary",
  );

  return (airLayer?.viewState.vectorsScope ?? "surface") === "full"
    ? "volume"
    : "surface";
}
