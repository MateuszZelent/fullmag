"use client";

import { useMeshSharedDomainManifestResource } from "@/kernel/resources/geometryLifecycleResources";
import type { InspectorPanelProps } from "../../inspectorTypes";
import { AirboxFieldRow as FieldRow } from "./airboxDisplay";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  aggregateAirboxBounds,
  aggregateAirboxMeshParts,
  findCanonicalAirboxPart,
  findAirboxParts,
} from "./airboxMeshInspectorModel";
import {
  matchesAirboxTopologyIdentity,
  shouldLoadAirboxMeshManifest,
  useAirboxInspectorRuntimeStatus,
} from "./airboxInspectorRuntimeStatus";

const vector = (value: readonly number[] | null | undefined) =>
  value?.length ? value.join(", ") : "not available";

export function AirboxMeshTopologyPanel({ selection }: InspectorPanelProps) {
  void selection;
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const manifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadAirboxMeshManifest(true, runtimeStatus),
  });
  const topologyMatches = matchesAirboxTopologyIdentity(runtimeStatus, manifest.data);
  const currentManifest = topologyMatches ? manifest.data : null;
  const shownStatus = manifest.status === "ready" && !topologyMatches ? "stale" : manifest.status;
  const airboxParts = findAirboxParts(currentManifest?.mesh_parts);
  const aggregate = aggregateAirboxMeshParts(airboxParts);
  const bounds = aggregateAirboxBounds(airboxParts);
  const part = findCanonicalAirboxPart(currentManifest?.mesh_parts);
  const topologyIdentityLabel = topologyMatches
    ? manifest.status === "ready"
      ? "matches current published FEM generation"
      : `cached identity matches; manifest resource is ${manifest.status}`
    : manifest.status === "loading"
      ? "checking published topology identity"
      : manifest.data
        ? "published topology identity does not match current status"
        : "not available";

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <InspectorGroup title="Airbox Mesh Topology" badge={shownStatus}>
        <FieldRow label="Canonical target" value="airbox" />
        <FieldRow label="Canonical marker" value="not published by the topology manifest" />
        <FieldRow label="Topology identity" value={topologyIdentityLabel} />
        <FieldRow label="Mesh id" value={currentManifest?.mesh_id ?? "not available"} />
        <FieldRow label="Generation id" value={currentManifest?.generation_id ?? "not available"} />
        <FieldRow label="Manifest revision" value={String(currentManifest?.revision ?? "not available")} />
        <FieldRow label="Geometry realization revision" value={String(currentManifest?.geometry_realization_revision ?? "not available")} />
        <FieldRow label="Source scene revision" value={String(currentManifest?.source_scene_revision ?? "not available")} />
        <FieldRow label="Topology fingerprint" value={currentManifest?.topology_fingerprint ?? "not available"} />
        <FieldRow label="Carrier id" value={part?.id ?? "not available"} />
        <FieldRow label="Carrier role" value={part?.role ?? "not available"} />
        <FieldRow label="Carrier count" value={aggregate.carrierCount.toLocaleString("en-US")} />
        <FieldRow label="Bounds min (full Airbox extent)" value={vector(bounds?.min ?? part?.bounds_min)} unit="m" />
        <FieldRow label="Bounds max (full Airbox extent)" value={vector(bounds?.max ?? part?.bounds_max)} unit="m" />
        <FieldRow
          label="Node source"
          value={
            part?.node_indices?.length
              ? aggregate.carrierCount === 1
                ? "explicit node_indices; deduplicated published carrier coverage"
                : "explicit per-carrier node_indices; deduplicated published carrier coverage"
              : aggregate.nodeCountExact
                ? "deduplicated published carrier coverage"
                : "not fully published"
          }
        />
        <FieldRow
          label="Boundary-face source"
          value={
            part?.boundary_face_indices?.length
              ? aggregate.carrierCount === 1
                ? "explicit boundary_face_indices"
                : "explicit per-carrier boundary_face_indices"
              : aggregate.carrierCount
                ? "published per-carrier ranges"
                : "not available"
          }
        />
        <FieldRow label="Shared-interface caveat" value="Interface nodes belong to the shared-domain mesh and are not exclusive Airbox ownership." />
        <FieldRow label="Topology source" value="shared-domain manifest metadata (binary topology is not refetched)" />
      </InspectorGroup>
    </div>
  );
}
