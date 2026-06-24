import type {
  Viewport3DBuildJobKey,
  Viewport3DBuildLane,
} from "../viewport3dBuildEngineTypes";

export interface Viewport3DDerivedBufferCacheKeyParts {
  readonly algorithmVersion: number;
  readonly groupKey: string;
  readonly lane: Viewport3DBuildLane;
  readonly revisionSummary: string;
}

export function buildViewport3DDerivedBufferCacheKey(
  parts: Viewport3DDerivedBufferCacheKeyParts,
): Viewport3DBuildJobKey {
  return `${parts.lane}:${JSON.stringify(parts)}`;
}
