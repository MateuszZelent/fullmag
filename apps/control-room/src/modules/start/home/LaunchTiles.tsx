"use client";

import { FolderOpen, Grid3x3, Triangle, type LucideIcon } from "lucide-react";
import { forwardRef } from "react";

import { SolverBadge } from "../ui/SolverBadge";
import type { SolverKind } from "../model/types";

interface TileProps {
  readonly title: string;
  readonly hint: string;
  readonly shortcut?: string;
  readonly Icon: LucideIcon;
  readonly solver?: SolverKind;
  readonly disabled?: boolean;
  readonly onActivate: () => void;
}

const Tile = forwardRef<HTMLButtonElement, TileProps>(function Tile(
  { title, hint, shortcut, Icon, solver, disabled, onActivate },
  ref,
) {
  return (
    <button
      className="flex min-w-0 flex-col gap-fm-1 rounded-fm-lg border border-fm-default bg-fm-panel p-fm-3 text-left hover:bg-fm-raised disabled:opacity-50"
      disabled={disabled}
      onClick={onActivate}
      ref={ref}
      type="button"
    >
      <span className="flex items-center gap-fm-2">
        <Icon aria-hidden="true" className="size-4 text-fm-secondary" />
        <span className="font-fm-ui text-fm-md font-semibold text-fm-primary">{title}</span>
        {solver ? <SolverBadge solver={solver} /> : null}
        {shortcut ? <kbd className="ml-auto font-fm-mono text-fm-2xs text-fm-start-meta">{shortcut}</kbd> : null}
      </span>
      <span className="font-fm-ui text-fm-xs text-fm-start-meta">{hint}</span>
    </button>
  );
});

export interface LaunchTilesProps {
  readonly onCommand: (commandId: string, input?: unknown) => void;
  readonly isEnabled: (commandId: string) => boolean;
}

/** Present in every state of the start screen — never gated on the index. */
export function LaunchTiles({ onCommand, isEnabled }: LaunchTilesProps) {
  return (
    <div className="grid grid-cols-3 gap-fm-3 max-[940px]:grid-cols-1">
      <Tile
        Icon={Grid3x3}
        hint="Structured grid, fast on GPU."
        onActivate={() => onCommand("start.new-fdm")}
        shortcut="Ctrl N"
        solver="FDM"
        title="New simulation"
      />
      <Tile
        Icon={Triangle}
        hint="Unstructured mesh for curved geometry."
        onActivate={() => onCommand("start.new-fem")}
        solver="FEM"
        title="New simulation"
      />
      <Tile
        Icon={FolderOpen}
        disabled={!isEnabled("workspace.open-project")}
        hint="Browse for a .fms project archive."
        onActivate={() => onCommand("workspace.open-project")}
        shortcut="Ctrl O"
        title="Open project…"
      />
    </div>
  );
}
