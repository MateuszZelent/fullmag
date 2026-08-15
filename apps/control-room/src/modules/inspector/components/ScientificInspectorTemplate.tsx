import type { ReactNode } from "react";

import { Badge } from "@/shared/ui/Badge";

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

export interface ScientificInspectorTemplateProps {
  actions?: ReactNode;
  breadcrumbs?: readonly string[];
  children?: ReactNode;
  diagnostics?: readonly string[];
  methodLabel: string;
  physicalLabel: string;
  properties?: readonly ScientificInspectorProperty[];
  provenance?: readonly ScientificInspectorProperty[];
  status: ScientificInspectorStatus;
  title: string;
}

export function ScientificInspectorTemplate({
  actions,
  breadcrumbs = [],
  children,
  diagnostics = [],
  methodLabel,
  physicalLabel,
  properties = [],
  provenance = [],
  status,
  title,
}: ScientificInspectorTemplateProps) {
  return (
    <div className="fm-scientific-inspector">
      {breadcrumbs.length > 0 ? (
        <nav aria-label="Scientific result path" className="fm-scientific-inspector__breadcrumbs">
          {breadcrumbs.join(" / ")}
        </nav>
      ) : null}
      <div className="fm-scientific-inspector__heading">
        <h3>{title}</h3>
        <div className="fm-scientific-inspector__badges">
          <Badge variant="secondary">{physicalLabel}</Badge>
          <Badge variant="secondary">{methodLabel}</Badge>
        </div>
      </div>
      <InspectorGroup title="Status">
        <FieldRow label="Resource" status={status.resource} value={status.resource} />
        <FieldRow label="Execution" status={status.execution} value={status.execution} />
        <FieldRow label="Availability" status={status.availability} value={status.availability} />
      </InspectorGroup>
      {properties.length > 0 ? (
        <InspectorGroup title="Physical properties">
          {properties.map((property) => (
            <FieldRow key={property.label} {...property} />
          ))}
        </InspectorGroup>
      ) : null}
      {provenance.length > 0 ? (
        <InspectorGroup title="Provenance">
          {provenance.map((property) => (
            <FieldRow key={property.label} {...property} />
          ))}
        </InspectorGroup>
      ) : null}
      {diagnostics.length > 0 ? (
        <InspectorGroup title="Diagnostics">
          {diagnostics.map((diagnostic, index) => (
            <p className="fm-scientific-inspector__diagnostic" key={`${index}:${diagnostic}`}>
              {diagnostic}
            </p>
          ))}
        </InspectorGroup>
      ) : null}
      {children ? <div className="fm-scientific-inspector__content">{children}</div> : null}
      {actions ? <div className="fm-scientific-inspector__actions">{actions}</div> : null}
    </div>
  );
}
