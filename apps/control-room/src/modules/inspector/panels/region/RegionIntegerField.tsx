"use client";

import {
  QuantityField,
  type QuantityFieldParseResult,
} from "../../primitives/QuantityField";

const INTEGER_TEXT_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const INCOMPLETE_INTEGER_TEXT_PATTERNS = [
  /^[+-]?$/,
  /^[+-]?\.$/,
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?$/,
];

export function parseRegionIntegerText(
  text: string,
  minimum?: number,
): QuantityFieldParseResult<number> {
  if (
    text === "" ||
    INCOMPLETE_INTEGER_TEXT_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return { message: "Complete the integer value.", ok: false, status: "incomplete" };
  }
  if (!INTEGER_TEXT_PATTERN.test(text)) {
    return { message: "Enter a finite integer.", ok: false, status: "invalid" };
  }

  const value = Number(text);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return { message: "Enter a finite integer.", ok: false, status: "invalid" };
  }
  if (minimum !== undefined && value < minimum) {
    return {
      message: `Enter an integer greater than or equal to ${minimum}.`,
      ok: false,
      status: "invalid",
    };
  }
  return { ok: true, value };
}

export function objectRegionPriorityDraftKey(
  objectId: string,
  regionId: string,
): string {
  return `object-region:${objectId}:${regionId}:priority`;
}

export function objectRegionMeshOrderDraftKey(
  objectId: string,
  regionId: string,
): string {
  return `object-region:${objectId}:${regionId}:mesh-order`;
}

export function regionMaterialOverridePriorityDraftKey(uiKey: string): string {
  return `region-material-override:${uiKey}:priority`;
}

export function RegionIntegerField({
  disabled,
  draftKey,
  label,
  minimum,
  value,
  onValueChange,
}: {
  disabled?: boolean;
  draftKey: string;
  label: string;
  minimum?: number;
  value: number;
  onValueChange: (next: number) => void;
}) {
  const parse = (text: string) => parseRegionIntegerText(text, minimum);

  return (
      <QuantityField<number>
      disabled={disabled}
      draftKey={draftKey}
      format={String}
      invalidMessage="Enter a finite integer"
      label={label}
      parse={parse}
      value={value}
      onCommit={onValueChange}
    />
  );
}
