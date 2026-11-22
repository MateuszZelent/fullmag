import type { ReactNode } from "react";

import { FieldRow } from "../primitives/FieldRow";
import { InspectorGroup } from "../primitives/InspectorGroup";

export interface ScientificInspectorProperty {
  label: string;
  mono?: boolean;
  unit?: string;
  value: ReactNode;
}

export interface ScientificInspectorStatus {
  availability: string;
  execution: string;
  resource: string;
}

export interface ScientificInspectorContextProps {
  collapsible?: boolean;
  defaultOpen?: boolean;
  diagnostics?: readonly string[];
  properties?: readonly ScientificInspectorProperty[];
  provenance?: readonly ScientificInspectorProperty[];
  status: ScientificInspectorStatus;
}

export function ScientificInspectorContext({
  collapsible = false,
  defaultOpen = true,
  diagnostics = [],
  properties = [],
  provenance = [],
  status,
}: ScientificInspectorContextProps) {
  return (
    <>
      <InspectorGroup collapsible={collapsible} defaultOpen={defaultOpen} title="Status">
        <FieldRow label="Resource" status={status.resource} value={status.resource} />
        <FieldRow label="Execution" status={status.execution} value={status.execution} />
        <FieldRow label="Availability" status={status.availability} value={status.availability} />
      </InspectorGroup>
      {properties.length > 0 ? (
        <InspectorGroup
          collapsible={collapsible}
          defaultOpen={defaultOpen}
          title="Physical properties"
        >
          {properties.map((property) => (
            <FieldRow key={property.label} {...property} />
          ))}
        </InspectorGroup>
      ) : null}
      {provenance.length > 0 ? (
        <InspectorGroup
          collapsible={collapsible}
          defaultOpen={defaultOpen}
          title="Provenance"
        >
          {provenance.map((property) => (
            <FieldRow key={property.label} {...property} />
          ))}
        </InspectorGroup>
      ) : null}
      {diagnostics.length > 0 ? (
        <InspectorGroup
          collapsible={collapsible}
          defaultOpen={defaultOpen}
          title="Diagnostics"
        >
          {diagnostics.map((diagnostic, index) => (
            <p className="fm-scientific-inspector__diagnostic" key={`${index}:${diagnostic}`}>
              {diagnostic}
            </p>
          ))}
        </InspectorGroup>
      ) : null}
    </>
  );
}
