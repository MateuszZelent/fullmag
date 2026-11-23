"use client";

import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorGroup } from "../../../primitives/InspectorGroup";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisBranchesInspector({
  branches,
  draft,
  minorLoops,
}: Pick<HysteresisInspectorCommonProps, "branches" | "draft" | "minorLoops">) {
  return (
    <InspectorGroup
      title="Branches"
      badge={`${branches.length} branch(es)`}
    >
      <FieldRow label="Requested branch mode" value={draft?.protocolKind ?? "n/a"} />
      <FieldRow label="Minor loops" value={`${minorLoops.length} loop(s)`} />
      {branches.length > 0 ? (
        <div className="fm-hysteresis-inspector-step-list">
          {branches.map((branch) => (
            <div key={branch.branch_id} className="fm-hysteresis-inspector-step">
              <div className="fm-hysteresis-inspector-step__header">
                <span className="fm-hysteresis-inspector-step__title">{branch.branch_id}</span>
                <span className="fm-hysteresis-inspector-step__method">
                  {branch.branch_role}
                </span>
              </div>
              <div className="fm-hysteresis-inspector-step__meta">
                <span>points: {branch.point_count}</span>
                {branch.parent_branch_id && <span>parent: {branch.parent_branch_id}</span>}
                <span>start: {branch.start_field_mT.toFixed(3)} mT</span>
                <span>end: {branch.end_field_mT.toFixed(3)} mT</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="fm-hysteresis-inspector-empty">
          Branch metadata is not available yet.
        </div>
      )}
    </InspectorGroup>
  );
}
