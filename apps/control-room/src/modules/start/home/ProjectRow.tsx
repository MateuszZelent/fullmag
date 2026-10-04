"use client";

import { Link2, Star } from "lucide-react";
import { memo, type MouseEvent } from "react";

import { cn } from "@/shared/utils/className";

import { formatBytes, formatOpened, shortenPath } from "../model/recentIndex";
import type { RecentEntry } from "../model/types";
import { ProjectThumb } from "../ui/ProjectThumb";
import { SolverBadge } from "../ui/SolverBadge";
import { StatusPill } from "../ui/StatusPill";

export interface ProjectRowProps {
  readonly entry: RecentEntry;
  readonly selected: boolean;
  /** Set by the virtualiser so absolutely positioned rows stay accessible. */
  readonly position?: { readonly index: number; readonly count: number };
  readonly onSelect: (projectId: string) => void;
  readonly onActivate: (projectId: string) => void;
  readonly onTogglePin: (projectId: string, pinned: boolean) => void;
  readonly onContextMenu?: (projectId: string, event: MouseEvent) => void;
}

function ProjectRowImpl({
  entry,
  selected,
  position,
  onSelect,
  onActivate,
  onTogglePin,
  onContextMenu,
}: ProjectRowProps) {
  return (
    <div
      aria-posinset={position ? position.index + 1 : undefined}
      aria-selected={selected}
      aria-setsize={position?.count}
      className={cn("fm-start-row", selected && "fm-start-row--selected")}
      data-status={entry.status}
      id={rowDomId(entry.projectId)}
      onClick={() => onSelect(entry.projectId)}
      onContextMenu={(event) => onContextMenu?.(entry.projectId, event)}
      onDoubleClick={() => onActivate(entry.projectId)}
      role="option"
    >
      <ProjectThumb size="row" src={entry.thumbnail} status={entry.status} />
      <span className="fm-start-row__main">
        <span className="fm-start-row__name">
          <span className="fm-start-row__name-text">{entry.name}</span>
          {entry.mode === "read_only" ? (
            <Link2 aria-label="Read-only" className="fm-start-row__ro" size={12} />
          ) : null}
        </span>
        {/* Shortened in code rather than with direction: rtl, which reorders the
            backslashes of a Windows path. The full path stays in the tooltip. */}
        <span className="fm-start-row__path" title={entry.path}>
          {shortenPath(entry.path, 4)}
        </span>
      </span>
      <SolverBadge solver={entry.solver} />
      <StatusPill status={entry.status} />
      <span className="fm-start-row__size">{formatBytes(entry.sizeBytes)}</span>
      <span className="fm-start-row__opened">{formatOpened(entry.lastOpenedAt)}</span>
      {/* A pointer shortcut only: it is not a control inside the option, and
          the keyboard path is Ctrl+P on the list. */}
      <span
        aria-hidden="true"
        className="fm-start-row__pin"
        data-pinned={entry.pinned ? "true" : "false"}
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin(entry.projectId, !entry.pinned);
        }}
        title={entry.pinned ? "Unpin (Ctrl+P)" : "Pin (Ctrl+P)"}
      >
        <Star aria-hidden="true" fill={entry.pinned ? "currentColor" : "none"} size={14} />
      </span>
    </div>
  );
}

export const rowDomId = (projectId: string) => `fm-start-project-${projectId}`;

export const ProjectRow = memo(ProjectRowImpl);
