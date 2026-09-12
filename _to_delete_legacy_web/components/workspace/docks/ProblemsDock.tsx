"use client";

interface ProblemsDockProps {
  error: string | null;
}

export default function ProblemsDock({ error }: ProblemsDockProps) {
  return (
    <div className="rounded-md border border-border/30 bg-background/30 p-2 text-xs">
      <div className="font-semibold text-foreground">Problems</div>
      <div className="mt-1 text-muted-foreground">{error ?? "No active problems."}</div>
    </div>
  );
}

