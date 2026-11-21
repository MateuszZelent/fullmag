import type { resolveMeshQualityRefinementState } from "@/shared/domain/mesh/meshQualityRefinement";
import type {
  MeshQualityMetric,
  MeshWorstElement,
  normalizeMeshQualityStatistics,
} from "@/shared/domain/mesh/qualityStatistics";

import { InspectorGroup } from "../../primitives/InspectorGroup";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { formatCount, formatValue, MeshResourceEmpty, MeshResourceFields } from "../MeshResourceView";
import type { MeshSizeDistributionHoverBin } from "../MeshQualityChart";
import { MeshQualityStatisticsView } from "../MeshQualityStatisticsView";
import { type MixedCertificateQualityPresentation } from "./MeshQualityGatesSection.model";

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
