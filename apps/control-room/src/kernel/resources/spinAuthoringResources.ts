"use client";

import { useCallback } from "react";

import type {
  CurrentTransportListResource,
  OerstedFieldListResource,
  ResourceRevision,
  SpinTorqueListResource,
  SpinInterfaceListResource,
  SpinTransportListResource,
} from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import type { ResourceInvalidationController } from "./ResourceInvalidationController";
import type { ResourceKey } from "./resourceTypes";

import { useResource } from "./useResource";
import { useSceneResource, useMeshSharedDomainManifestResource } from "./geometryLifecycleResources";
import { useGeometryRealizationResource } from "./useGeometryRealizationResource";
import type { DecodedTopology } from "../api/codecs/types";
import type { MeshRegionMembershipResource, MeshSharedDomainManifestResource } from "../api/apiTypes";
import { PHYSICS_GRAPH_RESOURCE_KEY } from "./physicsGraphResources";
import { useSessionScopedResourceKey } from "./useSessionScopedResourceKey";

export const CURRENT_TRANSPORTS_RESOURCE_KEY = "model.current-transports";
export const SPIN_TORQUES_RESOURCE_KEY = "model.spin-torques";
export const SPIN_TRANSPORTS_RESOURCE_KEY = "model.spin-transports";
export const SPIN_INTERFACES_RESOURCE_KEY = "model.spin-interfaces";
export const OERSTED_FIELDS_RESOURCE_KEY = "model.oersted-fields";

export function transportMutationResourceKeys(
  family: "current_transport" | "spin_transport",
): readonly ResourceKey[] {
  return family === "current_transport"
    ? [CURRENT_TRANSPORTS_RESOURCE_KEY, PHYSICS_GRAPH_RESOURCE_KEY]
    : [
        SPIN_TRANSPORTS_RESOURCE_KEY,
        SPIN_INTERFACES_RESOURCE_KEY,
        PHYSICS_GRAPH_RESOURCE_KEY,
      ];
}

interface ResourceHookOptions {
  enabled?: boolean;
}

export function invalidateSpinAuthoringResources(
  resources: Pick<ResourceInvalidationController, "invalidate">,
  commit: { scene_revision: number },
  resourceKeys: readonly ResourceKey[],
): void {
  const keys = new Set<ResourceKey>([
    ...resourceKeys,
    PHYSICS_GRAPH_RESOURCE_KEY,
  ]);
  for (const resourceKey of keys) {
    resources.invalidate(resourceKey, commit.scene_revision);
  }
}

function sceneRevision(resource: { scene_revision: number } | null | undefined): ResourceRevision | null {
  return resource?.scene_revision ?? null;
}

export function useCurrentTransportsResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    CURRENT_TRANSPORTS_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => api.model.currentTransports({ sessionScopeKey, signal }),
    [api],
  );
  return useResource<CurrentTransportListResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: sceneRevision,
    resourceKey,
  });
}

export function useSpinTorquesResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    SPIN_TORQUES_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => api.model.spinTorques({ sessionScopeKey, signal }),
    [api],
  );
  return useResource<SpinTorqueListResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: sceneRevision,
    resourceKey,
  });
}

export function useSpinTransportsResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    SPIN_TRANSPORTS_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => api.model.spinTransports({ sessionScopeKey, signal }),
    [api],
  );
  return useResource<SpinTransportListResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: sceneRevision,
    resourceKey,
  });
}

export function useSpinInterfacesResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    SPIN_INTERFACES_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => api.model.spinInterfaces({ sessionScopeKey, signal }),
    [api],
  );
  return useResource<SpinInterfaceListResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: sceneRevision,
    resourceKey,
  });
}

export function useOerstedFieldsResource(options: ResourceHookOptions = {}) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    OERSTED_FIELDS_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => api.model.oerstedFields({ sessionScopeKey, signal }),
    [api],
  );
  return useResource<OerstedFieldListResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: sceneRevision,
    resourceKey,
  });
}

export function useSpinAuthoringGeometryResource(options: ResourceHookOptions = {}) {
  return useSceneResource(options);
}

export interface SpinInterfaceMeshEvidenceCarrier {
  manifest: MeshSharedDomainManifestResource;
  topology: DecodedTopology;
  sideA: MeshRegionMembershipResource;
  sideB: MeshRegionMembershipResource;
  geometryRealizationRevision: number;
}
/** One revision-scoped owner fetches the existing binary topology and both certified memberships. */
export function useSpinInterfaceMeshEvidenceResource(sideA: { objectId: string; regionId: string }, sideB: { objectId: string; regionId: string }) {
  const { api } = useKernel();
  const manifest = useMeshSharedDomainManifestResource();
  const geometry = useGeometryRealizationResource(true);
  const geometryPin = geometry.status === "ready" ? geometry.data : null;
  const pin = manifest.status === "ready" && geometryPin && manifest.data?.geometry_realization_revision === geometryPin.realization_revision ? manifest.data : null;
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(JSON.stringify([
    "spin-interface.mesh-evidence", geometryPin?.realization_revision ?? null, pin?.generation_id ?? null, pin?.topology_fingerprint ?? null, pin?.revision ?? null,
    sideA.objectId, sideA.regionId, sideB.objectId, sideB.regionId,
  ]));
  const load = useCallback(async ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }): Promise<SpinInterfaceMeshEvidenceCarrier | null> => {
    if (!pin || !geometryPin || !sideA.objectId || !sideA.regionId || !sideB.objectId || !sideB.regionId) return null;
    const options = { sessionScopeKey, signal };
    const [topology, a, b] = await Promise.all([
      api.meshing.sharedDomain.topology({ ...options, maxResponseBytes: 256 * 1024 * 1024 }),
      api.data.meshRegionMembership(sideA.objectId, sideA.regionId, options),
      api.data.meshRegionMembership(sideB.objectId, sideB.regionId, options),
    ]);
    if (topology.status !== "ready" || !a || !b) throw new Error("Accepted mesh topology and both region memberships are required.");
    // This exact strong ETag token is authored by get_mesh_shared_domain_topology.
    const expected = JSON.stringify(`mesh-shared-domain-topology:${pin.generation_id ?? "no-generation"}:${pin.topology_fingerprint}:${pin.revision}`);
    if (topology.etag !== expected) throw new Error("Topology response belongs to a different mesh generation or revision.");
    return { manifest: pin, topology: topology.data, sideA: a, sideB: b, geometryRealizationRevision: geometryPin.realization_revision };
  }, [api, pin, geometryPin, sideA.objectId, sideA.regionId, sideB.objectId, sideB.regionId]);
  return useResource<SpinInterfaceMeshEvidenceCarrier | null>({
    enabled: sessionIdentity !== null && Boolean(pin && sideA.objectId && sideA.regionId && sideB.objectId && sideB.regionId),
    load, resourceKey, resolveRevision: (carrier) => carrier?.manifest.revision ?? null,
  });
}