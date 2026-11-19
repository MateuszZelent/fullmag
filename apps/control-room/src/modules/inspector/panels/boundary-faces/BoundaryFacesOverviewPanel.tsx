"use client";

import { isUniverseOuterBoundaryCarrier } from "@/kernel/selection/semanticRenderTargetCatalog";
import {
  useMeshSharedDomainManifestResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  matchesAirboxTopologyIdentity,
  shouldLoadAirboxMeshManifest,
  useAirboxInspectorRuntimeStatus,
} from "../airbox/airboxInspectorRuntimeStatus";

function revisionsMatch(currentRevision: unknown, sourceRevision: unknown): boolean {
  const isRevision = (value: unknown) =>
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length > 0);
  return isRevision(currentRevision) &&
    isRevision(sourceRevision) &&
    String(currentRevision) === String(sourceRevision);
}

export function BoundaryFacesOverviewPanel({ selection }: InspectorPanelProps) {
  void selection;
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const meshEnabled = shouldLoadAirboxMeshManifest(true, runtimeStatus);
  const scene = useSceneResource({ enabled: meshEnabled });
  const manifest = useMeshSharedDomainManifestResource({
    enabled: meshEnabled,
  });
  const currentSceneRevision = scene.data?.revision ?? scene.data?.scene_revision;
  const carrierInventoryAvailable = manifest.status === "ready" &&
    scene.status === "ready" &&
    revisionsMatch(currentSceneRevision, manifest.data?.source_scene_revision) &&
    matchesAirboxTopologyIdentity(runtimeStatus, manifest.data) &&
    Array.isArray(manifest.data?.mesh_parts);
  const outerBoundaryCarriers = carrierInventoryAvailable
    ? manifest.data?.mesh_parts?.filter(isUniverseOuterBoundaryCarrier) ?? []
    : null;
  const boundaryFaceCount = outerBoundaryCarriers?.reduce(
    (count, carrier) => count + carrier.boundary_face_count,
    0,
  ) ?? null;

  return (
    <div className="fm-inspector-panel">
      <InspectorGroup
        badge={outerBoundaryCarriers === null
          ? "unavailable"
          : outerBoundaryCarriers.length > 0
            ? "realized"
            : "none in manifest"}
        title="Boundary Faces Overview"
      >
        <FieldRow label="Explorer address" value="model:boundary-faces" />
        <FieldRow label="Semantic role" value="outer_boundary" />
        <FieldRow
          label="Realized carriers"
          value={outerBoundaryCarriers?.length.toLocaleString("en-US") ?? "unavailable"}
        />
        <FieldRow
          label="Boundary faces"
          value={
            outerBoundaryCarriers === null
              ? "unavailable"
              : outerBoundaryCarriers.length > 0 && boundaryFaceCount !== null
                ? boundaryFaceCount.toLocaleString("en-US")
                : "not published in manifest"
          }
        />
        <FieldRow label="Manifest state" value={manifest.status} />
        <FieldRow
          label="Scope"
          value="Universe boundary; not an Airbox or unassigned mesh target"
        />
      </InspectorGroup>
    </div>
  );
}
