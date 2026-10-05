"use client";

import { FolderClosed, Star } from "lucide-react";
import { memo } from "react";

import { cn } from "@/shared/utils/className";

import { formatBytes, formatOpened, shortenPath } from "../model/recentIndex";
import { resultChip, resultSourceName } from "../model/resultModel";
import { displayPath, folderOf } from "../model/scriptRowModel";
import type { ApiWorkspaceItem } from "../model/workspaceApiTypes";
import { StatusPill } from "../ui/StatusPill";

export interface ResultRowProps {
  readonly item: ApiWorkspaceItem;
  readonly selected: boolean;
  /** Set by the virtualiser so absolutely positioned rows stay accessible. */
  readonly position?: { readonly index: number; readonly count: number };
  readonly onSelect: (id: string) => void;
  readonly onActivate: (id: string) => void;
  readonly onTogglePin: (id: string, pinned: boolean) => void;
}

export const resultRowDomId = (id: string) => `fm-start-result-${id}`;

/**
 * A result folder in the recent list. It reuses the project row's grid: the
 * folder glyph takes the thumbnail slot, the `.zarr` badge the solver slot, the
 * run status the status slot and the folder's size the size slot.
 */
function ResultRowImpl({ item, selected, position, onSelect, onActivate, onTogglePin }: ResultRowProps) {
  const chip = resultChip(item);
  const path = displayPath(item.path);
  const source = resultSourceName(item);
  return (
    <div
      aria-posinset={position ? position.index + 1 : undefined}
      aria-selected={selected}
      aria-setsize={position?.count}
      className={cn("fm-start-row", selected && "fm-start-row--selected")}
      data-kind="result"
      data-status={item.status}
      id={resultRowDomId(item.id)}
      onClick={() => onSelect(item.id)}
      onDoubleClick={() => onActivate(item.id)}
      role="option"
    >
      <span aria-hidden="true" className="fm-start-thumb fm-start-thumb--row fm-start-thumb--script">
        <FolderClosed size={16} />
      </span>
      <span className="fm-start-row__main">
        <span className="fm-start-row__name">
          <span className="fm-start-row__name-text">{item.name}</span>
          {item.pinned ? <span className="fm-start-visually-hidden">, pinned</span> : null}
        </span>
        <span className="fm-start-row__path" title={path}>
          {source ? `from ${source}` : shortenPath(folderOf(path), 4)}
        </span>
      </span>
      <span className="fm-start-badge fm-start-badge--script" title="Result folder">
        .zarr
      </span>
      {chip ? (
        <StatusPill
          label={chip.label || undefined}
          status={chip.status}
          title={chip.title || undefined}
        />
      ) : (
        <span aria-hidden="true" />
      )}
      <span className="fm-start-row__size">{formatBytes(item.sizeBytes)}</span>
      <span className="fm-start-row__opened">{formatOpened(item.modifiedAt ?? item.lastUsedAt)}</span>
      {/* A pointer shortcut only, like the other rows: the keyboard path is Ctrl+P on the list. */}
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

export const ResultRow = memo(ResultRowImpl);
