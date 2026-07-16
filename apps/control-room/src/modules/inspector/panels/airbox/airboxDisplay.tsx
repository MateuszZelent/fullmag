import type { ComponentProps } from "react";

import { FieldRow } from "../../primitives/FieldRow";

export const AIRBOX_DISPLAY_MAX_BYTES = 512;
export const AIRBOX_DISPLAY_MAX_ITEMS = 50;

export function boundedDisplayText(value: string | null | undefined, maxBytes = AIRBOX_DISPLAY_MAX_BYTES): string | null {
  if (value == null) return null;
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const suffix = "…";
  let result = "";
  for (const character of value) {
    if (encoder.encode(result + character + suffix).byteLength > maxBytes) break;
    result += character;
  }
  return result + suffix;
}

export function boundedItems<T>(items: readonly T[]): readonly T[] {
  return items.slice(0, AIRBOX_DISPLAY_MAX_ITEMS);
}

export function AirboxFieldRow(props: ComponentProps<typeof FieldRow>) {
  const value = typeof props.value === "string" || typeof props.value === "number"
    ? boundedDisplayText(String(props.value)) ?? ""
    : props.value;
  return <FieldRow {...props} label={boundedDisplayText(props.label) ?? ""} unit={boundedDisplayText(props.unit) ?? undefined} value={value} />;
}
