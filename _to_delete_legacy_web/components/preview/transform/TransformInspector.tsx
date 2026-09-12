"use client";

import { useCallback } from "react";
import type { ObjectTransform } from "./types";

interface TransformInspectorProps {
  /** Current transform of the selected object */
  transform: ObjectTransform;
  /** Called when user edits a value */
  onChange: (next: ObjectTransform) => void;
  /** Called to reset to identity */
  onReset: () => void;
}

function NumericField({
  label,
  value,
  onChange,
  step = 1e-9,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] font-bold text-muted-foreground w-3">{label}</span>
      <input
        type="number"
        className="w-full bg-card border border-border/40 rounded px-1.5 py-0.5 text-xs text-foreground tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        value={value}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      />
    </div>
  );
}

/**
 * Numeric transform inspector panel.
 * Shows Translation XYZ with editable fields.
 */
export function TransformInspector({ transform, onChange, onReset }: TransformInspectorProps) {
  const setT = useCallback(
    (axis: 0 | 1 | 2, v: number) => {
      const t = [...transform.translation] as [number, number, number];
      t[axis] = v;
      onChange({ ...transform, translation: t });
    },
    [transform, onChange],
  );

  return (
    <div className="space-y-2 p-2 rounded-lg border border-border/40 bg-card/60">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-foreground uppercase tracking-wider">Transform</span>
        <button
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          onClick={onReset}
        >
          Reset
        </button>
      </div>

      <div className="space-y-1">
        <span className="text-[10px] text-muted-foreground">Translation</span>
        <NumericField label="X" value={transform.translation[0]} onChange={(v) => setT(0, v)} />
        <NumericField label="Y" value={transform.translation[1]} onChange={(v) => setT(1, v)} />
        <NumericField label="Z" value={transform.translation[2]} onChange={(v) => setT(2, v)} />
      </div>
    </div>
  );
}
