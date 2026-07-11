"use client";

import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import { StageInspectorFrame, type StageInspectorFrameProps } from "./StageInspectorFrame";

export function RelaxStageInspector(props: StageInspectorFrameProps) {
  const draft = props.draft;
  const stage = props.stage;
  return (
    <>
      <StageInspectorFrame {...props} expectedKind="relax" kindLabel="Relax" />
      <InspectorSection
        value="relax-stop-criteria"
        title="Stop Criteria"
        badge={stage?.status ?? "draft"}
      >
        <FieldRow
          label="Torque tolerance"
          value={
            stage?.torqueToleranceFormatted ??
            draft?.torqueTolerance ??
            "not set"
          }
        />
        <FieldRow
          label="Energy tolerance"
          value={stage?.energyTolerance ?? draft?.energyTolerance ?? "not set"}
        />
        <FieldRow
          label="Max steps"
          value={stage?.maxSteps ?? draft?.maxSteps ?? "not set"}
        />
        {draft?.algorithm === "llg_overdamped" ? (
          <FieldRow
            label="Max relaxation time"
            value={draft.maxRelaxationTime || "not set"}
            unit={draft.maxRelaxationTime ? "s" : undefined}
          />
        ) : null}
      </InspectorSection>
      <InspectorSection
        value="relax-numerics"
        title="Numerics"
        badge={draft?.algorithm ?? "algorithm"}
      >
        <FieldRow label="Algorithm" value={draft?.algorithm ?? "not set"} />
        {draft?.algorithm === "llg_overdamped" ? (
          <>
            <FieldRow label="Integrator" value={draft.solver || "default"} />
            <FieldRow label="Fixed dt" value={draft.dt || "auto"} />
            <FieldRow label="Adaptive dt min" value={draft.dtMin || "not set"} />
            <FieldRow label="Adaptive tolerance" value={draft.maxError || "not set"} />
            <FieldRow label="Relax alpha" value={draft.relaxAlpha || "not set"} />
            <FieldRow label="Demag interval" value={draft.demagInterval || "not set"} />
            <FieldRow label="Field refresh" value={draft.fieldEvery || "not set"} />
          </>
        ) : null}
      </InspectorSection>
      <InspectorSection value="relax-results" title="Relax Results">
        <FieldRow
          label="Metric"
          value={stage?.runtimeMetric?.name ?? "not available"}
        />
        <FieldRow
          label="Metric value"
          value={stage?.runtimeMetric?.value ?? "not available"}
        />
        <FieldRow
          label="Metric threshold"
          value={stage?.runtimeMetric?.threshold ?? "not available"}
        />
        <FieldRow label="Stop reason" value={stage?.stopReason ?? "not available"} />
        <FieldRow
          label="Converged"
          value={
            stage?.converged === null || stage?.converged === undefined
              ? "not reported"
              : stage.converged
                ? "yes"
                : "no"
          }
        />
      </InspectorSection>
    </>
  );
}
