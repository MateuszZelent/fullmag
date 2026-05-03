"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { CheckCircle2, Circle, LoaderCircle, MinusCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  BackendCapabilities,
  MeshWorkspaceManifestRegionState,
  ModelBuilderGraphV2,
  SceneDocument,
  ScriptBuilderCurrentModuleEntry,
  ScriptBuilderExcitationAnalysisEntry,
  ScriptBuilderGeometryEntry,
  ScriptBuilderMagneticInteractionEntry,
  ScriptBuilderMagnetizationEntry,
  ScriptBuilderStageState,
  VisualizationPreset,
  VisualizationPresetRef,
  StudyPipelineNodeState,
} from "@/lib/session/types";
import { buildScriptBuilderFromSceneDocument } from "@/lib/session/sceneDocument";
import {
  ensureObjectPhysicsStack,
  magneticInteractionLabel,
} from "@/lib/session/magneticPhysics";
import { buildDefaultScriptBuilderMagnetization } from "@/lib/session/magnetizationCanonical";
import {
  buildPhysicsCapabilityView,
  type PhysicsCapabilityViewEntry,
} from "@/lib/session/physicsCatalog";
import {
  buildFlatStudyStageNodeId,
  buildPipelineStudyStageNodeId,
} from "@/lib/study-builder/node-context";
import { parseVisualizationPresetNodeId } from "../runs/control-room/visualizationPresets";
import TreeNodeIcon from "@/features/iconography/TreeNodeIcon";
import { buildGeometryBuilderTreeNodes } from "@/features/geometry-builder/tree/builderTreeNodes";
import type { DirtyState, GeometryGraphDocument, BuilderSelectionTarget } from "@/features/geometry-builder/model/types";
import type { PrimitiveNode } from "@/features/geometry-builder/model/types";

/* ── Types ─────────────────────────────────────────────────────────── */

export type NodeStatus =
  | "ready"
  | "active"
  | "pending"
  | "dirty"
  | "stale"
  | "blocked"
  | "warning"
  | "error"
  | "completed"
  | "running"
  | "failed"
  | "skipped";

export type NodeDomain = "build" | "study" | "analyze" | "results";

export interface TreeNodeData {
  id: string;
  label: string;
  icon?: string;
  badge?: string;
  status?: NodeStatus;
  defaultOpen?: boolean;
  domain?: NodeDomain;
  children?: TreeNodeData[];
  onClick?: () => void;
}

function humanizeStageKind(kind: string | null | undefined): string {
  if (!kind) return "Stage";
  return kind
    .replaceAll("_", " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function studyStageDisplayName(kind: string | null | undefined): string {
  if (!kind) return "Stage";
  if (kind === "eigenmodes") return "Eigensolve";
  if (kind === "hysteresis_loop") return "Hysteresis Loop";
  if (kind === "field_sweep_relax") return "Field Sweep + Relax";
  if (kind === "field_sweep_relax_snapshot") return "Field Sweep + Snapshot";
  if (kind === "parameter_sweep") return "Parameter Sweep";
  return humanizeStageKind(kind);
}

function humanizeStudyPipelineNodeStateKind(node: StudyPipelineNodeState): string {
  if (node.node_kind === "primitive") {
    return studyStageDisplayName(node.stage_kind);
  }
  if (node.node_kind === "macro") {
    if (node.macro_kind === "hysteresis_loop") return "Hysteresis Loop";
    if (node.macro_kind === "field_sweep_relax") return "Field Sweep + Relax";
    if (node.macro_kind === "field_sweep_relax_snapshot") return "Field Sweep + Relax + Snapshot";
    if (node.macro_kind === "relax_run") return "Relax -> Run";
    if (node.macro_kind === "relax_eigenmodes") return "Relax -> Eigensolve";
    if (node.macro_kind === "parameter_sweep") return "Parameter Sweep";
    return humanizeStageKind(node.macro_kind);
  }
  return "Stage Group";
}

function summarizeStudyPipelineNodeState(node: StudyPipelineNodeState): string {
  if (node.node_kind === "primitive") {
    const originalKind =
      typeof node.payload.kind === "string" && node.payload.kind.length > 0
        ? node.payload.kind
        : node.stage_kind;
    return originalKind !== node.stage_kind
      ? `${studyStageDisplayName(node.stage_kind)} <- ${studyStageDisplayName(originalKind)}`
      : studyStageDisplayName(node.stage_kind);
  }
  if (node.node_kind === "macro") {
    if (node.macro_kind === "hysteresis_loop") {
      const start = Number(node.config.start_mT ?? -100);
      const stop = Number(node.config.stop_mT ?? 100);
      const steps = Math.max(2, Number(node.config.steps ?? 21));
      return `hysteresis ${start} -> ${stop} mT (${steps} points)`;
    }
    if (node.macro_kind === "field_sweep_relax") {
      const start = Number(node.config.start_mT ?? -100);
      const stop = Number(node.config.stop_mT ?? 100);
      const steps = Math.max(1, Number(node.config.steps ?? 11));
      return `field sweep ${start} -> ${stop} mT (${steps} steps)`;
    }
    if (node.macro_kind === "field_sweep_relax_snapshot") {
      const start = Number(node.config.start_mT ?? -100);
      const stop = Number(node.config.stop_mT ?? 100);
      const steps = Math.max(1, Number(node.config.steps ?? 11));
      return `field sweep ${start} -> ${stop} mT (${steps} steps) + snapshots`;
    }
    if (node.macro_kind === "parameter_sweep") {
      const parameter = String(node.config.parameter ?? "b_ext");
      const steps = Math.max(1, Number(node.config.steps ?? 11));
      return `parameter sweep ${parameter} (${steps} points)`;
    }
    if (node.macro_kind === "relax_run") return "relax then run";
    if (node.macro_kind === "relax_eigenmodes") return "relax then eigensolve";
    return humanizeStageKind(node.macro_kind);
  }
  return `${node.children.length} nodes`;
}

function summarizeStage(stage: ScriptBuilderStageState): string {
  if (stage.kind === "relax" || stage.kind.includes("relax")) {
    return [
      stage.relax_algorithm ? humanizeStageKind(stage.relax_algorithm) : null,
      stage.max_steps ? `${stage.max_steps} steps` : null,
      stage.torque_tolerance ? `tol ${stage.torque_tolerance}` : null,
    ].filter(Boolean).join(" · ");
  }
  if (stage.kind === "run" || stage.kind.includes("run")) {
    return stage.until_seconds ? `until ${stage.until_seconds} s` : "time evolution";
  }
  if (stage.kind === "eigenmodes" || stage.kind.includes("eigen")) {
    return [
      stage.eigen_count ? `${stage.eigen_count} modes` : null,
      stage.eigen_target ? humanizeStageKind(stage.eigen_target) : null,
    ].filter(Boolean).join(" · ");
  }
  return stage.entrypoint_kind ? humanizeStageKind(stage.entrypoint_kind) : "configured";
}

function buildStageDetailChildren(
  baseId: string,
  detailIds: Array<{ id: string; label: string; icon: string }>,
  status: NodeStatus = "ready",
): TreeNodeData[] {
  return detailIds.map((detail) => ({
    id: `${baseId}/${detail.id}`,
    label: detail.label,
    icon: detail.icon,
    status,
  }));
}

function resolveStageStatus(
  stageIndexes: number[],
  enabled: boolean,
  stageStatuses: readonly string[],
): NodeStatus {
  if (!enabled) {
    return "pending";
  }
  if (stageIndexes.length === 0) {
    return "pending";
  }
  const statuses = stageIndexes.map((stageIndex) => stageStatuses[stageIndex] ?? "pending");
  if (statuses.some((status) => status === "failed" || status === "error")) {
    return "failed";
  }
  if (statuses.some((status) => status === "running" || status === "paused")) {
    return "running";
  }
  if (statuses.every((status) => status === "skipped")) {
    return "skipped";
  }
  if (statuses.every((status) => status === "completed" || status === "done")) {
    return "completed";
  }
  if (statuses.some((status) => status === "completed" || status === "done" || status === "skipped")) {
    return "running";
  }
  return "pending";
}

function buildStudyPipelineTreeNodes(
  nodes: StudyPipelineNodeState[],
  stageIndexesByNodeId: ReadonlyMap<string, number[]>,
  stageStatuses: readonly string[],
): TreeNodeData[] {
  return nodes.map((node, index) => {
    const stageIndexes = stageIndexesByNodeId.get(node.id) ?? [];
    const nodeStatus = resolveStageStatus(stageIndexes, node.enabled, stageStatuses);
    if (node.node_kind === "group") {
      const baseId = buildPipelineStudyStageNodeId(node.id);
      return {
        id: baseId,
        label: node.label || `Group ${index + 1}`,
        icon: "🧩",
        badge: `${node.children.length} nodes`,
        status: nodeStatus,
        defaultOpen: !node.collapsed,
        children: buildStudyPipelineTreeNodes(
          node.children,
          stageIndexesByNodeId,
          stageStatuses,
        ),
      };
    }
    if (node.node_kind === "macro") {
      const baseId = buildPipelineStudyStageNodeId(node.id);
      const macroChildren =
        node.macro_kind === "hysteresis_loop"
        || node.macro_kind === "field_sweep_relax"
        || node.macro_kind === "field_sweep_relax_snapshot"
        || node.macro_kind === "parameter_sweep"
          ? buildStageDetailChildren(baseId, [
              { id: "overview", label: "Overview", icon: "🧾" },
              { id: "sweep", label: "Sweep Definition", icon: "↕" },
              { id: "settle", label: "Settle Stage", icon: "🧲" },
              { id: "outputs", label: "Outputs", icon: "💾" },
              { id: "materialized", label: "Materialized Preview", icon: "🧱" },
            ], nodeStatus)
          : buildStageDetailChildren(baseId, [
              { id: "overview", label: "Overview", icon: "🧾" },
              { id: "materialized", label: "Materialized Preview", icon: "🧱" },
            ], nodeStatus);
      return {
        id: baseId,
        label: `Stage ${index + 1} · ${node.label || humanizeStudyPipelineNodeStateKind(node)}`,
        icon: "⚗",
        badge: summarizeStudyPipelineNodeState(node),
        status: nodeStatus,
        children: macroChildren,
      };
    }
    const importedKind =
      typeof node.payload.kind === "string" && node.payload.kind.length > 0
        ? node.payload.kind
        : node.stage_kind;
    const baseId = buildPipelineStudyStageNodeId(node.id);
    const detailChildren =
      node.stage_kind === "run"
        ? buildStageDetailChildren(baseId, [
            { id: "overview", label: "Overview", icon: "🧾" },
            { id: "solver", label: "Solver", icon: "⚙" },
            { id: "time-range", label: "Time Range", icon: "⏱" },
            { id: "outputs", label: "Outputs", icon: "💾" },
          ], nodeStatus)
        : node.stage_kind === "relax"
          ? buildStageDetailChildren(baseId, [
              { id: "overview", label: "Overview", icon: "🧾" },
              { id: "solver", label: "Solver", icon: "⚙" },
              { id: "stop-criteria", label: "Stop Criteria", icon: "🎯" },
              { id: "outputs", label: "Outputs", icon: "💾" },
            ], nodeStatus)
          : node.stage_kind === "eigenmodes"
            ? buildStageDetailChildren(baseId, [
                { id: "overview", label: "Overview", icon: "🧾" },
                { id: "solver", label: "Solver", icon: "⚙" },
                { id: "equilibrium", label: "Equilibrium", icon: "🧲" },
                { id: "operator", label: "Operator & Spectrum", icon: "〰" },
                { id: "outputs", label: "Outputs", icon: "💾" },
              ], nodeStatus)
            : buildStageDetailChildren(baseId, [
                { id: "overview", label: "Overview", icon: "🧾" },
              ], nodeStatus);
    return {
      id: baseId,
      label: `Stage ${index + 1} · ${node.label || studyStageDisplayName(node.stage_kind)}`,
      icon: "◌",
      badge:
        importedKind !== node.stage_kind
          ? `${studyStageDisplayName(node.stage_kind)} <- ${studyStageDisplayName(importedKind)}`
          : summarizeStudyPipelineNodeState(node),
      status: nodeStatus,
      children: detailChildren,
    };
  });
}

function buildFlatStudyStageTreeNodes(
  stages: ScriptBuilderStageState[],
  stageStatuses: readonly string[],
): TreeNodeData[] {
  return stages.map((stage, index) => {
    const baseId = buildFlatStudyStageNodeId(index);
    const stageStatus = resolveStageStatus([index], true, stageStatuses);
    const detailChildren =
      stage.kind === "run"
        ? buildStageDetailChildren(baseId, [
            { id: "overview", label: "Overview", icon: "🧾" },
            { id: "solver", label: "Solver", icon: "⚙" },
            { id: "time-range", label: "Time Range", icon: "⏱" },
            { id: "outputs", label: "Outputs", icon: "💾" },
          ], stageStatus)
        : stage.kind === "relax"
          ? buildStageDetailChildren(baseId, [
              { id: "overview", label: "Overview", icon: "🧾" },
              { id: "solver", label: "Solver", icon: "⚙" },
              { id: "stop-criteria", label: "Stop Criteria", icon: "🎯" },
              { id: "outputs", label: "Outputs", icon: "💾" },
            ], stageStatus)
          : stage.kind === "eigenmodes"
            ? buildStageDetailChildren(baseId, [
                { id: "overview", label: "Overview", icon: "🧾" },
                { id: "solver", label: "Solver", icon: "⚙" },
                { id: "equilibrium", label: "Equilibrium", icon: "🧲" },
                { id: "operator", label: "Operator & Spectrum", icon: "〰" },
                { id: "outputs", label: "Outputs", icon: "💾" },
              ], stageStatus)
            : buildStageDetailChildren(baseId, [
                { id: "overview", label: "Overview", icon: "🧾" },
              ], stageStatus);
    return {
      id: baseId,
      label: `Stage ${index + 1} · ${studyStageDisplayName(stage.kind)}`,
      icon: "▶",
      badge: summarizeStage(stage) || studyStageDisplayName(stage.entrypoint_kind),
      status: stageStatus,
      children: detailChildren,
    };
  });
}

function hasNonZeroField(field: readonly number[] | null | undefined): boolean {
  return Boolean(field && field.some((component) => Math.abs(Number(component) || 0) > 0));
}

function normalizePhysicsStack(
  stack: readonly ScriptBuilderMagneticInteractionEntry[],
): ScriptBuilderMagneticInteractionEntry[] {
  const byKind = new Map<string, ScriptBuilderMagneticInteractionEntry>();
  for (const entry of stack) {
    const current = byKind.get(entry.kind);
    if (!current) {
      byKind.set(entry.kind, entry);
      continue;
    }
    byKind.set(entry.kind, {
      ...current,
      enabled: current.enabled || entry.enabled,
      params: current.params ?? entry.params,
    });
  }
  return Array.from(byKind.values());
}

function enrichPhysicsCapabilityEntries(
  entries: PhysicsCapabilityViewEntry[],
  opts: {
    zeemanField?: readonly number[] | null;
    exchangeEnabled?: boolean;
    demagEnabled?: boolean;
    interfacialDmiFromMaterial?: boolean;
    metadata?: Record<string, unknown> | null;
  },
): PhysicsCapabilityViewEntry[] {
  return entries.map((entry) => {
    let active = entry.active;
    let available = entry.available;
    if (entry.id === "zeeman") {
      active = hasNonZeroField(opts.zeemanField);
      if (active) {
        available = true;
      }
    } else if (entry.id === "exchange") {
      active = opts.exchangeEnabled ?? entry.active;
      if (opts.exchangeEnabled === true) {
        available = true;
      }
    } else if (entry.id === "demag") {
      active = opts.demagEnabled ?? entry.active;
      if (opts.demagEnabled === true) {
        available = true;
      }
    } else if (entry.id === "interfacial_dmi") {
      active = entry.active || opts.interfacialDmiFromMaterial === true;
    } else if (entry.id === "thermal_noise") {
      active = opts.metadata?.thermal_active === true;
    } else if (entry.id === "spin_transfer_torque") {
      active = opts.metadata?.stt_active === true;
    } else if (entry.id === "spin_orbit_torque") {
      active = opts.metadata?.sot_active === true;
    } else if (entry.id === "oersted") {
      active = opts.metadata?.oersted_active === true;
    }
    return { ...entry, active, available };
  });
}

function physicsModuleNodeStatus(entry: PhysicsCapabilityViewEntry): NodeStatus {
  if (entry.active && !entry.available) return "error";
  if (entry.active) return "ready";
  if (entry.available) return "pending";
  return "pending";
}

function physicsModuleNodeBadge(entry: PhysicsCapabilityViewEntry): string {
  if (entry.active && !entry.available) return "active · unsupported";
  if (entry.active) return "active";
  if (entry.available) return "available";
  return "unavailable";
}

interface ModelTreeProps {
  nodes: TreeNodeData[];
  activeId?: string | null;
  onNodeClick?: (id: string) => void;
  onContextAction?: (nodeId: string, action: string) => void;
  className?: string;
  compact?: boolean;
}

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

          {/* Status icon */}
          {node.status && (
            <span className="ml-1 shrink-0 opacity-90">
              <StatusIcon status={node.status} />
            </span>
          )}

          {/* Badge */}
          {showBadge ? (
            <span className={cn(
              "ml-1 shrink-0 rounded px-1.5 py-[1px] text-[0.55rem] font-medium font-mono opacity-80",
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

/* ── ModelTree ──────────────────────────────────────────────────────── */

export default function ModelTree({
  nodes,
  activeId,
  onNodeClick,
  onContextAction,
  className,
  compact = false,
}: ModelTreeProps) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; nodeId: string; label: string } | null>(null);
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
  const contextVisualizationPreset = useMemo(
    () => parseVisualizationPresetNodeId(ctxMenu?.nodeId),
    [ctxMenu?.nodeId],
  );
  const contextResultAnalysis = useMemo(
    () => Boolean(ctxMenu?.nodeId?.startsWith("res-analysis-")),
    [ctxMenu?.nodeId],
  );

  const contextStage = useMemo(
    () => Boolean(ctxMenu?.nodeId?.startsWith("study-stage-node:")),
    [ctxMenu?.nodeId],
  );

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

      {/* Context menu overlay */}
      {ctxMenu && (
        <div
          ref={menuRef}
          className="fixed z-[200] min-w-[160px] p-1 rounded-md bg-popover border border-border shadow-md animate-in fade-in zoom-in-95 duration-100"
        >
          <div className="px-2 py-1 text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground border-b border-border/10 mb-1">
            {ctxMenu.label}
          </div>
          <button className="w-full text-left px-2 py-1.5 text-xs font-medium rounded-sm hover:bg-muted text-popover-foreground transition-colors" onClick={() => handleAction("select")}>Select</button>
          {contextVisualizationPreset ? (
            <>
              <button className="w-full text-left px-2 py-1.5 text-xs font-medium rounded-sm hover:bg-muted text-popover-foreground transition-colors" onClick={() => handleAction("apply")}>Apply</button>
              <button className="w-full text-left px-2 py-1.5 text-xs font-medium rounded-sm hover:bg-muted text-popover-foreground transition-colors" onClick={() => handleAction("rename")}>Rename</button>
              <button className="w-full text-left px-2 py-1.5 text-xs font-medium rounded-sm hover:bg-muted text-popover-foreground transition-colors" onClick={() => handleAction("duplicate")}>Duplicate</button>
              <button className="w-full text-left px-2 py-1.5 text-xs font-medium rounded-sm hover:bg-muted text-popover-foreground transition-colors" onClick={() => handleAction(contextVisualizationPreset.source === "project" ? "save-local" : "save-project")}>
                {contextVisualizationPreset.source === "project" ? "Save To Local" : "Save To Project"}
              </button>
              <button className="w-full text-left px-2 py-1.5 text-xs font-medium rounded-sm hover:bg-muted text-popover-foreground transition-colors" onClick={() => handleAction("delete")}>Delete</button>
            </>
          ) : contextResultAnalysis ? (
            <>
              <button className="w-full text-left px-2 py-1.5 text-xs font-medium rounded-sm hover:bg-muted text-popover-foreground transition-colors" onClick={() => handleAction("rename")}>Rename</button>
              <button className="w-full text-left px-2 py-1.5 text-xs font-medium rounded-sm hover:bg-muted text-popover-foreground transition-colors" onClick={() => handleAction("duplicate")}>Duplicate</button>
              <button className="w-full text-left px-2 py-1.5 text-xs font-medium rounded-sm hover:bg-muted text-popover-foreground transition-colors" onClick={() => handleAction("toggle-pin")}>Pin / Unpin</button>
              <button className="w-full text-left px-2 py-1.5 text-xs font-medium rounded-sm hover:bg-muted text-popover-foreground transition-colors" onClick={() => handleAction("delete")}>Delete</button>
            </>
          ) : contextStage ? (
            <>
              <button className="w-full text-left px-2 py-1.5 text-xs font-medium rounded-sm hover:bg-muted text-popover-foreground transition-colors" onClick={() => handleAction("toggle-stage")}>Enable / Disable</button>
              <button className="w-full text-left px-2 py-1.5 text-xs font-medium rounded-sm hover:bg-muted text-popover-foreground transition-colors" onClick={() => handleAction("delete-stage")}>Delete Stage</button>
            </>
          ) : (
            <button className="w-full text-left px-2 py-1.5 text-xs font-medium rounded-sm hover:bg-muted text-popover-foreground transition-colors" onClick={() => handleAction("focus")}>Focus in 3D</button>
          )}
          <button className="w-full text-left px-2 py-1.5 text-xs font-medium rounded-sm hover:bg-muted text-popover-foreground transition-colors" onClick={() => handleAction("copy-name")}>Copy Name</button>
          <div className="h-px bg-border/50 my-1 mx-1" />
          <button className="w-full text-left px-2 py-1.5 text-xs font-medium rounded-sm hover:bg-muted text-popover-foreground transition-colors" onClick={() => handleAction("expand-all")}>Expand All</button>
          <button className="w-full text-left px-2 py-1.5 text-xs font-medium rounded-sm hover:bg-muted text-popover-foreground transition-colors" onClick={() => handleAction("collapse-all")}>Collapse All</button>
        </div>
      )}
    </div>
  );
}

export function buildFullmagModelTree(opts: {
  graph?: ModelBuilderGraphV2 | null;
  sceneDocument?: SceneDocument | null;
  studyLabel?: string | null;
  backend?: string;
  showUniverse?: boolean;
  universeMode?: string | null;
  universeDeclaredSize?: [number, number, number] | null;
  universeEffectiveSize?: [number, number, number] | null;
  universeCenter?: [number, number, number] | null;
  universePadding?: [number, number, number] | null;
  universeRole?: string | null;
  domainMeshMode?: string | null;
  airPartElementCount?: number | null;
  airPartNodeCount?: number | null;
  geometryKind?: string;
  materialName?: string;
  materialMsat?: number | null;
  materialAex?: number | null;
  materialAlpha?: number | null;
  meshStatus?: NodeStatus;
  meshElements?: number;
  meshNodes?: number;
  meshFeOrder?: number | null;
  meshName?: string | null;
  solverStatus?: NodeStatus;
  solverIntegrator?: string;
  solverRelaxAlgorithm?: string;
  demagRealization?: string | null;
  physicsTerms?: string[];
  capabilities?: BackendCapabilities | null;
  metadata?: Record<string, unknown> | null;
  exchangeEnabled?: boolean;
  demagEnabled?: boolean;
  zeemanField?: number[] | null;
  convergenceStatus?: NodeStatus;
  scalarRowCount?: number;
  onGeometryClick?: () => void;
  onRegionsClick?: () => void;
  onMeshClick?: () => void;
  onMaterialClick?: () => void;
  onPhysicsClick?: () => void;
  onSolverClick?: () => void;
  onResultsClick?: () => void;
  /** When false, the Outputs/Results branch is hidden. */
  showResultsSection?: boolean;
  /** Result quantities available for spatial/field previews. */
  resultsFieldQuantities?: Array<{
    id: string;
    label: string;
    kind: string;
    unit?: string | null;
  }>;
  /** Result quantities available as derived/global scalars. */
  resultsScalarQuantities?: Array<{
    id: string;
    label: string;
    kind: string;
    unit?: string | null;
  }>;
  /** User-created/custom result analyses (added from ribbon and interactions). */
  resultWorkspaceEntries?: Array<{
    id: string;
    label: string;
    icon?: string;
    badge?: string | null;
    status?: NodeStatus;
    group?: "auto" | "pinned";
    createdAtUnixMs?: number;
  }>;
  initialStatePath?: string | null;
  initialStateFormat?: string | null;
  geometries?: ScriptBuilderGeometryEntry[];
  currentModules?: ScriptBuilderCurrentModuleEntry[];
  excitationAnalysis?: ScriptBuilderExcitationAnalysisEntry | null;
  /** Number of eigenmodes computed. When >0 an Eigenmodes branch appears under Outputs. */
  eigenModeCount?: number | null;
  /** Short summary labels for each computed eigenmode (e.g. "0 · 12.3 GHz · ip"). */
  eigenModeSummaries?: { index: number; label: string }[];
  eigenHasDispersion?: boolean;
  /** Whether time-domain vortex data is available (scalarRows with mx/my/mz). */
  hasVortexData?: boolean;
  visualizationProjectPresets?: VisualizationPreset[];
  visualizationLocalPresets?: VisualizationPreset[];
  activeVisualizationPresetRef?: VisualizationPresetRef | null;
  activeStudyStageIndex?: number | null;
  completedStudyStageIndexes?: number[];
  studyStageStatuses?: string[];
  pipelineStageIndexesByNodeId?: Record<string, number[]>;
  geometryAuthoringGraph?: GeometryGraphDocument | null;
  geometryAuthoringDirty?: DirtyState | null;
  meshManifestSceneRevision?: number | null;
  meshManifestRealizationRevision?: number | null;
  meshManifestRegionCount?: number | null;
  meshManifestRegions?: MeshWorkspaceManifestRegionState[];
  onGeometryAuthoringSelect?: (target: BuilderSelectionTarget) => void;
}): TreeNodeData[] {
  const graph = opts.graph ?? null;
  const sceneDocument = opts.sceneDocument ?? null;
  const sceneBuilder = sceneDocument
    ? buildScriptBuilderFromSceneDocument(sceneDocument)
    : null;
  const graphUniverse = graph?.universe.value ?? null;
  const graphObjects =
    graph?.objects.items.map((objectNode) => ({
      id: `obj-${objectNode.id}`,
      objectId: objectNode.id,
      name: objectNode.name,
        label: objectNode.label,
        geometry: objectNode.geometry,
        tree: objectNode.tree,
    })) ??
    [];
  const sceneObjects = sceneDocument?.objects ?? [];
  const sceneTreeObjects =
    sceneObjects.length > 0
      ? sceneObjects.map((object, index) => ({
          id: `obj-${object.name || object.id}`,
          objectId: object.id,
          name: object.name || object.id,
          label: object.name || object.id,
          geometry:
            sceneBuilder?.geometries[index] ?? {
              name: object.name || object.id,
              region_name: object.region_name,
              geometry_kind: object.geometry.geometry_kind,
              geometry_params: object.geometry.geometry_params,
              bounds_min: object.geometry.bounds_min ?? null,
              bounds_max: object.geometry.bounds_max ?? null,
              material: {
                Ms: null,
                Aex: null,
                alpha: 0.01,
                Dind: null,
              },
              physics_stack: ensureObjectPhysicsStack(null),
              magnetization: buildDefaultScriptBuilderMagnetization(),
              mesh: object.mesh_override,
            },
          tree: {
            geometry: `geo-${object.name || object.id}`,
            material: `mat-${object.name || object.id}`,
            region: `reg-${object.name || object.id}`,
            mesh: `geo-${object.name || object.id}-mesh`,
          },
          meshDirty: object.tags?.includes("mesh:dirty") ?? false,
        }))
      : [];
  const geos = sceneTreeObjects.map((objectNode) => objectNode.geometry).length > 0
    ? sceneTreeObjects.map((objectNode) => objectNode.geometry)
    : graphObjects.map((objectNode) => objectNode.geometry).length > 0
      ? graphObjects.map((objectNode) => objectNode.geometry)
    : opts.geometries ?? [];
  const objects = sceneTreeObjects.length > 0
    ? sceneTreeObjects
    : graphObjects.length > 0
      ? graphObjects
    : geos.map((geometry) => ({
        id: `obj-${geometry.name}`,
        objectId: geometry.name,
        name: geometry.name,
        label: geometry.name,
        geometry,
        tree: {
          geometry: `geo-${geometry.name}`,
          material: `mat-${geometry.name}`,
          region: `reg-${geometry.name}`,
          mesh: `geo-${geometry.name}-mesh`,
        },
      }));
  const modules = graph?.current_modules.modules ?? opts.currentModules ?? [];
  const excitationAnalysis =
    graph?.current_modules.excitation_analysis ?? opts.excitationAnalysis ?? null;
  const visualizationProjectPresets = opts.visualizationProjectPresets ?? [];
  const visualizationLocalPresets = opts.visualizationLocalPresets ?? [];
  const activeVisualizationPresetRef = opts.activeVisualizationPresetRef ?? null;
  const studyStages = graph?.study.stages ?? [];
  const studyPipeline = graph?.study.study_pipeline ?? null;
  const activeStudyStageIndex = opts.activeStudyStageIndex ?? null;
  const completedStudyStageIndexes = new Set(opts.completedStudyStageIndexes ?? []);
  const studyStageStatuses =
    opts.studyStageStatuses && opts.studyStageStatuses.length > 0
      ? opts.studyStageStatuses
      : Array.from({ length: studyStages.length }, (_, index) =>
          activeStudyStageIndex === index
            ? "running"
            : completedStudyStageIndexes.has(index)
              ? "completed"
              : "pending",
        );
  const pipelineStageIndexesByNodeId = new Map(
    Object.entries(opts.pipelineStageIndexesByNodeId ?? {}),
  );
  const showResultsSection = opts.showResultsSection ?? true;
  const resultFieldQuantities = opts.resultsFieldQuantities ?? [];
  const resultScalarQuantities = opts.resultsScalarQuantities ?? [];
  const resultWorkspaceEntries = opts.resultWorkspaceEntries ?? [];
  const pinnedResultWorkspaces = resultWorkspaceEntries
    .filter((entry) => entry.group !== "auto")
    .sort((a, b) => (b.createdAtUnixMs ?? 0) - (a.createdAtUnixMs ?? 0));
  const autoResultWorkspaces = resultWorkspaceEntries
    .filter((entry) => entry.group === "auto")
    .sort((a, b) => (a.createdAtUnixMs ?? 0) - (b.createdAtUnixMs ?? 0));
  const showUniverse = Boolean(
    graphUniverse ||
      opts.showUniverse ||
      opts.universeDeclaredSize ||
      opts.universeEffectiveSize,
  );
  const universeMode = opts.universeMode ?? graphUniverse?.mode ?? null;
  const universeDeclaredSize = opts.universeDeclaredSize ?? graphUniverse?.size ?? null;
  const universeCenter = opts.universeCenter ?? graphUniverse?.center ?? null;
  const universePadding = opts.universePadding ?? graphUniverse?.padding ?? null;
  const geometryAuthoringDirty = opts.geometryAuthoringDirty ?? null;
  const geometryAuthoringMeshDirty = Boolean(
    geometryAuthoringDirty?.geometryDraftDirty ||
      geometryAuthoringDirty?.geometryRealizationDirty ||
      geometryAuthoringDirty?.meshDirty,
  );
  const meshManifestSceneRevision = opts.meshManifestSceneRevision ?? null;
  const meshManifestRealizationRevision = opts.meshManifestRealizationRevision ?? null;
  const meshManifestRegions = opts.meshManifestRegions ?? [];
  const meshManifestStale = Boolean(
    sceneDocument &&
      meshManifestSceneRevision != null &&
      sceneDocument.revision !== meshManifestSceneRevision,
  );
  const meshRegionsByObjectId = new Map<string, MeshWorkspaceManifestRegionState[]>();
  for (const region of meshManifestRegions) {
    for (const objectId of region.source_object_ids) {
      const current = meshRegionsByObjectId.get(objectId) ?? [];
      current.push(region);
      meshRegionsByObjectId.set(objectId, current);
    }
  }

  /* ── Physics ─────────────────────────────────────────────────────── */
  const aggregatePhysicsStack = normalizePhysicsStack(
    geos.flatMap((geometry) =>
      ensureObjectPhysicsStack(
        geometry.physics_stack,
        geometry.material.Dind ?? null,
      ),
    ),
  );
  const rawPhysicsCapabilityEntries = buildPhysicsCapabilityView(
    opts.capabilities ?? null,
    aggregatePhysicsStack,
  );
  const physicsCapabilityEntries = enrichPhysicsCapabilityEntries(
    rawPhysicsCapabilityEntries,
    {
      zeemanField: opts.zeemanField,
      exchangeEnabled: opts.exchangeEnabled,
      demagEnabled: opts.demagEnabled,
      interfacialDmiFromMaterial: geos.some(
        (geometry) => Math.abs(Number(geometry.material.Dind ?? 0)) > 0,
      ),
      metadata: opts.metadata,
    },
  );
  const visiblePhysicsCapabilityEntries = physicsCapabilityEntries.filter((entry) => entry.active);
  const demagBoundaryLabel =
    opts.demagRealization == null || opts.demagRealization === "auto"
      ? "Auto"
      : opts.demagRealization === "poisson_dirichlet" || opts.demagRealization === "airbox_dirichlet"
        ? "Dirichlet"
        : opts.demagRealization === "poisson_robin" || opts.demagRealization === "airbox_robin"
          ? "Robin"
          : opts.demagRealization;
  const physicsChildren: TreeNodeData[] = [
    {
      id: "physics-solver",
      label: "Solver",
      icon: "wrench",
      status: "ready",
      badge: opts.solverIntegrator ? opts.solverIntegrator.toUpperCase() : "auto",
    },
    ...visiblePhysicsCapabilityEntries.map((entry) => ({
      id: `physics-module-${entry.id}`,
      label: entry.label,
      icon:
        entry.id === "exchange"
          ? "repeat"
          : entry.id === "demag"
            ? "magnet"
            : entry.id === "zeeman"
              ? "arrow-right"
              : entry.id === "thermal_noise"
                ? "thermometer"
                : entry.id === "spin_transfer_torque" || entry.id === "spin_orbit_torque"
                  ? "refresh-cw"
                  : entry.id === "interfacial_dmi" || entry.id === "bulk_dmi"
                    ? "git-branch"
                    : entry.id === "uniaxial_anisotropy" || entry.id === "cubic_anisotropy"
                      ? "diamond"
                      : "zap",
      status: physicsModuleNodeStatus(entry),
      badge: physicsModuleNodeBadge(entry),
      children:
        entry.id === "demag"
          ? [
              {
                id: "physics-module-demag-method",
                label: "Method",
                icon: "settings",
                status: physicsModuleNodeStatus(entry),
                badge: opts.solverIntegrator ? opts.solverIntegrator.toUpperCase() : undefined,
              },
              {
                id: "physics-module-demag-boundary",
                label: "Boundary Conditions",
                icon: "square",
                status: physicsModuleNodeStatus(entry),
                badge: demagBoundaryLabel,
              },
            ]
          : undefined,
    })),
  ];

  const authoringPrimitiveObjects =
    opts.geometryAuthoringGraph && geometryAuthoringDirty
      ? opts.geometryAuthoringGraph.nodes
          .filter((node): node is PrimitiveNode => node.kind === "primitive")
          .map((node) =>
            _buildAuthoringPrimitiveObjectNode(
              node,
              geometryAuthoringDirty,
              opts.onGeometryAuthoringSelect,
            ),
          )
      : [];

  const objectsChildren: TreeNodeData[] =
    objects.length > 0
      ? [
          ...objects.map((objectNode) =>
            _buildObjectNode(objectNode, undefined, {
              regions:
                meshRegionsByObjectId.get(objectNode.objectId ?? objectNode.name) ??
                meshRegionsByObjectId.get(objectNode.name) ??
                [],
              manifestStale: meshManifestStale,
            }),
          ),
          ...authoringPrimitiveObjects,
        ]
      : authoringPrimitiveObjects.length > 0
        ? authoringPrimitiveObjects
      : [
          {
            id: "objects-empty",
            label: "No objects yet",
            icon: "◻",
            status: "pending",
          },
        ];

  const studyChildren: TreeNodeData[] = [];

  studyChildren.push({
    id: "runtime",
    label: "Runtime & Backend",
    icon: "cpu",
    badge: opts.backend ?? "auto",
    status: opts.solverStatus === "active" ? "active" : "ready",
    defaultOpen: false,
  });

  if (showUniverse) {
    studyChildren.push({
      id: "universe",
      label: "Universe",
      icon: "box",
      badge: universeMode ?? "derived",
      status: "ready",
      defaultOpen: true,
      children: _buildUniverseChildren({
        universeDeclaredSize,
        universeEffectiveSize: opts.universeEffectiveSize,
        universeCenter,
        universePadding,
        universeRole: opts.universeRole,
        domainMeshMode: opts.domainMeshMode,
        airPartElementCount: opts.airPartElementCount,
        airPartNodeCount: opts.airPartNodeCount,
        meshStatus: opts.meshStatus,
        meshElements: opts.meshElements,
        meshNodes: opts.meshNodes,
        meshFeOrder: opts.meshFeOrder,
      }),
    });
  }

  if (opts.domainMeshMode === "shared_domain_mesh_with_air") {
    studyChildren.push({
      id: "mesh",
      label: "Study Domain Mesh",
      icon: "grid-3x3",
      badge: opts.meshElements
        ? `${opts.meshElements.toLocaleString()} el`
        : opts.meshNodes
          ? `${opts.meshNodes.toLocaleString()} nodes`
          : "—",
      status: geometryAuthoringMeshDirty ? "stale" : (opts.meshStatus ?? "pending"),
      defaultOpen: false,
      children: [
        ...(geometryAuthoringMeshDirty
          ? [{ id: "mesh-authoring-dirty", label: "Mesh out of date - build mesh before compute", icon: "alert-triangle", status: "blocked" as const }]
          : []),
        ...(meshManifestStale
          ? [{ id: "mesh-manifest-stale", label: "Mesh manifest is stale for current scene revision", icon: "alert-triangle", status: "warning" as const }]
          : []),
        ...(meshManifestSceneRevision != null
          ? [{ id: "mesh-source-scene-revision", label: `Scene rev ${meshManifestSceneRevision}`, icon: "git-commit" } satisfies TreeNodeData]
          : []),
        ...(meshManifestRealizationRevision != null
          ? [{ id: "mesh-realization-revision", label: `Geometry realization rev ${meshManifestRealizationRevision}`, icon: "workflow" } satisfies TreeNodeData]
          : []),
        ...(opts.meshManifestRegionCount != null
          ? [{ id: "mesh-region-count", label: `${opts.meshManifestRegionCount} mesh region${opts.meshManifestRegionCount === 1 ? "" : "s"}`, icon: "layers" } satisfies TreeNodeData]
          : []),
        { id: "mesh-view", label: "Inspector", icon: "eye" },
        { id: "mesh-statistics", label: "Statistics", icon: "bar-chart-3" },
        { id: "mesh-size", label: "Size", icon: "ruler" },
        { id: "mesh-quality", label: "Quality", icon: "gauge" },
        { id: "mesh-pipeline", label: "Pipeline", icon: "workflow" },
      ],
    });
  }

  studyChildren.push({
    id: "objects",
    label: "Objects",
    icon: "package",
    badge: `${objects.length + authoringPrimitiveObjects.length}`,
    status: objects.length + authoringPrimitiveObjects.length > 0 ? "ready" : "pending",
    defaultOpen: true,
    onClick: opts.onGeometryClick,
    children: objectsChildren,
  });

  if (modules.length > 0 || excitationAnalysis) {
    const antennaChildren: TreeNodeData[] = modules.map((module) => ({
      id: `ant-${module.name}`,
      label: module.name,
      icon: module.antenna_kind === "CPWAntenna" ? "≋" : "▭",
      badge: `${module.antenna_kind === "CPWAntenna" ? "CPW" : "µstrip"} · ${(module.drive.current_a * 1e3).toFixed(1)} mA`,
      status: "ready" as const,
    }));
    if (excitationAnalysis) {
      antennaChildren.push({
        id: "ant-excitation",
        label: "Excitation Analysis",
        icon: "📡",
        badge: excitationAnalysis.method,
        status: "ready",
      });
    }
    studyChildren.push({
      id: "antennas",
      label: "Antennas / RF",
      icon: "📻",
      badge: `${modules.length} source${modules.length !== 1 ? "s" : ""}`,
      status: modules.length > 0 ? "ready" : "pending",
      defaultOpen: false,
      children: antennaChildren,
    });
  }

  const authoringStageChildren =
    studyPipeline && studyPipeline.nodes.length > 0
      ? buildStudyPipelineTreeNodes(
          studyPipeline.nodes,
          pipelineStageIndexesByNodeId,
          studyStageStatuses,
        )
      : buildFlatStudyStageTreeNodes(
          studyStages,
          studyStageStatuses,
        );
  const authoringStageCount = studyPipeline?.nodes.length ?? studyStages.length;
  const hasRunStage = studyStages.some((stage) => stage.kind === "run");
  const hasRelaxStage = studyStages.some((stage) => stage.kind === "relax");
  const hasEigenStage =
    studyStages.some((stage) => stage.kind === "eigenmodes") ||
    Boolean(opts.eigenModeCount && opts.eigenModeCount > 0);
  const hasSaveStateStage = studyStages.some((stage) => stage.kind === "save_state");
  const resultFieldChildren: TreeNodeData[] =
    resultFieldQuantities.length > 0
      ? resultFieldQuantities.map((quantity) => ({
          id: `res-qty-${encodeURIComponent(quantity.id)}`,
          label: quantity.label,
          icon: "𝑓",
          badge: quantity.unit ? `${quantity.kind} · ${quantity.unit}` : quantity.kind,
          status: "ready",
        }))
      : [
          {
            id: "res-fields-empty",
            label: "No field quantities yet",
            icon: "◌",
            status: "pending",
          },
        ];
  const resultSolutionChildren: TreeNodeData[] = [
    ...(hasRunStage || hasRelaxStage
      ? [
          {
            id: "res-dataset-time-series",
            label: "Time-Dependent Fields",
            icon: "⏱",
            badge: opts.scalarRowCount ? `${opts.scalarRowCount} samples` : "pending",
            status: (opts.scalarRowCount && opts.scalarRowCount > 0 ? "ready" : "pending") as NodeStatus,
          },
          {
            id: "res-dataset-final-state",
            label: "Final State",
            icon: "◉",
            status: (opts.scalarRowCount && opts.scalarRowCount > 0 ? "ready" : "pending") as NodeStatus,
          },
        ]
      : []),
    ...(hasEigenStage
      ? [
          {
            id: "res-dataset-eigen-spectrum",
            label: "Eigen Spectrum",
            icon: "≈",
            status: (opts.eigenModeCount && opts.eigenModeCount > 0 ? "ready" : "pending") as NodeStatus,
            badge: opts.eigenModeCount ? `${opts.eigenModeCount} modes` : "pending",
          },
          ...(opts.eigenHasDispersion
            ? [
                {
                  id: "res-dataset-eigen-dispersion",
                  label: "Eigen Dispersion",
                  icon: "∿",
                  status: "ready" as const,
                },
              ]
            : []),
        ]
      : []),
    ...(hasSaveStateStage
      ? [
          {
            id: "res-dataset-checkpoints",
            label: "Saved States",
            icon: "💾",
            status: "ready" as const,
          },
        ]
      : []),
  ];
  const resultDatasetChildren: TreeNodeData[] = [
    {
      id: "res-dataset-study-1",
      label: "Study 1",
      icon: "Σ",
      status: "ready" as const,
      children: [
        {
          id: "res-dataset-solution-1",
          label: "Solution 1",
          icon: "◉",
          badge: opts.scalarRowCount ? `${opts.scalarRowCount} samples` : "pending",
          status:
            opts.scalarRowCount && opts.scalarRowCount > 0
              ? "ready"
              : hasEigenStage
                ? "ready"
                : "pending" as NodeStatus,
          children:
            resultSolutionChildren.length > 0
              ? resultSolutionChildren
              : [
                  {
                    id: "res-dataset-empty",
                    label: "No solution outputs yet",
                    icon: "◌",
                    status: "pending",
                  },
                ],
        },
      ],
    },
  ];
  const resultScalarChildren: TreeNodeData[] =
    resultScalarQuantities.length > 0
      ? resultScalarQuantities.map((quantity) => ({
          id: `res-qty-${encodeURIComponent(quantity.id)}`,
          label: quantity.label,
          icon: "Σ",
          badge: quantity.unit ? `${quantity.kind} · ${quantity.unit}` : quantity.kind,
          status: "ready",
        }))
      : [
          {
            id: "res-scalars-empty",
            label: "No derived scalars yet",
            icon: "◌",
            status: "pending",
          },
        ];
  const resultRootChildren: TreeNodeData[] = [
    {
      id: "res-overview",
      label: "Overview",
      icon: "🧭",
      badge: opts.scalarRowCount ? `${opts.scalarRowCount} samples` : "pending",
      status: opts.scalarRowCount && opts.scalarRowCount > 0 ? "ready" : "pending",
    },
    {
      id: "res-datasets",
      label: "Datasets",
      icon: "🧱",
      status: opts.scalarRowCount && opts.scalarRowCount > 0 ? "ready" : "pending",
      children: resultDatasetChildren,
    },
    {
      id: "res-fields",
      label: "Field Quantities",
      icon: "🗂",
      status: resultFieldQuantities.length > 0 ? "ready" : "pending",
      badge: resultFieldQuantities.length > 0 ? `${resultFieldQuantities.length}` : undefined,
      children: resultFieldChildren,
    },
    {
      id: "res-energy",
      label: "Derived Scalars",
      icon: "⚡",
      status: resultScalarQuantities.length > 0 ? "ready" : "pending",
      badge: resultScalarQuantities.length > 0 ? `${resultScalarQuantities.length}` : undefined,
      children: resultScalarChildren,
    },
    {
      id: "res-analyses",
      label: "Analyses",
      icon: "🧠",
      status: resultWorkspaceEntries.length > 0 ? "ready" : "pending",
      badge: resultWorkspaceEntries.length > 0 ? `${resultWorkspaceEntries.length}` : undefined,
      children:
        resultWorkspaceEntries.length > 0
          ? [
              ...(pinnedResultWorkspaces.length > 0
                ? [
                    {
                      id: "res-analyses-pinned",
                      label: "Pinned",
                      icon: "📌",
                      badge: `${pinnedResultWorkspaces.length}`,
                      status: "ready" as const,
                      children: pinnedResultWorkspaces.map((entry) => ({
                        id: entry.id.startsWith("res-") ? entry.id : `res-analysis-${entry.id}`,
                        label: entry.label,
                        icon: entry.icon ?? "🧩",
                        badge: entry.badge ?? undefined,
                        status: entry.status ?? "ready",
                      })),
                    },
                  ]
                : []),
              ...(autoResultWorkspaces.length > 0
                ? [
                    {
                      id: "res-analyses-auto",
                      label: "Auto",
                      icon: "⚙",
                      badge: `${autoResultWorkspaces.length}`,
                      status: "ready" as const,
                      children: autoResultWorkspaces.map((entry) => ({
                        id: entry.id.startsWith("res-") ? entry.id : `res-analysis-${entry.id}`,
                        label: entry.label,
                        icon: entry.icon ?? "🧩",
                        badge: entry.badge ?? undefined,
                        status: entry.status ?? "ready",
                      })),
                    },
                  ]
                : []),
            ]
          : [
              {
                id: "res-analyses-empty",
                label: "No custom analyses yet",
                icon: "◌",
                status: "pending",
              },
            ],
    },
    { id: "res-state-io", label: "Session I/O", icon: "💾" },
    { id: "res-export", label: "Export", icon: "💾" },
    ...(opts.eigenModeCount && opts.eigenModeCount > 0
      ? [
          {
            id: "res-eigenmodes",
            label: "Eigenmodes",
            icon: "〜",
            badge: `${opts.eigenModeCount} modes`,
            status: "ready" as const,
            defaultOpen: false,
            children: [
              {
                id: "res-eigenmodes-summary",
                label: "Summary",
                icon: "📋",
                status: "ready" as const,
              },
              {
                id: "res-eigenmodes-spectrum",
                label: "Spectrum",
                icon: "📊",
                status: "ready" as const,
              },
              ...(opts.eigenHasDispersion
                ? [{
                    id: "res-eigenmodes-dispersion",
                    label: "Dispersion",
                    icon: "≈",
                    status: "ready" as const,
                  }]
                : []),
              ...(opts.eigenModeSummaries ?? []).map((m) => ({
                id: `res-eigenmode-${m.index}`,
                label: m.label,
                icon: "〜",
                status: "ready" as const,
              })),
            ],
          },
        ]
      : []),
    ...(opts.hasVortexData
      ? [
          {
            id: "res-vortex",
            label: "Vortex / STNO",
            icon: "🌀",
            badge: opts.scalarRowCount ? `${opts.scalarRowCount} pts` : undefined,
            status: "ready" as const,
            defaultOpen: false,
            children: [
              {
                id: "res-time-traces",
                label: "Time Traces",
                icon: "📈",
                status: "ready" as const,
                children: [
                  {
                    id: "res-time-trace-mx",
                    label: "mₓ(t)",
                    icon: "〰",
                    status: "ready" as const,
                  },
                  {
                    id: "res-time-trace-my",
                    label: "m_y(t)",
                    icon: "〰",
                    status: "ready" as const,
                  },
                  {
                    id: "res-time-trace-mz",
                    label: "mᵤ(t)",
                    icon: "〰",
                    status: "ready" as const,
                  },
                ],
              },
              {
                id: "res-vortex-frequency",
                label: "FFT / PSD",
                icon: "📊",
                status: "ready" as const,
              },
              {
                id: "res-vortex-trajectory",
                label: "Trajectory (mₓ vs m_y)",
                icon: "◎",
                status: "ready" as const,
              },
              {
                id: "res-vortex-orbit",
                label: "Orbit Amplitude",
                icon: "◉",
                status: "ready" as const,
              },
            ],
          },
        ]
      : []),
  ];

  studyChildren.push(
    {
      id: "physics",
      label: "Physics",
      icon: "zap",
      status: "ready",
      defaultOpen: true,
      onClick: opts.onPhysicsClick,
      children: physicsChildren,
    },
    {
      id: "study",
      label: "Study",
      icon: "play",
      badge: authoringStageCount > 0 ? `${authoringStageCount} stages` : (opts.backend ?? "—"),
      status: opts.solverStatus === "active" ? "ready" : (opts.solverStatus ?? "pending"),
      defaultOpen: true,
      onClick: opts.onSolverClick,
      children: [
        {
          id: "study-stages",
          label: "Stages",
          icon: "🧩",
          badge: opts.activeStudyStageIndex != null 
            ? `executing ${opts.activeStudyStageIndex + 1}/${authoringStageCount}` 
            : authoringStageCount > 0 ? `${authoringStageCount}` : "empty",
          status: authoringStageCount > 0 ? "ready" : "pending",
          defaultOpen: true,
          children:
            authoringStageChildren.length > 0
              ? authoringStageChildren
              : [
                  {
                    id: "study-stage-empty",
                    label: "No stages declared",
                    icon: "◌",
                    status: "pending",
                  },
                ],
        },
      ],
    },
    ...(showResultsSection
      ? [
          {
            id: "results",
            label: "Outputs",
            icon: "bar-chart-3",
            status: (opts.scalarRowCount && opts.scalarRowCount > 0 ? "ready" : "pending") as NodeStatus,
            badge: opts.scalarRowCount ? `${opts.scalarRowCount} pts` : undefined,
            defaultOpen: false,
            onClick: opts.onResultsClick,
            children: resultRootChildren,
          },
        ]
      : []),
  );

  const visualizationChildren: TreeNodeData[] = [
    {
      id: "visualization-section-project",
      label: "Project",
      icon: "🗂",
      badge: `${visualizationProjectPresets.length}`,
      status: "ready",
      defaultOpen: true,
      children:
        visualizationProjectPresets.length > 0
          ? visualizationProjectPresets.map((preset) => ({
              id: `vis-project-${preset.id}`,
              label: preset.name,
              icon: "🎛",
              badge:
                activeVisualizationPresetRef?.source === "project" &&
                activeVisualizationPresetRef?.preset_id === preset.id
                  ? "active"
                  : `${preset.domain.toUpperCase()} · ${preset.mode}`,
              status: "ready" as const,
            }))
          : [
              {
                id: "visualization-project-empty",
                label: "No project presets",
                icon: "◌",
                status: "pending" as const,
              },
            ],
    },
    {
      id: "visualization-section-local",
      label: "Local",
      icon: "💾",
      badge: `${visualizationLocalPresets.length}`,
      status: "ready",
      defaultOpen: true,
      children:
        visualizationLocalPresets.length > 0
          ? visualizationLocalPresets.map((preset) => ({
              id: `vis-local-${preset.id}`,
              label: preset.name,
              icon: "🎛",
              badge:
                activeVisualizationPresetRef?.source === "local" &&
                activeVisualizationPresetRef?.preset_id === preset.id
                  ? "active"
                  : `${preset.domain.toUpperCase()} · ${preset.mode}`,
              status: "ready" as const,
            }))
          : [
              {
                id: "visualization-local-empty",
                label: "No local presets",
                icon: "◌",
                status: "pending" as const,
              },
            ],
    },
  ];

  return [
    {
      id: "study-root",
      label: opts.studyLabel ?? "Simulation",
      icon: "◈",
      badge: opts.backend ?? undefined,
      status: "ready",
      defaultOpen: true,
      children: studyChildren,
    },
    {
      id: "visualization-root",
      label: "Visualization",
      icon: "paintbrush",
      badge: `${visualizationProjectPresets.length + visualizationLocalPresets.length}`,
      status: "ready",
      defaultOpen: false,
      children: visualizationChildren,
    },
  ];
}

function fmtCompact(v: number): string {
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
  return v.toFixed(0);
}

function fmtLength(value: number): string {
  const abs = Math.abs(value);
  if (!Number.isFinite(value)) return "—";
  if (abs >= 1e-3) return `${(value * 1e3).toFixed(2)} mm`;
  if (abs >= 1e-6) return `${(value * 1e6).toFixed(2)} µm`;
  return `${(value * 1e9).toFixed(1)} nm`;
}

function fmtVec(value: [number, number, number] | null | undefined): string {
  if (!value) return "—";
  return value.map((component) => fmtLength(component)).join(" · ");
}

function hasNonZeroVec(value: [number, number, number] | null | undefined): boolean {
  return Boolean(value && value.some((component) => Math.abs(component) > 0));
}

function _buildUniverseChildren(opts: {
  universeDeclaredSize?: [number, number, number] | null;
  universeEffectiveSize?: [number, number, number] | null;
  universeCenter?: [number, number, number] | null;
  universePadding?: [number, number, number] | null;
  universeRole?: string | null;
  domainMeshMode?: string | null;
  airPartElementCount?: number | null;
  airPartNodeCount?: number | null;
  meshStatus?: NodeStatus;
  meshElements?: number;
  meshNodes?: number;
  meshFeOrder?: number | null;
}): TreeNodeData[] {
  const children: TreeNodeData[] = [];
  const effectiveSize = opts.universeEffectiveSize ?? null;
  const declaredSize = opts.universeDeclaredSize ?? null;
  children.push({
    id: "universe-domain-frame",
    label: "Domain Frame",
    icon: "📐",
    status: "ready",
    children: [
      effectiveSize
        ? {
            id: "universe-effective-size",
            label: `Effective extent: ${fmtVec(effectiveSize)}`,
            icon: "📏",
          }
        : null,
      declaredSize
        ? {
            id: "universe-size",
            label: `Declared size: ${fmtVec(declaredSize)}`,
            icon: "◫",
          }
        : null,
      opts.universeCenter
        ? {
            id: "universe-center",
            label: `Center: ${fmtVec(opts.universeCenter)}`,
            icon: "⌖",
          }
        : null,
      hasNonZeroVec(opts.universePadding)
        ? {
            id: "universe-padding",
            label: `Padding: ${fmtVec(opts.universePadding)}`,
            icon: "↔",
          }
        : null,
      opts.universeRole
        ? {
            id: "universe-role",
            label: opts.universeRole,
            icon: "⚙",
          }
        : null,
    ].filter(Boolean) as TreeNodeData[],
  });
  if (opts.domainMeshMode === "shared_domain_mesh_with_air") {
    children.push({
      id: "universe-airbox",
      label: "Airbox",
      icon: "🌐",
      status: "ready",
      badge:
        opts.airPartElementCount != null
          ? `${opts.airPartElementCount.toLocaleString()} el`
          : (opts.airPartNodeCount != null ? `${opts.airPartNodeCount.toLocaleString()} nodes` : undefined),
      children: [
        {
          id: "universe-airbox-mesh",
          label: "Sizing",
          icon: "◫",
        },
      ],
    });
  }
  children.push({
    id: "universe-boundary",
    label: "Outer Boundary",
    icon: "🔲",
    status: "ready",
  });
  if (opts.domainMeshMode !== "shared_domain_mesh_with_air") {
    children.push({
      id: "universe-mesh",
      label: "Domain Mesh",
      icon: "◫",
      badge: opts.meshElements
        ? `${opts.meshElements.toLocaleString()} el`
        : opts.meshNodes
          ? `${opts.meshNodes.toLocaleString()} nodes`
          : "—",
      status: opts.meshStatus ?? "pending",
      children: [
        { id: "universe-mesh-view", label: "Inspector", icon: "👁" },
        {
          id: "universe-mesh-size",
          label: opts.meshFeOrder != null ? `Size · P${opts.meshFeOrder}` : "Size",
          icon: "📏",
        },
        { id: "universe-mesh-statistics", label: "Statistics", icon: "bar-chart-3" },
        { id: "universe-mesh-quality", label: "Quality", icon: "📊" },
        { id: "universe-mesh-pipeline", label: "Pipeline", icon: "🧭" },
      ],
    });
  }
  return children;
}

/* ── Per-geometry node builders ───────────────────────────────────── */

const GEOMETRY_ICONS: Record<string, string> = {
  Box: "◻",
  Cylinder: "⬡",
  Ellipsoid: "⬭",
  Ellipse: "◯",
  ImportedGeometry: "📦",
  Difference: "✂",
  Union: "∪",
  Intersection: "∩",
};

function _buildObjectNode(objectNode: {
  id: string;
  objectId?: string;
  name: string;
  label: string;
  geometry: ScriptBuilderGeometryEntry;
  meshDirty?: boolean;
  tree: {
    geometry: string;
    material: string;
    region: string;
    mesh: string;
  };
}, authoring?: {
  authoringGraph: GeometryGraphDocument | null;
  authoringDirty: DirtyState | null;
  onAuthoringSelect?: (target: BuilderSelectionTarget) => void;
}, meshManifest?: {
  regions: MeshWorkspaceManifestRegionState[];
  manifestStale: boolean;
}): TreeNodeData {
  const geo = objectNode.geometry;
  const geometryId = objectNode.tree.geometry;
  const regionId = objectNode.tree.region;
  const meshId = objectNode.tree.mesh;

  const authoringChildren = authoring?.authoringGraph && authoring.authoringDirty
    ? buildGeometryBuilderTreeNodes(
        authoring.authoringGraph,
        authoring.authoringDirty,
        authoring.onAuthoringSelect,
      ).children ?? []
    : [];
  const geometryChildren = [
    ..._buildGeometryParamChildren(geometryId, geo),
    ...authoringChildren,
  ];
  const authoringMeshDirty = Boolean(
    objectNode.meshDirty ||
    authoring?.authoringDirty?.geometryDraftDirty ||
      authoring?.authoringDirty?.geometryRealizationDirty ||
      authoring?.authoringDirty?.meshDirty,
  );
  const meshNode: TreeNodeData = {
    id: meshId,
    label: "Mesh",
    icon: "◫",
    status: authoringMeshDirty ? "stale" : (geo.mesh?.mode === "custom" ? "ready" : "pending"),
    badge:
      authoringMeshDirty
        ? "Mesh out of date"
        :
      geo.mesh?.mode === "custom"
        ? (geo.mesh.order ? `override · P${geo.mesh.order}` : "override")
        : "inherits",
    children: [
      ...(authoringMeshDirty
        ? [{ id: `${meshId}-authoring-dirty`, label: "Build mesh before compute", icon: "alert-triangle", status: "blocked" as const }]
        : []),
      {
        id: `${meshId}-mode`,
        label:
          geo.mesh?.mode === "custom"
            ? "Mode: local override"
            : "Mode: inherit shared object defaults",
        icon: "⇆",
      },
      {
        id: `${meshId}-hmax`,
        label:
          geo.mesh?.mode === "custom" && geo.mesh.hmax
            ? `Maximum element size: ${geo.mesh.hmax}`
            : "Maximum element size from object defaults",
        icon: "📏",
      },
      ...(geo.mesh?.mode === "custom" && geo.mesh.source
        ? [{ id: `${meshId}-source`, label: geo.mesh.source, icon: "📄" } satisfies TreeNodeData]
        : []),
    ],
  };

  return {
    id: objectNode.id,
    label: objectNode.label,
    icon: GEOMETRY_ICONS[geo.geometry_kind] ?? "📦",
    badge: geo.geometry_kind,
    status: "ready",
    defaultOpen: true,
    children: [
      {
        id: geometryId,
        label: "Geometry",
        icon: "🔷",
        status: "ready",
        defaultOpen: authoringChildren.length > 0,
        children: geometryChildren,
      },
      _buildRegionNode(geo, regionId, meshManifest),
      _buildMagneticParametersNode(geo, objectNode.name),
      {
        id: `mag-${objectNode.name}`,
        label:
          geo.magnetization.kind === "preset_texture"
            ? `Magnetic Texture — ${_magnetizationLabel(geo.magnetization)}`
            : "Magnetic Texture",
        icon: "🧭",
        status: "ready",
        badge:
          geo.magnetization.kind === "preset_texture"
            ? geo.magnetization.preset_kind ?? "preset"
            : geo.magnetization.kind,
        children: [
          {
            id: `mag-${objectNode.name}-kind`,
            label: `m₀: ${_magnetizationLabel(geo.magnetization)}`,
            icon: geo.magnetization.kind === "preset_texture" ? "◉" : "◢",
            status: "ready",
          },
	          ...(geo.magnetization.kind === "preset_texture"
	            ? [
	                {
	                  id: `mag-${objectNode.name}-transform`,
	                  label: "Texture Transform",
	                  icon: "⟳",
	                  status: "ready" as const,
	                  children: [
	                    {
	                      id: `mag-${objectNode.name}-transform-translate`,
	                      label: "Translate",
	                      icon: "↔",
	                      status: "ready" as const,
	                    },
	                    {
	                      id: `mag-${objectNode.name}-transform-rotate`,
	                      label: "Rotate",
	                      icon: "⤾",
	                      status: "ready" as const,
	                    },
	                    {
	                      id: `mag-${objectNode.name}-transform-scale`,
	                      label: "Scale",
	                      icon: "⬚",
	                      status: "ready" as const,
	                    },
	                  ],
	                },
	              ]
	            : []),
        ],
      },
      meshNode,
    ],
  };
}

function primitiveDimensionBadge(node: PrimitiveNode): string {
  switch (node.params.kind) {
    case "box":
    case "thin_film":
    case "nanowire":
    case "wedge":
      return fmtVec(node.params.data.size);
    case "cylinder":
    case "pillar":
      return `r=${fmtLength(node.params.data.radius)} h=${fmtLength(node.params.data.height)}`;
    case "sphere":
      return `r=${fmtLength(node.params.data.radius)}`;
    case "ellipsoid":
      return fmtVec(node.params.data.radii);
    case "disk":
      return `r=${fmtLength(node.params.data.radius)} t=${fmtLength(node.params.data.thickness)}`;
    case "ring":
    case "tube":
      return `ro=${fmtLength(node.params.data.outerRadius)} ri=${fmtLength(node.params.data.innerRadius)}`;
    case "triangular_prism":
      return `b=${fmtLength(node.params.data.base)} h=${fmtLength(node.params.data.triangleHeight)}`;
    case "cone":
      return `r=${fmtLength(node.params.data.radiusBottom)} h=${fmtLength(node.params.data.height)}`;
    case "capsule":
      return `r=${fmtLength(node.params.data.radius)} h=${fmtLength(node.params.data.height)}`;
    case "polygon_prism":
      return `${node.params.data.sides} sides · r=${fmtLength(node.params.data.radius)}`;
  }
}

function _buildAuthoringPrimitiveObjectNode(
  node: PrimitiveNode,
  dirty: DirtyState,
  onSelect?: (target: BuilderSelectionTarget) => void,
): TreeNodeData {
  const objectId = `builder-prim-${node.id}`;
  const meshDirty = dirty.geometryDraftDirty || dirty.geometryRealizationDirty || dirty.meshDirty;
  const select = onSelect ? () => onSelect({ type: "primitive", id: node.id }) : undefined;
  return {
    id: objectId,
    label: node.name,
    icon: "◻",
    badge: "draft object",
    status: meshDirty ? "dirty" : "ready",
    defaultOpen: true,
    domain: "build",
    onClick: select,
    children: [
      {
        id: `${objectId}-geometry`,
        label: "Geometry",
        icon: "🔷",
        badge: primitiveDimensionBadge(node),
        status: meshDirty ? "dirty" : "ready",
        defaultOpen: true,
        onClick: select,
        children: [
          {
            id: `${objectId}/params`,
            label: "Parameters",
            icon: "settings",
            badge: primitiveDimensionBadge(node),
            onClick: select,
          },
          {
            id: `${objectId}/transform`,
            label: "Transform",
            icon: "move",
            badge: `pos: ${fmtVec(node.transform.translation)}`,
            onClick: select,
          },
        ],
      },
      {
        id: `${objectId}-mesh`,
        label: "Mesh",
        icon: "◫",
        status: meshDirty ? "stale" : "pending",
        badge: meshDirty ? "Mesh out of date" : "not built",
        children: meshDirty
          ? [
              {
                id: `${objectId}-mesh-build-required`,
                label: "Build mesh before compute",
                icon: "alert-triangle",
                status: "blocked",
              },
            ]
          : undefined,
      },
    ],
  };
}

function _buildGeometryParamChildren(
  parentId: string,
  geo: ScriptBuilderGeometryEntry,
): TreeNodeData[] {
  const params = geo.geometry_params;
  const children: TreeNodeData[] = [];

  children.push({
    id: `${parentId}-kind`,
    label: geo.geometry_kind,
    icon: GEOMETRY_ICONS[geo.geometry_kind] ?? "⚙",
  });

  if (geo.geometry_kind === "Box" && Array.isArray(params.size)) {
    const [dx, dy, dz] = (params.size as number[]).map((v) => (v * 1e9).toFixed(1));
    children.push({ id: `${parentId}-size`, label: `Size: ${dx} × ${dy} × ${dz} nm`, icon: "📏" });
  } else if (geo.geometry_kind === "Cylinder") {
    const r = params.radius != null ? `r=${((params.radius as number) * 1e9).toFixed(1)}` : "";
    const h = params.height != null ? `h=${((params.height as number) * 1e9).toFixed(1)}` : "";
    children.push({ id: `${parentId}-dim`, label: `Dimensions: ${r} ${h} nm`, icon: "📏" });
  } else if (geo.geometry_kind === "Ellipsoid") {
    const rx = params.rx != null ? ((params.rx as number) * 1e9).toFixed(1) : "?";
    const ry = params.ry != null ? ((params.ry as number) * 1e9).toFixed(1) : "?";
    const rz = params.rz != null ? ((params.rz as number) * 1e9).toFixed(1) : "?";
    children.push({ id: `${parentId}-dim`, label: `Dimensions: ${rx} × ${ry} × ${rz} nm`, icon: "📏" });
  } else if (geo.geometry_kind === "Ellipse") {
    const rx = params.rx != null ? ((params.rx as number) * 1e9).toFixed(1) : "?";
    const ry = params.ry != null ? ((params.ry as number) * 1e9).toFixed(1) : "?";
    const height = params.height != null ? ((params.height as number) * 1e9).toFixed(1) : "?";
    children.push({ id: `${parentId}-dim`, label: `Dimensions: ${rx} × ${ry} × ${height} nm`, icon: "📏" });
  } else if (geo.geometry_kind === "ImportedGeometry" && typeof params.source === "string") {
    const basename = (params.source as string).split("/").pop() ?? params.source;
    children.push({ id: `${parentId}-source`, label: `Source: ${basename as string}`, icon: "📄" });
    if (params.volume === "surface") {
      children.push({ id: `${parentId}-volume`, label: "Volume: surface", icon: "◌" });
    }
  } else if (geo.geometry_kind === "Difference") {
    children.push({ id: `${parentId}-csg`, label: "CSG difference", icon: "✂" });
  } else if (geo.geometry_kind === "Union") {
    children.push({ id: `${parentId}-csg`, label: "CSG union", icon: "∪" });
  } else if (geo.geometry_kind === "Intersection") {
    children.push({ id: `${parentId}-csg`, label: "CSG intersection", icon: "∩" });
  }

  const translation = Array.isArray(params.translation)
    ? params.translation
    : Array.isArray(params.translate)
      ? params.translate
      : null;
  if (translation && translation.some((value) => Math.abs(Number(value)) > 0)) {
    children.push({
      id: `${parentId}-translation`,
      label: `Translate: ${translation.map((value) => `${(Number(value) * 1e9).toFixed(1)} nm`).join(" · ")}`,
      icon: "↔",
    });
  }

  if (geo.bounds_min && geo.bounds_max) {
    children.push({
      id: `${parentId}-bounds`,
      label: `Bounds: ${fmtVec([
        geo.bounds_max[0] - geo.bounds_min[0],
        geo.bounds_max[1] - geo.bounds_min[1],
        geo.bounds_max[2] - geo.bounds_min[2],
      ])}`,
      icon: "⌗",
    });
  }

  return children;
}

function _buildRegionNode(
  geo: ScriptBuilderGeometryEntry,
  regionId: string,
  meshManifest?: {
    regions: MeshWorkspaceManifestRegionState[];
    manifestStale: boolean;
  },
): TreeNodeData {
  const regionName = geo.region_name?.trim() || geo.name;
  const manifestRegions = meshManifest?.regions ?? [];
  return {
    id: regionId,
    label: "Regions",
    icon: "▣",
    status: meshManifest?.manifestStale ? "warning" : "ready",
    badge:
      manifestRegions.length > 0
        ? `${manifestRegions.length} mapped`
        : undefined,
    children: [
      {
        id: `${regionId}-item`,
        label: regionName,
        icon: "◫",
        status: meshManifest?.manifestStale ? "warning" : "ready",
        children: [
          ...(meshManifest?.manifestStale
            ? [
                {
                  id: `${regionId}-stale`,
                  label: "Mesh region mapping is stale",
                  icon: "alert-triangle",
                  status: "warning" as const,
                },
              ]
            : []),
          ...manifestRegions.flatMap((region) => [
            {
              id: `${regionId}-${region.region_id}-material`,
              label: `Material: ${region.material_ref}`,
              icon: "layers",
              status: "ready" as const,
            },
            {
              id: `${regionId}-${region.region_id}-mesh-parts`,
              label:
                region.mesh_part_ids.length > 0
                  ? `Mesh parts: ${region.mesh_part_ids.join(", ")}`
                  : "Mesh parts: none",
              icon: "grid-3x3",
              status: region.mesh_part_ids.length > 0 ? "ready" as const : "pending" as const,
            },
            {
              id: `${regionId}-${region.region_id}-elements`,
              label:
                region.element_count != null
                  ? `${region.element_count.toLocaleString()} elements`
                  : "Elements: unknown",
              icon: "hash",
              status: region.element_count != null ? "ready" as const : "pending" as const,
            },
          ]),
        ],
      },
    ],
  };
}

function _buildMagneticParametersNode(
  geo: ScriptBuilderGeometryEntry,
  objectName: string,
): TreeNodeData {
  const mat = geo.material;
  const stack = ensureObjectPhysicsStack(geo.physics_stack, geo.material.Dind);

  const children: TreeNodeData[] = [
    {
      id: `physobj-${objectName}-ms`,
      label: mat.Ms != null ? `Ms = ${fmtCompact(mat.Ms)} A/m` : "Ms (saturation)",
      icon: "𝑀",
      status: mat.Ms != null ? "ready" : "pending",
    },
    {
      id: `physobj-${objectName}-aex`,
      label: mat.Aex != null ? `A = ${mat.Aex.toExponential(1)} J/m` : "A (exchange)",
      icon: "𝐴",
      status: mat.Aex != null ? "ready" : "pending",
    },
    {
      id: `physobj-${objectName}-alpha`,
      label: `α = ${mat.alpha}`,
      icon: "α",
      status: "ready",
    },
  ];

  if (mat.Dind != null) {
    children.push({
      id: `physobj-${objectName}-dind`,
      label: `Dind = ${mat.Dind.toExponential(1)} J/m²`,
      icon: "𝐷",
      status: "ready",
    });
  }

  children.push(
    ...stack.map((entry): TreeNodeData => {
      if (entry.kind === "interfacial_dmi") {
        const dind = Number(entry.params?.dind ?? geo.material.Dind ?? 0);
        return {
          id: `physobj-${objectName}-interfacial_dmi`,
          label:
            dind !== 0
              ? `Interfacial DMI · D = ${dind.toExponential(2)} J/m²`
              : "Interfacial DMI",
          icon: "𝐷",
          status: entry.enabled ? "ready" : "pending",
          badge: entry.enabled ? undefined : "disabled",
        };
      }
      if (entry.kind === "uniaxial_anisotropy") {
        const ku1 = Number(entry.params?.ku1 ?? 0);
        return {
          id: `physobj-${objectName}-uniaxial_anisotropy`,
          label:
            ku1 !== 0
              ? `Uniaxial Ku · ${ku1.toExponential(2)} J/m³`
              : "Uniaxial Ku",
          icon: "K",
          status: entry.enabled ? "ready" : "pending",
          badge: entry.enabled ? undefined : "disabled",
        };
      }
      return {
        id: `physobj-${objectName}-${entry.kind}`,
        label: magneticInteractionLabel(entry.kind),
        icon: entry.kind === "exchange" ? "↔" : "🧲",
        status: entry.enabled ? "ready" : "pending",
        badge: entry.enabled ? undefined : "disabled",
      };
    }),
  );

  const optionalCount = stack.filter(
    (entry) => entry.kind !== "exchange" && entry.kind !== "demag",
  ).length;

  return {
    id: `physobj-${objectName}`,
    label: "Magnetic Parameters",
    icon: "🧲",
    status: mat.Ms != null ? "ready" : "pending",
    badge: optionalCount > 0 ? `+${optionalCount}` : "core",
    children,
  };
}

function _magnetizationLabel(
  mag: ScriptBuilderMagnetizationEntry,
): string {
  if (mag.kind === "preset_texture") {
    if (mag.preset_kind === "uniform") {
      const direction = Array.isArray(mag.preset_params?.direction)
        ? mag.preset_params.direction
        : mag.value;
      if (Array.isArray(direction) && direction.length >= 3) {
        return `(${direction.slice(0, 3).map((v) => Number(v).toFixed(2)).join(", ")})`;
      }
    }
    if (mag.preset_kind === "random" || mag.preset_kind === "random_seeded") {
      const seed =
        typeof mag.preset_params?.seed === "number"
          ? mag.preset_params.seed
          : mag.seed;
      return seed != null ? `random(seed=${seed})` : "random";
    }
    return mag.ui_label ?? mag.preset_kind ?? "preset_texture";
  }
  if (mag.kind === "sampled" && mag.source_path) {
    const basename = mag.source_path.split("/").pop() ?? mag.source_path;
    return basename;
  }
  return mag.kind;
}
