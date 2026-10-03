import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/shared/utils/className";

import type { SolverKind } from "../model/types";

export interface SolverBadgeProps
  extends Omit<ComponentPropsWithoutRef<"span">, "children"> {
  readonly solver: SolverKind;
}

/** Prints FDM / FEM — the hue is never the only carrier. */
export function SolverBadge({ className, solver, ...props }: SolverBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-fm-xs border px-1.5 py-px",
        "font-fm-ui text-fm-2xs font-semibold uppercase tracking-wider",
        solver === "FDM"
          ? "border-fm-solver-fdm text-fm-solver-fdm-text"
          : "border-fm-solver-fem text-fm-solver-fem-text",
        className,
      )}
      data-slot="solver-badge"
      title={solver === "FDM" ? "Finite difference" : "Finite element"}
      {...props}
    >
      {solver}
    </span>
  );
}
