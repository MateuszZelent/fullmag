"use client";

/**
 * A single entry in the recent-projects list.
 *
 * Selection and activation are separate: arrowing through the list moves
 * selection and updates the inspector, Enter opens. The row is a listbox
 * option, not a button, so the parent owns roving focus via aria-activedescendant.
 *
 * Reference implementation — intended to live at
 * apps/control-room/src/modules/start/home/ProjectRow.tsx
 */

import { FileWarning, Link2, Star } from "lucide-react";
import { memo, type MouseEvent } from "react";

import { cn } from "@/shared/utils/className";

import { SolverBadge, StatusPill } from "./ProjectBadges";
import { formatBytes, formatOpened } from "./recentIndex";
import type { RecentEntry } from "./types";

export interface ProjectRowProps {
  readonly entry: RecentEntry;
  readonly selected: boolean;
  readonly density?: "comfortable" | "compact";
  readonly onSelect: (projectId: string) => void;
  readonly onActivate: (projectId: string, modifiers: ActivationModifiers) => void;
  readonly onTogglePin: (projectId: string, pinned: boolean) => void;
  readonly onContextMenu?: (projectId: string, event: MouseEvent) => void;
}

export interface ActivationModifiers {
  /** Ctrl/Cmd — open a copy. */
  readonly copy: boolean;
  /** Alt — open read-only. */
  readonly readOnly: boolean;
}

function ProjectRowImpl({
  entry,
  selected,
  density = "comfortable",
  onSelect,
  onActivate,
  onTogglePin,
  onContextMenu,
}: ProjectRowProps) {
  const missing = entry.status === "missing";
  const compact = density === "compact";

  return (
    <div
      aria-selected={selected}
      className={cn(
        "group relative grid w-full items-center gap-fm-3 rounded-fm-md border border-transparent",
        "px-fm-2 py-fm-1 text-left transition-[background-color,border-color] duration-150",
        compact
          ? "min-h-[38px] grid-cols-[minmax(0,1fr)_74px_96px_64px_78px_26px]"
          : "min-h-fm-start-row grid-cols-[72px_minmax(0,1fr)_74px_96px_64px_78px_26px]",
        "hover:bg-fm-surface",
        selected && "border-fm-accent/40 bg-fm-selected",
        missing && "opacity-55",
        "focus-visible:border-fm-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fm-accent-soft",
        // The size column is the first thing to go on a narrow window.
        "max-[1400px]:[&>[data-col=size]]:hidden",
      )}
      data-slot="project-row"
      id={`fm-project-${entry.projectId}`}
      onClick={() => onSelect(entry.projectId)}
      onContextMenu={(event) => onContextMenu?.(entry.projectId, event)}
      onDoubleClick={(event) =>
        onActivate(entry.projectId, { copy: event.ctrlKey || event.metaKey, readOnly: event.altKey })
      }
      role="option"
    >
      {!compact && (
        <span
          className={cn(
            "relative size-[72px] h-[45px] shrink-0 overflow-hidden rounded-fm-sm",
            "border border-fm-subtle bg-fm-canvas",
            missing && "grid place-items-center text-fm-danger",
          )}
          data-slot="thumbnail"
        >
          {missing ? (
            <FileWarning aria-hidden="true" className="size-4" />
          ) : entry.thumbnail ? (
            // alt="" — the name sits right next to it, so announcing the image
            // would just repeat it.
            <img alt="" className="size-full object-cover" loading="lazy" src={entry.thumbnail} />
          ) : (
            <span className="block size-full bg-fm-canvas" />
          )}
        </span>
      )}

      <span className="min-w-0">
        <span className="flex items-center gap-1.5 font-fm-ui text-fm-md font-medium leading-tight">
          <span className="truncate">{entry.name}</span>
          {entry.mode === "read_only" && (
            <Link2 aria-label="Read-only" className="size-3 shrink-0 text-fm-muted" />
          )}
        </span>
        {/* direction:rtl ellipsises from the LEFT so the file name survives. */}
        <span
          className="mt-0.5 block truncate text-left font-fm-mono text-fm-2xs text-fm-muted [direction:rtl]"
          title={entry.path}
        >
          {entry.path}
        </span>
      </span>

      <span>
        <SolverBadge solver={entry.solver} />
      </span>

      <span>
        <StatusPill status={entry.status} />
      </span>

      <span className="text-right font-fm-mono text-fm-xs text-fm-muted" data-col="size">
        {formatBytes(entry.sizeBytes)}
      </span>

      <span className="text-right font-fm-mono text-fm-xs text-fm-muted">
        {formatOpened(entry.lastOpenedAt)}
      </span>

      <button
        aria-label={entry.pinned ? `Unpin ${entry.name}` : `Pin ${entry.name}`}
        aria-pressed={entry.pinned ?? false}
        className={cn(
          "grid size-[26px] place-items-center rounded-fm-sm text-fm-muted",
          "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
          "hover:bg-fm-raised hover:text-fm-primary",
          entry.pinned && "text-fm-warning opacity-100",
          selected && "opacity-100",
        )}
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin(entry.projectId, !entry.pinned);
        }}
        type="button"
      >
        <Star aria-hidden="true" className="size-3.5" fill={entry.pinned ? "currentColor" : "none"} />
      </button>
    </div>
  );
}

export const ProjectRow = memo(ProjectRowImpl);
