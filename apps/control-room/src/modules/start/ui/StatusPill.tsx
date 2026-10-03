import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/shared/utils/className";

import type { ProjectStatus } from "../model/types";

const LABEL: Record<ProjectStatus, string> = {
  ready: "Ready",
  running: "Running",
  failed: "Failed",
  draft: "Draft",
  migrate: "Migrate",
  missing: "Missing",
  readonly: "Read-only",
};

const TITLE: Record<ProjectStatus, string> = {
  ready: "Last run completed",
  running: "A run is in progress",
  failed: "The last run failed",
  draft: "No study configured yet",
  migrate: "Archive schema is older than this build",
  missing: "The file is no longer at this path",
  readonly: "Opens read-only",
};

const TEXT: Record<ProjectStatus, string> = {
  ready: "text-fm-project-ready-text",
  running: "text-fm-project-running-text",
  failed: "text-fm-project-failed-text",
  draft: "text-fm-project-draft-text",
  migrate: "text-fm-project-migrate-text",
  missing: "text-fm-project-failed-text",
  readonly: "text-fm-project-readonly-text",
};

const DOT: Record<ProjectStatus, string> = {
  ready: "bg-fm-project-ready",
  running: "bg-fm-project-running",
  failed: "bg-fm-project-failed",
  draft: "bg-fm-project-draft",
  migrate: "bg-fm-project-migrate",
  missing: "bg-fm-project-failed",
  readonly: "bg-fm-project-readonly-text",
};

export interface StatusPillProps extends ComponentPropsWithoutRef<"span"> {
  readonly status: ProjectStatus;
  readonly label?: string;
}

/** Dot + word. The dot is decorative; the word carries the meaning. */
export function StatusPill({ className, status, label, ...props }: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap font-fm-ui text-fm-xs",
        TEXT[status],
        className,
      )}
      data-slot="status-pill"
      title={TITLE[status]}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full", DOT[status])}
        data-fm-pulse={status === "running" ? "" : undefined}
        style={status === "running" ? { animation: "fm-pulse 1.6s ease-in-out infinite" } : undefined}
      />
      {label ?? LABEL[status]}
    </span>
  );
}
