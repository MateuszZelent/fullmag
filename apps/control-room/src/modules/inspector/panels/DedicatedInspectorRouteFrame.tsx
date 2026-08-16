import type { ReactNode } from "react";

import { ScientificInspectorTemplate } from "../components/ScientificInspectorTemplate";
import type { InspectorPanelProps } from "../inspectorTypes";

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
 * of its sibling while keeping the existing editor behavior intact.
 */
export function DedicatedInspectorRouteFrame({
  children,
  owner,
  selection,
}: DedicatedInspectorRouteFrameProps) {
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

function routeWords(owner: string): string[] {
  return owner
    .replace(/^object\./, "")
    .replace(/^physics\./, "")
    .replace(/-/g, " ")
    .split(/[.\s]+/)
    .flatMap((word) => word.split("_"))
    .filter(Boolean);
}

function routeTitle(owner: string): string {
  const words = routeWords(owner);
  if (words.length === 0) return "Explorer Inspector";
  return words
    .map((word, index) => index === 0
      ? `${word.charAt(0).toUpperCase()}${word.slice(1)}`
      : word.toLowerCase())
    .join(" ");
}

function routeBreadcrumbs(owner: string): string[] {
  const words = routeWords(owner);
  const family = words[0] ?? "Explorer";
  return ["Model", family.charAt(0).toUpperCase() + family.slice(1), routeTitle(owner)];
}

function routePhysicalLabel(owner: string): string {
  if (owner.startsWith("mesh.cross-section")) return "Derived visualization";
  if (owner.startsWith("mesh.") || owner.startsWith("fdm.")) return "Mesh realization";
  if (owner.startsWith("airbox")) return "Airbox visualization";
  if (owner.startsWith("study.")) return "Study pipeline";
  if (owner.startsWith("analysis.") || owner.startsWith("live.")) return "Published data";
  if (owner.startsWith("cross-section")) return "Derived visualization";
  if (owner.startsWith("physics.") || owner.includes("field-drive")) return "Physics authoring";
  return "Model authoring";
}

function routeMethod(owner: string): string {
  if (owner === "mesh.root") return "Mesh overview";
  if (owner === "mesh.shared-domain") return "Shared-domain mesh";
  if (owner === "mesh.builds") return "Mesh build pipeline";
  if (owner === "mesh.quality") return "Quality gates";
  if (owner === "mesh.size-fields") return "Size-field realization";
  if (owner === "mesh.regions") return "Mesh region mapping";
  if (owner.startsWith("mesh.cross-section")) {
    if (owner.endsWith(".draft")) return "Cross-section draft";
    if (owner.endsWith(".plot")) return "Cross-section plot";
    return "Cross-section definition";
  }
  if (owner === "object.geometry") return "Geometry authoring";
  if (owner === "builder.primitive") return "Primitive authoring";
  if (owner.endsWith("chart-point")) return "Data point inspection";
  if (owner.endsWith(".chart")) return "Chart resource";
  if (owner === "study.stage.relax") return "Relaxation stage";
  if (owner === "study.stage.run") return "Run stage";
  if (owner.startsWith("study.stage.")) return "Study stage";
  if (owner.includes("asset")) return "Published asset";
  if (owner.includes("load")) return "Resource loading";
  if (owner.includes("transform")) return "Coordinate transform";
  if (owner.includes("grid") || owner === "fdm.cell") return "Structured FDM grid";
  if (owner.includes("visualization") || owner.includes("airbox")) return "Visualization target";
  if (owner.startsWith("study.")) return "Study definition";
  if (owner.startsWith("analysis.") || owner.startsWith("live.")) return "Data inspection";
  return "Explorer resource";
}

function routePurpose(owner: string): string {
  if (owner === "mesh.root") return "Inspect the resolved mesh lane and its canonical realization.";
  if (owner === "mesh.shared-domain") return "Inspect the shared-domain mesh, counts, and universe boundaries.";
  if (owner === "mesh.builds") return "Inspect build operations, history, and the latest realization.";
  if (owner === "mesh.quality") return "Review quality gates and element statistics before using the mesh.";
  if (owner === "mesh.size-fields") return "Inspect the realized size fields that control mesh resolution.";
  if (owner === "mesh.regions") return "Inspect region ownership and mesh-policy differences.";
  if (owner === "mesh.cross-section.plot") return "Inspect the published cross-section plot and its sampling frame.";
  if (owner === "mesh.cross-section.draft") return "Edit the cross-section draft without confusing it with a published plot.";
  if (owner.startsWith("mesh.cross-section")) return "Inspect the cross-section definition and its derived-data contract.";
  if (owner === "object.geometry") return "Author the object's physical geometry and transform.";
  if (owner === "builder.primitive") return "Author a new primitive geometry draft.";
  if (owner.endsWith("chart-point")) return "Inspect the selected data point without changing the parent chart.";
  if (owner.endsWith(".chart")) return "Inspect the chart dataset, axes, and selected series.";
  if (owner === "study.stage.relax") return "Inspect relaxation controls, convergence, and the selected stage state.";
  if (owner === "study.stage.run") return "Inspect run controls, execution state, and stage provenance.";
  if (owner.includes("asset")) return "Inspect the published magnetic-texture asset identity.";
  if (owner.includes("load")) return "Inspect loading, availability, and resource provenance.";
  if (owner.includes("transform")) return "Inspect the texture coordinate transform.";
  if (owner.includes("grid")) return "Inspect the structured-grid scope represented by this node.";
  if (owner.includes("visualization")) return "Inspect the visualization target and its display contract.";
  if (owner.startsWith("study.")) return "Inspect this study scope without collapsing it into another stage.";
  if (owner.startsWith("analysis.") || owner.startsWith("live.")) return "Inspect this chart resource and its point-selection contract.";
  return "Inspect the selected Explorer resource and its owning contract.";
}

export const __dedicatedInspectorRouteFrameTestUtils = {
  routeMethod,
  routePhysicalLabel,
  routePurpose,
  routeTitle,
};
