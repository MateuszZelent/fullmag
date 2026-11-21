import type { ComponentProps } from "react";

import { FieldRow } from "../../primitives/FieldRow";
import { boundedDisplayText } from "./airboxDisplay.model";

export function AirboxFieldRow(props: ComponentProps<typeof FieldRow>) {
  const value = typeof props.value === "string" || typeof props.value === "number"
    ? boundedDisplayText(String(props.value)) ?? ""
    : props.value;
  return <FieldRow {...props} label={boundedDisplayText(props.label) ?? ""} unit={boundedDisplayText(props.unit) ?? undefined} value={value} />;
}
