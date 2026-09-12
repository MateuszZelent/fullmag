"use client";

import { cn } from "@/lib/utils";

type Tone = "default" | "accent" | "info" | "warn" | "danger";

interface MetricTileProps {
  label: string;
  value: string;
  detail?: string;
  progress?: number;
  tone?: Tone;
}

export default function MetricTile({
  label,
  value,
  detail,
  progress,
  tone = "default",
}: MetricTileProps) {
  const normalized =
    progress != null ? Math.max(0, Math.min(progress, 100)) : null;

  return (
    <article
      className="flex flex-col gap-2 p-3 rounded-lg border border-border/25 bg-gradient-to-b from-card/40 to-card/12 shadow-sm backdrop-blur-sm transition-colors hover:border-border/40"
      data-tone={tone}
    >
      <header className="flex justify-between gap-3 text-[0.6rem] font-semibold uppercase tracking-wider text-muted-foreground/80">
        <span>{label}</span>
        {detail && <small className="text-[0.6rem] normal-case tracking-normal text-muted-foreground/60">{detail}</small>}
      </header>
      <strong className="text-sm font-medium tracking-tight text-foreground">{value}</strong>
      {normalized != null && (
        <div className="h-1.5 w-full rounded-full bg-muted/30 overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-300",
              tone === "warn" ? "bg-amber-500" :
              tone === "danger" ? "bg-destructive" :
              tone === "accent" ? "bg-indigo-500" :
              tone === "info" ? "bg-sky-500" :
              "bg-primary"
            )}
            style={{ width: `${normalized}%` }}
          />
        </div>
      )}
    </article>
  );
}
