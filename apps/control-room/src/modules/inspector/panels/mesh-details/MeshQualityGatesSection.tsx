import type { resolveMeshQualityRefinementState } from "@/shared/domain/mesh/meshQualityRefinement";
import type {
  MeshQualityMetric,
  MeshWorstElement,
  normalizeMeshQualityStatistics,
} from "@/shared/domain/mesh/qualityStatistics";

import { InspectorGroup } from "../../primitives/InspectorGroup";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import {
  asRecord,
  formatCount,
  formatValue,
  MeshResourceEmpty,
  MeshResourceFields,
} from "../MeshResourceView";
import type { MeshSizeDistributionHoverBin } from "../MeshQualityChart";
import { MeshQualityStatisticsView } from "../MeshQualityStatisticsView";

export interface MixedCertificateQualityPresentation {
  certificateFingerprint: string;
  certificateSchemaVersion: string;
  certificateStatus: string;
  familyGates: readonly {
    family: string;
    metric: string;
    minimumJacobianM3: number;
    p05: number;
    passed: boolean;
    positiveJacobian: boolean;
    threshold: number;
  }[];
  meshRevision: number | null;
  reason: string;
  status: "valid" | "stale" | "rejected" | "unavailable";
  topologyFingerprint: string;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function resolveMixedCertificateQualityPresentation(
  value: unknown,
): MixedCertificateQualityPresentation {
  const record = asRecord(value);
  const publishedStatus = nonEmptyString(record?.status);
  const topologyFingerprint = nonEmptyString(record?.topology_fingerprint);
  const certificateFingerprint = nonEmptyString(record?.certificate_fingerprint);
  const certificateStatus = nonEmptyString(record?.certificate_status);
  const meshRevision = finiteNumber(record?.mesh_revision);
  const reason = nonEmptyString(record?.reason) ?? "No mixed-certificate evidence published.";
  const identityIsCurrent =
    topologyFingerprint !== null &&
    certificateFingerprint !== null &&
    topologyFingerprint === certificateFingerprint;
  const rows = Array.isArray(record?.family_gates) ? record.family_gates : [];
  const familyGates = rows.flatMap((entry) => {
    const row = asRecord(entry);
    const family = nonEmptyString(row?.family);
    const metric = nonEmptyString(row?.metric);
    const p05 = finiteNumber(row?.p05);
    const threshold = finiteNumber(row?.threshold);
    const minimumJacobianM3 = finiteNumber(row?.minimum_jacobian_m3);
    if (
      family === null ||
      metric === null ||
      p05 === null ||
      threshold === null ||
      minimumJacobianM3 === null ||
      typeof row?.passed !== "boolean" ||
      typeof row?.positive_jacobian !== "boolean"
    ) {
      return [];
    }
    return [{
      family,
      metric,
      minimumJacobianM3,
      p05,
      passed: row.passed,
      positiveJacobian: row.positive_jacobian,
      threshold,
    }];
  });
  const valid =
    publishedStatus === "valid" &&
    certificateStatus === "accepted" &&
    identityIsCurrent &&
    familyGates.length > 0 &&
    familyGates.length === rows.length;
  const status = valid
    ? "valid"
    : publishedStatus === "stale" ||
        (publishedStatus === "valid" && !identityIsCurrent)
      ? "stale"
      : publishedStatus === "rejected" || publishedStatus === "valid"
        ? "rejected"
        : "unavailable";

  return {
    certificateFingerprint: certificateFingerprint ?? "not published",
    certificateSchemaVersion:
      nonEmptyString(record?.certificate_schema_version) ?? "not published",
    certificateStatus: certificateStatus ?? "not published",
    familyGates: valid ? familyGates : [],
    meshRevision,
    reason: valid ? "Current certificate evidence is complete." : reason,
    status,
    topologyFingerprint: topologyFingerprint ?? "not published",
  };
}

export function MeshQualityGatesSection({
  badge,
  gateRows,
  mixedCertificate,
}: {
  badge: string;
  gateRows: Array<{ id: string; status: string; value: string }>;
  mixedCertificate: MixedCertificateQualityPresentation;
}) {
  return (
    <InspectorGroup title="Quality Gates" badge={badge} collapsible defaultOpen>
      {gateRows.length > 0 ? (
        <div className="fm-mesh-detail-table" role="table">
          <div className="fm-mesh-detail-table__row" role="row">
            <span>Check</span>
            <span>Status</span>
            <span>Value</span>
          </div>
          {gateRows.map((row) => (
            <div
              key={row.id}
              className="fm-mesh-detail-table__row"
              data-status={row.status}
              role="row"
            >
              <span>{row.id}</span>
              <span>{row.status}</span>
              <span>{row.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <MeshResourceEmpty label="No quality-gate checks published yet." />
      )}
      <strong id="fm-mixed-certificate-quality-heading">Mixed certificate quality</strong>
      {mixedCertificate.status === "valid" ? null : (
        <FeedbackBanner
          kind="warning"
          message={`Mixed certificate evidence is ${mixedCertificate.status}: ${mixedCertificate.reason}`}
        />
      )}
      <MeshResourceFields
        fields={[
          { label: "Evidence status", value: mixedCertificate.status },
          { label: "Mesh revision", value: String(mixedCertificate.meshRevision ?? "not published") },
          { label: "Topology fingerprint", value: mixedCertificate.topologyFingerprint },
          { label: "Certificate fingerprint", value: mixedCertificate.certificateFingerprint },
          { label: "Certificate schema", value: mixedCertificate.certificateSchemaVersion },
          { label: "Certificate status", value: mixedCertificate.certificateStatus },
        ]}
      />
      {mixedCertificate.familyGates.length > 0 ? (
        <div
          aria-labelledby="fm-mixed-certificate-quality-heading"
          className="fm-mesh-detail-table"
          role="table"
        >
          <div className="fm-mesh-detail-table__row" role="row">
            <span role="columnheader">Family / metric</span>
            <span role="columnheader">p05 / threshold</span>
            <span role="columnheader">Jacobian</span>
          </div>
          {mixedCertificate.familyGates.map((gate) => (
            <div
              key={`${gate.family}:${gate.metric}`}
              className="fm-mesh-detail-table__row"
              data-status={gate.passed && gate.positiveJacobian ? "pass" : "fail"}
              role="row"
            >
              <span role="cell">{gate.family} · {gate.metric}</span>
              <span role="cell">{formatValue(gate.p05)} / {formatValue(gate.threshold)} · {gate.passed ? "pass" : "fail"}</span>
              <span role="cell">{gate.positiveJacobian ? "positive" : "non-positive"} · {formatValue(gate.minimumJacobianM3)} m³</span>
            </div>
          ))}
        </div>
      ) : null}
    </InspectorGroup>
  );
}

export function MeshQualityStatisticsSection({
  onHoverSizeDistributionBin,
  onRefineWorstElement,
  onSelectMetric,
  onSelectWorstElement,
  refinementState,
  statistics,
}: {
  onHoverSizeDistributionBin: (bin: MeshSizeDistributionHoverBin | null) => void;
  onRefineWorstElement: () => void;
  onSelectMetric: (metric: MeshQualityMetric["id"]) => void;
  onSelectWorstElement: (element: MeshWorstElement) => void;
  refinementState: ReturnType<typeof resolveMeshQualityRefinementState>;
  statistics: ReturnType<typeof normalizeMeshQualityStatistics>;
}) {
  return (
    <InspectorGroup
      title="Quality Distributions"
      badge={statistics ? formatCount(statistics.elementCount) : "missing"}
      collapsible
      defaultOpen
    >
      <MeshQualityStatisticsView
        statistics={statistics}
        refinementState={refinementState}
        onHoverSizeDistributionBin={onHoverSizeDistributionBin}
        onRefineWorstElement={onRefineWorstElement}
        onSelectMetric={onSelectMetric}
        onSelectWorstElement={onSelectWorstElement}
      />
    </InspectorGroup>
  );
}
