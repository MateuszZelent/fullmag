"use client";

import type { ReactNode } from "react";
import type { Slice2DModel } from "./types";
import type { CrossSurfaceSelectionState } from "../workspaceSync/contracts";

interface Slice2DShellProps {
  model: Slice2DModel;
  children?: ReactNode;
  selection?: CrossSurfaceSelectionState | null;
}

export function Slice2DShell({
  model,
  children,
  selection,
}: Slice2DShellProps) {
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      data-surface="slice2d"
      data-status={model.diagnostics.status}
      data-selected-kind={selection?.primary.kind ?? "none"}
      data-selected-id={selection?.primary.id ?? undefined}
    >
      <div className="min-h-0 flex-1 p-3">
        <main className="relative h-full overflow-hidden rounded border border-border/30 bg-card/20">
          <div className="absolute left-3 top-3 z-10 rounded bg-background/80 px-2 py-1 text-xs text-muted-foreground">
            {model.render.sampling} · {model.render.query?.plane ?? "no slice"}
          </div>
          {children ?? (
            <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
              No 2D slice renderer is available for this domain.
            </div>
          )}
        </main>
      </div>
    </section>
  );
}
