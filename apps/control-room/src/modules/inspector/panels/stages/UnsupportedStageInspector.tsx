"use client";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  StageInspectorFrame,
  type StageInspectorFrameProps,
} from "./StageInspectorFrame";

export function UnsupportedStageInspector(props: StageInspectorFrameProps) {
  const draft = props.draft?.kind === "unsupported" ? props.draft : null;
  const originalKind = draft?.rawStage?.kind;

  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="unsupported"
        kindLabel="Unsupported"
      />
      <InspectorGroup
        title="Unsupported Stage"
        badge="read-only"
      >
        <FeedbackBanner
          kind="warning"
          message="This stage kind is not supported by the current editor. Fullmag preserves its original payload losslessly and will not reinterpret it as another physical instruction."
        />
        <FieldRow
          label="Original kind"
          value={typeof originalKind === "string" ? originalKind : "not declared"}
        />
        <FieldRow label="Editing" value="disabled to prevent semantic drift" />
        <FieldRow label="Round-trip" value="original payload preserved" />
      </InspectorGroup>
    </>
  );
}
