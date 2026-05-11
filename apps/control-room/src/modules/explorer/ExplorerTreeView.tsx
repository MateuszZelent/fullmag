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
  Layers,
  Magnet,
  Play,
  Settings,
  Shield,
  Sparkles,
  Triangle,
  Waves,
} from "lucide-react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import type { CommandContribution } from "@/kernel/commands/commandTypes";
import type { KernelApi, ModuleId } from "@/kernel/types";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/shared/ui/ContextMenu";

import { selectExplorerNode } from "./explorerSelection";
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

function statusLabel(status: ExplorerNodeStatus | undefined): string {
  if (!status) return "ready";
  return status;
}

function contextCommandsForNode(
  kernel: KernelApi,
  node: ExplorerNode,
): CommandContribution[] {
  return (node.contextCommands ?? [])
    .map((commandId) => kernel.commands.get(commandId))
    .filter((command): command is CommandContribution => Boolean(command));
}

function ExplorerTreeRow({
  activeNodeId,
  depth,
  expandedIds,
  kernel,
  moduleId,
  node,
  tabId,
}: {
  activeNodeId: string | null;
  depth: number;
  expandedIds: ReadonlySet<string>;
  kernel: KernelApi;
  moduleId: ModuleId;
  node: ExplorerNode;
  tabId: ExplorerTabId;
}) {
  const hasChildren = Boolean(node.children?.length);
  const expanded = expandedIds.has(node.id);
  const active = activeNodeId === node.id;
  const commands = contextCommandsForNode(kernel, node);

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
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleSelect();
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

  const row = (
    <div
      className="fm-explorer-tree-row"
      data-active={active}
      data-node-id={node.id}
      data-status={statusLabel(node.status)}
      role="treeitem"
      tabIndex={0}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={active}
      onClick={handleSelect}
      onDoubleClick={handleToggle}
      onKeyDown={handleKeyDown}
      style={{ "--fm-tree-depth": depth } as CSSProperties}
    >
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
      <span className="fm-explorer-tree-row__icon" aria-hidden="true">
        {node.icon ? ICONS[node.icon] : ICONS.file}
      </span>
      <span className="fm-explorer-tree-row__label">{node.label}</span>
      {node.status && node.status !== "ready" ? (
        <span className="fm-explorer-tree-row__status">{node.status}</span>
      ) : null}
      {node.badge ? (
        <span className="fm-explorer-tree-row__badge">{node.badge}</span>
      ) : null}
    </div>
  );

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>{node.label}</ContextMenuLabel>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={handleSelect}>Select</ContextMenuItem>
          {commands.map((command) => (
            <ContextMenuItem
              key={command.id}
              onSelect={() => {
                void kernel.commands.execute(
                  command.id,
                  createCommandContext("menu", kernel),
                );
              }}
            >
              {command.title}
            </ContextMenuItem>
          ))}
        </ContextMenuContent>
      </ContextMenu>
      {hasChildren && expanded ? (
        <div role="group">
          {node.children?.map((child) => (
            <ExplorerTreeRow
              key={child.id}
              activeNodeId={activeNodeId}
              depth={depth + 1}
              expandedIds={expandedIds}
              kernel={kernel}
              moduleId={moduleId}
              node={child}
              tabId={tabId}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

interface ExplorerTreeViewProps {
  activeNodeId: string | null;
  expandedIds: ReadonlySet<string>;
  kernel: KernelApi;
  moduleId: ModuleId;
  nodes: readonly ExplorerNode[];
  tabId: ExplorerTabId;
}

export function ExplorerTreeView({
  activeNodeId,
  expandedIds,
  kernel,
  moduleId,
  nodes,
  tabId,
}: ExplorerTreeViewProps) {
  return (
    <div className="fm-explorer-tree" role="tree" aria-label="Explorer tree">
      {nodes.map((node) => (
        <ExplorerTreeRow
          key={node.id}
          activeNodeId={activeNodeId}
          depth={0}
          expandedIds={expandedIds}
          kernel={kernel}
          moduleId={moduleId}
          node={node}
          tabId={tabId}
        />
      ))}
    </div>
  );
}
