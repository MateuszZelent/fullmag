import type { ReactNode } from "react";

import { cn } from "@/shared/utils/className";

interface FieldRowProps {
  label: string;
  unit?: string;
  value: ReactNode;
  /** Semantic status for color-coding the value (e.g. "completed", "running", "failed") */
  status?: string;
  /** When true, renders value in monospace font (IDs, hashes, codes) */
  mono?: boolean;
}

export function FieldRow({ label, unit, value, status, mono }: FieldRowProps) {
  return (
    <div className="fm-inspector-field-row">
      <span className="fm-inspector-field-row__label">{label}</span>
      <span
        className={cn(
          "fm-inspector-field-row__value",
          mono && "fm-inspector-field-row__value--mono",
        )}
        data-status={status}
      >
        {value}
        {unit ? <small>{unit}</small> : null}
      </span>
    </div>
  );
}
