import type {
  FdmCuboidBuildRequest,
  FdmCuboidBuildResult,
} from "./fdmCuboidBuildModel";

export type FdmCuboidBuildStatus = "idle" | "pending" | "ready" | "error";

export interface FdmCuboidBuildState {
  readonly buildKey: string | null;
  readonly error: Error | null;
  readonly result: FdmCuboidBuildResult | null;
  readonly status: FdmCuboidBuildStatus;
}

export interface FdmCuboidBuildSnapshot extends FdmCuboidBuildState {
  readonly request: FdmCuboidBuildRequest | null;
}

export function resolveFdmCuboidBuildState({
  currentBuildKey,
  snapshot,
}: {
  currentBuildKey: string | null;
  snapshot: FdmCuboidBuildSnapshot;
}): FdmCuboidBuildState {
  if (!currentBuildKey) {
    return { buildKey: null, error: null, result: null, status: "idle" };
  }
  if (snapshot.buildKey !== currentBuildKey) {
    return {
      buildKey: currentBuildKey,
      error: null,
      result: null,
      status: "pending",
    };
  }
  return {
    buildKey: currentBuildKey,
    error: snapshot.error,
    result: snapshot.result,
    status: snapshot.status,
  };
}
