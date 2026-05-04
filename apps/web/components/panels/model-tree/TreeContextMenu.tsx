"use client";

import { useMemo } from "react";
import type { ReactNode, RefObject } from "react";
import { parseVisualizationPresetNodeId } from "../../runs/control-room/visualizationPresets";

export interface TreeContextMenuState {
  x: number;
  y: number;
  nodeId: string;
  label: string;
}

interface TreeContextMenuProps {
  menu: TreeContextMenuState;
  menuRef: RefObject<HTMLDivElement | null>;
  onAction: (action: string) => void;
}

function TreeContextButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className="w-full rounded-sm px-2 py-1.5 text-left text-xs font-medium text-popover-foreground transition-colors hover:bg-muted"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function TreeContextMenu({ menu, menuRef, onAction }: TreeContextMenuProps) {
  const contextVisualizationPreset = useMemo(
    () => parseVisualizationPresetNodeId(menu.nodeId),
    [menu.nodeId],
  );
  const contextResultAnalysis = menu.nodeId.startsWith("res-analysis-");
  const contextStage = menu.nodeId.startsWith("study-stage-node:");

  return (
    <div
      ref={menuRef}
      className="fixed z-[200] min-w-[160px] rounded-md border border-border bg-popover p-1 shadow-md animate-in fade-in zoom-in-95 duration-100"
    >
      <div className="mb-1 border-b border-border/10 px-2 py-1 text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">
        {menu.label}
      </div>
      <TreeContextButton onClick={() => onAction("select")}>Select</TreeContextButton>
      {contextVisualizationPreset ? (
        <>
          <TreeContextButton onClick={() => onAction("apply")}>Apply</TreeContextButton>
          <TreeContextButton onClick={() => onAction("rename")}>Rename</TreeContextButton>
          <TreeContextButton onClick={() => onAction("duplicate")}>Duplicate</TreeContextButton>
          <TreeContextButton
            onClick={() =>
              onAction(contextVisualizationPreset.source === "project" ? "save-local" : "save-project")
            }
          >
            {contextVisualizationPreset.source === "project" ? "Save To Local" : "Save To Project"}
          </TreeContextButton>
          <TreeContextButton onClick={() => onAction("delete")}>Delete</TreeContextButton>
        </>
      ) : contextResultAnalysis ? (
        <>
          <TreeContextButton onClick={() => onAction("rename")}>Rename</TreeContextButton>
          <TreeContextButton onClick={() => onAction("duplicate")}>Duplicate</TreeContextButton>
          <TreeContextButton onClick={() => onAction("toggle-pin")}>Pin / Unpin</TreeContextButton>
          <TreeContextButton onClick={() => onAction("delete")}>Delete</TreeContextButton>
        </>
      ) : contextStage ? (
        <>
          <TreeContextButton onClick={() => onAction("toggle-stage")}>Enable / Disable</TreeContextButton>
          <TreeContextButton onClick={() => onAction("delete-stage")}>Delete Stage</TreeContextButton>
        </>
      ) : (
        <TreeContextButton onClick={() => onAction("focus")}>Focus in 3D</TreeContextButton>
      )}
      <TreeContextButton onClick={() => onAction("copy-name")}>Copy Name</TreeContextButton>
      <div className="mx-1 my-1 h-px bg-border/50" />
      <TreeContextButton onClick={() => onAction("expand-all")}>Expand All</TreeContextButton>
      <TreeContextButton onClick={() => onAction("collapse-all")}>Collapse All</TreeContextButton>
    </div>
  );
}
