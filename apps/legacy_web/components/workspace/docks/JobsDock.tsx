"use client";

interface JobsDockProps {
  status: string;
  commandMessage: string | null;
}

export default function JobsDock({ status, commandMessage }: JobsDockProps) {
  return (
    <div className="rounded-md border border-border/30 bg-background/30 p-2 text-xs">
      <div className="font-semibold text-foreground">Jobs</div>
      <div className="mt-1 text-muted-foreground">Status: {status}</div>
      <div className="text-muted-foreground">{commandMessage ?? "No active command."}</div>
    </div>
  );
}

