/**
 * useFemGeometryDisposalAudit — tracks FEM geometry resources in the viewport
 * resource manager and disposes stale entries on unmount or geometry change.
 *
 * Extracted from FemGeometry.tsx so the disposal concern is isolated from
 * geometry-build and render logic.
 */

import { useEffect, useLayoutEffect, useMemo } from "react";
import type * as THREE from "three";
import {
  estimateThreeBufferGeometryBytes,
  releaseViewportResource,
  trackViewportResource,
} from "@/lib/debug/viewportResourceManager";

export interface FemGeometryDisposalAuditArgs {
  resourceOwner: string;
  geometry: THREE.BufferGeometry | null;
  edgesGeometry: THREE.BufferGeometry | null;
  tetraEdgesGeometry: THREE.BufferGeometry | null;
  pointsGeometry: THREE.BufferGeometry | null;
}

/** Derive stable, typed resource key set from a resource owner string. */
function makeKeys(owner: string) {
  return {
    surface: `${owner}:surface`,
    edges: `${owner}:edges`,
    tetraEdges: `${owner}:tetraEdges`,
    points: `${owner}:points`,
  } as const;
}

/**
 * Registers each geometry in the viewport resource manager on change, and
 * releases all on unmount.
 *
 * Register / release calls are in `useLayoutEffect` to run synchronously
 * after DOM mutations (keeping resource accounting tight) and in `useEffect`
 * cleanup for unmount.
 */
export function useFemGeometryDisposalAudit({
  resourceOwner,
  geometry,
  edgesGeometry,
  tetraEdgesGeometry,
  pointsGeometry,
}: FemGeometryDisposalAuditArgs): void {
  const keys = useMemo(() => makeKeys(resourceOwner), [resourceOwner]);

  useLayoutEffect(() => {
    const register = (
      key: string,
      label: string,
      resource: THREE.BufferGeometry | null,
    ) => {
      if (!resource) {
        releaseViewportResource(key);
        return;
      }
      trackViewportResource({
        key,
        owner: resourceOwner,
        label,
        resource,
        estimatedBytes: estimateThreeBufferGeometryBytes(resource),
        dispose: () => resource.dispose(),
      });
    };

    register(keys.surface, "FEM surface geometry", geometry);
    register(keys.edges, "FEM wireframe geometry", edgesGeometry);
    register(keys.tetraEdges, "FEM volume-edge geometry", tetraEdgesGeometry);
    register(keys.points, "FEM points geometry", pointsGeometry);
  }, [
    keys,
    resourceOwner,
    geometry,
    edgesGeometry,
    tetraEdgesGeometry,
    pointsGeometry,
  ]);

  useEffect(() => {
    return () => {
      releaseViewportResource(keys.surface);
      releaseViewportResource(keys.edges);
      releaseViewportResource(keys.tetraEdges);
      releaseViewportResource(keys.points);
    };
  }, [keys]);
}
