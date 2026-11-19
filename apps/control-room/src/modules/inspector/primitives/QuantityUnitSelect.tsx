import { useId } from "react";

import type { QuantityInputState, QuantityUnit } from "@/kernel/authoring/object-edit/quantityInput";
import { controlVariants } from "@/shared/ui/controlVariants";
import { cn } from "@/shared/utils/className";

const LENGTH_UNITS = ["m", "mm", "um", "nm"] as const;
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
  const displayedUnit = input.dimension === "length" &&
    (input.unit === "µm" || input.unit === "μm")
    ? "um"
    : input.unit;
  return (
    <>
      <select
        aria-label={`${label} unit`}
        aria-describedby={reason ? reasonId : undefined}
        className={cn("fm-inspector-input fm-inspector-quantity-unit", controlVariants())}
        disabled={blocked}
        title={reason}
        value={displayedUnit}
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
