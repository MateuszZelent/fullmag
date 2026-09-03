"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { TreeContextMenu, type TreeContextMenuState } from "./model-tree/TreeContextMenu";
import { TreeNode } from "./model-tree/TreeNode";
import type { TreeNodeData } from "./model-tree/types";

/* ── Re-exports for public API ── */
export type { TreeNodeData, NodeStatus, NodeDomain } from "./model-tree/types";
export { buildFullmagModelTree } from "./model-tree/treeDataBuilders";

interface ModelTreeProps {
  nodes: TreeNodeData[];
  activeId?: string | null;
  onNodeClick?: (id: string) => void;
  onContextAction?: (nodeId: string, action: string) => void;
  className?: string;
  compact?: boolean;
}

/* ── ModelTree ──────────────────────────────────────────────────────── */

export default function ModelTree({
  nodes,
  activeId,
  onNodeClick,
  onContextAction,
  className,
  compact = false,
}: ModelTreeProps) {
  const [ctxMenu, setCtxMenu] = useState<TreeContextMenuState | null>(null);
  const [forceExpandToken, setForceExpandToken] = useState(0);
  const [forceExpandValue, setForceExpandValue] = useState<boolean | undefined>(undefined);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, nodeId: string, label: string) => {
    setCtxMenu({ x: e.clientX, y: e.clientY, nodeId, label });
  }, []);

  /* Close on click outside or Escape */
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    if (menuRef.current) {
      menuRef.current.style.left = `${ctxMenu.x}px`;
      menuRef.current.style.top = `${ctxMenu.y}px`;
    }
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", onKey); };
  }, [ctxMenu]);

  const handleAction = useCallback((action: string) => {
    if (ctxMenu) {
      if (action === "expand-all") {
        setForceExpandValue(true);
        setForceExpandToken((prev) => prev + 1);
      }
      if (action === "collapse-all") {
        setForceExpandValue(false);
        setForceExpandToken((prev) => prev + 1);
      }
      onContextAction?.(ctxMenu.nodeId, action);
      if (action === "select") onNodeClick?.(ctxMenu.nodeId);
      if (action === "copy-name" && ctxMenu.label) {
        void navigator.clipboard.writeText(ctxMenu.label).catch((error) => {
          console.warn("[ModelTree] Clipboard copy failed", error);
        });
      }
    }
    setCtxMenu(null);
  }, [ctxMenu, onContextAction, onNodeClick]);
  return (
    <div className={cn("flex flex-col gap-[1px] py-1 select-none", className)} role="tree">
      {nodes.map((node, idx) => (
        <TreeNode
          key={node.id}
          node={node}
          depth={0}
          activeId={activeId}
          onNodeClick={onNodeClick}
          onContextMenu={handleContextMenu}
          isLast={idx === nodes.length - 1}
          parentGuides={[]}
          forceExpandToken={forceExpandToken}
          forceExpandValue={forceExpandValue}
          compact={compact}
        />
      ))}

      {ctxMenu && (
        <TreeContextMenu menu={ctxMenu} menuRef={menuRef} onAction={handleAction} />
      )}
    </div>
  );
}
