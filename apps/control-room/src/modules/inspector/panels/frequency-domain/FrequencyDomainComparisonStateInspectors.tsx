import { FieldRow } from "../../primitives/FieldRow";

import type { FrequencyDomainPublishedState } from "./FrequencyDomainPublishedState";

export function FrequencyDomainPublishedIdentityRows({
  qualification,
  state,
}: {
  qualification: "unknown" | "unsupported";
  state: FrequencyDomainPublishedState;
}) {
  return (
    <>
      <FieldRow label="Artifact path" value={state.source.artifactPath ?? "unknown"} />
      <FieldRow label="Schema version" value={state.source.schemaVersion ?? "unknown"} />
      <FieldRow label="Content digest" value={state.source.contentDigest ?? "unknown"} />
      <FieldRow label="Run" value={state.source.runId ?? "unknown"} />
      <FieldRow label="Stage" value={state.source.stageId ?? "unknown"} />
      <FieldRow label="Resolved backend" value={state.source.backend ?? "unknown"} />
      <FieldRow label="Resolved device" value={state.source.device ?? "unknown"} />
      <FieldRow label="Resolved precision" value={state.source.precision ?? "unknown"} />
      <FieldRow label="Qualification" value={qualification} />
      <FieldRow label="Provenance" value={state.source.provenance ?? "unknown"} />
    </>
  );
}

export function FrequencyDomainComparisonContractRows() {
  return (
    <>
      <FieldRow
        label="Modal input"
        value="modal frequencies are markers, never FMR peak rows"
      />
      <FieldRow
        label="Compatibility"
        value="unsupported until a typed compatibility certificate is published"
      />
    </>
  );
}
