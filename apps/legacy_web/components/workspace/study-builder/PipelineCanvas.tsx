"use client";

import type { StudyPipelineNode } from "@/lib/study-builder/types";
import PipelineStageCard from "./PipelineStageCard";

interface PipelineCanvasProps {
  nodes: StudyPipelineNode[];
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onToggleEnabled: (id: string) => void;
  onInsertBeforeRun: (id: string) => void;
  onInsertAfterRun: (id: string) => void;
}

export default function PipelineCanvas({
  nodes,
  selectedNodeId,
  onSelectNode,
  onMoveUp,
  onMoveDown,
  onDelete,
  onDuplicate,
  onToggleEnabled,
  onInsertBeforeRun,
  onInsertAfterRun,
}: PipelineCanvasProps) {
  if (nodes.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/40 bg-background/30 p-4 text-xs text-muted-foreground">
        No stages in pipeline. Add the first stage from the Stage Builder ribbon above.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border/40 bg-background/30 p-3">
      <div className="border-b border-border/30 pb-3">
        <div className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Stage Sequence
        </div>
        <div className="mt-1 text-sm font-semibold text-foreground">
          Pipeline canvas
        </div>
        <div className="mt-1 text-[0.72rem] text-muted-foreground">
          This is the COMSOL-like authoring list for solver stages. Select a stage to edit its settings in the panel on the right.
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-2">
      {nodes.map((node, index) => (
        <PipelineStageCard
          key={node.id}
          node={node}
          selected={selectedNodeId === node.id}
          index={index}
          onSelect={() => onSelectNode(node.id)}
          onMoveUp={() => onMoveUp(node.id)}
          onMoveDown={() => onMoveDown(node.id)}
          onInsertBeforeRun={() => onInsertBeforeRun(node.id)}
          onInsertAfterRun={() => onInsertAfterRun(node.id)}
          onDuplicate={() => onDuplicate(node.id)}
          onToggleEnabled={() => onToggleEnabled(node.id)}
          onDelete={() => onDelete(node.id)}
        />
      ))}
      </div>
    </div>
  );
}
