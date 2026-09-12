export interface ViewportCameraFitDecision {
  nextFitSignature: string | null;
  shouldAdvanceGeneration: boolean;
}

export function buildViewportFitSeed(args: {
  resolvedFemTopologyKey: string | null;
  scaledFemMeshData:
    | {
        nNodes: number;
        nElements: number;
        boundaryFaces: ArrayLike<number>;
      }
    | null
    | undefined;
}): string {
  const sampleKey = args.scaledFemMeshData
    ? `${args.scaledFemMeshData.nNodes}:${args.scaledFemMeshData.nElements}:${args.scaledFemMeshData.boundaryFaces.length}`
    : "none";
  return [args.resolvedFemTopologyKey ?? "no-topology", sampleKey].join("|");
}

export function resolveViewportCameraFitDecision(args: {
  enabled: boolean;
  persistedCameraAvailable: boolean;
  previousFitSignature: string | null;
  viewportFitSeed: string | number | null | undefined;
  forceFitSeed?: string | number | null | undefined;
}): ViewportCameraFitDecision {
  if (!args.enabled) {
    return {
      nextFitSignature: args.previousFitSignature,
      shouldAdvanceGeneration: false,
    };
  }

  const forceFitSignature = args.forceFitSeed == null ? null : `force:${String(args.forceFitSeed)}`;
  const nextFitSignature =
    forceFitSignature ??
    (args.viewportFitSeed == null ? "initial" : String(args.viewportFitSeed));

  if (forceFitSignature) {
    return {
      nextFitSignature,
      shouldAdvanceGeneration: args.previousFitSignature !== nextFitSignature,
    };
  }

  if (args.persistedCameraAvailable) {
    return {
      nextFitSignature,
      shouldAdvanceGeneration: false,
    };
  }

  return {
    nextFitSignature,
    shouldAdvanceGeneration: args.previousFitSignature !== nextFitSignature,
  };
}
