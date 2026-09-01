import { FieldRow } from "../../primitives/FieldRow";

import {
  FrequencyDomainPublishedIdentityRows,
} from "./FrequencyDomainComparisonStateInspectors";
import type { FrequencyDomainPublishedState } from "./FrequencyDomainPublishedState";

export function FrequencyDomainFmrPeakContractRows({
  state,
}: {
  state: FrequencyDomainPublishedState;
}) {
  return (
    <>
      <FieldRow
        label="Peak workflow"
        value="published fmr/peaks.v1 only; modal frequencies remain markers"
      />
      <FrequencyDomainPublishedIdentityRows qualification="unsupported" state={state} />
    </>
  );
}
