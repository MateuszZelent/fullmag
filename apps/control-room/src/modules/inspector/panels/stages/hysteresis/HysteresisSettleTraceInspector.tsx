"use client";

import type { HysteresisSettleTraceEntrySchema } from "@/kernel/api/apiTypes";

import { InspectorSection } from "../../../primitives/InspectorSection";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisSettleTraceInspector({
  activeSnapshot,
  settleTrace,
  settleTraceStatus,
}: Pick<
  HysteresisInspectorCommonProps,
  "activeSnapshot" | "settleTrace" | "settleTraceStatus"
>) {
  return (
    <InspectorSection
      value="hysteresis-settle-trace"
      title="Settle Trace"
      badge={
        activeSnapshot?.pointId == null
          ? "select point"
          : settleTrace.length > 0
            ? `${settleTrace.length} step(s)`
            : settleTraceStatus === "loading"
              ? "loading"
              : "no trace"
      }
    >
      {activeSnapshot?.pointId == null ? (
        <div className="fm-hysteresis-inspector-empty">
          Select a calculated point to inspect the algorithms actually run for that field.
        </div>
      ) : settleTrace.length > 0 ? (
        <div className="fm-hysteresis-inspector-step-list">
          {settleTrace.map((entry) => (
            <HysteresisSettleTraceRow
              key={`${entry.step_index}-${entry.algorithm_id}-${entry.retry_attempt}`}
              entry={entry}
            />
          ))}
        </div>
      ) : (
        <div className="fm-hysteresis-inspector-empty">
          No settle trace is available for the selected point.
        </div>
      )}
    </InspectorSection>
  );
}

function HysteresisSettleTraceRow({
  entry,
}: {
  entry: HysteresisSettleTraceEntrySchema;
}) {
  return (
    <div className="fm-hysteresis-inspector-step">
      <div className="fm-hysteresis-inspector-step__header">
        <span className="fm-hysteresis-inspector-step__title">
          {entry.step_index + 1}. {entry.algorithm_id}
        </span>
        <span className="fm-hysteresis-inspector-step__method">{entry.method}</span>
      </div>
      <div className="fm-hysteresis-inspector-step__meta">
        <span>Status: {entry.status}</span>
        {entry.retry_attempt > 0 && <span>retry {entry.retry_attempt}</span>}
        {entry.resolved_timestep_s != null && (
          <span>dt: {entry.resolved_timestep_s.toExponential(2)} s</span>
        )}
        {entry.torque != null && <span>Torque: {entry.torque.toExponential(2)}</span>}
        {entry.energy != null && <span>Energy: {entry.energy.toExponential(2)}</span>}
        {entry.fallback_reason && <span>Fallback: {entry.fallback_reason}</span>}
      </div>
    </div>
  );
}
