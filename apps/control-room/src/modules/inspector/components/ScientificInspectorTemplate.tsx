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

export interface ScientificInspectorIdentityProps {
  breadcrumbs?: readonly string[];
  methodLabel: string;
  physicalLabel: string;
  title: string;
}

export interface ScientificInspectorContextProps {
  collapsible?: boolean;
  defaultOpen?: boolean;
  diagnostics?: readonly string[];
  properties?: readonly ScientificInspectorProperty[];
  provenance?: readonly ScientificInspectorProperty[];
  status: ScientificInspectorStatus;
}

export interface ScientificInspectorTemplateProps {
  actions?: ReactNode;
  children?: ReactNode;
  breadcrumbs?: ScientificInspectorIdentityProps["breadcrumbs"];
  diagnostics?: ScientificInspectorContextProps["diagnostics"];
  methodLabel: ScientificInspectorIdentityProps["methodLabel"];
  physicalLabel: ScientificInspectorIdentityProps["physicalLabel"];
  properties?: ScientificInspectorContextProps["properties"];
  provenance?: ScientificInspectorContextProps["provenance"];
  status: ScientificInspectorContextProps["status"];
  title: ScientificInspectorIdentityProps["title"];
}

export function ScientificInspectorIdentity({
  breadcrumbs = [],
  methodLabel,
  physicalLabel,
  title,
}: ScientificInspectorIdentityProps) {
  return (
    <>
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
    </>
  );
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
      <ScientificInspectorIdentity
        breadcrumbs={breadcrumbs}
        methodLabel={methodLabel}
        physicalLabel={physicalLabel}
        title={title}
      />
      <ScientificInspectorContext
        diagnostics={diagnostics}
        properties={properties}
        provenance={provenance}
        status={status}
      />
      {children ? <div className="fm-scientific-inspector__content">{children}</div> : null}
      {actions ? <div className="fm-scientific-inspector__actions">{actions}</div> : null}
    </div>
  );
}
