"use client";

import {
  useMeshSharedDomainManifestResource,
  useUniverseMeshPolicyResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { shouldLoadRuntimeMeshManifest } from "@/kernel/resources/studyRuntimeResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { AirboxFieldRow as FieldRow } from "./airboxDisplay";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { aggregateAirboxMeshParts, findCanonicalAirboxPart, findAirboxParts } from "./airboxMeshInspectorModel";
import { useAirboxInspectorRuntimeStatus } from "./airboxInspectorRuntimeStatus";

export function AirboxOverviewPanel({ selection }: InspectorPanelProps) {
  void selection;
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const policy = useUniverseMeshPolicyResource();
  const manifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadRuntimeMeshManifest(true, runtimeStatus),
  });
  const visualization = useVisualizationStateResource();
  const airboxParts = findAirboxParts(manifest.data?.mesh_parts);
  const aggregate = aggregateAirboxMeshParts(airboxParts);
  const carrier = findCanonicalAirboxPart(manifest.data?.mesh_parts);
  const authored = policy.data?.config ?? {};
  const override = visualization.data?.overrides?.find(
    (candidate) =>
      candidate.scope === "airbox" || candidate.scope_id === "airbox",
  );

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <InspectorGroup title="Airbox Overview" badge={policy.status}>
        <FieldRow label="Canonical target" value="airbox" />
        <FieldRow label="Domain mode" value={String(authored.mode ?? "inherited")} />
        <FieldRow label="Authored size" value={Array.isArray(authored.size) ? authored.size.join(", ") : "automatic"} unit="m" />
        <FieldRow label="Authored padding" value={Array.isArray(authored.padding) ? authored.padding.join(", ") : "automatic"} unit="m" />
        <FieldRow label="Authored center" value={Array.isArray(authored.center) ? authored.center.join(", ") : "automatic"} unit="m" />
        <FieldRow label="Policy revision" value={String(policy.data?.revision ?? "unknown")} />
        <FieldRow label="Mesh carrier" value={carrier?.id ?? "not available"} />
        <FieldRow label="Airbox carriers" value={aggregate.carrierCount.toLocaleString("en-US")} />
        <FieldRow label="Nodes (unique across carriers)" value={aggregate.nodeCount?.toLocaleString("en-US") ?? "not available"} />
        <FieldRow label="Elements (all carriers)" value={aggregate.elementCount?.toLocaleString("en-US") ?? "not available"} />
        <FieldRow label="Boundary faces (all carriers)" value={aggregate.boundaryFaceCount?.toLocaleString("en-US") ?? "not available"} />
        <FieldRow label="Node-count source" value={aggregate.nodeCountExact ? "deduplicated published carrier coverage" : "not fully published"} />
        <FieldRow label="Active quantity" value={visualization.data?.active_quantity_id ?? "not available"} />
        <FieldRow label="Shortcuts" value="Mesh Parameters · Mesh Build · Visualization" />
        <FieldRow label="Manifest state" value={manifest.status} />
        <FieldRow label="Visualization state" value={visualization.status} />
        <FieldRow
          label="Visible override"
          value={
            (override?.display?.visible ?? override?.visible) == null
              ? "inherited"
              : (override?.display?.visible ?? override?.visible)
                ? "visible"
                : "hidden"
          }
        />
      </InspectorGroup>
    </div>
  );
}
