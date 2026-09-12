"use client";

import { cn } from "@/lib/utils";

import type { AnalyzeRuntimeBadge } from "./useAnalyzeRuntimeDiagnostics";

function toneClass(tone: AnalyzeRuntimeBadge["tone"]): string {
  switch (tone) {
    case "success":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
    case "warning":
      return "border-amber-500/30 bg-amber-500/10 text-amber-300";
    case "danger":
      return "border-rose-500/30 bg-rose-500/10 text-rose-300";
    case "info":
      return "border-sky-500/30 bg-sky-500/10 text-sky-300";
    default:
      return "border-border/50 bg-background/50 text-muted-foreground";
  }
}

export default function AnalyzeRuntimeBadges({
  badges,
}: {
  badges: AnalyzeRuntimeBadge[];
}) {
  if (!badges.length) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {badges.map((badge) => (
        <span
          key={badge.id}
          title={badge.tooltip}
          className={cn(
            "rounded-full border px-2 py-0.5 text-[0.62rem] font-bold uppercase tracking-[0.16em]",
            toneClass(badge.tone),
          )}
        >
          {badge.label}
        </span>
      ))}
    </div>
  );
}
