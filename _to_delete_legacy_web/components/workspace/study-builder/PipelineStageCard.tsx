"use client";

import { ArrowDown, ArrowUp, Copy, PlusSquare, Power, Trash2 } from "lucide-react";
import type { StudyPipelineNode } from "@/lib/study-builder/types";
import { humanizeStudyPipelineNodeKind, summarizeStudyPipelineNode } from "@/lib/study-builder/summaries";
import StageSummaryChip from "./StageSummaryChip";

interface PipelineStageCardProps {
  node: StudyPipelineNode;
  selected: boolean;
  index: number;
  onSelect: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onInsertBeforeRun: () => void;
  onInsertAfterRun: () => void;
  onDuplicate: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
}

export default function PipelineStageCard({
  node,
  selected,
  index,
  onSelect,
  onMoveUp,
  onMoveDown,
  onInsertBeforeRun,
  onInsertAfterRun,
  onDuplicate,
  onToggleEnabled,
  onDelete,
}: PipelineStageCardProps) {
  return (
    <div
      className={`rounded-lg border ${
        selected ? "border-primary/50 bg-primary/10 shadow-[0_0_0_1px_rgba(99,102,241,0.16)]" : "border-border/40 bg-background/35"
      } ${!node.enabled ? "opacity-60" : ""}`}
    >
      <button type="button" onClick={onSelect} className="flex w-full flex-col gap-3 p-3 text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Stage {index + 1}
            </div>
            <div className="mt-1 text-sm font-semibold text-foreground">
              {node.label}
              {!node.enabled ? " (disabled)" : ""}
            </div>
            <div className="mt-1 text-[0.72rem] leading-relaxed text-muted-foreground">
              {summarizeStudyPipelineNode(node)}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            <StageSummaryChip
              label={node.source === "script_imported" ? "Script" : "UI"}
              tone={node.source === "script_imported" ? "amber" : "emerald"}
            />
            <StageSummaryChip
              label={humanizeStudyPipelineNodeKind(node)}
              tone={node.node_kind === "macro" ? "violet" : "default"}
            />
          </div>
        </div>
      </button>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-border/30 px-3 py-2">
        <button type="button" onClick={onMoveUp} className="rounded border border-border/40 px-2 py-1 text-[0.64rem]">
          <ArrowUp className="mr-1 inline size-3" />
          Up
        </button>
        <button type="button" onClick={onMoveDown} className="rounded border border-border/40 px-2 py-1 text-[0.64rem]">
          <ArrowDown className="mr-1 inline size-3" />
          Down
        </button>
        <button type="button" onClick={onInsertBeforeRun} className="rounded border border-border/40 px-2 py-1 text-[0.64rem]">
          <PlusSquare className="mr-1 inline size-3" />
          Run Before
        </button>
        <button type="button" onClick={onInsertAfterRun} className="rounded border border-border/40 px-2 py-1 text-[0.64rem]">
          <PlusSquare className="mr-1 inline size-3" />
          Run After
        </button>
        <button type="button" onClick={onDuplicate} className="rounded border border-border/40 px-2 py-1 text-[0.64rem]">
          <Copy className="mr-1 inline size-3" />
          Duplicate
        </button>
        <button type="button" onClick={onToggleEnabled} className="rounded border border-border/40 px-2 py-1 text-[0.64rem]">
          <Power className="mr-1 inline size-3" />
          {node.enabled ? "Disable" : "Enable"}
        </button>
        <button type="button" onClick={onDelete} className="rounded border border-border/40 px-2 py-1 text-[0.64rem] text-rose-300">
          <Trash2 className="mr-1 inline size-3" />
          Delete
        </button>
      </div>
    </div>
  );
}
