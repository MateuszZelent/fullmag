"use client";

import type { ReactNode } from "react";
import type { MeshWorkspaceModel } from "./types";
import type {
  CrossSurfaceSelectionState,
  WorkspaceSyncState,
} from "../workspaceSync/contracts";
import { DEFAULT_WORKSPACE_SYNC_STATE } from "../workspaceSync/contracts";

interface MeshWorkspaceShellProps {
  model: MeshWorkspaceModel;
  children?: ReactNode;
  selection?: CrossSurfaceSelectionState | null;
  sync?: WorkspaceSyncState;
  onBuild?: () => void;
  onToolbarChange?: (patch: Partial<MeshWorkspaceModel["toolbar"]>) => void;
}

const TOOLBAR_SLOTS = [
  "viewMode",
  "colorBy",
  "objects",
  "mesh",
  "quality",
  "labels",
  "boundaries",
  "renderMode",
  "opacity",
  "clip",
  "clipAxis",
  "clipPosition",
] as const;

export function MeshWorkspaceShell({
  model,
  children,
  selection,
  sync = DEFAULT_WORKSPACE_SYNC_STATE,
  onBuild,
  onToolbarChange,
}: MeshWorkspaceShellProps) {
  const toolbar = model.toolbar;
  const gate = model.capabilityGates;

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      data-surface="mesh-workspace"
      data-status={model.diagnostics.status}
      data-selected-kind={selection?.primary.kind ?? "none"}
      data-selected-id={selection?.primary.id ?? undefined}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/30 px-3 py-2">
        <label className="text-[0.65rem] uppercase text-muted-foreground">
          View
          <select
            className="ml-2 h-7 rounded border border-border/40 bg-background px-2 text-foreground"
            value={toolbar.viewMode}
            onChange={(event) =>
              onToolbarChange?.({ viewMode: event.target.value as typeof toolbar.viewMode })
            }
          >
            <option value="realized-domain">realized domain</option>
            <option value="topology">topology</option>
            <option value="quality">quality</option>
            <option value="parts">parts</option>
            <option value="object-overrides">object overrides</option>
            <option value="build-history">build history</option>
          </select>
        </label>
        <label className="text-[0.65rem] uppercase text-muted-foreground">
          Color
          <select
            className="ml-2 h-7 rounded border border-border/40 bg-background px-2 text-foreground"
            value={toolbar.colorBy}
            onChange={(event) =>
              onToolbarChange?.({ colorBy: event.target.value as typeof toolbar.colorBy })
            }
          >
            <option value="object">object</option>
            <option value="material">material</option>
            <option value="part">part</option>
            <option value="quality">quality</option>
            <option value="none">none</option>
          </select>
        </label>
        {TOOLBAR_SLOTS.slice(2, 7).map((slot) => {
          const key = slot === "objects" ? "showObjects" : slot === "mesh" ? "showMesh" : slot === "quality" ? "showQuality" : slot === "labels" ? "showLabels" : "showBoundaries";
          const disabled = slot === "quality" && !gate.mesh_quality_metrics.enabled;
          return (
            <label
              key={slot}
              className="inline-flex items-center gap-1.5 text-[0.65rem] text-muted-foreground"
              title={disabled ? gate.mesh_quality_metrics.reason ?? undefined : undefined}
            >
              <input
                type="checkbox"
                checked={Boolean(toolbar[key])}
                disabled={disabled}
                onChange={(event) => onToolbarChange?.({ [key]: event.target.checked })}
              />
              <span>{slot}</span>
            </label>
          );
        })}
        <label className="text-[0.65rem] uppercase text-muted-foreground">
          Render
          <select
            className="ml-2 h-7 rounded border border-border/40 bg-background px-2 text-foreground"
            value={toolbar.renderMode}
            onChange={(event) =>
              onToolbarChange?.({ renderMode: event.target.value as typeof toolbar.renderMode })
            }
          >
            <option value="solid">solid</option>
            <option value="wireframe">wireframe</option>
            <option value="solid+wireframe">solid+wireframe</option>
            <option value="points">points</option>
          </select>
        </label>
        <button
          type="button"
          className="h-7 rounded border border-border/40 px-2 text-[0.68rem] disabled:opacity-50"
          disabled={!gate.meshing.enabled || model.activeBuild != null}
          title={gate.meshing.reason ?? undefined}
          onClick={onBuild}
        >
          {model.activeBuild ? "Building..." : model.dirty.isDirty ? "Rebuild" : "Build"}
        </button>
        <div className="ml-auto flex items-center gap-1 text-[0.65rem] uppercase text-muted-foreground">
          <span className={sync.selectionSync ? "text-foreground" : ""}>Sel</span>
          <span className={sync.quantitySync ? "text-foreground" : ""}>Qty</span>
          <span className={sync.planeSync ? "text-foreground" : ""}>Plane</span>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <main className="h-full min-h-0 p-0" data-toolbar-slots={TOOLBAR_SLOTS.join(",")}>
          <div className="relative h-full overflow-hidden bg-card/20">
            <div className="absolute left-3 top-3 z-10 flex flex-wrap gap-2 text-xs text-muted-foreground">
              {model.dirty.isDirty && <span className="rounded bg-background/80 px-2 py-1">mesh dirty</span>}
              {model.activeBuild && <span className="rounded bg-background/80 px-2 py-1">active build</span>}
              {model.lastSuccess && <span className="rounded bg-background/80 px-2 py-1">last success available</span>}
              {model.capabilities.explicit_topology && <span className="rounded bg-background/80 px-2 py-1">explicit topology</span>}
              {model.capabilities.structured_grid && <span className="rounded bg-background/80 px-2 py-1">structured grid</span>}
            </div>
            {children ?? (
              <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
                No mesh viewport renderer is available for this domain.
              </div>
            )}
          </div>
        </main>
      </div>
    </section>
  );
}
