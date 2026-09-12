"use client";

import {
  ANALYSIS_FREQUENCY_DOMAIN_FMR_KITTEL_FIT_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_FMR_RESONANCE_FITS_PATH,
} from "@/kernel/api/apiPaths";
import type { FrequencyDomainJsonArtifactResource } from "@/kernel/api/apiTypes";
import {
  useFrequencyDomainFmrKittelFitResource,
  useFrequencyDomainFmrResonanceFitsResource,
} from "@/kernel/resources/studyRuntimeResources";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { FrequencyDomainFmrFitContractRows } from "./FrequencyDomainFmrFitInspectors";
import { frequencyDomainPublishedState } from "./FrequencyDomainPublishedState";

export function FmrResonanceFitsInspectorPanel(props: InspectorPanelProps) {
  const resource = useFrequencyDomainFmrResonanceFitsResource();
  return (
    <FmrFitInspectorPanel
      artifactLabel="Resonance fits"
      fitKind="resonance"
      props={props}
      resource={resource}
      resourcePath={ANALYSIS_FREQUENCY_DOMAIN_FMR_RESONANCE_FITS_PATH}
    />
  );
}

export function FmrKittelFitInspectorPanel(props: InspectorPanelProps) {
  const resource = useFrequencyDomainFmrKittelFitResource();
  return (
    <FmrFitInspectorPanel
      artifactLabel="Kittel fit"
      fitKind="kittel"
      props={props}
      resource={resource}
      resourcePath={ANALYSIS_FREQUENCY_DOMAIN_FMR_KITTEL_FIT_PATH}
    />
  );
}

function FmrFitInspectorPanel({
  artifactLabel,
  fitKind,
  props,
  resource,
  resourcePath,
}: {
  artifactLabel: string;
  fitKind: "kittel" | "resonance";
  props: InspectorPanelProps;
  resource: {
    data: FrequencyDomainJsonArtifactResource | null;
    revision: string | number | null;
    status: ResourceStatus;
  };
  resourcePath: string;
}) {
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

  return (
    <div data-inspector-surface={`fmr-${fitKind}-fit`} data-status="unsupported">
      <InspectorGroup title={`FMR ${artifactLabel}`} badge="unsupported">
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
          value={resource.data?.resource_key ?? resourcePath}
        />
        <FieldRow
          label="Revision"
          value={resource.revision == null ? "not published" : String(resource.revision)}
        />
        <FrequencyDomainFmrFitContractRows fitKind={fitKind} state={state} />
      </InspectorGroup>
    </div>
  );
}
