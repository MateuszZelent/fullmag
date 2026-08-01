"use client";

import { isUniverseOuterBoundaryCarrier } from "@/kernel/selection/semanticRenderTargetCatalog";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { useMeshSharedDomainManifestResource } from "@/kernel/resources/geometryLifecycleResources";
import { shouldLoadRuntimeMeshManifest } from "@/kernel/resources/studyRuntimeResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";

export function BoundaryFacesOverviewPanel({ selection }: InspectorPanelProps) {
  void selection;
  const sessionStatus = useSessionStatusSelector((status) => status.data);
  const manifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadRuntimeMeshManifest(true, sessionStatus),
  });
  const outerBoundaryCarriers = (manifest.data?.mesh_parts ?? []).filter(
    isUniverseOuterBoundaryCarrier,
  );
  const boundaryFaceCount = outerBoundaryCarriers.reduce(
    (count, carrier) => count + carrier.boundary_face_count,
    0,
  );

  return (
    <div className="fm-inspector-panel">
      <InspectorGroup
        badge={outerBoundaryCarriers.length > 0 ? "realized" : "unavailable"}
        title="Boundary Faces Overview"
      >
        <FieldRow label="Explorer address" value="model:boundary-faces" />
        <FieldRow label="Semantic role" value="outer_boundary" />
        <FieldRow
          label="Realized carriers"
          value={outerBoundaryCarriers.length.toLocaleString("en-US")}
        />
        <FieldRow
          label="Boundary faces"
          value={
            outerBoundaryCarriers.length > 0
              ? boundaryFaceCount.toLocaleString("en-US")
              : "mesh required"
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
