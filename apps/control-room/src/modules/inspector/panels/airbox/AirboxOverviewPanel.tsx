"use client";

import { Accordion } from "@/shared/ui/Accordion";
import {
  useMeshSharedDomainManifestResource,
  useUniverseMeshPolicyResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { shouldLoadRuntimeMeshManifest } from "@/kernel/resources/studyRuntimeResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { AirboxFieldRow as FieldRow } from "./airboxDisplay";
import { InspectorSection } from "../../primitives/InspectorSection";
import { findCanonicalAirboxPart } from "./airboxMeshInspectorModel";
import { useAirboxInspectorRuntimeStatus } from "./airboxInspectorRuntimeStatus";

export function AirboxOverviewPanel({ selection }: InspectorPanelProps) {
  void selection;
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const policy = useUniverseMeshPolicyResource();
  const manifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadRuntimeMeshManifest(true, runtimeStatus),
  });
  const visualization = useVisualizationStateResource();
  const carrier = findCanonicalAirboxPart(manifest.data?.mesh_parts);
  const authored = policy.data?.config ?? {};
  const override = visualization.data?.overrides?.find(
    (candidate) =>
      candidate.scope === "airbox" || candidate.scope_id === "airbox",
  );

  return (
    <Accordion className="fm-inspector-panel" type="multiple" defaultValue={["overview"]}>
      <InspectorSection value="overview" title="Airbox Overview" badge={policy.status}>
        <FieldRow label="Canonical target" value="airbox" />
        <FieldRow label="Domain mode" value={String(authored.mode ?? "inherited")} />
        <FieldRow label="Authored size" value={Array.isArray(authored.size) ? authored.size.join(", ") : "automatic"} unit="m" />
        <FieldRow label="Authored padding" value={Array.isArray(authored.padding) ? authored.padding.join(", ") : "automatic"} unit="m" />
        <FieldRow label="Authored center" value={Array.isArray(authored.center) ? authored.center.join(", ") : "automatic"} unit="m" />
        <FieldRow label="Policy revision" value={String(policy.data?.revision ?? "unknown")} />
        <FieldRow label="Mesh carrier" value={carrier?.id ?? "not available"} />
        <FieldRow label="Nodes" value={carrier?.node_count?.toLocaleString("en-US") ?? "not available"} />
        <FieldRow label="Elements" value={carrier?.element_count?.toLocaleString("en-US") ?? "not available"} />
        <FieldRow label="Boundary faces" value={carrier?.boundary_face_count?.toLocaleString("en-US") ?? "not available"} />
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
      </InspectorSection>
    </Accordion>
  );
}
