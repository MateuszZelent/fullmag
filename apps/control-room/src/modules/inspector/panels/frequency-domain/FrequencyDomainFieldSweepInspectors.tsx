import { FieldRow } from "../../primitives/FieldRow";

import {
  FrequencyDomainPublishedIdentityRows,
} from "./FrequencyDomainComparisonStateInspectors";
import type { FrequencyDomainPublishedState } from "./FrequencyDomainPublishedState";
import type { NavigatorFieldSweepPayload } from "@/modules/results-navigator/public";

import { buildFrequencyDomainFieldSweepInspectorModel } from "./FrequencyDomainFieldSweepInspectorModel";

export function FrequencyDomainFieldSweepContractRows({
  payload,
  state,
  selectedSampleId,
}: {
  payload?: NavigatorFieldSweepPayload | null;
  state: FrequencyDomainPublishedState;
  selectedSampleId?: string | null;
}) {
  const model = payload
    ? buildFrequencyDomainFieldSweepInspectorModel(payload, selectedSampleId)
    : null;
  return (
    <>
      <FrequencyDomainPublishedIdentityRows
        qualification={model ? "unknown" : "unsupported"}
        state={state}
      />
      <FieldRow label="Dataset revision" value={model?.datasetRevision ?? "not published"} mono />
      <FieldRow label="Source revision" value={model?.sourceRevision ?? "not published"} mono />
      <FieldRow label="Samples requested" value={model?.requestedSamples ?? "not published"} />
      <FieldRow label="Samples completed" value={model?.completedSamples ?? "not published"} />
      <FieldRow label="Scan axis" value={model?.axis ?? "not published"} />
      <FieldRow label="Display conversions" value={model?.conversions ?? "not published"} />
      <FieldRow label="Units" value={model?.units ?? "not published"} />
      <FieldRow label="Selected sample" value={model?.selectedSample ?? "not selected"} />
      <FieldRow label="Selected coordinates" value={model?.selectedCoordinates ?? "not selected"} />
      <FieldRow label="Sample status" value={model?.sampleStatus ?? "not published"} />
      <FieldRow label="Branch tracking" value={model?.branchTracking ?? "not published"} />
      <FieldRow label="Topology" value={model?.topology ?? "not published"} />
      <FieldRow label="Mode fields" value={model?.fieldAvailability ?? "not published"} />
    </>
  );
}
