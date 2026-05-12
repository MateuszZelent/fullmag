"use client";

interface StageSummaryChipProps {
  label: string;
  tone?: "default" | "primary" | "emerald" | "amber" | "violet";
}

const toneClassMap: Record<NonNullable<StageSummaryChipProps["tone"]>, string> = {
  default: "border-border/40 bg-background/70 text-muted-foreground",
  primary: "border-primary/30 bg-primary/10 text-primary",
  emerald: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  amber: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  violet: "border-violet-500/30 bg-violet-500/10 text-violet-300",
};

export default function StageSummaryChip({
  label,
  tone = "default",
}: StageSummaryChipProps) {
  return (
    <span
      className={`inline-flex rounded-md border px-2 py-1 text-[0.6rem] font-semibold uppercase tracking-[0.16em] ${toneClassMap[tone]}`}
    >
      {label}
    </span>
  );
}
