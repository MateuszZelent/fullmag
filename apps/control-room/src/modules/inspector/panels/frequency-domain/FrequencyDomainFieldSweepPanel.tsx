"use client";

import { ANALYSIS_FREQUENCY_DOMAIN_EIGEN_FIELD_SWEEP_PATH } from "@/kernel/api/apiPaths";
import { useFrequencyDomainEigenFieldSweepResource } from "@/kernel/resources/studyRuntimeResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { FrequencyDomainFieldSweepContractRows } from "./FrequencyDomainFieldSweepInspectors";
import { frequencyDomainPublishedState } from "./FrequencyDomainPublishedState";

export function EigenFieldSweepInspectorPanel(props: InspectorPanelProps) {
  const resource = useFrequencyDomainEigenFieldSweepResource();
  const ref = props.selection.ref?.type === "frequency-domain"
    ? props.selection.ref
    : null;
  const state = frequencyDomainPublishedState({
    data: resource.data,
    publishedRevision: resource.revision,
    resourceStatus: resource.status,
    runId: ref?.analysisRunId,
    selectedResourceKey: ref?.resourceRef,
    selectedRevision:
      ref?.artifactRevision == null ? null : String(ref.artifactRevision),
    stageId: ref?.analysisStageId,
  });
  const reason = state.binding === "incompatible"
    ? "Selected Field Sweep resource identity or revision does not match the loaded artifact."
    : "Field Sweep is unsupported until typed A2 publishes frequency, unit, branch/tracking, and per-sample result fields.";

  return (
    <div data-inspector-surface="eigen-field-sweep" data-status="unsupported">
      <InspectorGroup title="Eigen Field Sweep" badge="unsupported">
        <FieldRow label="Resource state" value={state.resource} />
        <FieldRow label="Artifact state" value={state.artifact} />
        <FieldRow label="Qualification state" value="unsupported" />
        <FieldRow label="Selection binding" value={state.binding} />
        <FieldRow
          label="Last-valid snapshot"
          value={state.retainedLastValid ? "retained" : "not retained"}
        />
        <FieldRow
          label="Resource"
          value={resource.data?.resource_key ?? ANALYSIS_FREQUENCY_DOMAIN_EIGEN_FIELD_SWEEP_PATH}
        />
        <FieldRow
          label="Revision"
          value={resource.revision == null ? "not published" : String(resource.revision)}
        />
        <FrequencyDomainFieldSweepContractRows state={state} />
        <FieldRow label="Availability" value={reason} />
      </InspectorGroup>
    </div>
  );
}
