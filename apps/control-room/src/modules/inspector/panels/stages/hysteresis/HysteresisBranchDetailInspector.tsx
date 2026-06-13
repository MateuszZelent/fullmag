"use client";

import type {
  HysteresisBranchSchema,
  HysteresisMinorLoopSchema,
} from "@/kernel/api/apiTypes";

import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorSection } from "../../../primitives/InspectorSection";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisBranchDetailInspector({
  activeBranch,
  branches,
  minorLoops,
}: Pick<
  HysteresisInspectorCommonProps,
  "activeBranch" | "branches" | "minorLoops"
>) {
  if (activeBranch?.kind === "minor-loops") {
    return (
      <InspectorSection
        value="hysteresis-branch-detail"
        title="Minor Loops"
        badge={`${minorLoops.length} loop(s)`}
      >
        {minorLoops.length > 0 ? (
          <div className="fm-hysteresis-inspector-step-list">
            {minorLoops.map((loop) => (
              <MinorLoopCard key={loop.loop_id} loop={loop} />
            ))}
          </div>
        ) : (
          <div className="fm-hysteresis-inspector-empty">
            No minor-loop artifact is available for this hysteresis stage.
          </div>
        )}
      </InspectorSection>
    );
  }

  const selectedBranch = selectBranchForRequestedRole(
    branches,
    activeBranch?.kind === "branch" ? activeBranch : null,
  );

  return (
    <InspectorSection
      value="hysteresis-branch-detail"
      title={activeBranch?.kind === "branch" ? branchTitle(activeBranch) : "Branch"}
      badge={selectedBranch ? `${selectedBranch.point_count} point(s)` : "not available"}
    >
      {selectedBranch ? (
        <BranchDetail branch={selectedBranch} />
      ) : (
        <div className="fm-hysteresis-inspector-empty">
          Branch metadata is not available yet for the selected branch.
        </div>
      )}
    </InspectorSection>
  );
}

function BranchDetail({ branch }: { branch: HysteresisBranchSchema }) {
  return (
    <>
      <FieldRow label="Branch id" value={branch.branch_id} />
      <FieldRow label="Role" value={branch.branch_role} />
      <FieldRow label="Direction" value={String(branch.direction)} />
      <FieldRow label="Points" value={String(branch.point_count)} />
      <FieldRow label="Start point" value={String(branch.start_point_id)} />
      <FieldRow label="End point" value={String(branch.end_point_id)} />
      <FieldRow
        label="Start field"
        value={branch.start_field_mT.toFixed(3)}
        unit="mT"
      />
      <FieldRow
        label="End field"
        value={branch.end_field_mT.toFixed(3)}
        unit="mT"
      />
      {branch.parent_branch_id && (
        <FieldRow label="Parent branch" value={branch.parent_branch_id} />
      )}
      {branch.minor_loop_id && (
        <FieldRow label="Minor loop" value={branch.minor_loop_id} />
      )}
      {branch.points.length > 0 ? (
        <div className="fm-hysteresis-inspector-table-wrap">
          <table className="fm-hysteresis-inspector-table">
            <thead>
              <tr>
                <th>Point</th>
                <th>Field (mT)</th>
                <th>M_parallel</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {branch.points.map((point) => (
                <tr key={point.point_id} data-status={point.status}>
                  <td>{point.point_id}</td>
                  <td>{point.field_value_mT.toFixed(2)}</td>
                  <td>{point.m_parallel.toFixed(5)}</td>
                  <td>{point.settle_status ?? point.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="fm-hysteresis-inspector-empty">
          This branch has no embedded point list in the current artifact.
        </div>
      )}
    </>
  );
}

function MinorLoopCard({ loop }: { loop: HysteresisMinorLoopSchema }) {
  return (
    <div className="fm-hysteresis-inspector-step">
      <div className="fm-hysteresis-inspector-step__header">
        <span className="fm-hysteresis-inspector-step__title">{loop.loop_id}</span>
        <span className="fm-hysteresis-inspector-step__method">
          {loop.closure_status ?? "closure unknown"}
        </span>
      </div>
      <div className="fm-hysteresis-inspector-step__meta">
        <span>reversal: {loop.reversal_field_mT.toFixed(3)} mT</span>
        <span>return: {loop.return_field_mT.toFixed(3)} mT</span>
        {loop.closure_error_m_parallel != null && (
          <span>closure error: {loop.closure_error_m_parallel.toExponential(2)}</span>
        )}
        {loop.recoil_susceptibility != null && (
          <span>recoil susceptibility: {loop.recoil_susceptibility.toExponential(2)}</span>
        )}
        {loop.minor_loop_area != null && (
          <span>area: {loop.minor_loop_area.toExponential(2)}</span>
        )}
      </div>
    </div>
  );
}

function selectBranchForRequestedRole(
  branches: HysteresisBranchSchema[],
  selection: { branchId: string | null; requestedRole: "forward" | "return" | null } | null,
): HysteresisBranchSchema | null {
  const branchId = selection?.branchId;
  if (branchId) {
    const exactBranch = branches.find((branch) => branch.branch_id === branchId);
    if (exactBranch) return exactBranch;
  }
  const requestedRole = selection?.requestedRole ?? null;
  if (!requestedRole) return branches[0] ?? null;
  const roleCandidates =
    requestedRole === "forward"
      ? ["forward", "descending", "ascending", "virgin"]
      : ["return", "ascending", "descending"];
  return (
    branches.find((branch) =>
      roleCandidates.some((candidate) =>
        branch.branch_role.toLowerCase().includes(candidate),
      ),
    ) ??
    branches.find((branch) =>
      requestedRole === "forward" ? branch.direction < 0 : branch.direction > 0,
    ) ??
    null
  );
}

function branchTitle(selection: {
  branchId: string | null;
  requestedRole: "forward" | "return" | null;
}): string {
  if (selection.requestedRole === "forward") return "Forward Branch";
  if (selection.requestedRole === "return") return "Return Branch";
  return selection.branchId ? `Branch ${selection.branchId}` : "Branch";
}
