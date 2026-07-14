"use client";

import { Accordion } from "@/shared/ui/Accordion";
import { useMeshSharedDomainManifestResource } from "@/kernel/resources/geometryLifecycleResources";
import { shouldLoadRuntimeMeshManifest } from "@/kernel/resources/studyRuntimeResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { AirboxFieldRow as FieldRow } from "./airboxDisplay";
import { InspectorSection } from "../../primitives/InspectorSection";
import { findCanonicalAirboxPart } from "./airboxMeshInspectorModel";
import { useAirboxInspectorRuntimeStatus } from "./airboxInspectorRuntimeStatus";

const vector = (value: readonly number[] | null | undefined) =>
  value?.length ? value.join(", ") : "not available";

export function AirboxMeshTopologyPanel({ selection }: InspectorPanelProps) {
  void selection;
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const manifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadRuntimeMeshManifest(true, runtimeStatus),
  });
  const part = findCanonicalAirboxPart(manifest.data?.mesh_parts);

  return (
    <Accordion className="fm-inspector-panel" type="multiple" defaultValue={["topology"]}>
      <InspectorSection value="topology" title="Airbox Mesh Topology" badge={manifest.status}>
        <FieldRow label="Canonical target" value="airbox" />
        <FieldRow label="Canonical marker" value="not published" />
        <FieldRow label="Mesh id" value={manifest.data?.mesh_id ?? "not available"} />
        <FieldRow label="Generation id" value={manifest.data?.generation_id ?? "not available"} />
        <FieldRow label="Manifest revision" value={String(manifest.data?.revision ?? "not available")} />
        <FieldRow label="Geometry realization revision" value={String(manifest.data?.geometry_realization_revision ?? "not available")} />
        <FieldRow label="Source scene revision" value={String(manifest.data?.source_scene_revision ?? "not available")} />
        <FieldRow label="Topology fingerprint" value={manifest.data?.topology_fingerprint ?? "not available"} />
        <FieldRow label="Carrier id" value={part?.id ?? "not available"} />
        <FieldRow label="Carrier role" value={part?.role ?? "not available"} />
        <FieldRow label="Bounds min" value={vector(part?.bounds_min)} unit="m" />
        <FieldRow label="Bounds max" value={vector(part?.bounds_max)} unit="m" />
        <FieldRow
          label="Node source"
          value={part?.node_indices?.length ? "explicit node_indices" : part ? "node_start/node_count range" : "not available"}
        />
        <FieldRow label="Boundary-face source" value={part?.boundary_face_indices?.length ? "explicit boundary_face_indices" : part ? "boundary_face_start/boundary_face_count range" : "not available"} />
        <FieldRow label="Shared-interface caveat" value="Interface nodes belong to the shared-domain mesh and are not exclusive Airbox ownership." />
        <FieldRow label="Topology source" value="shared-domain manifest metadata (binary topology is not refetched)" />
      </InspectorSection>
    </Accordion>
  );
}
