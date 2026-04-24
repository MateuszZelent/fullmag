"use client";

import dynamic from "next/dynamic";

const ChartsViewport = dynamic(
  () => import("@/components/runs/control-room/ChartsViewport"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground/50">
        Loading charts...
      </div>
    ),
  },
);

export function ChartsTabPanel({ disabled }: { disabled: boolean }) {
  if (disabled) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground/50">
        Charts disabled via feature flags
      </div>
    );
  }
  return <ChartsViewport />;
}
