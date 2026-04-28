"use client";

import type { FemSliceViewportModel } from "./useFemSliceViewportModel";
import { sliceTitle } from "./femSliceQuery";
import { cn } from "@/lib/utils";

export interface FemSliceTitleBarProps {
  model: FemSliceViewportModel;
  className?: string;
}

export function FemSliceTitleBar({ model, className }: FemSliceTitleBarProps) {
  const title = sliceTitle(model.query, model.resolved.planeWorldCoord);
  return (
    <div
      className={cn(
        "rounded-lg border border-border/30 bg-background/78 px-3 py-1 text-[0.68rem]",
        "font-mono text-slate-200 shadow-lg backdrop-blur-md pointer-events-auto",
        className,
      )}
    >
      {title}
    </div>
  );
}
