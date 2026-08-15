import type { ReactNode } from "react";

import type { InspectorPanelProps } from "../inspectorTypes";
import { ScientificInspectorTemplate } from "../components/ScientificInspectorTemplate";

function RuntimeOverviewInspector({
  breadcrumbs,
  methodLabel,
  physicalLabel,
  title,
  children,
}: {
  breadcrumbs: readonly string[];
  children: ReactNode;
  methodLabel: string;
  physicalLabel: string;
  title: string;
}) {
  return (
    <ScientificInspectorTemplate
      breadcrumbs={breadcrumbs}
      diagnostics={["This node is a navigator context. Select a child to inspect an owned runtime resource."]}
      methodLabel={methodLabel}
      physicalLabel={physicalLabel}
      properties={[
        { label: "Payload owner", value: "Typed child resources" },
        { label: "Selection scope", value: "Current session" },
      ]}
      provenance={[{ label: "Selection source", value: "explorer" }]}
      status={{ availability: "context-only", execution: "not_applicable", resource: "child-scoped" }}
      title={title}
    >
      {children}
    </ScientificInspectorTemplate>
  );
}

export function ResourcesOverviewInspectorPanel({}: InspectorPanelProps) {
  return (
    <RuntimeOverviewInspector
      breadcrumbs={["Resources", "Overview"]}
      methodLabel="Resource-first runtime inventory"
      physicalLabel="Resource catalog"
      title="Resources"
    >
      <p className="fm-scientific-inspector__diagnostic">
        Resource keys, revisions, generations, cache state and locations are
        available on the individual resource nodes.
      </p>
    </RuntimeOverviewInspector>
  );
}

export function JobsOverviewInspectorPanel({}: InspectorPanelProps) {
  return (
    <RuntimeOverviewInspector
      breadcrumbs={["Jobs", "Overview"]}
      methodLabel="Runtime lifecycle navigator"
      physicalLabel="Execution jobs"
      title="Jobs"
    >
      <p className="fm-scientific-inspector__diagnostic">
        Run, stage and command nodes expose requested execution separately from
        resolved backend, device and precision.
      </p>
    </RuntimeOverviewInspector>
  );
}

export function DiagnosticsOverviewInspectorPanel({}: InspectorPanelProps) {
  return (
    <RuntimeOverviewInspector
      breadcrumbs={["Diagnostics", "Overview"]}
      methodLabel="Evidence navigator"
      physicalLabel="Runtime diagnostics"
      title="Diagnostics"
    >
      <p className="fm-scientific-inspector__diagnostic">
        Select a diagnostic child to inspect health, capability, solver, mesh,
        frequency-domain, performance or resource evidence.
      </p>
    </RuntimeOverviewInspector>
  );
}
