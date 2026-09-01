"use client";

import { useMemo, useState } from "react";

import { paginateNavigatorItems } from "./resultsNavigatorModel";
import type { ResultsNavigatorNode } from "./resultsNavigatorTypes";

const ROW_INDENT_PX = 14;

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

interface ResultsNavigatorTreeRowProps {
  depth: number;
  expanded: boolean;
  node: ResultsNavigatorNode;
  onSelect?: (node: ResultsNavigatorNode) => void;
  onToggle: (nodeId: string) => void;
  page: number;
  expandedIds: ReadonlySet<string>;
  pages: Readonly<Record<string, number>>;
  selectedNodeId: string | null;
  setPage: (nodeId: string, page: number) => void;
}

function ResultsNavigatorTreeRow({
  depth,
  expanded,
  node,
  onSelect,
  onToggle,
  page,
  expandedIds,
  pages,
  selectedNodeId,
  setPage,
}: ResultsNavigatorTreeRowProps) {
  const hasChildren = Boolean(node.children?.length);
  const pageModel = node.collection && node.children
    ? paginateNavigatorItems(node.children, {
        page,
        pageSize: node.collection.pageSize,
      })
    : null;
  const visibleChildren = pageModel?.items ?? node.children ?? [];

  return (
    <li className="fm-results-navigator__item" data-status={node.status}>
      <div className="fm-results-navigator__row" style={{ paddingInlineStart: depth * ROW_INDENT_PX }}>
        {hasChildren ? (
          <button
            aria-label={expanded ? `Collapse ${node.label}` : `Expand ${node.label}`}
            className="fm-results-navigator__disclosure"
            type="button"
            onClick={() => onToggle(node.id)}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span aria-hidden="true" className="fm-results-navigator__disclosure-placeholder" />
        )}
        <button
          aria-current={selectedNodeId === node.id ? "true" : undefined}
          className="fm-results-navigator__node"
          data-node-id={node.id}
          data-status={node.status}
          type="button"
          onClick={() => onSelect?.(node)}
        >
          <span className="fm-results-navigator__label">{node.label}</span>
          <span className="fm-results-navigator__status">{node.status}</span>
          {node.statusReason ? (
            <span
              aria-label={`Reason: ${node.statusReason}`}
              className="fm-results-navigator__status-reason"
              data-status-reason="true"
              title={node.statusReason}
            >
              {node.statusReason}
            </span>
          ) : null}
        </button>
      </div>
      {expanded && visibleChildren.length > 0 ? (
        <ul className="fm-results-navigator__children">
          {visibleChildren.map((child) => (
            <ResultsNavigatorTreeRow
              depth={depth + 1}
              key={child.id}
              node={child}
              onSelect={onSelect}
              onToggle={onToggle}
              expanded={expandedIds.has(child.id)}
              expandedIds={expandedIds}
              page={pages[child.id] ?? 1}
              pages={pages}
              selectedNodeId={selectedNodeId}
              setPage={setPage}
            />
          ))}
        </ul>
      ) : null}
      {expanded && pageModel && pageModel.pageCount > 1 ? (
        <div className="fm-results-navigator__pagination" style={{ paddingInlineStart: (depth + 1) * ROW_INDENT_PX }}>
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
        </div>
      ) : null}
    </li>
  );
}

export function ResultsNavigatorTree({
  nodes,
  onSelect,
  selectedNodeId = null,
}: ResultsNavigatorTreeProps) {
  const initialExpanded = useMemo(() => collectExpandableIds(nodes), [nodes]);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(initialExpanded);
  const [pages, setPages] = useState<Readonly<Record<string, number>>>({});

  const toggle = (nodeId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };
  const setPage = (nodeId: string, page: number) => {
    setPages((current) => ({ ...current, [nodeId]: page }));
  };

  return (
    <nav aria-label="Results navigator" className="fm-results-navigator">
      <ul className="fm-results-navigator__tree">
        {nodes.map((node) => (
          <ResultsNavigatorTreeRow
            depth={0}
            expanded={expandedIds.has(node.id)}
            key={node.id}
            node={node}
            onSelect={onSelect}
            onToggle={toggle}
            expandedIds={expandedIds}
            page={pages[node.id] ?? 1}
            pages={pages}
            selectedNodeId={selectedNodeId}
            setPage={setPage}
          />
        ))}
      </ul>
    </nav>
  );
}
