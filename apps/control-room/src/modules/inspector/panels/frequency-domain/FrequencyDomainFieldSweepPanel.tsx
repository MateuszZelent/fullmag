"use client";

import { ANALYSIS_FREQUENCY_DOMAIN_EIGEN_FIELD_SWEEP_PATH } from "@/kernel/api/apiPaths";
import { useFrequencyDomainEigenFieldSweepResource } from "@/kernel/resources/studyRuntimeResources";
import { navigatorFieldSweepFromResource } from "@/modules/results-navigator/public";

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
  const typedPayload = navigatorFieldSweepFromResource(resource.data);
  const typedPayloadIncomplete = typedPayload?.complete === false || [
    "corrupt",
    "error",
    "failed",
    "incomplete",
    "interrupted",
    "partial",
  ].includes((typedPayload?.status ?? "").trim().toLowerCase());
  const panelStatus = !typedPayload
    ? "unsupported"
    : state.binding === "incompatible"
      ? "partial"
      : state.artifact === "complete" && !typedPayloadIncomplete
        ? "ready"
        : "partial";
  const reason = state.binding === "incompatible"
    ? "Selected Field Sweep resource identity or revision does not match the loaded artifact."
    : !typedPayload
      ? "Typed Field Sweep payload is not available on this transport."
      : typedPayloadIncomplete
        ? typedPayload.stopReason ?? "Field Sweep is incomplete."
      : typedPayload.joins.spectrum === "stale" || typedPayload.joins.branches === "stale"
        ? "Field Sweep companion revisions are stale; stable Field Sweep data remains visible."
        : null;

  return (
    <div data-inspector-surface="eigen-field-sweep" data-status={panelStatus}>
      <InspectorGroup title="Eigen Field Sweep" badge={panelStatus}>
        <FieldRow label="Resource state" value={state.resource} />
        <FieldRow label="Artifact state" value={state.artifact} />
        <FieldRow label="Qualification state" value={typedPayload ? state.qualification : "unsupported"} />
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
        <FrequencyDomainFieldSweepContractRows
          payload={typedPayload}
          selectedSampleId={ref?.sampleId}
          state={state}
        />
        {reason ? <FieldRow label="Availability" value={reason} /> : null}
      </InspectorGroup>
    </div>
  );
}
