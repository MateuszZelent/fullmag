"use client";

import { useState, useCallback } from "react";
import { CheckCircle2, Circle, LoaderCircle, MinusCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import TreeNodeIcon from "@/features/iconography/TreeNodeIcon";
import type { TreeNodeData, NodeStatus } from "./types";

/* ── Constants for tree geometry are now defined in globals.css ── */

function nodeStatusTone(status: NodeStatus | undefined, isActive: boolean): string {
  if (isActive) {
    return "bg-primary/12 text-primary border border-primary/20 shadow-sm";
  }
  if (status === "running") {
    return "bg-sky-500/10 text-sky-300 border border-sky-500/20";
  }
  if (status === "failed" || status === "blocked" || status === "stale" || status === "dirty") {
    return "bg-rose-500/10 text-rose-300 border border-rose-500/20";
  }
  if (status === "warning") {
    return "bg-amber-500/10 text-amber-300 border border-amber-500/20";
  }
  if (status === "completed") {
    return "bg-emerald-500/10 text-emerald-300 border border-emerald-500/20";
  }
  if (status === "skipped") {
    return "bg-card/40 text-muted-foreground border border-border/10";
  }
  if (status === "active") {
    return "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
  }
  return "hover:bg-card/40 text-foreground/85 hover:text-foreground border border-transparent hover:border-border/10";
}

function StatusIcon({ status }: { status: NodeStatus }) {
  if (status === "completed") {
    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />;
  }
  if (status === "running") {
    return <LoaderCircle className="h-3.5 w-3.5 animate-spin text-sky-400" aria-hidden="true" />;
  }
  if (status === "failed") {
    return <XCircle className="h-3.5 w-3.5 text-rose-400" aria-hidden="true" />;
  }
  if (status === "blocked" || status === "stale" || status === "dirty") {
    return <XCircle className="h-3.5 w-3.5 text-rose-400" aria-hidden="true" />;
  }
  if (status === "warning") {
    return <Circle className="h-3.5 w-3.5 fill-current text-amber-400 opacity-80" aria-hidden="true" />;
  }
  if (status === "skipped") {
    return <MinusCircle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />;
  }
  if (status === "active") {
    return <Circle className="h-3.5 w-3.5 fill-current text-primary" aria-hidden="true" />;
  }
  if (status === "error") {
    return <XCircle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />;
  }
  if (status === "ready") {
    return <Circle className="h-3.5 w-3.5 fill-current text-emerald-500 opacity-80" aria-hidden="true" />;
  }
  return <Circle className="h-3.5 w-3.5 text-muted-foreground/40" aria-hidden="true" />;
}

/* ── Constants for tree geometry are now defined in globals.css ── */

/* ── Tree Node ─────────────────────────────────────────────────────── */

function TreeNode({
  node,
  depth,
  activeId,
  onNodeClick,
  onContextMenu,
  isLast = false,
  parentGuides = [],
  forceExpandToken = 0,
  forceExpandValue,
  compact = false,
}: {
  node: TreeNodeData;
  depth: number;
  activeId?: string | null;
  onNodeClick?: (id: string) => void;
  onContextMenu?: (e: React.MouseEvent, nodeId: string, label: string) => void;
  isLast?: boolean;
  parentGuides?: boolean[];
  forceExpandToken?: number;
  forceExpandValue?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(node.defaultOpen ?? depth < 2);
  const hasChildren = node.children && node.children.length > 0;
  const isActive = activeId === node.id;

  // Sync open state with force expansion token during render (React 19 recommended pattern for resets)
  const [prevForceExpandToken, setPrevForceExpandToken] = useState(forceExpandToken);
  if (forceExpandToken !== prevForceExpandToken) {
    setPrevForceExpandToken(forceExpandToken);
    if (hasChildren && forceExpandValue != null) {
      setOpen(forceExpandValue);
    }
  }

  const handleClick = useCallback(() => {
    if (hasChildren) setOpen((prev) => !prev);
    node.onClick?.();
    onNodeClick?.(node.id);
  }, [hasChildren, node, onNodeClick]);

  const indentStyle = compact ? { width: "0.625rem" } : undefined;
  const showBadge = Boolean(node.badge) && (!compact || depth < 2);

  /* Guides to pass to children: add current level's continuation */
  const childGuides = depth > 0
    ? [...parentGuides, !isLast]
    : parentGuides;

  return (
    <div className="flex flex-col">
      {/* ── Node row: [guides column] [interactive content] ── */}
      <div
        className="flex items-stretch cursor-pointer group min-h-tree-row"
        onClick={handleClick}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu?.(e, node.id, node.label); }}
        role="treeitem"
        aria-expanded={hasChildren ? open : undefined}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handleClick();
          }
        }}
      >
        {/* ─── LEFT: Guide columns (never clipped) ─── */}
        {parentGuides.map((showLine, idx) => (
          <div
            key={`g-${idx}`}
            className="shrink-0 flex justify-center w-tree-indent"
            style={indentStyle}
          >
            {showLine && (
              <div className="w-px h-full bg-border/25" />
            )}
          </div>
        ))}

        {/* Own branch connector: vertical ↓ + horizontal → */}
        {depth > 0 && (
          <div
            className="shrink-0 relative w-tree-indent"
            style={indentStyle}
          >
            {/* Vertical segment: top → center (last child) or top → bottom */}
            <div
              className="absolute left-1/2 top-0 -translate-x-1/2 w-px bg-border/30"
              style={{ height: isLast ? '50%' : '100%' }}
            />
            {/* Horizontal branch: center → right edge */}
            <div
              className="absolute top-1/2 -translate-y-1/2 h-px bg-border/30"
              style={{ left: '50%', right: 0 }}
            />
          </div>
        )}

        {/* ─── RIGHT: Interactive content (overflow-clipped) ─── */}
        <div
          className={cn(
            "flex-1 flex items-center gap-1 pr-2 rounded-lg transition-[background-color,border-color,color,box-shadow] duration-200 overflow-hidden relative min-w-0",
            nodeStatusTone(node.status, isActive),
          )}
        >
          {/* Active indicator bar - glowing effect */}
          {isActive && (
            <span 
              className="absolute left-0 top-1 bottom-1 w-[3px] bg-primary rounded-r-full"
              style={{ boxShadow: '0 0 8px rgba(99,102,241,0.5), 0 0 12px rgba(99,102,241,0.3)' }}
            />
          )}

          {/* Expand/collapse chevron */}
          {hasChildren ? (
            <span className="ml-0.5 flex h-4 w-3 shrink-0 items-center justify-center">
              <svg
                width="8" height="8" viewBox="0 0 8 8" fill="none"
                className={cn(
                  "text-muted-foreground/60 transition-transform duration-150",
                  open && "rotate-90"
                )}
              >
                <path d="M2 1L6 4L2 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          ) : null}

          {/* Icon */}
          {node.icon && (
            <span className={cn(
              "flex h-4 w-4 shrink-0 items-center justify-center text-[0.72rem]",
              isActive ? "opacity-100 text-primary" : "opacity-65 group-hover:opacity-90"
            )}>
              <TreeNodeIcon icon={node.icon} size={14} />
            </span>
          )}

          {/* Label */}
          <span className={cn(
            "flex-1 truncate text-[0.78rem] tracking-wide",
            isActive ? "font-semibold" : "font-normal"
          )}>
            {node.label}
          </span>

          {/* Status icon — only for states not already conveyed by the row background */}
          {node.status && node.status !== "ready" && node.status !== "active" && (
            <span className="ml-1 shrink-0 opacity-90">
              <StatusIcon status={node.status} />
            </span>
          )}

          {/* Badge */}
          {showBadge ? (
            <span className={cn(
              "ml-1 shrink-0 rounded px-1.5 py-[1px] text-[0.625rem] font-medium font-mono opacity-80",
              isActive
                ? "bg-primary/10 text-primary border border-primary/10"
                : "bg-card/40 text-muted-foreground/70 border border-border/10"
            )}>
              {node.badge}
            </span>
          ) : null}
        </div>
      </div>

      {/* ── Children ── */}
      {hasChildren && open && (
        <div className="flex flex-col" role="group">
          {node.children!.map((child, idx) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              activeId={activeId}
              onNodeClick={onNodeClick}
              onContextMenu={onContextMenu}
              isLast={idx === node.children!.length - 1}
              parentGuides={childGuides}
              forceExpandToken={forceExpandToken}
              forceExpandValue={forceExpandValue}
              compact={compact}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export { TreeNode };
