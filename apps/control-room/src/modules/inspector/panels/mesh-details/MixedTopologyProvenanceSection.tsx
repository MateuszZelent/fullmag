import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { formatCount, MeshResourceFields } from "../MeshResourceView";

interface MixedTopologyPresentationInput {
  buildReport: unknown;
  manifest: unknown;
  rejectionEvidence?: unknown;
}

export interface MixedTopologyPresentation {
  certificateFingerprint: string;
  certificateReason: string;
  certificateStatus: string;
  elementCounts: readonly { family: string; count: unknown }[];
  facetCounts: readonly { familyAndRole: string; count: unknown }[];
  fallback: string;
  gmshVersion: string;
  layers: number | null;
  nodePlanes: number | null;
  requestedExactLayers: boolean | null;
  requestedLayers: number | null;
  requestedTopology: string;
  rejection: {
    alternative: string;
    category: string;
    fallback: string;
    missingCapabilities: readonly string[];
    reason: string;
    requestedExecution: string;
    resolvedExecution: string;
  } | null;
  resolvedExactLayers: boolean | null;
  resolvedLayers: number | null;
  resolvedTopology: string;
  topologySchemaVersion: string;
  transitionPolicy: string;
  visible: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    const record = asRecord(value);
    if (record) return record;
  }
  return null;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "not published";
}

function firstPositiveInteger(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
  }
  return null;
}

function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return null;
}

function executionSummary(value: unknown, missing: string): string {
  const record = asRecord(value);
  if (!record) return missing;
  const fields = ["backend", "device", "precision", "mode", "study"]
    .map((key) => record[key])
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return fields.length > 0 ? fields.join(" / ") : missing;
}

function flattenedCounts(
  record: Record<string, unknown> | null,
): readonly { key: string; count: unknown }[] {
  const rows: { key: string; count: unknown }[] = [];
  for (const [key, value] of Object.entries(record ?? {})) {
    if (typeof value === "number") {
      rows.push({ count: value, key });
      continue;
    }
    for (const [nestedKey, count] of Object.entries(asRecord(value) ?? {})) {
      if (typeof count === "number") {
        rows.push({ count, key: `${key}:${nestedKey}` });
      }
    }
  }
  return rows;
}

export function resolveMixedTopologyPresentation({
  buildReport,
  manifest,
  rejectionEvidence,
}: MixedTopologyPresentationInput): MixedTopologyPresentation {
  const report = asRecord(buildReport);
  const manifestRecord = asRecord(manifest);
  const provenance = firstRecord(
    report?.mixed_topology_provenance,
    report?.topology_provenance,
    manifestRecord?.mixed_topology_provenance,
    manifestRecord?.topology_provenance,
  );
  const requestedPolicy = firstRecord(
    report?.requested_layered_policy,
    report?.requested_policy,
    manifestRecord?.requested_layered_policy,
    manifestRecord?.requested_policy,
  );
  const resolvedPolicy = firstRecord(
    report?.resolved_layered_policy,
    report?.resolved_policy,
    manifestRecord?.resolved_layered_policy,
    manifestRecord?.resolved_policy,
  );
  const certificate = firstRecord(
    rejectionEvidence,
    report?.mixed_layer_topology_rejection,
    report?.mixed_layer_topology_certificate,
    report?.mixed_layer_topology_certificate_summary,
    manifestRecord?.mixed_layer_topology_certificate,
    manifestRecord?.mixed_layer_topology_certificate_summary,
  );
  const rejectionRecord = asRecord(rejectionEvidence);
  const missingCapabilities = Array.isArray(rejectionRecord?.missing_capabilities)
    ? rejectionRecord.missing_capabilities.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  const counts = firstRecord(
    report?.element_counts_by_type,
    manifestRecord?.element_counts_by_type,
  );
  const facetCounts = firstRecord(
    report?.facet_counts_by_type_and_role,
    manifestRecord?.facet_counts_by_type_and_role,
  );
  const publishedFallbacks = Array.isArray(report?.fallbacks_triggered)
    ? report.fallbacks_triggered
    : Array.isArray(manifestRecord?.fallbacks_triggered)
      ? manifestRecord.fallbacks_triggered
      : null;
  const fallbacks = publishedFallbacks
    ? publishedFallbacks.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  const requestedLayers = firstPositiveInteger(
    requestedPolicy?.layers,
    requestedPolicy?.layer_count,
    requestedPolicy?.num_layers,
    requestedPolicy?.through_thickness_elements,
    certificate?.requested_layer_count,
  );
  const resolvedLayers = firstPositiveInteger(
    resolvedPolicy?.layers,
    resolvedPolicy?.layer_count,
    resolvedPolicy?.num_layers,
    resolvedPolicy?.through_thickness_elements,
    certificate?.realized_layer_count,
  );
  const publishedNodePlanes = firstPositiveInteger(
    certificate?.actual_node_plane_count,
    certificate?.node_plane_count,
    Array.isArray(certificate?.magnetic_plane_coordinates_m)
      ? certificate.magnetic_plane_coordinates_m.length
      : undefined,
  );
  const effectiveLayers = resolvedLayers ?? requestedLayers;
  const nodePlanes =
    publishedNodePlanes ??
    (effectiveLayers === null ? null : effectiveLayers + 1);
  const certificateStatus = firstString(
    certificate?.certificate_status,
    certificate?.status,
    certificate?.accepted === true ? "accepted" : undefined,
    certificate?.accepted === false ? "rejected" : undefined,
  );
  const requestedTopology = firstString(
    provenance?.requested_topology,
    requestedPolicy?.topology,
  );
  const resolvedTopology = firstString(
    provenance?.resolved_topology,
    resolvedPolicy?.topology,
  );

  return {
    certificateFingerprint: firstString(
      certificate?.topology_fingerprint,
      provenance?.accepted_certificate_fingerprint,
    ),
    certificateReason: firstString(
      certificate?.rejection_reason,
      certificate?.reason,
    ),
    certificateStatus,
    elementCounts: flattenedCounts(counts).map(({ key, count }) => ({
      count,
      family: key,
    })),
    facetCounts: flattenedCounts(facetCounts).map(({ key, count }) => ({
      count,
      familyAndRole: key,
    })),
    fallback: publishedFallbacks === null
      ? "not published"
      : fallbacks.length > 0
        ? fallbacks.join(", ")
        : "none (strict)",
    gmshVersion: firstString(report?.gmsh_version, manifestRecord?.gmsh_version),
    layers: requestedLayers,
    nodePlanes,
    requestedExactLayers: firstBoolean(requestedPolicy?.exact_layer_count),
    requestedLayers,
    requestedTopology,
    rejection: rejectionRecord
      ? {
          alternative: firstString(rejectionRecord.free_tetrahedral_alternative),
          category: firstString(rejectionRecord.rejection_category),
          fallback: firstString(rejectionRecord.fallback),
          missingCapabilities,
          reason: firstString(rejectionRecord.rejection_reason),
          requestedExecution: executionSummary(
            rejectionRecord.requested_execution,
            "not published",
          ),
          resolvedExecution: executionSummary(
            rejectionRecord.resolved_execution,
            "not resolved",
          ),
        }
      : null,
    resolvedExactLayers: firstBoolean(resolvedPolicy?.exact_layer_count),
    resolvedLayers,
    resolvedTopology,
    topologySchemaVersion: String(
      report?.topology_schema_version ??
        manifestRecord?.topology_schema_version ??
        "not published",
    ),
    transitionPolicy: firstString(
      requestedPolicy?.transition_policy,
      resolvedPolicy?.transition_policy,
    ),
    visible: Boolean(
      provenance ||
        certificate ||
        counts ||
        facetCounts ||
        requestedPolicy ||
        resolvedPolicy,
    ),
  };
}

export function MixedTopologyProvenanceSection({
  model,
}: {
  model: MixedTopologyPresentation;
}) {
  if (!model.visible) return null;
  const rejected = model.certificateStatus === "rejected";
  return (
    <InspectorGroup
      title="Mixed Topology Provenance"
      badge={model.certificateStatus}
      collapsible
      defaultOpen
    >
      {rejected ? (
        <FeedbackBanner
          kind="error"
          message={`Exact-layer certificate rejected: ${model.certificateReason}.`}
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
      {model.layers === 1 ? (
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
