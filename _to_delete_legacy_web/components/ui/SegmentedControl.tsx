"use client";


interface SegmentOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SegmentedControlProps {
  label?: string;
  value: string;
  options: SegmentOption[];
  onchange?: (value: string) => void;
}

export default function SegmentedControl({
  label,
  value,
  options,
  onchange,
}: SegmentedControlProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">{label}</span>}
      <div className="grid grid-flow-col auto-cols-fr p-1 rounded-full border border-border/40 bg-card/30 shadow-sm">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className="min-h-[2.3rem] px-3.5 rounded-full border-none bg-transparent text-muted-foreground font-semibold cursor-pointer transition-colors hover:text-foreground data-[active=true]:bg-primary data-[active=true]:text-primary-foreground disabled:opacity-50 disabled:cursor-not-allowed"
            data-active={value === opt.value}
            disabled={opt.disabled}
            onClick={() => onchange?.(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
