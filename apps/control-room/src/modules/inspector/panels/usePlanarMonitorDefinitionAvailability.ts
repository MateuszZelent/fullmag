"use client";

import { useMemo } from "react";

import {
  useFdmRegionMembershipResource,
  useMeshSharedDomainManifestResource,
  useModelRegionsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";

import {
  resolvePlanarMonitorDefinitionAvailability,
  type PlanarMonitorDefinitionAvailability,
} from "./PlanarMonitorDefinitionEditor";

export function usePlanarMonitorDefinitionAvailability(): PlanarMonitorDefinitionAvailability {
  const discretization = useSessionStatusSelector(
    (status) => status.data?.domain.discretization ?? null,
  );
  const scene = useSceneResource({ enabled: discretization === "fdm" || discretization === "fem" });
  const regions = useModelRegionsResource({ enabled: discretization === "fdm" || discretization === "fem" });
  const fdmMembership = useFdmRegionMembershipResource({ enabled: discretization === "fdm" });
  const manifest = useMeshSharedDomainManifestResource({ enabled: discretization === "fem" });
  return useMemo(
    () => resolvePlanarMonitorDefinitionAvailability({
      discretization,
      fdmObjectIds: fdmMembership.availability.status === "ready"
        ? fdmMembership.data?.object_ids ?? []
        : null,
      fdmRegionRefs: fdmMembership.availability.status === "ready"
        ? (fdmMembership.data?.region_legend ?? []).map((entry) => ({
          objectId: entry.object_id,
          regionId: entry.region_id,
        }))
        : null,
      femTopologyReady: manifest.status === "ready" && manifest.data !== null,
      modelRegionRefs: regions.status === "ready" && regions.data
        ? regions.data.regions.flatMap((entry) => entry.owner_object_id
          ? [{ objectId: entry.owner_object_id, regionId: entry.region_id }]
          : [])
        : null,
      sceneObjectIds: scene.status === "ready" && scene.data
        ? (scene.data.objects ?? []).map((entry) => entry.id)
        : null,
    }),
    [
      discretization,
      fdmMembership.availability.status,
      fdmMembership.data,
      manifest.data,
      manifest.status,
      regions.data,
      regions.status,
      scene.data,
      scene.status,
    ],
  );
}
