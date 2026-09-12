import { FieldRow } from "../../primitives/FieldRow";

export function FrequencyDomainDrivenResponseContractRows() {
  return (
    <>
      <FieldRow label="Driven Response state" value="unsupported" />
      <FieldRow
        label="Observable contract"
        value="typed exact observable kind, unit, and provenance are not published by A2"
      />
    </>
  );
}
