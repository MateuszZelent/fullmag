import { FieldRow } from "../../primitives/FieldRow";

import {
  FrequencyDomainPublishedIdentityRows,
} from "./FrequencyDomainComparisonStateInspectors";
import type { FrequencyDomainPublishedState } from "./FrequencyDomainPublishedState";

export function FrequencyDomainFieldSweepContractRows({
  state,
}: {
  state: FrequencyDomainPublishedState;
}) {
  return (
    <>
      <FrequencyDomainPublishedIdentityRows qualification="unsupported" state={state} />
      <FieldRow label="Bias axis" value="H_bias [A/m] (typed); chart unavailable" />
      <FieldRow label="Frequency axis" value="not published by typed A2" />
    </>
  );
}
