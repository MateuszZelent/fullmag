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
  onToolbarChange?: (patch: Partial<Slice2DModel["toolbar"]>) => void;
}

const ROW_A_SLOTS = [
  "quantity",
  "component",
  "axis",
  "mode",
  "layerPosition",
  "thickness",
  "colormap",
  "autoScale",
  "primitives",
  "mesh",
  "quantityOverlay",
  "vectors",
  "render",
] as const;

export function Slice2DShell({
  model,
  children,
  selection,
  sync = DEFAULT_WORKSPACE_SYNC_STATE,
  onToolbarChange,
}: Slice2DShellProps) {
  const toolbar = model.toolbar;
  const gates = model.capabilityGates;

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      data-surface="slice2d"
      data-status={model.diagnostics.status}
      data-selected-kind={selection?.primary.kind ?? "none"}
      data-selected-id={selection?.primary.id ?? undefined}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/30 px-3 py-2">
        <span className="text-[0.65rem] uppercase text-muted-foreground">Quantity</span>
        <span className="rounded border border-border/40 px-2 py-1 text-xs">
          {toolbar.quantityId}
        </span>
        <label className="text-[0.65rem] uppercase text-muted-foreground">
          Component
          <select
            className="ml-2 h-7 rounded border border-border/40 bg-background px-2 text-foreground"
            value={toolbar.component}
            onChange={(event) =>
              onToolbarChange?.({ component: event.target.value as typeof toolbar.component })
            }
          >
            <option value="x">x</option>
            <option value="y">y</option>
            <option value="z">z</option>
            <option value="magnitude">magnitude</option>
          </select>
        </label>
        <label className="text-[0.65rem] uppercase text-muted-foreground">
          Axis
          <select
            className="ml-2 h-7 rounded border border-border/40 bg-background px-2 text-foreground"
            value={toolbar.axis}
            onChange={(event) =>
              onToolbarChange?.({ axis: event.target.value as typeof toolbar.axis })
            }
          >
            <option value="x">X</option>
            <option value="y">Y</option>
            <option value="z">Z</option>
          </select>
        </label>
        <label className="text-[0.65rem] uppercase text-muted-foreground">
          Mode
          <select
            className="ml-2 h-7 rounded border border-border/40 bg-background px-2 text-foreground"
            value={toolbar.mode}
            onChange={(event) =>
              onToolbarChange?.({ mode: event.target.value as typeof toolbar.mode })
            }
          >
            <option value="single">single</option>
            <option value="slab">slab</option>
            <option value="all_layers" disabled={!gates.slice_all_layers.enabled}>
              all layers
            </option>
          </select>
        </label>
        <label className="inline-flex items-center gap-1.5 text-[0.65rem] text-muted-foreground">
          <input
            type="checkbox"
            checked={toolbar.showPrimitives}
            disabled={!gates.authoring_primitives.enabled}
            title={gates.authoring_primitives.reason ?? undefined}
            onChange={(event) => onToolbarChange?.({ showPrimitives: event.target.checked })}
          />
          <span>Primitives</span>
        </label>
        <label className="inline-flex items-center gap-1.5 text-[0.65rem] text-muted-foreground">
          <input
            type="checkbox"
            checked={toolbar.showMesh}
            disabled={!gates.explicit_topology.enabled}
            title={gates.explicit_topology.reason ?? undefined}
            onChange={(event) => onToolbarChange?.({ showMesh: event.target.checked })}
          />
          <span>Mesh</span>
        </label>
        <label className="inline-flex items-center gap-1.5 text-[0.65rem] text-muted-foreground">
          <input
            type="checkbox"
            checked={toolbar.showVectors}
            disabled={!gates.slice_vectors.enabled}
            title={gates.slice_vectors.reason ?? undefined}
            onChange={(event) => onToolbarChange?.({ showVectors: event.target.checked })}
          />
          <span>Vectors</span>
        </label>
        <label className="text-[0.65rem] uppercase text-muted-foreground">
          Render
          <select
            className="ml-2 h-7 rounded border border-border/40 bg-background px-2 text-foreground"
            value={toolbar.renderMode}
            onChange={(event) =>
              onToolbarChange?.({ renderMode: event.target.value as typeof toolbar.renderMode })
            }
          >
            <option value="heatmap">heatmap</option>
            <option value="contour">contour</option>
            <option value="heatmap+contour">heatmap+contour</option>
            <option value="vectors">vectors</option>
            <option value="mesh-overlay">mesh-overlay</option>
          </select>
        </label>
        <div className="ml-auto flex items-center gap-1 text-[0.65rem] uppercase text-muted-foreground">
          <span className={sync.selectionSync ? "text-foreground" : ""}>Sel</span>
          <span className={sync.quantitySync ? "text-foreground" : ""}>Qty</span>
          <span className={sync.planeSync ? "text-foreground" : ""}>Plane</span>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_minmax(14rem,20rem)]">
        <main className="min-h-0 p-3" data-toolbar-slots={ROW_A_SLOTS.join(",")}>
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
          </dl>
        </aside>
      </div>
    </section>
  );
}
