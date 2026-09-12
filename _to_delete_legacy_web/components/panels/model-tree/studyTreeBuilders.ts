import type {
  ScriptBuilderStageState,
  StudyPipelineNodeState,
} from "@/lib/session/types";
import {
  buildFlatStudyStageNodeId,
  buildPipelineStudyStageNodeId,
} from "@/lib/study-builder/node-context";
import type { NodeStatus, TreeNodeData } from "./types";

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
  if (!enabled) return "pending";
  if (stageIndexes.length === 0) return "pending";
  const statuses = stageIndexes.map((stageIndex) => stageStatuses[stageIndex] ?? "pending");
  if (statuses.some((status) => status === "failed" || status === "error")) return "failed";
  if (statuses.some((status) => status === "running" || status === "paused")) return "running";
  if (statuses.every((status) => status === "skipped")) return "skipped";
  if (statuses.every((status) => status === "completed" || status === "done")) return "completed";
  if (statuses.some((status) => status === "completed" || status === "done" || status === "skipped")) {
    return "running";
  }
  return "pending";
}

export function buildStudyPipelineTreeNodes(
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

export function buildFlatStudyStageTreeNodes(
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
