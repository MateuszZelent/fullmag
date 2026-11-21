import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { formatCount, MeshResourceFields } from "../MeshResourceView";
import { type MixedTopologyPresentation } from "./MixedTopologyProvenanceSection.model";

export function MixedTopologyProvenanceSection({
  model,
}: {
  model: MixedTopologyPresentation;
}) {
  if (!model.visible) return null;
  const rejected = model.certificateStatus === "rejected";
  const orphanRejected = model.topologyIntegrity === "rejected";
  return (
    <InspectorGroup
      title="Mixed Topology Provenance"
      badge={orphanRejected ? "invalid topology" : model.certificateStatus}
      collapsible
      defaultOpen
    >
      {model.certificateStatus === "unavailable" ? (
        <FeedbackBanner
          kind="warning"
          message="Mixed-topology certificate is unavailable or has an unrecognized status. Execution and quality are not confirmed."
        />
      ) : null}
      {rejected ? (
        <FeedbackBanner
          kind="error"
          message={`Exact-layer certificate rejected: ${model.certificateReason}.`}
        />
      ) : null}
      {orphanRejected ? (
        <FeedbackBanner
          kind="error"
          message="Orphan topology entities invalidate this mixed mesh; execution and quality conclusions must fail closed."
        />
      ) : null}
      {model.rejection ? (
        <>
          <strong>Mixed-P1 request rejected</strong>
          <MeshResourceFields
            fields={[
              { label: "Rejection category", value: model.rejection.category },
              { label: "Reason", value: model.rejection.reason },
              {
                label: "Missing capabilities",
                value: model.rejection.missingCapabilities.length > 0
                  ? model.rejection.missingCapabilities.join(", ")
                  : "not published",
              },
              { label: "Requested execution", value: model.rejection.requestedExecution },
              { label: "Resolved execution", value: model.rejection.resolvedExecution },
              { label: "Fallback", value: model.rejection.fallback },
              { label: "Free tetrahedral alternative", value: model.rejection.alternative },
            ]}
          />
        </>
      ) : null}
      {model.hasSingleLayer ? (
        <FeedbackBanner
          kind="warning"
          message="One exact prism layer requires layer-convergence evidence before scientific qualification."
        />
      ) : null}
      <MeshResourceFields
        fields={[
          { label: "Requested topology", value: model.requestedTopology },
          { label: "Resolved topology", value: model.resolvedTopology },
          { label: "Requested element layers", value: String(model.requestedLayers ?? "not published") },
          { label: "Resolved element layers", value: String(model.resolvedLayers ?? "not published") },
          { label: "Requested exact layers", value: String(model.requestedExactLayers ?? "not published") },
          { label: "Resolved exact layers", value: String(model.resolvedExactLayers ?? "not published") },
          { label: "Node planes", value: String(model.nodePlanes ?? "not published") },
          { label: "Transition policy", value: model.transitionPolicy },
          { label: "Certificate", value: model.certificateStatus },
          { label: "Certificate fingerprint", value: model.certificateFingerprint },
          { label: "Fallback", value: model.fallback },
          { label: "Topology schema", value: model.topologySchemaVersion },
          { label: "Gmsh version", value: model.gmshVersion },
          {
            label: "Orphan entities",
            value: model.orphanEntities.length > 0
              ? model.orphanEntities
                  .map(({ dimension, tag }) => `dimension ${dimension}, tag ${tag}`)
                  .join("; ")
              : "none",
          },
          ...model.regionFields,
          ...model.elementCounts.map(({ family, count }) => ({
            label: `Family ${family}`,
            value: formatCount(count),
          })),
          ...model.facetCounts.map(({ familyAndRole, count }) => ({
            label: `Facet ${familyAndRole}`,
            value: formatCount(count),
          })),
        ]}
      />
    </InspectorGroup>
  );
}
