"use client";

import dynamic from "next/dynamic";

const Plot2DWorkbench = dynamic(
  () => import("@/features/plots2d/components/Plot2DWorkbench"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground/50">
        Loading 2D Plots…
      </div>
    ),
  },
);

export function ChartsTabPanel({ disabled }: { disabled: boolean }) {
  if (disabled) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground/50">
        2D Plots disabled via feature flags
      </div>
    );
  }
  return <Plot2DWorkbench />;
}
