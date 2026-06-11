"use client";

import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorSection } from "../../../primitives/InspectorSection";
import { displayValue, isRecord, parseJsonArray } from "./HysteresisInspectorUtils";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisSettlePipelineInspector({
  draft,
  executionTree,
  settlePipeline,
}: Pick<HysteresisInspectorCommonProps, "draft" | "executionTree" | "settlePipeline">) {
  const pipeline = isRecord(settlePipeline?.settle_pipeline)
    ? settlePipeline.settle_pipeline
    : null;
  const resolvedSteps = Array.isArray(pipeline?.steps)
    ? pipeline.steps.filter(isRecord)
    : [];
  const settleSteps = resolvedSteps.length > 0
    ? resolvedSteps
    : parseJsonArray(draft?.settleSteps);
  const activeNode = executionTree?.nodes.find((node) => node.status === "active");
  const activeStep = activeNode?.children?.find((node) => node.status === "active");

  return (
    <InspectorSection
      value="hysteresis-settle"
      title="Settle Pipeline"
      badge={`${settleSteps.length} step(s)`}
    >
      <FieldRow
        label="Pipeline mode"
        value={displayValue(pipeline?.kind) ?? draft?.settlePipelineMode ?? "n/a"}
      />
      {activeStep && (
        <FieldRow
          label="Active algorithm"
          value={`${activeStep.label} (${activeStep.status})`}
        />
      )}
      {settleSteps.length > 0 ? (
        <div className="fm-hysteresis-inspector-step-list">
          {settleSteps.map((step, idx) => (
            <div key={idx} className="fm-hysteresis-inspector-step">
              <div className="fm-hysteresis-inspector-step__header">
                <span className="fm-hysteresis-inspector-step__title">
                  {idx + 1}. {displayValue(step.algorithm_kind) ?? displayValue(step.kind) ?? "Step"}
                </span>
                <span className="fm-hysteresis-inspector-step__method">
                  {displayValue(step.method)}
                </span>
              </div>
              <div className="fm-hysteresis-inspector-step__meta">
                {displayValue(step.torque_tolerance) && (
                  <span>Torque tol: {displayValue(step.torque_tolerance)}</span>
                )}
                {displayValue(step.max_steps) && <span>Max steps: {displayValue(step.max_steps)}</span>}
                {displayValue(step.alpha) && <span>Alpha: {displayValue(step.alpha)}</span>}
                {displayValue(step.dt) && <span>dt: {displayValue(step.dt)}</span>}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="fm-hysteresis-inspector-empty">
          Using solver default relaxation sequence.
        </div>
      )}
    </InspectorSection>
  );
}
