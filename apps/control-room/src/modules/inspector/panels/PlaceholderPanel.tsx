import { ScientificInspectorTemplate } from "../components/ScientificInspectorTemplate";
import type { InspectorPanelProps } from "../inspectorTypes";

export function PlaceholderPanel({ selection }: InspectorPanelProps) {
  return (
    <div className="fm-unsupported-inspector" data-inspector-owner="unsupported-inspector">
      <ScientificInspectorTemplate
        breadcrumbs={["Inspector", "Unsupported"]}
        diagnostics={["No dedicated Inspector route is registered for this selected kind."]}
        methodLabel="Contract gap"
        physicalLabel="Unsupported selection"
        properties={[
          { label: "Kind", mono: true, value: selection.kind ?? "unknown" },
          { label: "Label", value: selection.label ?? "Unnamed" },
        ]}
        provenance={[
          { label: "Node", mono: true, value: selection.nodeId ?? "none" },
          { label: "Selection source", value: selection.moduleSource },
        ]}
        status={{ availability: "unsupported", execution: "unknown", resource: "unavailable" }}
        title="Unsupported Inspector"
      />
    </div>
  );
}
