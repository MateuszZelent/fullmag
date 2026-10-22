"use client";

import { QuantityField } from "../primitives/QuantityField";
import { usePlanarFieldDraftKey } from "./PlanarPresentationDraftOwner";

import { parsePlanarNumberText } from "./planarNumberModel";

export function PlanarNumberField({
  disabled,
  hint,
  integer,
  label,
  maximum,
  minimum,
  minimumExclusive,
  onCommit,
  path,
  unit,
  value,
}: {
  disabled?: boolean;
  hint?: string;
  integer?: boolean;
  label: string;
  maximum?: number;
  minimum?: number;
  minimumExclusive?: boolean;
  onCommit: (value: number) => void;
  path: string;
  unit?: string;
  value: number | null;
}) {
  const draftKey = usePlanarFieldDraftKey(path);
  const parse = (text: string) =>
    parsePlanarNumberText(text, { integer, maximum, minimum, minimumExclusive });

  return (
    <QuantityField<number | null>
      disabled={disabled}
      draftKey={draftKey}
      format={(current) => (current === null ? "" : String(current))}
      invalidMessage="Enter a finite decimal number"
      label={label}
      parse={parse}
      value={value}
      unit={unit}
      hint={hint}
      onCommit={(next) => {
        if (next !== null) onCommit(next);
      }}
    />
  );
}
