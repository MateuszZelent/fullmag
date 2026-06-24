"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";

import type { DecodedTopology } from "@/kernel/api/codecs";

import { buildViewport3DTopologyIndexJobKey } from "../build-engine/viewport3dBuildJobKeys";
import {
  buildViewport3DTopologyIndicesOffMainThread,
  type Viewport3DTopologyIndexBuildRequest,
} from "../viewport3dTopologyIndexScheduler";
import type {
  Viewport3DTopologyIndexBundle,
  Viewport3DTopologyIndexPartInput,
} from "../viewport3dTopologyIndexModel";

export type Viewport3DTopologyIndexBuildStatus =
  | "building"
  | "idle"
  | "ready"
  | "unavailable";

export interface Viewport3DTopologyIndexIdentity {
  airboxParts: object;
  magneticParts: object;
  magneticSurfacePartsByPartId: object;
  topology: object;
}

export interface Viewport3DTopologyIndexBuildReference {
  buildKey: string;
  groupKey: string;
  revisionSummary: string;
}

export interface Viewport3DTopologyIndexBuildReferenceInput {
  domainId: string;
  sessionId: string;
  targetVisualizationRevision: string | null;
  topologyRevision: string | null;
}

interface Viewport3DTopologyIndexReducerState {
  bundle: Viewport3DTopologyIndexBundle | null;
  identity: Viewport3DTopologyIndexIdentity | null;
  pending: boolean;
  unavailable: boolean;
}

type Viewport3DTopologyIndexAction =
  | { identity: Viewport3DTopologyIndexIdentity; type: "start" }
  | {
      bundle: Viewport3DTopologyIndexBundle;
      identity: Viewport3DTopologyIndexIdentity;
      type: "success";
    }
  | { identity: Viewport3DTopologyIndexIdentity; type: "unavailable" };

export interface Viewport3DTopologyIndexBundleResult {
  bundle: Viewport3DTopologyIndexBundle | null;
  status: Viewport3DTopologyIndexBuildStatus;
}

const VIEWPORT_3D_TOPOLOGY_INDEX_INITIAL_STATE: Viewport3DTopologyIndexReducerState =
  {
    bundle: null,
    identity: null,
    pending: false,
    unavailable: false,
  };

export function createViewport3DTopologyIndexBuildReference({
  domainId,
  sessionId,
  targetVisualizationRevision,
  topologyRevision,
}: Viewport3DTopologyIndexBuildReferenceInput): Viewport3DTopologyIndexBuildReference | null {
  if (!topologyRevision) return null;
  const resolvedTargetRevision = targetVisualizationRevision ?? "unknown";
  return {
    buildKey: buildViewport3DTopologyIndexJobKey({
      algorithmVersion: 1,
      component: null,
      domainId,
      fieldRevision: null,
      quantityId: null,
      samplingRevision: "none",
      scopeId: null,
      scopeKind: null,
      sessionId,
      styleRevision: "none",
      targetVisualizationRevision: resolvedTargetRevision,
      topologyRevision,
    }),
    groupKey: `topology-index:session=${sessionId}:domain=${domainId}`,
    revisionSummary: `topology=${topologyRevision} targets=${resolvedTargetRevision}`,
  };
}

function viewport3DTopologyIndexReducer(
  _state: Viewport3DTopologyIndexReducerState,
  action: Viewport3DTopologyIndexAction,
): Viewport3DTopologyIndexReducerState {
  switch (action.type) {
    case "start":
      return {
        bundle: null,
        identity: action.identity,
        pending: true,
        unavailable: false,
      };
    case "success":
      return {
        bundle: action.bundle,
        identity: action.identity,
        pending: false,
        unavailable: false,
      };
    case "unavailable":
      return {
        bundle: null,
        identity: action.identity,
        pending: false,
        unavailable: true,
      };
  }
}

export function viewport3DTopologyIndexStateIsCompatible(
  current: Viewport3DTopologyIndexIdentity | null,
  request: Viewport3DTopologyIndexIdentity | null,
): boolean {
  return Boolean(
    current &&
      request &&
      current.topology === request.topology &&
      current.magneticParts === request.magneticParts &&
      current.airboxParts === request.airboxParts &&
      current.magneticSurfacePartsByPartId ===
        request.magneticSurfacePartsByPartId,
  );
}

export function resolveViewport3DTopologyIndexStatus({
  enabled,
  hasCompatibleBundle,
  hasCompatibleUnavailableState,
  hasTopology,
  pendingForCurrentRequest,
}: {
  enabled: boolean;
  hasCompatibleBundle: boolean;
  hasCompatibleUnavailableState: boolean;
  hasTopology: boolean;
  pendingForCurrentRequest: boolean;
}): Viewport3DTopologyIndexBuildStatus {
  if (!enabled || !hasTopology) return "idle";
  if (hasCompatibleBundle) return "ready";
  if (hasCompatibleUnavailableState) return "unavailable";
  if (pendingForCurrentRequest) return "building";
  return "building";
}

export function useViewport3DTopologyIndexBundle({
  airboxParts,
  domainId = "shared-domain",
  enabled,
  magneticParts,
  magneticSurfacePartsByPartId,
  sessionId = "current",
  targetVisualizationRevision,
  topology,
  topologyRevision,
}: {
  airboxParts: readonly Viewport3DTopologyIndexPartInput[];
  domainId?: string;
  enabled: boolean;
  magneticParts: readonly Viewport3DTopologyIndexPartInput[];
  magneticSurfacePartsByPartId: ReadonlyMap<
    string,
    readonly Viewport3DTopologyIndexPartInput[]
  >;
  sessionId?: string;
  targetVisualizationRevision?: string | null;
  topology: DecodedTopology | null | undefined;
  topologyRevision?: string | null;
}): Viewport3DTopologyIndexBundleResult {
  const [state, dispatch] = useReducer(
    viewport3DTopologyIndexReducer,
    VIEWPORT_3D_TOPOLOGY_INDEX_INITIAL_STATE,
  );
  const activeBuildIdRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);
  const identity = useMemo<Viewport3DTopologyIndexIdentity | null>(
    () =>
      topology
        ? {
            airboxParts,
            magneticParts,
            magneticSurfacePartsByPartId,
            topology,
          }
        : null,
    [airboxParts, magneticParts, magneticSurfacePartsByPartId, topology],
  );
  const buildReference = useMemo(
    () =>
      createViewport3DTopologyIndexBuildReference({
        domainId,
        sessionId,
        targetVisualizationRevision: targetVisualizationRevision ?? null,
        topologyRevision: topologyRevision ?? null,
      }),
    [domainId, sessionId, targetVisualizationRevision, topologyRevision],
  );
  const compatible = viewport3DTopologyIndexStateIsCompatible(
    state.identity,
    identity,
  );
  const hasCompatibleBundle = compatible && Boolean(state.bundle);
  const pendingForCurrentRequest = compatible && state.pending;
  const hasCompatibleUnavailableState = compatible && state.unavailable;
  const status = resolveViewport3DTopologyIndexStatus({
    enabled,
    hasCompatibleBundle,
    hasCompatibleUnavailableState,
    hasTopology: Boolean(topology),
    pendingForCurrentRequest,
  });

  useEffect(() => {
    return () => {
      activeBuildIdRef.current += 1;
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !topology || !identity || status !== "building") {
      return undefined;
    }
    if (pendingForCurrentRequest) {
      return undefined;
    }

    activeBuildIdRef.current += 1;
    activeControllerRef.current?.abort();
    const buildId = activeBuildIdRef.current;
    const controller = new AbortController();
    activeControllerRef.current = controller;
    dispatch({ identity, type: "start" });

    const request: Viewport3DTopologyIndexBuildRequest = {
      airboxParts,
      magneticParts,
      magneticSurfacePartsByPartId,
      topology: {
        boundaryFaces: topology.boundaryFaces,
        indices: topology.indices,
        nodeCount: topology.nodeCount,
      },
    };

    void buildViewport3DTopologyIndicesOffMainThread(request, {
      buildKey: buildReference?.buildKey,
      groupKey: buildReference?.groupKey,
      latestWins: true,
      revisionSummary: buildReference?.revisionSummary,
      signal: controller.signal,
    })
      .then((bundle) => {
        if (activeBuildIdRef.current === buildId) {
          dispatch({ bundle, identity, type: "success" });
        }
      })
      .catch((error) => {
        if (activeBuildIdRef.current !== buildId || isAbortError(error)) {
          return;
        }
        dispatch({ identity, type: "unavailable" });
      })
      .finally(() => {
        if (activeBuildIdRef.current === buildId) {
          activeControllerRef.current = null;
        }
      });

    return undefined;
  }, [
    airboxParts,
    buildReference?.buildKey,
    buildReference?.groupKey,
    buildReference?.revisionSummary,
    enabled,
    identity,
    magneticParts,
    magneticSurfacePartsByPartId,
    pendingForCurrentRequest,
    status,
    topology,
  ]);

  return {
    bundle: hasCompatibleBundle ? state.bundle : null,
    status,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
