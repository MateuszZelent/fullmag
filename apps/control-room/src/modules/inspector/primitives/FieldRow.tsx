import type { ReactNode } from "react";

interface FieldRowProps {
  label: string;
  unit?: string;
  value: ReactNode;
}

export function FieldRow({ label, unit, value }: FieldRowProps) {
  return (
    <div className="fm-inspector-field-row">
      <span className="fm-inspector-field-row__label">{label}</span>
      <span className="fm-inspector-field-row__value">
        {value}
        {unit ? <small>{unit}</small> : null}
      </span>
    </div>
  );
}
