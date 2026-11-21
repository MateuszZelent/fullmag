import type { ReactNode } from "react";

import { ScientificInspectorTemplate } from "../components/ScientificInspectorTemplate";
import type { InspectorPanelProps } from "../inspectorTypes";
import { routeTitle, routeMethod, routePhysicalLabel, routePurpose, routeWords } from "./DedicatedInspectorRouteFrame.model";

interface DedicatedInspectorRouteFrameProps extends InspectorPanelProps {
  children: ReactNode;
  owner: string;
}

/**
 * Gives route-only Explorer panels the same semantic header and provenance
 * contract as result and visualization Inspectors.
 *
 * The wrapped panel remains the owner of its controls and resource lifecycle;
 * this frame owns only route identity, status, and the common scientific
 * chrome. This prevents a grouped route from looking like an anonymous copy
 * of its sibling while keeping the existing editor behavior intact. Geometry
 * authoring keeps the shared Inspector header because it has no execution or
 * availability facets for this result-oriented frame to report.
 */
export function DedicatedInspectorRouteFrame({
  children,
  owner,
  selection,
}: DedicatedInspectorRouteFrameProps) {
  // These panels own their resource state and use the shared Inspector identity.
  // A mesh cell has no execution lifecycle to fill the generic result facets.
  if (owner === "object.geometry" || owner === "object.absorbing-boundary" || owner === "builder.primitive" || owner === "fdm.cell") {
    return (
      <div
        className="fm-inspector-route fm-inspector-route--dedicated"
        data-inspector-route-owner={owner}
      >
        {children}
      </div>
    );
  }

  const ref = selection.ref as Record<string, unknown> | null;
  const title = routeTitle(owner);
  const status = {
    availability: stringValue(ref?.availability) ?? "unknown",
    execution: stringValue(ref?.executionState) ?? "unknown",
    resource: stringValue(ref?.resourceState) ?? "unknown",
  };

  return (
    <div
      className="fm-inspector-route fm-inspector-route--dedicated"
      data-inspector-route-owner={owner}
    >
      <ScientificInspectorTemplate
        breadcrumbs={routeBreadcrumbs(owner)}
        methodLabel={routeMethod(owner)}
        physicalLabel={routePhysicalLabel(owner)}
        properties={[
          { label: "Node", value: selection.label ?? "Unnamed node" },
          { label: "Route", mono: true, value: owner },
          { label: "Purpose", value: routePurpose(owner) },
        ]}
        provenance={[
          { label: "Explorer node", mono: true, value: selection.nodeId ?? "Unavailable" },
          { label: "Selection source", value: selection.moduleSource ?? "Unavailable" },
        ]}
        status={status}
        title={selection.label || title}
      >
        <div className="fm-inspector-route__content">{children}</div>
      </ScientificInspectorTemplate>
    </div>
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function routeBreadcrumbs(owner: string): string[] {
  const words = routeWords(owner);
  const family = words[0] ?? "Explorer";
  return ["Model", family.charAt(0).toUpperCase() + family.slice(1), routeTitle(owner)];
}
