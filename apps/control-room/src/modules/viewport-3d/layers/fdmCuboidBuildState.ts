import type { FdmCuboidBuildResult } from "./fdmCuboidBuildModel";

export type FdmCuboidBuildStatus = "idle" | "pending" | "ready" | "error";

export interface FdmCuboidBuildState {
  readonly buildKey: string | null;
  readonly error: Error | null;
  readonly result: FdmCuboidBuildResult | null;
  readonly status: FdmCuboidBuildStatus;
}

export interface FdmCuboidBuildSnapshot extends FdmCuboidBuildState {
  readonly topologyKey: string | null;
}

export interface FdmCuboidBuildStateController {
  readonly begin: (buildKey: string, topologyKey?: string | null) => void;
  readonly getSnapshot: () => FdmCuboidBuildSnapshot;
  readonly reject: (buildKey: string, error: unknown) => void;
  readonly resolve: (buildKey: string, result: FdmCuboidBuildResult) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export const EMPTY_FDM_CUBOID_BUILD_SNAPSHOT: FdmCuboidBuildSnapshot =
  Object.freeze({
    buildKey: null,
    error: null,
    result: null,
    status: "idle" as const,
    topologyKey: null,
  });

export function resolveFdmCuboidBuildState({
  currentBuildKey,
  currentTopologyKey,
  snapshot,
}: {
  currentBuildKey: string | null;
  currentTopologyKey: string | null;
  snapshot: FdmCuboidBuildSnapshot;
}): FdmCuboidBuildState {
  if (!currentBuildKey) {
    return { buildKey: null, error: null, result: null, status: "idle" };
  }
  if (snapshot.buildKey !== currentBuildKey) {
    const retainLastGoodResult =
      snapshot.topologyKey !== null &&
      snapshot.topologyKey === currentTopologyKey &&
      snapshot.result !== null;
    return {
      buildKey: currentBuildKey,
      error: null,
      result: retainLastGoodResult ? snapshot.result : null,
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

export function createFdmCuboidBuildStateController(): FdmCuboidBuildStateController {
  let snapshot = EMPTY_FDM_CUBOID_BUILD_SNAPSHOT;
  let topologyKey: string | null = null;
  const listeners = new Set<() => void>();
  const publish = (nextSnapshot: FdmCuboidBuildSnapshot) => {
    if (snapshot === nextSnapshot) return;
    snapshot = nextSnapshot;
    for (const listener of listeners) listener();
  };

  return {
    begin: (buildKey, nextTopologyKey = null) => {
      const retainLastGood =
        nextTopologyKey !== null && topologyKey !== null && nextTopologyKey === topologyKey;
      topologyKey = nextTopologyKey;
      publish({
        buildKey,
        error: null,
        result: retainLastGood ? snapshot.result : null,
        status: "pending",
        topologyKey: nextTopologyKey,
      });
    },
    getSnapshot: () => snapshot,
    reject: (buildKey, error) => {
      if (snapshot.buildKey !== buildKey || isFdmCuboidBuildAbortError(error)) {
        return;
      }
      publish({
        buildKey,
        error: error instanceof Error ? error : new Error(String(error)),
        result: snapshot.result,
        status: "error",
        topologyKey: snapshot.topologyKey,
      });
    },
    resolve: (buildKey, result) => {
      if (snapshot.buildKey !== buildKey) return;
      publish({
        buildKey,
        error: null,
        result: mergeFdmCuboidBuildResult(snapshot.result, result),
        status: "ready",
        topologyKey: snapshot.topologyKey,
      });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function mergeFdmCuboidBuildResult(
  previous: FdmCuboidBuildResult | null,
  next: FdmCuboidBuildResult,
): FdmCuboidBuildResult {
  if (next.model !== null || previous?.model === null || previous === null) {
    return next;
  }
  return {
    ...next,
    model: previous.model,
  };
}

function isFdmCuboidBuildAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message === "FDM cuboid build aborted")
  );
}
