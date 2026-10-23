"use client";

import { useState } from "react";

import { QuantityField, QuantityFieldDraftScope, type QuantityFieldParseResult } from "../primitives/QuantityField";
import { createQuantityFieldDraftStore } from "../primitives/quantityFieldDraftStore";
import { parsePlanarNumberText } from "./planarNumberModel";
import { usePlanarFieldDraftKey, usePlanarPresentationDraftState } from "./PlanarPresentationDraftOwner";

type Range = { mode: "manual"; min: number; max: number };

/** Either limit can finish a valid pair; neither sends an invalid partial range. */
export function PlanarManualRangeFields({
  minimum,
  maximum,
  disabled,
  hint,
  onCommit,
}: {
  minimum: number | null;
  maximum: number | null;
  disabled?: boolean;
  hint?: string;
  onCommit: (range: Range) => void;
}) {
  const owner = usePlanarPresentationDraftState();
  const [localStore] = useState(createQuantityFieldDraftStore);
  const store = owner.store ?? localStore;
  const minKey = usePlanarFieldDraftKey("range.min");
  const maxKey = usePlanarFieldDraftKey("range.max");

  function readPair(field: "min" | "max", value: number): Range | null {
    const otherKey = field === "min" ? maxKey : minKey;
    const otherDraft = store.get(otherKey);
    const other = otherDraft
      ? parsePlanarNumberText(otherDraft.rawText)
      : { ok: true as const, value: field === "min" ? maximum : minimum };
    if (!other.ok || other.value === null) return null;
    return field === "min"
      ? { mode: "manual", min: value, max: other.value }
      : { mode: "manual", min: other.value, max: value };
  }

  function parse(field: "min" | "max", text: string): QuantityFieldParseResult<number | null> {
    const parsed = parsePlanarNumberText(text);
    if (!parsed.ok) return parsed;
    const pair = readPair(field, parsed.value);
    if (!pair) return { ok: false, status: "invalid", message: "Complete both range limits." };
    if (pair.min >= pair.max) return { ok: false, status: "invalid", message: "Manual range requires minimum < maximum." };
    return parsed;
  }

  function commit(field: "min" | "max", value: number | null): void {
    if (value === null) return;
    const pair = readPair(field, value);
    if (!pair || pair.min >= pair.max) return;
    onCommit(pair);
    store.remove(minKey);
    store.remove(maxKey);
  }

  return (
    <QuantityFieldDraftScope store={store}>
      <QuantityField<number | null>
        disabled={disabled}
        draftKey={minKey}
        format={(value) => value === null ? "" : String(value)}
        hint={hint}
        label="Range minimum"
        parse={(text) => parse("min", text)}
        value={minimum}
        onCommit={(value) => commit("min", value)}
      />
      <QuantityField<number | null>
        disabled={disabled}
        draftKey={maxKey}
        format={(value) => value === null ? "" : String(value)}
        hint={hint}
        label="Range maximum"
        parse={(text) => parse("max", text)}
        value={maximum}
        onCommit={(value) => commit("max", value)}
      />
    </QuantityFieldDraftScope>
  );
}
