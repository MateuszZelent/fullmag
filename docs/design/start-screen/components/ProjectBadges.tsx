/**
 * SolverBadge and StatusPill.
 *
 * Both deliberately carry a word as well as a colour: removing colour entirely
 * must leave the screen usable (see docs/03-interaction-and-accessibility.md §4).
 *
 * Reference implementation — intended to live at
 * apps/control-room/src/modules/start/ui/
 */

import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/shared/utils/className";

import type { ProjectStatus, SolverKind } from "./types";

/* ── Solver badge ───────────────────────────────────────────────────────── */

const solverBadgeVariants = cva(
  [
    "inline-flex h-[17px] items-center gap-1 whitespace-nowrap rounded-fm-xs px-1.5",
    "font-fm-ui text-[9px] font-[650] uppercase tracking-[0.05em]",
    "border border-current/35 bg-current/10",
  ],
  {
    variants: {
      solver: {
        FDM: "text-fm-solver-fdm",
        FEM: "text-fm-solver-fem",
      },
    },
    defaultVariants: { solver: "FDM" },
  },
);

export interface SolverBadgeProps
  extends Omit<ComponentPropsWithoutRef<"span">, "children">,
    VariantProps<typeof solverBadgeVariants> {
  readonly solver: SolverKind;
}

export function SolverBadge({ className, solver, ...props }: SolverBadgeProps) {
  return (
    <span
      className={cn(solverBadgeVariants({ solver }), className)}
      data-slot="solver-badge"
      title={solver === "FDM" ? "Finite difference" : "Finite element"}
      {...props}
    >
      {solver}
    </span>
  );
}

/* ── Status pill ────────────────────────────────────────────────────────── */

const STATUS_LABEL: Record<ProjectStatus, string> = {
  ready: "Ready",
  running: "Running",
  failed: "Failed",
  draft: "Draft",
  migrate: "Migrate",
  missing: "Missing",
  readonly: "Read-only",
};

/** Longer form for tooltips and screen readers, where there is room to explain. */
const STATUS_TITLE: Record<ProjectStatus, string> = {
  ready: "Last run completed",
  running: "A run is in progress",
  failed: "The last run failed",
  draft: "No study configured yet",
  migrate: "Archive schema is older than this build",
  missing: "The file is no longer at this path",
  readonly: "Opens read-only",
};

const statusPillVariants = cva(
  "inline-flex items-center gap-1.5 whitespace-nowrap font-fm-ui text-fm-xs",
  {
    variants: {
      status: {
        ready: "text-fm-project-ready",
        running: "text-fm-project-running",
        failed: "text-fm-project-failed",
        draft: "text-fm-project-draft",
        migrate: "text-fm-project-migrate",
        missing: "text-fm-project-failed",
        readonly: "text-fm-project-readonly",
      },
    },
    defaultVariants: { status: "ready" },
  },
);

export interface StatusPillProps extends ComponentPropsWithoutRef<"span"> {
  readonly status: ProjectStatus;
  /** Override the label — used by the Runs table, which shows the run id. */
  readonly label?: string;
}

export function StatusPill({ className, status, label, ...props }: StatusPillProps) {
  return (
    <span
      className={cn(statusPillVariants({ status }), className)}
      data-slot="status-pill"
      title={STATUS_TITLE[status]}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full bg-current",
          // The pulse is the only motion here and it is redundant with the
          // word, so disabling it under reduced-motion loses nothing.
          status === "running" && "motion-safe:animate-[fm-pulse_1.6s_ease-in-out_infinite]",
        )}
      />
      {label ?? STATUS_LABEL[status]}
    </span>
  );
}

/* Add once to src/design/styles/start-screen.css:

   @keyframes fm-pulse {
     0%, 100% { opacity: 1;   transform: scale(1);   }
     50%      { opacity: .35; transform: scale(.8);  }
   }
*/
