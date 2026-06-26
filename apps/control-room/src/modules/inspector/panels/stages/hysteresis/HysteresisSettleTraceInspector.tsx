"use client";

import type { HysteresisSettleTraceEntrySchema } from "@/kernel/api/apiTypes";

import { InspectorSection } from "../../../primitives/InspectorSection";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisSettleTraceInspector({
  activePoint,
  settleTrace,
  settleTraceStatus,
}: Pick<
  HysteresisInspectorCommonProps,
  "activePoint" | "settleTrace" | "settleTraceStatus"
>) {
  return (
    <InspectorSection
      value="hysteresis-settle-trace"
      title="Settle Trace"
      badge={
        activePoint?.pointId == null
          ? settleTrace.length > 0
            ? `${settleTrace.length} stage step(s)`
            : settleTraceStatus === "loading"
              ? "loading"
              : "no stage trace"
          : settleTrace.length > 0
            ? `${settleTrace.length} step(s)`
            : settleTraceStatus === "loading"
              ? "loading"
              : "no trace"
      }
    >
      {settleTrace.length > 0 ? (
        <div className="fm-hysteresis-inspector-step-list">
          {settleTrace.map((entry) => (
            <HysteresisSettleTraceRow
              key={`${entry.step_index}-${entry.algorithm_id}-${entry.retry_attempt}`}
              entry={entry}
            />
          ))}
        </div>
      ) : activePoint?.pointId == null ? (
        <div className="fm-hysteresis-inspector-empty">
          No stage-level settle trace is available yet.
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
        <span>Status: {settleTraceStatusLabel(entry.status)}</span>
        {entry.protocol_role && <span>Role: {entry.protocol_role}</span>}
        {entry.point_id != null && <span>Point: {entry.point_id}</span>}
        {entry.retry_attempt > 0 && <span>retry {entry.retry_attempt}</span>}
        {entry.resolved_timestep_s != null && (
          <span>dt: {entry.resolved_timestep_s.toExponential(2)} s</span>
        )}
        {entry.torque != null && <span>Torque: {entry.torque.toExponential(2)}</span>}
        {entry.energy != null && <span>Energy: {entry.energy.toExponential(2)}</span>}
        {entry.stop_reason && <span>Stop reason: {entry.stop_reason}</span>}
        {entry.metric_name && <span>Stop metric: {entry.metric_name}</span>}
        {entry.metric_value != null && (
          <span>Value: {entry.metric_value.toExponential(2)}</span>
        )}
        {entry.threshold != null && (
          <span>Threshold: {entry.threshold.toExponential(2)}</span>
        )}
        {entry.resolved_parameters != null && (
          <span>
            Resolved params: {settleTraceValue(entry.resolved_parameters)}
          </span>
        )}
        {entry.fallback_reason && <span>Fallback: {entry.fallback_reason}</span>}
      </div>
    </div>
  );
}

function settleTraceStatusLabel(status: string): string {
  if (status === "completed_duration") return "duration complete";
  if (status === "non_converged") return "non converged";
  return status;
}

function settleTraceValue(value: unknown): string {
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
