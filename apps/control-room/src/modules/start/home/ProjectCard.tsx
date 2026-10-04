"use client";

import { Link2 } from "lucide-react";
import { memo } from "react";

import { cn } from "@/shared/utils/className";

import { formatOpened } from "../model/recentIndex";
import type { RecentEntry } from "../model/types";
import { ProjectThumb } from "../ui/ProjectThumb";
import { SolverBadge } from "../ui/SolverBadge";
import { StatusPill } from "../ui/StatusPill";

import { rowDomId } from "./ProjectRow";

export interface ProjectCardProps {
  readonly entry: RecentEntry;
  readonly selected: boolean;
  readonly position: { readonly index: number; readonly count: number };
  readonly onSelect: (projectId: string) => void;
  readonly onActivate: (projectId: string) => void;
}

/** Grid-view counterpart of a row: recognised by its result rather than its path. */
function ProjectCardImpl({ entry, selected, position, onSelect, onActivate }: ProjectCardProps) {
  return (
    <div
      aria-posinset={position.index + 1}
      aria-selected={selected}
      aria-setsize={position.count}
      className={cn("fm-start-card", selected && "fm-start-card--selected")}
      data-status={entry.status}
      id={rowDomId(entry.projectId)}
      onClick={() => onSelect(entry.projectId)}
      onDoubleClick={() => onActivate(entry.projectId)}
      role="option"
    >
      <span className="fm-start-card__media">
        <ProjectThumb size="card" src={entry.thumbnail} status={entry.status} />
        {/* Over the dark render the badge keeps its own dark chip in both themes. */}
        <SolverBadge className="fm-start-card__badge" solver={entry.solver} />
      </span>
      <span className="fm-start-card__name" title={entry.path}>
        <span className="fm-start-card__name-text">{entry.name}</span>
        {entry.mode === "read_only" ? (
          <Link2 aria-label="Read-only" className="fm-start-row__ro" size={12} />
        ) : null}
      </span>
      <span className="fm-start-card__foot">
        <StatusPill status={entry.status} />
        <span className="fm-start-card__date">{formatOpened(entry.lastOpenedAt)}</span>
      </span>
    </div>
  );
}

export const ProjectCard = memo(ProjectCardImpl);
