"use client";

import { FieldRow } from "../../primitives/FieldRow";
import { keyedOccurrences } from "@/shared/utils/keyedOccurrences";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  StageInspectorFrame,
  type StageInspectorFrameProps,
} from "./StageInspectorFrame";
import type { MaskFieldDriveStageSummary } from "./maskFieldDriveStageSummary";

interface MaskFieldDriveStageInspectorProps extends StageInspectorFrameProps {
  summary: MaskFieldDriveStageSummary;
}

/**
 * Stage actions of a mask antenna in the Study pipeline: Add and Update.
 * The stage is shown as authored; its payload is kept unchanged.
 */
export function MaskFieldDriveStageInspector({
  summary,
  ...props
}: MaskFieldDriveStageInspectorProps) {
  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="unsupported"
        kindLabel={summary.kindLabel}
      />
      {summary.action === "add" ? (
        <>
          <InspectorGroup title="Antenna" badge="read-only">
            <FieldRow label="Name" value={summary.driveName ?? summary.driveId} />
            <FieldRow label="Id" value={summary.driveId} mono />
            <FieldRow label="Target" value={summary.target ?? "not declared"} />
            <FieldRow label="Support" value={summary.shape ?? "not declared"} />
            <FieldRow label="Frame" value={summary.frame ?? "local"} />
            <FieldRow label="Clock" value={summary.timeOrigin ?? "stage_local"} />
            <FieldRow
              label="Effect"
              value="active from this stage until a Remove stage"
            />
          </InspectorGroup>
          {summary.terms.map((term) => (
            <InspectorGroup key={term.label} title={`Term ${term.label}`} badge="mask × time">
              <FieldRow label="Mask" value={term.mask.call} mono />
              {term.mask.outputs.map((output, component) => (
                <FieldRow
                  key={`mask-${component}`}
                  label={["Bx", "By", "Bz"][component] ?? `B${component}`}
                  unit="T"
                  value={output}
                  mono
                />
              ))}
              <FieldRow label="Time" value={term.time.call} mono />
              {keyedOccurrences(term.time.outputs, (output) => output).map(({ item: output, key }) => (
                <FieldRow key={key} label="f(t)" value={output} mono />
              ))}
            </InspectorGroup>
          ))}
        </>
      ) : (
        <InspectorGroup title="Antenna Update" badge="read-only">
          <FieldRow label="Antenna id" value={summary.driveId} mono />
          <FieldRow label="Term" value={summary.term ?? "the only term"} />
          <FieldRow label="Mask values" value={summary.maskParameters ?? "unchanged"} mono />
          <FieldRow label="Time values" value={summary.timeParameters ?? "unchanged"} mono />
          <FieldRow
            label="Effect"
            value="new values from this stage on; the antenna definition is unchanged"
          />
        </InspectorGroup>
      )}
    </>
  );
}
