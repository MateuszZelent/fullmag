"use client";

import type { ReactNode } from "react";
import type { Slice2DModel } from "./types";
import type {
  CrossSurfaceSelectionState,
  WorkspaceSyncState,
} from "../workspaceSync/contracts";
import { DEFAULT_WORKSPACE_SYNC_STATE } from "../workspaceSync/contracts";

interface Slice2DShellProps {
  model: Slice2DModel;
  children?: ReactNode;
  selection?: CrossSurfaceSelectionState | null;
  sync?: WorkspaceSyncState;
}

export function Slice2DShell({
  model,
  children,
  selection,
  sync = DEFAULT_WORKSPACE_SYNC_STATE,
}: Slice2DShellProps) {
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      data-surface="slice2d"
      data-status={model.diagnostics.status}
      data-selected-kind={selection?.primary.kind ?? "none"}
      data-selected-id={selection?.primary.id ?? undefined}
    >
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_minmax(14rem,20rem)]">
        <main className="min-h-0 p-3">
          <div className="relative h-full overflow-hidden rounded border border-border/30 bg-card/20">
            <div className="absolute left-3 top-3 z-10 rounded bg-background/80 px-2 py-1 text-xs text-muted-foreground">
              {model.render.sampling} · {model.render.query?.plane ?? "no slice"}
            </div>
            {children ?? (
              <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
                No 2D slice renderer is available for this domain.
              </div>
            )}
          </div>
        </main>
        <aside className="min-h-0 overflow-auto border-l border-border/30 p-3">
          <h2 className="text-xs font-semibold uppercase text-muted-foreground">Slice Info</h2>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <dt className="text-muted-foreground">Status</dt>
            <dd>{model.diagnostics.status}</dd>
            <dt className="text-muted-foreground">Domain</dt>
            <dd>{model.revisions.domainGenerationId ?? "n/a"}</dd>
            <dt className="text-muted-foreground">Fields</dt>
            <dd>{model.revisions.fieldsRevision ?? "n/a"}</dd>
            <dt className="text-muted-foreground">Selection</dt>
            <dd>{selection?.primary.id ?? selection?.primary.kind ?? "none"}</dd>
            <dt className="text-muted-foreground">Sync</dt>
            <dd>
              {[
                sync.selectionSync ? "sel" : null,
                sync.quantitySync ? "qty" : null,
                sync.planeSync ? "plane" : null,
              ].filter(Boolean).join(" / ") || "off"}
            </dd>
          </dl>
        </aside>
      </div>
    </section>
  );
}
