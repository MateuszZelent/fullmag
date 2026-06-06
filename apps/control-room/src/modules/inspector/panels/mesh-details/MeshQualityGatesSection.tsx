import type { resolveMeshQualityRefinementState } from "@/shared/domain/mesh/meshQualityRefinement";
import type {
  MeshQualityMetric,
  MeshWorstElement,
  normalizeMeshQualityStatistics,
} from "@/shared/domain/mesh/qualityStatistics";

import { InspectorSection } from "../../primitives/InspectorSection";
import { formatCount, MeshResourceEmpty } from "../MeshResourceView";
import type { MeshSizeDistributionHoverBin } from "../MeshQualityChart";
import { MeshQualityStatisticsView } from "../MeshQualityStatisticsView";

export function MeshQualityGatesSection({
  badge,
  gateRows,
}: {
  badge: string;
  gateRows: Array<{ id: string; status: string; value: string }>;
}) {
  return (
    <InspectorSection value="quality-gates" title="Quality Gates" badge={badge} collapsible defaultCollapsed={false}>
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
    </InspectorSection>
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
    <InspectorSection
      value="quality-statistics"
      title="Quality Distributions"
      badge={statistics ? formatCount(statistics.elementCount) : "missing"}
      collapsible
      defaultCollapsed={false}
    >
      <MeshQualityStatisticsView
        statistics={statistics}
        refinementState={refinementState}
        onHoverSizeDistributionBin={onHoverSizeDistributionBin}
        onRefineWorstElement={onRefineWorstElement}
        onSelectMetric={onSelectMetric}
        onSelectWorstElement={onSelectWorstElement}
      />
    </InspectorSection>
  );
}
