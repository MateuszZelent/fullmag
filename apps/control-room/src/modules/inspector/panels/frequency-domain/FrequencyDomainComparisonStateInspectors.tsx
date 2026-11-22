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
      <FieldRow label="Artifact path" value={state.source.artifactPath ?? "—"} />
      <FieldRow label="Schema version" value={state.source.schemaVersion ?? "—"} />
      <FieldRow label="Content digest" value={state.source.contentDigest ?? "—"} />
      <FieldRow label="Run" value={state.source.runId ?? "—"} />
      <FieldRow label="Stage" value={state.source.stageId ?? "—"} />
      <FieldRow label="Resolved backend" value={state.source.backend ?? "—"} />
      <FieldRow label="Resolved device" value={state.source.device ?? "—"} />
      <FieldRow label="Resolved precision" value={state.source.precision ?? "—"} />
      <FieldRow label="Qualification" value={qualification === "unknown" ? "unverified" : qualification} />
      <FieldRow label="Provenance" value={state.source.provenance ?? "—"} />
    </>
  );
}
