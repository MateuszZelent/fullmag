import { cva } from "class-variance-authority";
import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/shared/utils/className";

import type { ProjectStatus } from "../model/types";

const STATUS_LABEL: Readonly<Record<ProjectStatus, string>> = {
  ready: "Ready",
  running: "Running",
  failed: "Failed",
  draft: "Draft",
  migrate: "Migrate",
  missing: "Missing",
  readonly: "Read-only",
};

/** Longer form for tooltips, where there is room to explain the word. */
const STATUS_TITLE: Readonly<Record<ProjectStatus, string>> = {
  ready: "Last run completed",
  running: "A run is in progress",
  failed: "The last run failed",
  draft: "No study configured yet",
  migrate: "Archive schema is older than this build",
  missing: "The file is no longer at this path",
  readonly: "Opens read-only",
};

const statusPillVariants = cva("fm-start-pill", {
  variants: {
    status: {
      ready: "fm-start-pill--ready",
      running: "fm-start-pill--running",
      failed: "fm-start-pill--failed",
      draft: "fm-start-pill--draft",
      migrate: "fm-start-pill--migrate",
      missing: "fm-start-pill--missing",
      readonly: "fm-start-pill--readonly",
    },
  },
  defaultVariants: { status: "ready" },
});

export interface StatusPillProps extends ComponentPropsWithoutRef<"span"> {
  readonly status: ProjectStatus;
  /** The Runs table shows the run id in place of the status word. */
  readonly label?: string;
}

/** Dot plus word: removing colour must leave the status readable. */
export function StatusPill({ className, label, status, ...props }: StatusPillProps) {
  return (
    <span
      className={cn(statusPillVariants({ status }), className)}
      data-slot="status-pill"
      title={STATUS_TITLE[status]}
      {...props}
    >
      <span aria-hidden="true" className="fm-start-pill__dot" />
      {label ?? STATUS_LABEL[status]}
    </span>
  );
}
