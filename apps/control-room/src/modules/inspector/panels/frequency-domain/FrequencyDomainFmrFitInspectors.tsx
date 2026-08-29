import { FieldRow } from "../../primitives/FieldRow";

import {
  FrequencyDomainPublishedIdentityRows,
} from "./FrequencyDomainComparisonStateInspectors";
import type { FrequencyDomainPublishedState } from "./FrequencyDomainPublishedState";

export function FrequencyDomainFmrFitContractRows({
  fitKind,
  state,
}: {
  fitKind: "kittel" | "resonance";
  state: FrequencyDomainPublishedState;
}) {
  return (
    <>
      <FieldRow label="Fit contract" value={`${fitKind} fit remains unsupported by typed A2`} />
      <FrequencyDomainPublishedIdentityRows qualification="unsupported" state={state} />
    </>
  );
}
