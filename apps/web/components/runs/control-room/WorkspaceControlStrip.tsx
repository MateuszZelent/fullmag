"use client";

import { memo } from "react";

import {
  Activity,
  BarChart3,
  Box,
  Columns2,
  Cpu,
  Eye,
  Grid3X3,
  Magnet,
  PanelRight,
  Pause,
  Play,
  Shapes,
  SkipForward,
  Square,
  Target,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtExp, fmtSI } from "./shared";
import { useTransport, useViewport, useCommand, useModel } from "./context-hooks";
import { MESH_WORKSPACE_PRESETS } from "./meshWorkspace";
import { isFemDiscretization } from "@/src/domain/capabilities";
import { appendNode, createPrimitiveNode, insertNodeNear } from "@/lib/study-builder/operations";
import { materializeStudyPipeline } from "@/lib/study-builder/materialize";
import { migrateFlatStagesToStudyPipeline } from "@/lib/study-builder/migrate";
import { buildPipelineStudyStageNodeId, parseStudyNodeContext } from "@/lib/study-builder/node-context";
import type { StudyPipelineDocument, StudyPrimitiveStageKind } from "@/lib/study-builder/types";

function syncStudyCompatibilityState(
  ctx: ReturnType<typeof useTransport> &
    ReturnType<typeof useViewport> &
    ReturnType<typeof useCommand> &
    ReturnType<typeof useModel>,
  stages: ReturnType<typeof materializeStudyPipeline>["stages"],
): void {
  const firstRun = stages.find((stage) => stage.kind === "run");
  const firstRelax = stages.find((stage) => stage.kind === "relax");
  if (firstRun?.until_seconds) {
    ctx.setRunUntilInput(firstRun.until_seconds);
  }
  if (firstRelax) {
    ctx.setSolverSettings((current) => ({
      ...current,
      integrator: firstRelax.integrator || current.integrator,
      fixedTimestep: firstRelax.fixed_timestep || current.fixedTimestep,
      relaxAlgorithm: firstRelax.relax_algorithm || current.relaxAlgorithm,
      torqueTolerance: firstRelax.torque_tolerance || current.torqueTolerance,
      energyTolerance: firstRelax.energy_tolerance || current.energyTolerance,
      maxRelaxSteps: firstRelax.max_steps || current.maxRelaxSteps,
    }));
  }
}

function resolveStudyAnchorNodeId(
  document: StudyPipelineDocument,
  selectedNodeId: string | null,
): string | null {
  const studyNode = parseStudyNodeContext(selectedNodeId);
  if (studyNode?.kind !== "study-stage") {
    return null;
  }
  if (studyNode.source === "pipeline") {
    return studyNode.stageKey;
  }
  const flatIndex = Number(studyNode.stageKey);
  return Number.isFinite(flatIndex) ? document.nodes[flatIndex]?.id ?? null : null;
}

function quantityIcon(quantityId: string, label: string) {
  const lowerId = quantityId.toLowerCase();
  const lowerLabel = label.toLowerCase();
  if (quantityId === "m") return <Magnet size={14} />;
  if (lowerId.includes("demag") || lowerLabel.includes("demag")) return <Shapes size={14} />;
  if (lowerId.includes("ex") || lowerLabel.includes("exchange")) return <Zap size={14} />;
  if (lowerId.startsWith("e_") || lowerLabel.startsWith("e")) return <BarChart3 size={14} />;
  return <Eye size={14} />;
}

function quantityTone(quantityId: string, label: string) {
  const lowerId = quantityId.toLowerCase();
  const lowerLabel = label.toLowerCase();
  if (quantityId === "m") return "text-rose-300";
  if (lowerId.includes("demag") || lowerLabel.includes("demag")) return "text-fuchsia-300";
  if (lowerId.includes("ex") || lowerLabel.includes("exchange")) return "text-amber-300";
  if (lowerId.startsWith("e_") || lowerLabel.startsWith("e")) return "text-emerald-300";
  return "text-sky-300";
}

function runtimeTone(status: string) {
  if (status === "running") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  if (status === "paused") return "border-amber-500/30 bg-amber-500/10 text-amber-300";
  if (status === "failed") return "border-rose-500/30 bg-rose-500/10 text-rose-300";
  if (status === "awaiting_command") return "border-sky-500/30 bg-sky-500/10 text-sky-300";
  return "border-border/60 bg-background/50 text-muted-foreground";
}

function solverAcceleratorLabel(
  runtimeEngineLabel: string | null,
  runtimeEngineGpuLabel: string | null,
) {
  const haystack = `${runtimeEngineLabel ?? ""} ${runtimeEngineGpuLabel ?? ""}`.toLowerCase();
  if (/(gpu|cuda)/.test(haystack)) return "GPU";
  if (/(cpu|reference)/.test(haystack)) return "CPU";
  return null;
}

const WorkspaceControlStrip = memo(function WorkspaceControlStrip() {
  const transport = useTransport();
  const viewport = useViewport();
  const cmd = useCommand();
  const model = useModel();
  /* Backward-compatible ctx alias */
  const ctx = { ...transport, ...viewport, ...cmd, ...model };
  const femDiscretization = ctx.domainCapabilities
    ? isFemDiscretization(ctx.domainCapabilities)
    : ctx.isFemBackend;
  const solverAccelerator = solverAcceleratorLabel(
    ctx.runtimeEngineLabel,
    ctx.runtimeEngineGpuLabel,
  );

  const currentScalarValue =
    ctx.selectedScalarValue != null
      ? `${fmtExp(ctx.selectedScalarValue)}${ctx.selectedQuantityUnit ? ` ${ctx.selectedQuantityUnit}` : ""}`
      : null;
  const detailText =
    ctx.workspaceStatus === "running"
      ? `Step ${ctx.effectiveStep.toLocaleString()} · ${fmtSI(ctx.effectiveTime, "s")}`
      : ctx.activity.detail ?? null;
  const authoringStudyDocument = (
    ctx.studyPipeline as StudyPipelineDocument | null
  ) ?? migrateFlatStagesToStudyPipeline(ctx.studyStages);

  const appendStudyStage = (kind: StudyPrimitiveStageKind) => {
    const nextNode = createPrimitiveNode(kind);
    const anchorId = resolveStudyAnchorNodeId(authoringStudyDocument, ctx.selectedSidebarNodeId);
    const nextDocument = anchorId
      ? insertNodeNear(authoringStudyDocument, anchorId, "after", nextNode)
      : appendNode(authoringStudyDocument, nextNode);
    const compiled = materializeStudyPipeline(nextDocument);
    ctx.setStudyPipeline(nextDocument);
    ctx.setStudyStages(compiled.stages);
    syncStudyCompatibilityState(ctx, compiled.stages);
    ctx.setWorkspaceMode("study");
    ctx.setSelectedSidebarNodeId(buildPipelineStudyStageNodeId(nextNode.id));
  };

  const viewModes = [
    { id: "3D", label: "3D", icon: <Box size={14} /> },
    { id: "2D", label: "2D", icon: <Columns2 size={14} /> },
    { id: "Mesh", label: "Mesh", icon: <Grid3X3 size={14} /> },
    { id: "Analyze", label: "Analyze", icon: <BarChart3 size={14} /> },
  ] as const;

  return (
    <div className="border-b border-white/5 bg-[linear-gradient(180deg,rgba(15,23,42,0.92),rgba(12,18,30,0.82))] shadow-[0_16px_40px_rgba(2,6,23,0.45)]">
      <div className="flex flex-col gap-3 px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-[0.62rem] font-bold uppercase tracking-[0.22em] text-primary">
            Live Workspace
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.62rem] font-bold uppercase tracking-[0.18em]",
              runtimeTone(ctx.workspaceStatus),
            )}
          >
            <Activity size={11} className={cn(ctx.workspaceStatus === "running" && "animate-pulse")} />
            {ctx.workspaceStatus.replaceAll("_", " ")}
          </span>
          {ctx.runtimeEngineLabel && (
            <span className="rounded-full border border-border/60 bg-background/40 px-2.5 py-1 text-[0.62rem] font-bold uppercase tracking-[0.18em] text-muted-foreground">
              {ctx.runtimeEngineLabel}
              {ctx.runtimeEngineGpuLabel ? ` · ${ctx.runtimeEngineGpuLabel}` : ""}
            </span>
          )}
          {solverAccelerator && (
            <span
              className={cn(
                "rounded-full border px-2.5 py-1 text-[0.62rem] font-bold uppercase tracking-[0.18em]",
                solverAccelerator === "GPU"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-300",
              )}
            >
              Solver {solverAccelerator}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground/90">
            {ctx.activity.label}
          </span>
          {ctx.commandMessage && (
            <span
              className={cn(
                "max-w-full truncate rounded-full border px-2.5 py-1 text-[0.62rem] font-bold uppercase tracking-[0.18em]",
                ctx.commandBusy
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                  : "border-sky-500/30 bg-sky-500/10 text-sky-300",
              )}
              title={ctx.commandMessage}
            >
              {ctx.commandMessage}
            </span>
          )}
          {ctx.previewBusy && (
            <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-[0.62rem] font-bold uppercase tracking-[0.18em] text-violet-200">
              Preview switching
            </span>
          )}
        </div>

        <div className="grid gap-3 xl:grid-cols-[minmax(18rem,1.2fr)_minmax(22rem,1.8fr)_minmax(16rem,1fr)]">
          <section className="flex flex-col gap-2 rounded-2xl border border-white/8 bg-white/[0.03] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.62rem] font-bold uppercase tracking-[0.22em] text-muted-foreground">
                Command Deck
              </span>
              {detailText && (
                <span className="truncate text-[0.72rem] font-medium text-muted-foreground" title={detailText}>
                  {detailText}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex min-w-[10.5rem] flex-1 items-center gap-2 rounded-xl border border-border/50 bg-background/50 px-2.5 py-2">
                <span className="text-[0.62rem] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                  Run Until
                </span>
                <input
                  className="min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/50"
                  value={ctx.runUntilInput}
                  onChange={(event) => ctx.setRunUntilInput(event.target.value)}
                  disabled={ctx.commandBusy || (ctx.primaryRunAction === "run" && !ctx.runtimeCanAcceptCommands)}
                  placeholder="1e-12"
                />
                <span className="text-[0.62rem] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                  s
                </span>
              </label>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[0.68rem] font-bold uppercase tracking-[0.16em] transition-colors",
                    "border-amber-500/25 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20",
                  )}
                  onClick={() => appendStudyStage("relax")}
                >
                  <Target size={13} />
                  Add Relax
                </button>
                <button
                  type="button"
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[0.68rem] font-bold uppercase tracking-[0.16em] transition-colors",
                    "border-emerald-500/25 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20",
                  )}
                  onClick={() => appendStudyStage("run")}
                >
                  <Play size={13} />
                  Add Run
                </button>
                <button
                  type="button"
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[0.68rem] font-bold uppercase tracking-[0.16em] transition-colors",
                    ctx.canRunCommand
                      ? "border-sky-500/25 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20"
                      : "border-border/50 bg-background/40 text-muted-foreground/50",
                  )}
                  onClick={() => ctx.handleSimulationAction(ctx.primaryRunAction)}
                  disabled={!ctx.canRunCommand}
                >
                  <Cpu size={13} />
                  Compute
                </button>
                <button
                  type="button"
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[0.68rem] font-bold uppercase tracking-[0.16em] transition-colors",
                    ctx.canPauseCommand
                      ? "border-sky-500/25 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20"
                      : "border-border/50 bg-background/40 text-muted-foreground/50",
                  )}
                  onClick={() => ctx.handleSimulationAction("pause")}
                  disabled={!ctx.canPauseCommand}
                >
                  <Pause size={13} fill="currentColor" />
                  Pause
                </button>
                <button
                  type="button"
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[0.68rem] font-bold uppercase tracking-[0.16em] transition-colors",
                    ctx.canStopCommand
                      ? "border-rose-500/25 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
                      : "border-border/50 bg-background/40 text-muted-foreground/50",
                  )}
                  onClick={() => ctx.handleSimulationAction("stop")}
                  disabled={!ctx.canStopCommand}
                >
                  <Square size={13} fill="currentColor" />
                  Stop
                </button>
                <button
                  type="button"
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[0.68rem] font-bold uppercase tracking-[0.16em] transition-colors",
                    ctx.canSkipCommand
                      ? "border-violet-500/25 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20"
                      : "border-border/50 bg-background/40 text-muted-foreground/50",
                  )}
                  onClick={() => ctx.handleSimulationAction("skip")}
                  disabled={!ctx.canSkipCommand}
                >
                  <SkipForward size={13} />
                  Skip
                </button>
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-2 rounded-2xl border border-white/8 bg-white/[0.03] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.62rem] font-bold uppercase tracking-[0.22em] text-muted-foreground">
                Results Palette
              </span>
              <span className="truncate text-[0.72rem] text-muted-foreground" title={ctx.selectedQuantityLabel}>
                {ctx.selectedQuantityLabel}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {ctx.quickPreviewTargets.map((target) => {
                const active = ctx.requestedPreviewQuantity === target.id;
                const pending = active && ctx.previewBusy;
                return (
                  <button
                    key={target.id}
                    type="button"
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[0.68rem] font-bold uppercase tracking-[0.16em] transition-all",
                      active
                        ? "border-primary/30 bg-primary/12 text-primary shadow-[0_0_0_1px_rgba(59,130,246,0.15)]"
                        : "border-border/50 bg-background/45 text-muted-foreground hover:border-border hover:bg-background/75 hover:text-foreground",
                      !target.available && "cursor-not-allowed opacity-35",
                      pending && "animate-pulse",
                    )}
                    disabled={!target.available || ctx.previewBusy}
                    onClick={() => ctx.requestPreviewQuantity(target.id)}
                    title={`Switch to ${target.shortLabel}`}
                  >
                    <span className={cn(active ? "text-primary" : quantityTone(target.id, target.shortLabel))}>
                      {quantityIcon(target.id, target.shortLabel)}
                    </span>
                    {target.shortLabel}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="flex flex-col gap-2 rounded-2xl border border-white/8 bg-white/[0.03] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.62rem] font-bold uppercase tracking-[0.22em] text-muted-foreground">
                Workspace View
              </span>
              <button
                type="button"
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[0.68rem] font-bold uppercase tracking-[0.16em] transition-colors",
                  ctx.sidebarCollapsed
                    ? "border-border/50 bg-background/45 text-muted-foreground hover:bg-background/70 hover:text-foreground"
                    : "border-primary/20 bg-primary/10 text-primary",
                )}
                onClick={() => ctx.setSidebarCollapsed((current) => !current)}
              >
                <PanelRight size={13} />
                {ctx.sidebarCollapsed ? "Show Panel" : "Hide Panel"}
              </button>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {viewModes.map((mode) => {
                const disabled = mode.id === "Mesh" && !femDiscretization && ctx.totalCells == null;
                const active = ctx.effectiveViewMode === mode.id;
                return (
                  <button
                    key={mode.id}
                    type="button"
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[0.68rem] font-bold uppercase tracking-[0.16em] transition-colors",
                      active
                        ? "border-primary/30 bg-primary/12 text-primary"
                        : "border-border/50 bg-background/45 text-muted-foreground hover:bg-background/75 hover:text-foreground",
                      disabled && "cursor-not-allowed opacity-35",
                    )}
                    onClick={() => ctx.handleViewModeChange(mode.id)}
                    disabled={disabled}
                  >
                    {mode.icon}
                    {mode.label}
                  </button>
                );
              })}
            </div>

            {femDiscretization && (
              <div className="flex flex-col gap-2 rounded-xl border border-border/50 bg-background/45 px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[0.62rem] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                    Mesh Presets
                  </span>
                  <span className="text-[0.68rem] text-muted-foreground">
                    {MESH_WORKSPACE_PRESETS.find((preset) => preset.id === ctx.meshWorkspacePreset)?.label ?? "Custom"}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {MESH_WORKSPACE_PRESETS.map((preset) => {
                    const active = ctx.meshWorkspacePreset === preset.id;
                    const disabled = !ctx.effectiveFemMesh && preset.id !== "optimize";
                    const Icon = preset.icon;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[0.68rem] font-bold uppercase tracking-[0.16em] transition-colors",
                          active
                            ? "border-primary/30 bg-primary/12 text-primary"
                            : "border-border/50 bg-background/45 text-muted-foreground hover:bg-background/75 hover:text-foreground",
                          disabled && "cursor-not-allowed opacity-35",
                        )}
                        onClick={() => ctx.applyMeshWorkspacePreset(preset.id)}
                        disabled={disabled}
                        title={preset.description}
                      >
                        <Icon size={14} className={cn(active ? "text-primary" : "opacity-60")} />
                        {preset.shortLabel}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/50 bg-background/45 px-2.5 py-2">
              <span className="text-[0.62rem] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                Display
              </span>
              <span className="font-medium text-foreground/90">{ctx.selectedQuantityLabel}</span>
              {ctx.selectedQuantityUnit && (
                <span className="rounded-full border border-border/50 bg-background/60 px-2 py-0.5 text-[0.62rem] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                  {ctx.selectedQuantityUnit}
                </span>
              )}
              {currentScalarValue ? (
                <span className="ml-auto font-mono text-xs text-emerald-300">{currentScalarValue}</span>
              ) : (
                <span className="ml-auto font-mono text-xs text-muted-foreground">
                  {ctx.isVectorQuantity ? ctx.requestedPreviewComponent : "scalar"}
                </span>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
});

export default WorkspaceControlStrip;
