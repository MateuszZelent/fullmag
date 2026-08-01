import type { MeshPolicyDiffRow } from "@/shared/domain/mesh/meshPolicyDiff";

import { InspectorGroup } from "../../primitives/InspectorGroup";
import { MeshResourceEmpty } from "../MeshResourceView";

export function MeshPolicyComparisonSection({
  rows,
}: {
  rows: MeshPolicyDiffRow[];
}) {
  return (
    <InspectorGroup
      title="Policy Comparison"
      badge={`${rows.length}`}
      collapsible
      defaultOpen={rows.length > 0}
    >
      {rows.length > 0 ? (
        <div className="fm-mesh-detail-table" role="table">
          <div className="fm-mesh-detail-table__row" role="row">
            <span>Parameter</span>
            <span>Current</span>
            <span>Draft</span>
            <span>Realized</span>
            <span>Impact</span>
          </div>
          {rows.map((row) => (
            <div
              key={`${row.scope}:${row.path}`}
              className="fm-mesh-detail-table__row"
              data-status={row.state}
              role="row"
            >
              <span>{row.label}</span>
              <span>{row.currentValue}</span>
              <span>{row.draftValue}</span>
              <span>{row.realizedValue}</span>
              <span>{row.impact}</span>
            </div>
          ))}
        </div>
      ) : (
        <MeshResourceEmpty label="No shared-domain policy fields are available for comparison yet." />
      )}
    </InspectorGroup>
  );
}
