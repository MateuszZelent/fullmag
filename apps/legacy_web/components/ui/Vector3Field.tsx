import type React from "react";
import { TextField } from "./TextField";

interface Vector3FieldProps {
  label: string;
  value: [number, number, number];
  unit?: string;
  onChange: (value: [number, number, number]) => void;
  onNormalize?: boolean;
}

export function Vector3Field({ label, value, unit, onChange, onNormalize }: Vector3FieldProps) {
  const handleBlur = (axis: number, event: React.ChangeEvent<HTMLInputElement>) => {
    const next = [...value] as [number, number, number];
    const parsed = Number.parseFloat(event.target.value);
    if (!Number.isFinite(parsed)) return;
    next[axis] = parsed;
    onChange(next);
  };

  const handleNormalize = () => {
    const len = Math.sqrt(value[0] ** 2 + value[1] ** 2 + value[2] ** 2);
    if (len > 0) {
      onChange([value[0] / len, value[1] / len, value[2] / len]);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[0.65rem] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        {onNormalize && (
          <button
            type="button"
            className="text-[0.6rem] font-medium tracking-wider text-primary hover:text-primary/80 transition-colors"
            onClick={handleNormalize}
          >
            NORMALIZE
          </button>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <TextField
          label="X"
          defaultValue={String(Number(value[0] ?? 0))}
          onBlur={(e) => handleBlur(0, e)}
          unit={unit}
          mono
        />
        <TextField
          label="Y"
          defaultValue={String(Number(value[1] ?? 0))}
          onBlur={(e) => handleBlur(1, e)}
          unit={unit}
          mono
        />
        <TextField
          label="Z"
          defaultValue={String(Number(value[2] ?? 0))}
          onBlur={(e) => handleBlur(2, e)}
          unit={unit}
          mono
        />
      </div>
    </div>
  );
}
