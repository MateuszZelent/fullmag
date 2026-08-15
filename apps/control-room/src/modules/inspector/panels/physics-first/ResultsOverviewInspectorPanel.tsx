import { ScientificInspectorTemplate } from "../../components/ScientificInspectorTemplate";
import type { InspectorPanelProps } from "../../inspectorTypes";

export function ResultsOverviewInspectorPanel({ selection }: InspectorPanelProps) {
  return (
    <ScientificInspectorTemplate
      breadcrumbs={["Results", "Overview"]}
      diagnostics={[
        "This is a navigational Results context. Select a published child product to inspect data or provenance.",
      ]}
      methodLabel="Physics-first result navigator"
      physicalLabel="Results context"
      properties={[
        { label: "Context node", mono: true, value: selection.nodeId ?? "Unavailable" },
        { label: "Published payload", value: "Owned by child result resources" },
      ]}
      provenance={[
        { label: "Selection source", value: selection.moduleSource },
        { label: "Kind", mono: true, value: selection.kind ?? "results.root" },
      ]}
      status={{ availability: "context-only", execution: "not_applicable", resource: "child-scoped" }}
      title={selection.label ?? "Results"}
    />
  );
}
