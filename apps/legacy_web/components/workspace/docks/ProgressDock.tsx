"use client";

interface ProgressDockProps {
  label: string;
  detail: string | null;
}

export default function ProgressDock({ label, detail }: ProgressDockProps) {
  return (
    <div className="rounded-md border border-border/30 bg-background/30 p-2 text-xs">
      <div className="font-semibold text-foreground">{label}</div>
      <div className="mt-1 text-muted-foreground">{detail ?? "Idle"}</div>
    </div>
  );
}

