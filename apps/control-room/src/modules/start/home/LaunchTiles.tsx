"use client";

import { cva } from "class-variance-authority";

import type { Ref } from "react";

import { SectionHeader } from "../ui/SectionHeader";
import { LAUNCH_TILES } from "./LaunchTiles.model";

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
              </span>
              <span className="fm-start-tile__desc" id={descriptionId}>
                {tile.description}
              </span>
              {/* The shortcut sits in the foot so the title keeps the full row. */}
              <span className="fm-start-tile__foot">
                <span id={footId}>{reason ?? tile.foot}</span>
                {tile.shortcut ? (
                  <kbd aria-hidden="true" className="fm-start-kbd">
                    {tile.shortcut}
                  </kbd>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
