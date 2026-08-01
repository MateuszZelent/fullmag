"use client";

import type {
  HysteresisAdaptiveRefinementCandidateSchema,
  HysteresisPointSchema,
} from "@/kernel/api/apiTypes";

import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorGroup } from "../../../primitives/InspectorGroup";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisAdaptiveRefinementInspector({
  adaptiveRefinement,
}: Pick<HysteresisInspectorCommonProps, "adaptiveRefinement">) {
  const candidates = adaptiveRefinement?.candidates ?? [];
  const points = adaptiveRefinement?.points ?? [];
  const settleTraceCount = adaptiveRefinement?.settle_trace?.length ?? 0;

  return (
    <InspectorGroup
      title="Adaptive Refinement"
      badge={adaptiveRefinement?.status ?? "not available"}
    >
      {adaptiveRefinement ? (
        <>
          <FieldRow label="Status" value={adaptiveRefinement.status} />
          <FieldRow label="Enabled" value={adaptiveRefinement.enabled ? "yes" : "no"} />
          <FieldRow label="Kind" value={adaptiveRefinement.kind} />
          <FieldRow
            label="Source points"
            value={String(adaptiveRefinement.source_point_count)}
          />
          <FieldRow
            label="Pass limit"
            value={`${adaptiveRefinement.max_passes} pass(es), ${adaptiveRefinement.max_insertions_per_pass} insertion(s)/pass`}
          />
          <FieldRow label="Candidates" value={String(candidates.length)} />
          <FieldRow label="Computed points" value={String(points.length)} />
          <FieldRow label="Settle trace rows" value={String(settleTraceCount)} />
          {candidates.length > 0 && (
            <div className="fm-hysteresis-inspector-list">
              {candidates.map((candidate) => (
                <AdaptiveCandidateRow
                  candidate={candidate}
                  key={candidate.candidate_id}
                />
              ))}
            </div>
          )}
          {points.length > 0 && (
            <div className="fm-hysteresis-inspector-list">
              {points.map((point) => (
                <AdaptivePointRow key={point.point_id} point={point} />
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="fm-hysteresis-inspector-empty">
          No adaptive-refinement runtime artifact is available for this
          hysteresis stage yet.
        </div>
      )}
    </InspectorGroup>
  );
}

function AdaptiveCandidateRow({
  candidate,
}: {
  candidate: HysteresisAdaptiveRefinementCandidateSchema;
}) {
  return (
    <div className="fm-hysteresis-inspector-list__item">
      <FieldRow label="Candidate" value={candidate.candidate_id} />
      <FieldRow label="Status" value={candidate.status} />
      <FieldRow label="Field" value={candidate.field_value_mT.toFixed(3)} unit="mT" />
      <FieldRow
        label="Parents"
        value={`${candidate.parent_left_point_id} (${candidate.parent_left_field_mT.toFixed(3)} mT) -> ${candidate.parent_right_point_id} (${candidate.parent_right_field_mT.toFixed(3)} mT)`}
      />
      <FieldRow
        label="dm/dH"
        value={candidate.dm_dh_per_mT.toExponential(4)}
        unit="1/mT"
      />
      <FieldRow label="Reasons" value={candidate.reasons.join(", ") || "n/a"} />
      <FieldRow label="Pass" value={String(candidate.pass_index)} />
    </div>
  );
}

function AdaptivePointRow({ point }: { point: HysteresisPointSchema }) {
  const reasons = point.refinement_reason?.join(", ") || "n/a";
  const parentLeft = point.refinement_parent_left_point_id ?? "n/a";
  const parentRight = point.refinement_parent_right_point_id ?? "n/a";

  return (
    <div className="fm-hysteresis-inspector-list__item">
      <FieldRow label="Inserted point" value={String(point.point_id)} />
      <FieldRow label="Field" value={point.field_value_mT.toFixed(3)} unit="mT" />
      <FieldRow label="m_parallel" value={point.m_parallel.toExponential(4)} />
      <FieldRow label="Parents" value={`${parentLeft} -> ${parentRight}`} />
      <FieldRow label="Reasons" value={reasons} />
      <FieldRow label="Status" value={point.status} />
    </div>
  );
}
