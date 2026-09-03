"use client";

import { cn } from "@/lib/utils";

interface ReadonlyFieldProps {
  label: string;
  value: string;
  unit?: string;
  mono?: boolean;
}

export default function ReadonlyField({
  label,
  value,
  unit,
  mono = false,
}: ReadonlyFieldProps) {
  return (
    <div className="flex flex-col gap-1.5 py-2.5 px-3 rounded-lg border border-border/25 bg-gradient-to-b from-card/35 to-card/10 backdrop-blur-sm min-w-0">
      <div className="flex justify-between gap-3 text-[0.6rem] font-semibold tracking-wider uppercase text-muted-foreground/80">
        <span>{label}</span>
      </div>
      <div className={cn("flex items-baseline gap-2 flex-wrap min-w-0 text-foreground", mono && "font-mono tracking-tight")}>
        <strong className="text-sm font-semibold min-w-0 break-words">{value}</strong>
        {unit && <span className="text-xs text-muted-foreground/70">{unit}</span>}
      </div>
    </div>
  );
}
