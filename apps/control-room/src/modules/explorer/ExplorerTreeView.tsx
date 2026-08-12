"use client";

import {
  Activity,
  Box,
  Braces,
  ChevronRight,
  Circle,
  Database,
  File,
  Folder,
  Gauge,
  Layers,
  Magnet,
  Play,
  Settings,
  Shield,
  Sparkles,
  Triangle,
  Waves,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import type {
  CommandActiveResource,
  CommandContribution,
} from "@/kernel/commands/commandTypes";
import {
  useCommandDetailResource,
  useRuntimeCommandControlResourceData,
} from "@/kernel/resources/studyRuntimeResources";
import type { KernelApi, ModuleId } from "@/kernel/types";
import { CommandDetailDialog } from "@/shared/runtime/CommandDetailDialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/shared/ui/ContextMenu";

import { selectExplorerNode } from "./explorerSelection";
import { explorerStatusClassName } from "./explorerStatusClass";
import { cn } from "@/shared/utils/className";
import {
  setExplorerKeyboardRow,
  toggleExplorerNode,
} from "./explorerStore";
import type {
  ExplorerIconToken,
  ExplorerNode,
  ExplorerNodeStatus,
  ExplorerTabId,
} from "./explorerTypes";

const ICONS: Record<ExplorerIconToken, ReactNode> = {
  activity: <Activity size={14} />,
  box: <Box size={14} />,
  braces: <Braces size={14} />,
  circle: <Circle size={14} />,
  database: <Database size={14} />,
  file: <File size={14} />,
  folder: <Folder size={14} />,
  gauge: <Gauge size={14} />,
  layers: <Layers size={14} />,
  magnet: <Magnet size={14} />,
  mesh: <Triangle size={14} />,
  play: <Play size={14} />,
  settings: <Settings size={14} />,
  shield: <Shield size={14} />,
  sparkles: <Sparkles size={14} />,
  triangle: <Triangle size={14} />,
  wave: <Waves size={14} />,
};

const EXPLORER_ROW_HEIGHT = 28;
const EXPLORER_ROW_OVERSCAN = 8;
const EXPLORER_VIRTUALIZATION_THRESHOLD = 200;

export function resolveExplorerRevealScrollTop({
  activeNodeId,
  rowHeight,
  rowIds,
  scrollTop,
  viewportHeight,
}: {
  activeNodeId: string | null;
  rowHeight: number;
  rowIds: readonly string[];
  scrollTop: number;
  viewportHeight: number;
}): number | null {
  if (!activeNodeId) return null;
  const index = rowIds.indexOf(activeNodeId);
  if (index < 0) return null;
  const rowTop = index * rowHeight;
  const rowBottom = rowTop + rowHeight;
  if (rowTop < scrollTop) return rowTop;
  if (rowBottom > scrollTop + viewportHeight) {
    return Math.max(rowBottom - viewportHeight, 0);
  }
  return null;
}

function statusLabel(status: ExplorerNodeStatus | undefined): string {
  if (!status) return "ready";
  return status;
}

function contextCommandsForNode(
  kernel: KernelApi,
  node: ExplorerNode,
): CommandContribution[] {
  const commands: CommandContribution[] = [];

  for (const commandId of node.contextCommands ?? []) {
    const command = kernel.commands.get(commandId);
    if (command) {
      commands.push(command);
    }
  }

  return commands;
}

function commandContextForNode(
  kernel: KernelApi,
  node: ExplorerNode,
  commandId: string,
  resourceData: Readonly<Record<string, unknown>>,
) {
  const input = node.contextCommandInputs?.[commandId];
  return createCommandContext("explorer", kernel, {
    ...(input !== undefined ? { input } : {}),
    resourceData,
  });
}

export interface ExplorerContextCommandItem {
  active: boolean;
  activeResource: CommandActiveResource | null;
  command: CommandContribution;
  disabled: boolean;
  disabledReason: string | null;
}

export function contextCommandItemsForNode({
  kernel,
  node,
  resourceData,
}: {
  kernel: KernelApi;
  node: ExplorerNode;
  resourceData: Readonly<Record<string, unknown>>;
}): ExplorerContextCommandItem[] {
  return contextCommandsForNode(kernel, node).map((command) => {
    const context = commandContextForNode(
      kernel,
      node,
      command.id,
      resourceData,
    );
    const active = kernel.commands.isActive(command.id, context);
    return {
      active,
      activeResource: active ? command.activeResource?.(context) ?? null : null,
      command,
      disabled: !kernel.commands.isEnabled(command.id, context),
      disabledReason:
        kernel.commands.get(command.id)?.disabledReason?.(context) ?? null,
    };
  });
}

interface ExplorerTreeRowModel {
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  node: ExplorerNode;
}

interface ExplorerVisibleRowSlice {
  bottomPadding: number;
  rows: ExplorerTreeRowModel[];
  start: number;
  topPadding: number;
}

export function resolveExplorerFocusableRowId({
  activeNodeId,
  keyboardRowId,
  rowIds,
}: {
  activeNodeId: string | null;
  keyboardRowId: string | null;
  rowIds: readonly string[];
}): string | null {
  const visibleIds = new Set(rowIds);
  if (keyboardRowId && visibleIds.has(keyboardRowId)) return keyboardRowId;
  if (activeNodeId && visibleIds.has(activeNodeId)) return activeNodeId;
  return rowIds[0] ?? null;
}

export function resolveExplorerKeyboardTargetRowId({
  currentNodeId,
  key,
  rowIds,
}: {
  currentNodeId: string;
  key: string;
  rowIds: readonly string[];
}): string | null {
  const currentIndex = rowIds.indexOf(currentNodeId);
  if (currentIndex < 0) return null;

  if (key === "ArrowDown") {
    return rowIds[Math.min(rowIds.length - 1, currentIndex + 1)] ?? null;
  }
  if (key === "ArrowUp") {
    return rowIds[Math.max(0, currentIndex - 1)] ?? null;
  }
  if (key === "Home") return rowIds[0] ?? null;
  if (key === "End") return rowIds.at(-1) ?? null;
  return null;
}

export function sliceVisibleExplorerRows({
  overscan,
  rowHeight,
  rows,
  scrollTop,
  viewportHeight,
}: {
  overscan: number;
  rowHeight: number;
  rows: readonly ExplorerTreeRowModel[];
  scrollTop: number;
  viewportHeight: number;
}): ExplorerVisibleRowSlice {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const end = Math.min(rows.length, start + visibleCount);

  return {
    bottomPadding: Math.max(0, (rows.length - end) * rowHeight),
    rows: rows.slice(start, end),
    start,
    topPadding: start * rowHeight,
  };
}

export function flattenVisibleExplorerRows(
  nodes: readonly ExplorerNode[],
  expandedIds: ReadonlySet<string>,
  depth = 0,
): ExplorerTreeRowModel[] {
  const rows: ExplorerTreeRowModel[] = [];

  for (const node of nodes) {
    const hasChildren = Boolean(node.children?.length);
    const expanded = hasChildren && expandedIds.has(node.id);
    rows.push({ depth, expanded, hasChildren, node });
    if (expanded && node.children) {
      rows.push(
        ...flattenVisibleExplorerRows(node.children, expandedIds, depth + 1),
      );
    }
  }

  return rows;
}

const ExplorerTreeRow = memo(function ExplorerTreeRow({
  active,
  depth,
  expanded,
  focusable,
  hasChildren,
  kernel,
  moduleId,
  node,
  resourceData,
  rowIds,
  tabId,
}: {
  active: boolean;
  depth: number;
  expanded: boolean;
  focusable: boolean;
  hasChildren: boolean;
  kernel: KernelApi;
  moduleId: ModuleId;
  node: ExplorerNode;
  resourceData: Readonly<Record<string, unknown>>;
  rowIds: readonly string[];
  tabId: ExplorerTabId;
}) {
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(null);
  const commandDetail = useCommandDetailResource(selectedCommandId);
  const commandItems = contextCommandItemsForNode({
    kernel,
    node,
    resourceData,
  });
  const activeCommandItems = commandItems.reduce<typeof commandItems>((items, item) => {
    if (item.activeResource?.kind === "command") items.push(item);
    return items;
  }, []);
  const selectable = node.selectable !== false;

  function handleSelect(): void {
    selectExplorerNode(kernel, node, moduleId);
    setExplorerKeyboardRow(node.id);
  }

  function handleToggle(): void {
    if (hasChildren) {
      toggleExplorerNode(tabId, node.id);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const navigationTarget = resolveExplorerKeyboardTargetRowId({
      currentNodeId: node.id,
      key: event.key,
      rowIds,
    });

    if (navigationTarget) {
      event.preventDefault();
      setExplorerKeyboardRow(navigationTarget);
      const tree = event.currentTarget.closest('[role="tree"]');
      const targetRow = Array.from(
        tree?.querySelectorAll<HTMLElement>("[data-node-id]") ?? [],
      ).find((row) => row.dataset.nodeId === navigationTarget);
      targetRow?.focus();
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (selectable) handleSelect();
      return;
    }
    if (event.key === "ArrowRight" && hasChildren && !expanded) {
      event.preventDefault();
      toggleExplorerNode(tabId, node.id);
      return;
    }
    if (event.key === "ArrowLeft" && hasChildren && expanded) {
      event.preventDefault();
      toggleExplorerNode(tabId, node.id);
    }
  }

  const tooltipParts: string[] = [node.label];
  if (node.status && node.status !== "ready") tooltipParts.push(`[${node.status}]`);
  if (node.badge) tooltipParts.push(`— ${node.badge}`);

  const row = (
    <div
      className={cn(
        "fm-explorer-tree-row",
        node.activeAnalysisField && "fm-explorer-tree-row--active-analysis-field",
        explorerStatusClassName(node.status),
      )}
      data-active={active}
      data-active-analysis-field={node.activeAnalysisField ? "true" : undefined}
      data-node-id={node.id}
      data-status={statusLabel(node.status)}
      role="treeitem"
      tabIndex={focusable ? 0 : -1}
      title={tooltipParts.length > 1 ? tooltipParts.join(" ") : undefined}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={selectable ? active : undefined}
      onClick={selectable ? handleSelect : undefined}
      onDoubleClick={handleToggle}
      onFocus={() => setExplorerKeyboardRow(node.id)}
      onKeyDown={handleKeyDown}
      style={{ "--fm-tree-depth": depth } as CSSProperties}
    >
      {depth > 0
        ? Array.from({ length: depth }, (_, i) => (
            <span
              key={i}
              aria-hidden="true"
              className="fm-explorer-tree-guide"
              style={{ left: `calc(var(--fm-space-1) + ${i} * var(--fm-tree-indent) + var(--fm-tree-guide-offset))` } as CSSProperties}
            />
          ))
        : null}
      <span className="fm-explorer-tree-row__branch" aria-hidden="true">
        {hasChildren ? (
          <ChevronRight
            size={13}
            data-expanded={expanded}
            onClick={(event) => {
              event.stopPropagation();
              handleToggle();
            }}
          />
        ) : null}
      </span>
      <span
        className="fm-explorer-tree-row__icon"
        aria-hidden="true"
        data-icon={node.icon ?? "file"}
      >
        {node.icon ? ICONS[node.icon] : ICONS.file}
      </span>
      <span className="fm-explorer-tree-row__label">{node.label}</span>
      {node.status && node.status !== "ready" ? (
        <span className="fm-explorer-tree-row__status">{node.status}</span>
      ) : null}
      {node.activeAnalysisField ? (
        <span className="fm-explorer-tree-row__active-field">active</span>
      ) : null}
    </div>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>{node.label}</ContextMenuLabel>
        <ContextMenuSeparator />
        {selectable ? <ContextMenuItem onSelect={handleSelect}>Select</ContextMenuItem> : null}
        {commandItems.map(({ active, command, disabled, disabledReason }) => (
          <ContextMenuItem
            key={command.id}
            data-active={active}
            disabled={disabled}
            title={disabledReason ?? (active ? "Command active" : undefined)}
            onSelect={() => {
              void kernel.commands.execute(
                command.id,
                commandContextForNode(kernel, node, command.id, resourceData),
              );
            }}
          >
            <span>{command.title}</span>
            {active ? (
              <span className="fm-context-menu-item__meta">active</span>
            ) : null}
          </ContextMenuItem>
        ))}
        {activeCommandItems.length > 0 ? (
          <>
            <ContextMenuSeparator />
            {activeCommandItems.map((item) => (
                <ContextMenuItem
                  key={`${item.command.id}:detail`}
                  onSelect={() => {
                    const commandId = item.activeResource?.commandId;
                    if (commandId) setSelectedCommandId(commandId);
                  }}
                >
                  <span>{item.command.title} detail</span>
                </ContextMenuItem>
              ))}
          </>
        ) : null}
      </ContextMenuContent>
      <CommandDetailDialog
        commandId={selectedCommandId}
        detail={commandDetail}
        onOpenChange={(open) => {
          if (!open) setSelectedCommandId(null);
        }}
      />
    </ContextMenu>
  );
});

interface ExplorerTreeViewProps {
  activeNodeId: string | null;
  expandedIds: ReadonlySet<string>;
  keyboardRowId: string | null;
  kernel: KernelApi;
  moduleId: ModuleId;
  nodes: readonly ExplorerNode[];
  tabId: ExplorerTabId;
}

export function ExplorerTreeView({
  activeNodeId,
  expandedIds,
  keyboardRowId,
  kernel,
  moduleId,
  nodes,
  tabId,
}: ExplorerTreeViewProps) {
  const treeRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ height: 420, scrollTop: 0 });
  const runtimeResourceData = useRuntimeCommandControlResourceData({
    includeSharedDomainReadiness: false,
    includeStageExecution: false,
  });
  const rows = useMemo(
    () => flattenVisibleExplorerRows(nodes, expandedIds),
    [expandedIds, nodes],
  );
  const virtualized = rows.length > EXPLORER_VIRTUALIZATION_THRESHOLD;
  const visibleRows = useMemo(
    () =>
      virtualized
        ? sliceVisibleExplorerRows({
            overscan: EXPLORER_ROW_OVERSCAN,
            rowHeight: EXPLORER_ROW_HEIGHT,
            rows,
            scrollTop: viewport.scrollTop,
            viewportHeight: viewport.height,
          })
        : {
            bottomPadding: 0,
            rows,
            start: 0,
            topPadding: 0,
          },
    [rows, viewport.height, viewport.scrollTop, virtualized],
  );
  const visibleRowIds = useMemo(
    () => visibleRows.rows.map((row) => row.node.id),
    [visibleRows.rows],
  );
  const focusableRowId = useMemo(
    () =>
      resolveExplorerFocusableRowId({
        activeNodeId,
        keyboardRowId,
        rowIds: visibleRowIds,
      }),
    [activeNodeId, keyboardRowId, visibleRowIds],
  );

  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;

    const updateHeight = () => {
      setViewport((current) => ({
        ...current,
        height: tree.clientHeight || current.height,
      }));
    };
    updateHeight();

    const observer = new ResizeObserver(updateHeight);
    observer.observe(tree);
    return () => observer.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    const tree = treeRef.current;
    if (!tree) return;
    setViewport((current) =>
      current.scrollTop === tree.scrollTop
        ? current
        : { ...current, scrollTop: tree.scrollTop },
    );
  }, []);

  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const nextScrollTop = resolveExplorerRevealScrollTop({
      activeNodeId,
      rowHeight: EXPLORER_ROW_HEIGHT,
      rowIds: rows.map((row) => row.node.id),
      scrollTop: tree.scrollTop,
      viewportHeight: tree.clientHeight || viewport.height,
    });
    if (nextScrollTop === null) return;
    tree.scrollTop = nextScrollTop;
    setViewport((current) =>
      current.scrollTop === nextScrollTop
        ? current
        : { ...current, scrollTop: nextScrollTop },
    );
  }, [activeNodeId, rows, viewport.height]);

  return (
    <div
      ref={treeRef}
      className="fm-explorer-tree"
      role="tree"
      aria-label="Explorer tree"
      onScroll={handleScroll}
    >
      {visibleRows.topPadding > 0 ? (
        <div
          aria-hidden="true"
          style={{ height: visibleRows.topPadding }}
        />
      ) : null}
      {visibleRows.rows.map(({ depth, expanded, hasChildren, node }) => (
        <ExplorerTreeRow
          key={node.id}
          active={activeNodeId === node.id}
          depth={depth}
          expanded={expanded}
          focusable={focusableRowId === node.id}
          hasChildren={hasChildren}
          kernel={kernel}
          moduleId={moduleId}
          node={node}
          resourceData={runtimeResourceData}
          rowIds={visibleRowIds}
          tabId={tabId}
        />
      ))}
      {visibleRows.bottomPadding > 0 ? (
        <div
          aria-hidden="true"
          style={{ height: visibleRows.bottomPadding }}
        />
      ) : null}
    </div>
  );
}
