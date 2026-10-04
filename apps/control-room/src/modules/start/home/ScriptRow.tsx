"use client";

import { FileCode2, Star } from "lucide-react";
import { memo } from "react";

import { cn } from "@/shared/utils/className";

import { formatOpened, shortenPath } from "../model/recentIndex";
import { displayPath, folderOf, formatLines, runChip } from "../model/scriptRowModel";
import type { WorkspaceItem } from "../model/workspaceItems";
import { StatusPill } from "../ui/StatusPill";

export interface ScriptRowProps {
  readonly item: WorkspaceItem;
  readonly selected: boolean;
  /** Set by the virtualiser so absolutely positioned rows stay accessible. */
  readonly position?: { readonly index: number; readonly count: number };
  readonly onSelect: (id: number) => void;
  readonly onActivate: (id: number) => void;
  readonly onTogglePin: (id: number, pinned: boolean) => void;
}

export const scriptRowDomId = (id: number) => `fm-start-script-${id}`;

/**
 * A script in the recent list. It reuses the project row's grid: the glyph
 * takes the thumbnail slot, the `.py` badge the solver slot, the run chip (or
 * the missing/failed state) the status slot and the line count the size slot.
 */
function ScriptRowImpl({
  item,
  selected,
  position,
  onSelect,
  onActivate,
  onTogglePin,
}: ScriptRowProps) {
  const chip = runChip(item.meta.lastRun);
  const lines = formatLines(item);
  const path = displayPath(item.path);
  return (
    <div
      aria-posinset={position ? position.index + 1 : undefined}
      aria-selected={selected}
      aria-setsize={position?.count}
      className={cn("fm-start-row", selected && "fm-start-row--selected")}
      data-kind="script"
      data-status={item.status}
      id={scriptRowDomId(item.id)}
      onClick={() => onSelect(item.id)}
      onDoubleClick={() => onActivate(item.id)}
      role="option"
    >
      <span aria-hidden="true" className="fm-start-thumb fm-start-thumb--row fm-start-thumb--script">
        <FileCode2 size={16} />
      </span>
      <span className="fm-start-row__main">
        <span className="fm-start-row__name">
          <span className="fm-start-row__name-text">{item.name}</span>
          {item.pinned ? <span className="fm-start-visually-hidden">, pinned</span> : null}
        </span>
        <span className="fm-start-row__path" title={path}>
          {shortenPath(folderOf(path), 4)}
        </span>
      </span>
      <span className="fm-start-badge fm-start-badge--script" title="Python script">
        .py
      </span>
      {item.status !== "ready" ? (
        <StatusPill status={item.status} />
      ) : chip ? (
        <StatusPill label={chip.label} status={chip.status} title={chip.title} />
      ) : (
        <span aria-hidden="true" />
      )}
      <span className="fm-start-row__size">{lines ?? "—"}</span>
      <span className="fm-start-row__opened">{formatOpened(item.lastUsedAt)}</span>
      {/* A pointer shortcut only, like the project row: the keyboard path is
          Ctrl+P on the list. */}
      <span
        aria-hidden="true"
        className="fm-start-row__pin"
        data-pinned={item.pinned ? "true" : "false"}
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin(item.id, !item.pinned);
        }}
        title={item.pinned ? "Unpin (Ctrl+P)" : "Pin (Ctrl+P)"}
      >
        <Star aria-hidden="true" fill={item.pinned ? "currentColor" : "none"} size={14} />
      </span>
    </div>
  );
}

export const ScriptRow = memo(ScriptRowImpl);
