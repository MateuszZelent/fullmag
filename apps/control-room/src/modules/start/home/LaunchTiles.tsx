"use client";

import { cva } from "class-variance-authority";
import { FileCode2, FlaskConical, Grid3x3, Import, Triangle, type LucideIcon } from "lucide-react";
import type { Ref } from "react";

import { SectionHeader } from "../ui/SectionHeader";

type TileTone = "fdm" | "fem" | "import" | "template" | "script";

interface LaunchTile {
  readonly commandId: string;
  readonly description: string;
  readonly foot: string;
  readonly icon: LucideIcon;
  readonly id: string;
  /** Absent when the command has no shortcut (Ctrl+Shift+O is taken). */
  readonly keys?: string;
  readonly name: string;
  readonly shortcut?: string;
  readonly tone: TileTone;
}

export const LAUNCH_TILES: readonly LaunchTile[] = [
  {
    commandId: "start.new-fdm",
    description:
      "Structured finite-difference grid. GPU-accelerated, best for large uniform geometries.",
    foot: "empty problem",
    icon: Grid3x3,
    id: "fdm",
    keys: "Control+N",
    name: "FDM simulation",
    shortcut: "Ctrl N",
    tone: "fdm",
  },
  {
    commandId: "start.new-fem",
    description:
      "Unstructured tetrahedral mesh. Curved bodies, Bloch-periodic eigenmode studies.",
    foot: "empty problem",
    icon: Triangle,
    id: "fem",
    keys: "Control+Shift+N",
    name: "FEM simulation",
    shortcut: "Ctrl ⇧ N",
    tone: "fem",
  },
  {
    commandId: "start.templates",
    description:
      "Benchmarks and ready-made studies saved as Python scripts — µMAG problems, dispersion, FMR, skyrmions.",
    foot: "saved as a .py script",
    icon: FlaskConical,
    id: "template",
    keys: "Control+T",
    name: "From template",
    shortcut: "Ctrl T",
    tone: "template",
  },
  {
    commandId: "start.import",
    description:
      "Bring in an existing model from another micromagnetic package or a Fullmag archive.",
    foot: ".mif · .mx3 · .mph · .fms",
    icon: Import,
    id: "import",
    keys: "Control+I",
    name: "Import",
    shortcut: "Ctrl I",
    tone: "import",
  },
  {
    commandId: "start.open-script",
    description:
      "Add a Python script to your recent work. Fullmag lists it with its last use and last run.",
    foot: ".py · desktop app",
    icon: FileCode2,
    id: "script",
    name: "Open script…",
    tone: "script",
  },
];

const tileVariants = cva("fm-start-tile", {
  variants: {
    tone: {
      fdm: "fm-start-tile--fdm",
      fem: "fm-start-tile--fem",
      import: "fm-start-tile--import",
      template: "fm-start-tile--template",
      script: "fm-start-tile--script",
    },
  },
});

export interface LaunchTilesProps {
  /** Keyed by command id; a missing entry means the tile is enabled. */
  readonly disabledReasons: Readonly<Record<string, string | null>>;
  /** Attached to the first enabled tile, which takes focus on mount. */
  readonly initialFocusRef?: Ref<HTMLButtonElement>;
  readonly onRunCommand: (commandId: string) => void;
}

/**
 * The ways to start work. They render in every index state, including
 * the error state, because nothing on this screen may block creating or
 * opening a project.
 */
export function LaunchTiles({ disabledReasons, initialFocusRef, onRunCommand }: LaunchTilesProps) {
  const focusIndex = LAUNCH_TILES.findIndex(
    (tile) => (disabledReasons[tile.commandId] ?? null) === null,
  );
  return (
    <section aria-labelledby="fm-start-launch-title" className="fm-start-section">
      <SectionHeader id="fm-start-launch-title" title="Start something new" />
      <div className="fm-start-tiles">
        {LAUNCH_TILES.map((tile, index) => {
          const Icon = tile.icon;
          const reason = disabledReasons[tile.commandId] ?? null;
          const nameId = `fm-start-tile-${tile.id}-name`;
          const descriptionId = `fm-start-tile-${tile.id}-desc`;
          const footId = `fm-start-tile-${tile.id}-foot`;
          return (
            <button
              aria-describedby={`${descriptionId} ${footId}`}
              aria-keyshortcuts={tile.keys}
              aria-labelledby={nameId}
              className={tileVariants({ tone: tile.tone })}
              data-command-id={tile.commandId}
              disabled={reason !== null}
              key={tile.id}
              onClick={() => onRunCommand(tile.commandId)}
              ref={index === focusIndex ? initialFocusRef : undefined}
              title={reason ?? undefined}
              type="button"
            >
              <span className="fm-start-tile__top">
                <span aria-hidden="true" className="fm-start-tile__glyph">
                  <Icon size={16} />
                </span>
                <span className="fm-start-tile__name" id={nameId}>
                  {tile.name}
                </span>
                {tile.shortcut ? (
                  <kbd aria-hidden="true" className="fm-start-kbd">
                    {tile.shortcut}
                  </kbd>
                ) : null}
              </span>
              <span className="fm-start-tile__desc" id={descriptionId}>
                {tile.description}
              </span>
              <span className="fm-start-tile__foot" id={footId}>
                {reason ?? tile.foot}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
