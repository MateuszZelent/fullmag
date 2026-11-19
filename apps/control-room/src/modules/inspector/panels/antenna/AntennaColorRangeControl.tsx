"use client";

import { useState } from "react";
import { parseAntennaColorRange, type AntennaColorRange } from "@/kernel/visualization/antennaColorRange";
import { Button } from "@/shared/ui/Button";
import { FormField } from "../../primitives/FormField";

export function AntennaColorRangeControl({ context, range, data, unit, disabled, onApply, scopeDescription = "One scale for points, vectors and surfaces" }: {
  context: string; range?: AntennaColorRange; data?: AntennaColorRange; unit: string;
  scopeDescription?: string;
  disabled: boolean; onApply: (range: AntennaColorRange | undefined) => void;
}) {
  const initial = () => ({ context, minimum: String(range?.minimum ?? data?.minimum ?? ""), maximum: String(range?.maximum ?? data?.maximum ?? ""), touched: false, error: "" });
  const [draft, setDraft] = useState(initial);
  if (draft.context !== context) setDraft(initial());
  const minimum = draft.touched ? draft.minimum : String(range?.minimum ?? data?.minimum ?? "");
  const maximum = draft.touched ? draft.maximum : String(range?.maximum ?? data?.maximum ?? "");
  const edit = (key: "minimum" | "maximum", value: string) => setDraft((previous) => ({ ...previous, minimum, maximum, [key]: value, touched: true, error: "" }));
  const apply = () => {
    try { const next = parseAntennaColorRange(minimum, maximum); onApply(next); setDraft((previous) => ({ ...previous, error: "" })); }
    catch (error) { setDraft((previous) => ({ ...previous, error: error instanceof Error ? error.message : String(error) })); }
  };
  return <div className="fm-antenna-color-range">
    <p role="status">{range ? `Manual color range: ${range.minimum.toExponential(4)} … ${range.maximum.toExponential(4)} ${unit}` : "Auto color range"}. {scopeDescription}; values outside the limits use endpoint colors.</p>
    <FormField label="Color minimum" unit={unit} disabled={disabled} value={minimum} onChange={(event) => edit("minimum", event.target.value)} />
    <FormField label="Color maximum" unit={unit} disabled={disabled} value={maximum} onChange={(event) => edit("maximum", event.target.value)} />
    {draft.error ? <p role="alert">{draft.error}</p> : null}
    <div className="fm-antenna-color-range__actions flex flex-wrap gap-2">
      <Button type="button" disabled={disabled} onClick={apply}>Apply color range</Button>
      <Button type="button" disabled={disabled || !range} onClick={() => { onApply(undefined); setDraft({ context, minimum: String(data?.minimum ?? ""), maximum: String(data?.maximum ?? ""), touched: false, error: "" }); }}>Reset color range to Auto</Button>
    </div>
  </div>;
}
