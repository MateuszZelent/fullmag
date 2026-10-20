"use client";

import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import { paginateNavigatorItems } from "./resultsNavigatorModel";
import type { ResultsNavigatorNode } from "./resultsNavigatorTypes";

export interface ResultsNavigatorTreeProps {
  nodes: readonly ResultsNavigatorNode[];
  onSelect?: (node: ResultsNavigatorNode) => void;
  selectedNodeId?: string | null;
}

function collectExpandableIds(
  nodes: readonly ResultsNavigatorNode[],
  depth = 0,
): Set<string> {
  const expanded = new Set<string>();
  for (const node of nodes) {
    if (!node.children?.length) continue;
    if (depth <= 4) expanded.add(node.id);
    for (const child of node.children) {
      for (const id of collectExpandableIds([child], depth + 1)) expanded.add(id);
    }
  }
  return expanded;
}

interface VisibleTreeItem {
  hasChildren: boolean;
  node: ResultsNavigatorNode;
  parentId: string | null;
}

function visibleChildrenOf(
  node: ResultsNavigatorNode,
  page: number,
): readonly ResultsNavigatorNode[] {
  if (node.collection && node.children) {
    return paginateNavigatorItems(node.children, {
      page,
      pageSize: node.collection.pageSize,
    }).items;
  }
  return node.children ?? [];
}

/** Visible items in document order, used for arrow-key navigation (APG tree). */
function flattenVisibleItems(
  nodes: readonly ResultsNavigatorNode[],
  expandedIds: ReadonlySet<string>,
  pages: Readonly<Record<string, number>>,
  parentId: string | null = null,
  out: VisibleTreeItem[] = [],
): VisibleTreeItem[] {
  for (const node of nodes) {
    const hasChildren = Boolean(node.children?.length);
    out.push({ hasChildren, node, parentId });
    if (hasChildren && expandedIds.has(node.id)) {
      flattenVisibleItems(
        visibleChildrenOf(node, pages[node.id] ?? 1),
        expandedIds,
        pages,
        node.id,
        out,
      );
    }
  }
  return out;
}

interface ResultsNavigatorTreeRowProps {
  activeId: string | null;
  depth: number;
  expandedIds: ReadonlySet<string>;
  node: ResultsNavigatorNode;
  onActivate: (nodeId: string) => void;
  onSelect?: (node: ResultsNavigatorNode) => void;
  onToggle: (nodeId: string) => void;
  pages: Readonly<Record<string, number>>;
  positionInSet: number;
  selectedNodeId: string | null;
  setPage: (nodeId: string, page: number) => void;
  setSize: number;
}

function ResultsNavigatorTreeRow({
  activeId,
  depth,
  expandedIds,
  node,
  onActivate,
  onSelect,
  onToggle,
  pages,
  positionInSet,
  selectedNodeId,
  setPage,
  setSize,
}: ResultsNavigatorTreeRowProps) {
  const hasChildren = Boolean(node.children?.length);
  const expanded = hasChildren && expandedIds.has(node.id);
  const page = pages[node.id] ?? 1;
  const pageModel = node.collection && node.children
    ? paginateNavigatorItems(node.children, {
        page,
        pageSize: node.collection.pageSize,
      })
    : null;
  const visibleChildren = pageModel?.items ?? node.children ?? [];
  const selected = selectedNodeId === node.id;
  const depthStyle = { "--fm-results-navigator-depth": depth } as CSSProperties;

  return (
    <li
      aria-expanded={hasChildren ? expanded : undefined}
      aria-level={depth + 1}
      aria-posinset={positionInSet}
      aria-selected={selected}
      aria-setsize={setSize}
      className="fm-results-navigator__item"
      data-node-id={node.id}
      data-status={node.status}
      role="treeitem"
      tabIndex={activeId === node.id ? 0 : -1}
      onClick={(event) => {
        event.stopPropagation();
        onActivate(node.id);
        onSelect?.(node);
      }}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onActivate(node.id);
      }}
    >
      <div
        className="fm-results-navigator__row"
        data-selected={selected || undefined}
        style={depthStyle}
      >
        {hasChildren ? (
          <span
            aria-hidden="true"
            className="fm-results-navigator__disclosure"
            onClick={(event) => {
              event.stopPropagation();
              onActivate(node.id);
              onToggle(node.id);
            }}
          >
            {expanded ? "▾" : "▸"}
          </span>
        ) : (
          <span aria-hidden="true" className="fm-results-navigator__disclosure-placeholder" />
        )}
        <span className="fm-results-navigator__node" data-status={node.status}>
          <span className="fm-results-navigator__label">{node.label}</span>
          <span className="fm-results-navigator__status">{node.status}</span>
          {node.statusReason ? (
            <span
              className="fm-results-navigator__status-reason"
              data-status-reason="true"
              title={node.statusReason}
            >
              {`Reason: ${node.statusReason}`}
            </span>
          ) : null}
        </span>
      </div>
      {expanded && visibleChildren.length > 0 ? (
        <ul className="fm-results-navigator__children" role="group">
          {visibleChildren.map((child, index) => (
            <ResultsNavigatorTreeRow
              activeId={activeId}
              depth={depth + 1}
              expandedIds={expandedIds}
              key={child.id}
              node={child}
              onActivate={onActivate}
              onSelect={onSelect}
              onToggle={onToggle}
              pages={pages}
              positionInSet={index + 1}
              selectedNodeId={selectedNodeId}
              setPage={setPage}
              setSize={visibleChildren.length}
            />
          ))}
          {pageModel && pageModel.pageCount > 1 ? (
            <li
              className="fm-results-navigator__pagination"
              role="none"
              style={{ "--fm-results-navigator-depth": depth + 1 } as CSSProperties}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                disabled={!pageModel.hasPrevious}
                type="button"
                onClick={() => setPage(node.id, pageModel.page - 1)}
              >
                Previous
              </button>
              <span aria-live="polite">
                Page {pageModel.page} / {pageModel.pageCount} ({pageModel.total})
              </span>
              <button
                disabled={!pageModel.hasNext}
                type="button"
                onClick={() => setPage(node.id, pageModel.page + 1)}
              >
                Next
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Results tree following the WAI-ARIA APG tree pattern: one tab stop (roving
 * tabindex), Up/Down move between visible items, Right expands or enters the
 * first child, Left collapses or returns to the parent, Home/End jump, and
 * Enter/Space select.
 */
export function ResultsNavigatorTree({
  nodes,
  onSelect,
  selectedNodeId = null,
}: ResultsNavigatorTreeProps) {
  const initialExpanded = useMemo(() => collectExpandableIds(nodes), [nodes]);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(initialExpanded);
  const [pages, setPages] = useState<Readonly<Record<string, number>>>({});
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const treeRef = useRef<HTMLUListElement | null>(null);

  const visibleItems = useMemo(
    () => flattenVisibleItems(nodes, expandedIds, pages),
    [expandedIds, nodes, pages],
  );
  const isVisible = (nodeId: string | null) =>
    nodeId !== null && visibleItems.some((item) => item.node.id === nodeId);
  // Exactly one tab stop: the focused item, else the selection, else the first item.
  const activeId = isVisible(focusedId)
    ? focusedId
    : isVisible(selectedNodeId)
      ? selectedNodeId
      : (visibleItems[0]?.node.id ?? null);

  const toggle = (nodeId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };
  const setExpanded = (nodeId: string, expanded: boolean) => {
    setExpandedIds((current) => {
      if (current.has(nodeId) === expanded) return current;
      const next = new Set(current);
      if (expanded) next.add(nodeId);
      else next.delete(nodeId);
      return next;
    });
  };
  const setPage = (nodeId: string, page: number) => {
    setPages((current) => ({ ...current, [nodeId]: page }));
  };

  const focusItem = (nodeId: string) => {
    setFocusedId(nodeId);
    const element = Array.from(
      treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
    ).find((item) => item.dataset.nodeId === nodeId);
    element?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const target = event.target as HTMLElement;
    if (target.getAttribute("role") !== "treeitem") return;
    const currentId = target.dataset.nodeId ?? null;
    const index = visibleItems.findIndex((item) => item.node.id === currentId);
    if (index < 0) return;
    const current = visibleItems[index];
    let handled = true;
    switch (event.key) {
      case "ArrowDown": {
        const next = visibleItems[index + 1];
        if (next) focusItem(next.node.id);
        break;
      }
      case "ArrowUp": {
        const previous = visibleItems[index - 1];
        if (previous) focusItem(previous.node.id);
        break;
      }
      case "ArrowRight":
        if (current.hasChildren) {
          if (!expandedIds.has(current.node.id)) {
            setExpanded(current.node.id, true);
          } else {
            const child = visibleItems[index + 1];
            if (child?.parentId === current.node.id) focusItem(child.node.id);
          }
        }
        break;
      case "ArrowLeft":
        if (current.hasChildren && expandedIds.has(current.node.id)) {
          setExpanded(current.node.id, false);
        } else if (current.parentId) {
          focusItem(current.parentId);
        }
        break;
      case "Home": {
        const first = visibleItems[0];
        if (first) focusItem(first.node.id);
        break;
      }
      case "End": {
        const last = visibleItems[visibleItems.length - 1];
        if (last) focusItem(last.node.id);
        break;
      }
      case "Enter":
      case " ":
        onSelect?.(current.node);
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <nav aria-label="Results navigator" className="fm-results-navigator">
      <ul
        aria-label="Results"
        className="fm-results-navigator__tree"
        ref={treeRef}
        role="tree"
        onKeyDown={onKeyDown}
      >
        {nodes.map((node, index) => (
          <ResultsNavigatorTreeRow
            activeId={activeId}
            depth={0}
            expandedIds={expandedIds}
            key={node.id}
            node={node}
            onActivate={setFocusedId}
            onSelect={onSelect}
            onToggle={toggle}
            pages={pages}
            positionInSet={index + 1}
            selectedNodeId={selectedNodeId}
            setPage={setPage}
            setSize={nodes.length}
          />
        ))}
      </ul>
    </nav>
  );
}
