import { useId } from "react";

import type { QuantityInputState, QuantityUnit } from "@/kernel/authoring/object-edit/quantityInput";

const LENGTH_UNITS = ["m", "mm", "um", "µm", "μm", "nm"] as const;
const ANGLE_UNITS = ["rad", "deg", "°"] as const;

/** Controlled presentation only; raw values and unit transitions belong to the kernel. */
export function QuantityUnitSelect({
  input,
  label,
  onChange,
}: {
  input: QuantityInputState;
  label: string;
  onChange: (unit: QuantityUnit) => void;
}) {
  const reasonId = useId();
  const blocked = input.parseStatus !== "valid";
  const reason = blocked ? "Finish or revert this field before changing its unit." : undefined;
  const units = input.dimension === "length" ? LENGTH_UNITS
    : input.dimension === "angle" ? ANGLE_UNITS : ["1"] as const;
  return (
    <>
      <select
        aria-label={`${label} unit`}
        aria-describedby={reason ? reasonId : undefined}
        className="fm-inspector-select fm-inspector-quantity-unit"
        disabled={blocked}
        title={reason}
        value={input.unit}
        onChange={(event) => {
          const nextUnit = units.find((unit) => unit === event.target.value);
          if (nextUnit && !blocked) onChange(nextUnit);
        }}
      >
        {units.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
      </select>
      {reason ? <span className="sr-only" id={reasonId}>{reason}</span> : null}
    </>
  );
}
