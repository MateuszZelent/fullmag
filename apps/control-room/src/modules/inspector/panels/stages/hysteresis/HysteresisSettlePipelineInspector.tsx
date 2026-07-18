"use client";

import { FieldRow } from "../../../primitives/FieldRow";
import { FormField } from "../../../primitives/FormField";
import { InspectorGroup } from "../../../primitives/InspectorGroup";
import {
  displayValue,
  isRecord,
  parseJsonArray,
} from "./HysteresisInspectorUtils";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

function settleStepKey(step: Record<string, unknown>): string {
  const explicitId =
    displayValue(step.id) ??
    displayValue(step.step_id) ??
    displayValue(step.algorithm_id);
  if (explicitId) return explicitId;
  return JSON.stringify(step);
}

function settleStepValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function settleBranchKey(branch: Record<string, unknown>, index: number): string {
  return (
    displayValue(branch.branch_id) ??
    displayValue(branch.branchId) ??
    displayValue(branch.id) ??
    `${index}:${displayValue(branch.when) ?? "branch"}`
  );
}

function settleBranchRunKind(branch: Record<string, unknown>): string {
  const run = isRecord(branch.run) ? branch.run : null;
  return displayValue(run?.algorithm_kind) ?? displayValue(run?.kind) ?? "n/a";
}

function resolvedSettleStep(step: Record<string, unknown>): Record<string, unknown> {
  const resolvedParameters = isRecord(step.resolved_parameters)
    ? step.resolved_parameters
    : {};
  return { ...resolvedParameters, ...step };
}

function resolvedBranchIdsToRecords(branchIds: readonly unknown[]): Record<string, unknown>[] {
  return branchIds
    .filter((branchId): branchId is string => typeof branchId === "string")
    .map((branchId) => ({ branch_id: branchId }));
}

export function HysteresisSettlePipelineInspector({
  draft,
  executionTree,
  onUpdateDraft,
  settlePipeline,
}: Pick<
  HysteresisInspectorCommonProps,
  "draft" | "executionTree" | "onUpdateDraft" | "settlePipeline"
>) {
  const pipeline = isRecord(settlePipeline?.settle_pipeline)
    ? settlePipeline.settle_pipeline
    : null;
  const topLevelResolvedSteps = Array.isArray(settlePipeline?.resolved_steps)
    ? settlePipeline.resolved_steps.flatMap((step) =>
        isRecord(step) ? [resolvedSettleStep(step)] : [],
      )
    : [];
  const rawPipelineSteps = Array.isArray(pipeline?.steps)
    ? pipeline.steps.filter(isRecord)
    : [];
  const settleSteps = topLevelResolvedSteps.length > 0
    ? topLevelResolvedSteps
    : rawPipelineSteps.length > 0
      ? rawPipelineSteps
      : parseJsonArray(draft?.settleSteps);
  const topLevelResolvedBranches = Array.isArray(settlePipeline?.resolved_branch_ids)
    ? resolvedBranchIdsToRecords(settlePipeline.resolved_branch_ids)
    : [];
  const rawPipelineBranches = Array.isArray(pipeline?.branches)
    ? pipeline.branches.filter(isRecord)
    : [];
  const settleBranches = topLevelResolvedBranches.length > 0
    ? topLevelResolvedBranches
    : rawPipelineBranches.length > 0
      ? rawPipelineBranches
      : parseJsonArray(draft?.settleBranches);
  const executionNodes = Array.isArray(executionTree?.nodes)
    ? executionTree.nodes
    : [];
  const activeNode = executionNodes.find((node) => node.status === "active");
  const activeStep = activeNode?.children?.find((node) => node.status === "active");

  return (
    <InspectorGroup
      title="Settle Pipeline"
      badge={`${settleSteps.length} step(s)`}
    >
      <FieldRow
        label="Pipeline mode"
        value={displayValue(pipeline?.kind) ?? draft?.settlePipelineMode ?? "n/a"}
      />
      {draft?.kind === "hysteresis" ? (
        <div className="fm-inspector-form-section">
          <div className="fm-inspector-form-section__header">
            <strong>Draft controls</strong>
            <span>Save stage commits changes</span>
          </div>
          <FormField
            label="Settle pipeline mode"
            type="select"
            value={draft.settlePipelineMode}
            onChange={(event) =>
              onUpdateDraft({ settlePipelineMode: event.target.value })
            }
          >
            <option value="sequence">Sequence</option>
            <option value="tree">Tree</option>
          </FormField>
          <FormField
            label="Settle steps JSON"
            rows={5}
            type="textarea"
            value={draft.settleSteps}
            onChange={(event) =>
              onUpdateDraft({ settleSteps: event.target.value })
            }
          />
          {draft.settlePipelineMode === "tree" ? (
            <>
              <FormField
                label="Fallback branches JSON"
                rows={4}
                type="textarea"
                value={draft.settleBranches}
                onChange={(event) =>
                  onUpdateDraft({ settleBranches: event.target.value })
                }
              />
            </>
          ) : null}
        </div>
      ) : null}
      {activeStep && (
        <FieldRow
          label="Active algorithm"
          value={`${activeStep.label} (${activeStep.status})`}
        />
      )}
      {settleSteps.length > 0 ? (
        <div className="fm-hysteresis-inspector-step-list">
          {settleSteps.map((step, idx) => (
            <div key={settleStepKey(step)} className="fm-hysteresis-inspector-step">
              <div className="fm-hysteresis-inspector-step__header">
                <span className="fm-hysteresis-inspector-step__title">
                  {idx + 1}. {displayValue(step.algorithm_kind) ?? displayValue(step.kind) ?? "Step"}
                </span>
                <span className="fm-hysteresis-inspector-step__method">
                  {displayValue(step.method)}
                </span>
              </div>
              <div className="fm-hysteresis-inspector-step__meta">
                {settleStepValue(step.step_id) && (
                  <span>Step ID: {settleStepValue(step.step_id)}</span>
                )}
                {settleStepValue(step.applies_to) && (
                  <span>Applies to: {settleStepValue(step.applies_to)}</span>
                )}
                {displayValue(step.torque_tolerance) && (
                  <span>Torque tol: {displayValue(step.torque_tolerance)}</span>
                )}
                {displayValue(step.energy_tolerance) && (
                  <span>Energy tol: {displayValue(step.energy_tolerance)}</span>
                )}
                {displayValue(step.max_steps) && <span>Max steps: {displayValue(step.max_steps)}</span>}
                {displayValue(step.alpha) && <span>Alpha: {displayValue(step.alpha)}</span>}
                {displayValue(step.damping) && <span>Damping: {displayValue(step.damping)}</span>}
                {displayValue(step.timestep_s) && (
                  <span>Timestep: {displayValue(step.timestep_s)}</span>
                )}
                {displayValue(step.dt) && <span>dt: {displayValue(step.dt)}</span>}
                {displayValue(step.on_non_convergence) && (
                  <span>On non-convergence: {displayValue(step.on_non_convergence)}</span>
                )}
                {displayValue(step.retry_timestep_scale) && (
                  <span>Retry scale: {displayValue(step.retry_timestep_scale)}</span>
                )}
                {displayValue(step.retry_max_attempts) && (
                  <span>Retry attempts: {displayValue(step.retry_max_attempts)}</span>
                )}
                {settleStepValue(step.stop_criteria) && (
                  <span>Stop criteria: {settleStepValue(step.stop_criteria)}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="fm-hysteresis-inspector-empty">
          Using solver default relaxation sequence.
        </div>
      )}
      {settleBranches.length > 0 && (
        <div className="fm-hysteresis-inspector-step-list">
          <FieldRow label="Fallback branches" value={`${settleBranches.length}`} />
          {settleBranches.map((branch, index) => (
            <div
              className="fm-hysteresis-inspector-step"
              key={settleBranchKey(branch, index)}
            >
              <div className="fm-hysteresis-inspector-step__header">
                <span className="fm-hysteresis-inspector-step__title">
                  Branch {index + 1}
                </span>
                <span className="fm-hysteresis-inspector-step__method">
                  {displayValue(branch.branch_id) ??
                    displayValue(branch.branchId) ??
                    "fallback"}
                </span>
              </div>
              <div className="fm-hysteresis-inspector-step__meta">
                {displayValue(branch.when) && (
                  <span>Trigger: {displayValue(branch.when)}</span>
                )}
                <span>Run: {settleBranchRunKind(branch)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </InspectorGroup>
  );
}
