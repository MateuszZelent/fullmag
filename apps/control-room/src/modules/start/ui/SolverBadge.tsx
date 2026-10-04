import { cva } from "class-variance-authority";
import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/shared/utils/className";

import type { SolverKind } from "../model/types";

const solverBadgeVariants = cva("fm-start-badge", {
  variants: {
    solver: {
      FDM: "fm-start-badge--fdm",
      FEM: "fm-start-badge--fem",
    },
  },
  defaultVariants: { solver: "FDM" },
});

const SOLVER_TITLE: Readonly<Record<SolverKind, string>> = {
  FDM: "Finite difference",
  FEM: "Finite element",
};

export interface SolverBadgeProps
  extends Omit<ComponentPropsWithoutRef<"span">, "children"> {
  readonly solver: SolverKind;
}

/** Prints the solver name so the badge survives without its colour. */
export function SolverBadge({ className, solver, ...props }: SolverBadgeProps) {
  return (
    <span
      className={cn(solverBadgeVariants({ solver }), className)}
      data-slot="solver-badge"
      title={SOLVER_TITLE[solver]}
      {...props}
    >
      {solver}
    </span>
  );
}
