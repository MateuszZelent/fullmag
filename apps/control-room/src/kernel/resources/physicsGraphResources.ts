"use client";

import { useCallback } from "react";

import type { PhysicsGraphResource, ResourceRevision } from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import { useResource } from "./useResource";

export const PHYSICS_GRAPH_RESOURCE_KEY = "model.physics-graph";

interface ResourceHookOptions {
  enabled?: boolean;
}

function sceneRevision(
  resource: PhysicsGraphResource | null | undefined,
): ResourceRevision | null {
  return resource?.scene_revision ?? null;
}

/** Read the canonical authored physics-module graph for Explorer placement. */
export function usePhysicsGraphResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.model.physicsGraph({ signal }),
    [api],
  );
  return useResource<PhysicsGraphResource>({
    enabled: options.enabled,
    load,
    resolveRevision: sceneRevision,
    resourceKey: PHYSICS_GRAPH_RESOURCE_KEY,
  });
}
