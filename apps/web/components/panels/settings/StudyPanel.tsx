"use client";
/* eslint-disable react-hooks/preserve-manual-memoization */

import { useMemo } from "react";
import { fmtExp, fmtSIOrDash } from "@/lib/format";
import {
  parseStudyNodeContext,
  type StudyNodeContext,
} from "@/lib/study-builder/node-context";
import { materializeStudyPipeline } from "@/lib/study-builder/materialize";
import { migrateFlatStagesToStudyPipeline } from "@/lib/study-builder/migrate";
import {
  findNodeById,
  patchNode,
  patchNodeConfig,
  toggleNodeEnabled,
} from "@/lib/study-builder/operations";
import {
  type MaterializedStageMapEntry,
  type StudyPipelineDocument,
  type StudyPipelineNode,
} from "@/lib/study-builder/types";
import { summarizeMaterializedStage } from "@/lib/study-builder/summaries";
import type { ScriptBuilderStageState } from "@/lib/session/types";
import StageInspector from "@/components/workspace/study-builder/StageInspector";
import StudyBuilderWorkspace from "@/components/workspace/study-builder/StudyBuilderWorkspace";
import { IntegratorSettingsPanel, RelaxationSettingsPanel } from "../SolverSettingsPanel";
import { useTransport, useViewport, useCommand, useModel } from "../../runs/control-room/context-hooks";
import { Button } from "../../ui/button";
import SelectField from "../../ui/SelectField";
import TextField from "../../ui/TextField";
import SolverSelector from "../../solver/SolverSelector";
import {
  BACKEND_PROFILES,
  INTEGRATOR_PROFILES,
  PRECISION_PROFILES,
  RELAXATION_PROFILES,
} from "./profiles";
import {
  humanizeToken,
  precessionModeForPlan,
  studyKindForPlan,
  timestepModeForPlan,
} from "./helpers";
import { InfoRow, SidebarSection, StatusBadge } from "./primitives";

interface StudyPanelProps {
  nodeId: string;
}

interface EigenBcCarrier {
  eigen_spin_wave_bc?: unknown;
  eigen_spin_wave_bc_config?: unknown;
}

const STUDY_ROOT_NODE: StudyNodeContext = { kind: "study-root" };

function stageDisplayName(kind: string): string {
  if (kind === "eigenmodes") return "Eigensolve";
  if (kind === "hysteresis_loop") return "Hysteresis Loop";
  if (kind === "field_sweep_relax") return "Field Sweep + Relax";
  if (kind === "field_sweep_relax_snapshot") return "Field Sweep + Relax + Snapshot";
  if (kind === "parameter_sweep") return "Parameter Sweep";
  return humanizeToken(kind);
}

function eigenBcConfig(stage: EigenBcCarrier): Record<string, unknown> {
  const config: Record<string, unknown> =
    stage.eigen_spin_wave_bc_config && typeof stage.eigen_spin_wave_bc_config === "object"
      ? { ...stage.eigen_spin_wave_bc_config }
      : {};
  if (typeof config.kind !== "string" || !config.kind) {
    config.kind = stage.eigen_spin_wave_bc || "free";
  }
  return config;
}

function patchEigenBcConfig(
  stage: EigenBcCarrier,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...eigenBcConfig(stage), ...patch };
  return {
    eigen_spin_wave_bc: String(next.kind ?? stage.eigen_spin_wave_bc ?? "free"),
    eigen_spin_wave_bc_config: next,
  };
}

function findMaterializedEntry(
  entries: MaterializedStageMapEntry[],
  nodeId: string | null,
): MaterializedStageMapEntry | null {
  if (!nodeId) return null;
  for (const entry of entries) {
    if (entry.nodeId === nodeId) return entry;
    if (entry.childEntries?.length) {
      const child = findMaterializedEntry(entry.childEntries, nodeId);
      if (child) return child;
    }
  }
  return null;
}

function builtAuthoringDocument(
  pipeline: StudyPipelineDocument | null,
  stages: ScriptBuilderStageState[],
): StudyPipelineDocument {
  return pipeline ?? migrateFlatStagesToStudyPipeline(stages);
}

function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function formatExternalField(field: [number, number, number] | null): string {
  if (!field) return "disabled";
  return `${fmtExp(field[0])}, ${fmtExp(field[1])}, ${fmtExp(field[2])} T`;
}

function syncCompatibilityState(
  ctx: { setRunUntilInput: (v: string) => void; setSolverSettings: React.Dispatch<React.SetStateAction<any>> },
  stages: ScriptBuilderStageState[],
): void {
  const firstRun = stages.find((stage) => stage.kind === "run");
  const firstRelax = stages.find((stage) => stage.kind === "relax");
  if (firstRun?.until_seconds) {
    ctx.setRunUntilInput(firstRun.until_seconds);
  }
  if (firstRelax) {
    ctx.setSolverSettings((current: any) => ({
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

function StageSectionNote({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <SidebarSection title={title} defaultOpen={true}>
      <div className="rounded-lg border border-border/35 bg-background/35 p-3 text-[0.74rem] leading-relaxed text-muted-foreground">
        {body}
      </div>
    </SidebarSection>
  );
}

function StageMaterializedPreview({ stages }: { stages: ScriptBuilderStageState[] }) {
  return (
    <SidebarSection title="Materialized Preview" icon="🧱" defaultOpen={true}>
      {stages.length === 0 ? (
        <div className="rounded-lg border border-border/35 bg-background/35 p-3 text-[0.74rem] text-muted-foreground">
          This node does not currently materialize to backend execution steps.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {stages.map((stage, index) => (
            <div
              key={`${stage.kind}-${stage.entrypoint_kind}-${index}`}
              className="rounded-lg border border-border/35 bg-background/35 p-3"
            >
              <div className="text-[0.66rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Step {index + 1}
              </div>
              <div className="mt-1 text-sm font-semibold text-foreground">
                {stageDisplayName(stage.kind)}
              </div>
              <div className="mt-1 text-[0.72rem] text-muted-foreground">
                {summarizeMaterializedStage(stage)}
              </div>
            </div>
          ))}
        </div>
      )}
    </SidebarSection>
  );
}

export default function StudyPanel({ nodeId }: StudyPanelProps) {
  const transport = useTransport();
  const viewport = useViewport();
  const cmd = useCommand();
  const model = useModel();
  /* Backward-compatible ctx composed from granular hooks */
  const ctx = {
    ...model,
    totalCells: viewport.totalCells,
    workspaceMode: viewport.workspaceMode,
    setWorkspaceMode: viewport.setWorkspaceMode,
    isFemBackend: cmd.isFemBackend,
    activity: cmd.activity,
    workspaceStatus: cmd.workspaceStatus,
    sessionFooter: cmd.sessionFooter,
    runtimeEngineLabel: cmd.runtimeEngineLabel,
    session: cmd.session,
    setRunUntilInput: cmd.setRunUntilInput,
    quantities: cmd.quantities,
    artifacts: cmd.artifacts,
    stateIoBusy: cmd.stateIoBusy,
    effectiveDt: transport.effectiveDt,
    hasSolverTelemetry: transport.hasSolverTelemetry,
  };
  const studyNode = useMemo(
    () => parseStudyNodeContext(nodeId) ?? STUDY_ROOT_NODE,
    [nodeId],
  );
  const externalField =
    ctx.sceneDocument?.study.external_field ??
    ctx.modelBuilderGraph?.study.external_field ??
    null;
  const solverPlan = ctx.solverPlan;
  const backendProfile = solverPlan?.backendKind ? BACKEND_PROFILES[solverPlan.backendKind] : null;
  const integratorProfile = solverPlan?.integrator ? INTEGRATOR_PROFILES[solverPlan.integrator] : null;
  const precisionProfile = solverPlan?.precision ? PRECISION_PROFILES[solverPlan.precision] : null;
  const relaxationProfile = solverPlan?.relaxation?.algorithm
    ? RELAXATION_PROFILES[solverPlan.relaxation.algorithm]
    : null;
  const workloadLabel = ctx.isFemBackend && ctx.femMesh
    ? `${ctx.femMesh.nodes.length.toLocaleString()} nodes · ${ctx.femMesh.elements.length.toLocaleString()} tets`
    : ctx.totalCells && ctx.totalCells > 0
      ? `${ctx.totalCells.toLocaleString()} cells`
      : "—";
  const isBuilderAuthoringMode = ctx.workspaceMode === "build";
  const stageMatch = (ctx.activity.label ?? "").match(/stage\s+(\d+)\/(\d+)/i);
  const activeStageIndex = stageMatch ? Math.max(0, Number(stageMatch[1]) - 1) : null;
  const completedStageCount = stageMatch
    ? Math.max(0, Number(stageMatch[1]) - 1)
    : (ctx.workspaceStatus === "completed" || ctx.workspaceStatus === "awaiting_command")
      ? ctx.studyStages.length
      : 0;
  const stageStatuses = useMemo(
    () =>
      Array.from({ length: ctx.studyStages.length }, (_, index) =>
        activeStageIndex === index
          ? "running"
          : index < completedStageCount
            ? "completed"
            : "pending",
      ),
    [activeStageIndex, completedStageCount, ctx.studyStages.length],
  );

  const authoringDocument = builtAuthoringDocument(
    (ctx.studyPipeline as StudyPipelineDocument | null) ?? null,
    ctx.studyStages,
  );
  const materialized = useMemo(
    () => materializeStudyPipeline(authoringDocument),
    [authoringDocument],
  );

  const selectedAuthoringNode = useMemo<StudyPipelineNode | null>(() => {
    if (studyNode.kind !== "study-stage") return null;
    if (studyNode.source === "pipeline") {
      return findNodeById(authoringDocument.nodes, studyNode.stageKey);
    }
    const flatIndex = Number(studyNode.stageKey);
    return Number.isFinite(flatIndex) ? authoringDocument.nodes[flatIndex] ?? null : null;
  }, [authoringDocument.nodes, studyNode]);

  const selectedCompiledStages = (() => {
    if (studyNode.kind !== "study-stage") return [];
    if (studyNode.source === "pipeline" && selectedAuthoringNode) {
      const entry = findMaterializedEntry(materialized.map, selectedAuthoringNode.id);
      return entry
        ? entry.stageIndexes.map((index) => materialized.stages[index]).filter(Boolean)
        : [];
    }
    const flatIndex = Number(studyNode.stageKey);
    return Number.isFinite(flatIndex) && ctx.studyStages[flatIndex] ? [ctx.studyStages[flatIndex]] : [];
  })();

  const selectedDiagnostics = useMemo(() => {
    if (studyNode.kind !== "study-stage" || !selectedAuthoringNode) return [];
    return materialized.diagnostics.filter((item) => item.nodeId === selectedAuthoringNode.id);
  }, [materialized.diagnostics, selectedAuthoringNode, studyNode]);

  const commitDocument = (next: StudyPipelineDocument) => {
    const compiled = materializeStudyPipeline(next);
    ctx.setStudyPipeline(next);
    ctx.setStudyStages(compiled.stages);
    syncCompatibilityState(ctx, compiled.stages);
  };

  const patchSelectedNode = (patch: Record<string, unknown>) => {
    if (!selectedAuthoringNode) return;
    commitDocument(patchNodeConfig(authoringDocument, selectedAuthoringNode.id, patch));
  };

  const setExternalFieldComponent = (axis: 0 | 1 | 2, rawValue: string) => {
    const parsed = parseOptionalNumber(rawValue);
    ctx.setSceneDocument((previous) => {
      if (!previous) return previous;
      const baseline = previous.study.external_field ?? [0, 0, 0];
      const nextField: [number, number, number] = [...baseline] as [number, number, number];
      nextField[axis] = parsed ?? 0;
      return {
        ...previous,
        study: {
          ...previous.study,
          external_field: nextField,
        },
      };
    });
  };

  const clearExternalField = () => {
    ctx.setSceneDocument((previous) =>
      previous
        ? {
            ...previous,
            study: {
              ...previous.study,
              external_field: null,
            },
          }
        : previous,
    );
  };

  const renderStudyRoot = () => (
    <>
      <SidebarSection
        title="Study"
        icon="🧭"
        badge={`${authoringDocument.nodes.length} stages`}
        defaultOpen={true}
      >
        <div className="rounded-lg border border-border/35 bg-background/35 p-3 text-[0.74rem] leading-relaxed text-muted-foreground">
          This is the COMSOL-like study subsystem root. Authoring lives under <span className="font-semibold text-foreground">Defaults</span> and <span className="font-semibold text-foreground">Stages</span>, while runtime progress stays in the lower dock and status bar.
        </div>
        <div className="mt-3 grid gap-1">
          <InfoRow label="Study kind" value={studyKindForPlan(solverPlan)} />
          <InfoRow label="Stages" value={`${authoringDocument.nodes.length}`} />
          <InfoRow label="Compiled steps" value={`${materialized.stages.length}`} />
          <InfoRow label="Workspace status" value={ctx.workspaceStatus} />
          <InfoRow label="Active workload" value={workloadLabel} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" type="button" onClick={() => ctx.setSelectedSidebarNodeId("study-defaults")}>
            Open Defaults
          </Button>
          <Button size="sm" variant="outline" type="button" onClick={() => ctx.setSelectedSidebarNodeId("study-stages")}>
            Open Stages
          </Button>
        </div>
      </SidebarSection>

      <SidebarSection title="Validation Snapshot" icon="✅" defaultOpen={true}>
        <div className="grid gap-1">
          <InfoRow label="Diagnostics" value={`${materialized.diagnostics.length}`} />
          <InfoRow label="Execution step map" value={`${materialized.map.length} entries`} />
          <InfoRow label="Current stage" value={activeStageIndex != null ? `${activeStageIndex + 1}` : "—"} />
          <InfoRow label="Completed stages" value={`${completedStageCount}`} />
        </div>
      </SidebarSection>
    </>
  );

  const renderDefaultsOverview = () => (
    <>
      <SidebarSection title="Study Defaults" icon="⚙" defaultOpen={true}>
        <div className="rounded-lg border border-border/35 bg-background/35 p-3 text-[0.74rem] leading-relaxed text-muted-foreground">
          Defaults define the baseline runtime, solver and output policy inherited by newly authored stages. Individual stages can diverge later, but this is the first place where the study contract should be configured.
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" type="button" onClick={() => ctx.setSelectedSidebarNodeId("study-defaults-runtime")}>
            Runtime & Backend
          </Button>
          <Button size="sm" variant="outline" type="button" onClick={() => ctx.setSelectedSidebarNodeId("study-defaults-solver")}>
            Solver Defaults
          </Button>
          <Button size="sm" variant="outline" type="button" onClick={() => ctx.setSelectedSidebarNodeId("study-defaults-physics")}>
            Physics Defaults
          </Button>
          <Button size="sm" variant="outline" type="button" onClick={() => ctx.setSelectedSidebarNodeId("study-defaults-outputs")}>
            Outputs Defaults
          </Button>
        </div>
      </SidebarSection>
      <SidebarSection title="Current Default Snapshot" icon="📌" defaultOpen={true}>
        <div className="grid gap-1">
          <InfoRow label="Requested backend" value={humanizeToken(ctx.requestedRuntimeSelection.requested_backend)} />
          <InfoRow label="Requested device" value={humanizeToken(ctx.requestedRuntimeSelection.requested_device)} />
          <InfoRow label="Requested precision" value={humanizeToken(ctx.requestedRuntimeSelection.requested_precision)} />
          <InfoRow label="Integrator" value={ctx.solverSettings.integrator || "—"} />
          <InfoRow label="Fixed dt" value={ctx.solverSettings.fixedTimestep || "adaptive / default"} />
          <InfoRow label="Relax algorithm" value={humanizeToken(ctx.solverSettings.relaxAlgorithm)} />
          <InfoRow label="External field B [T]" value={formatExternalField(externalField)} />
        </div>
      </SidebarSection>
    </>
  );

  const renderRuntimeDefaults = () => (
    <>
      <SidebarSection title="Runtime & Backend" icon="⚙" defaultOpen={true}>
        <SolverSelector />
      </SidebarSection>
      <SidebarSection title="Resolved Runtime" icon="🧠" defaultOpen={true}>
        <div className="grid gap-1">
          <InfoRow label="State" value={ctx.workspaceStatus} />
          <InfoRow label="Engine" value={ctx.runtimeEngineLabel ?? ctx.sessionFooter.requestedBackend ?? "—"} />
          <InfoRow label="Backend" value={humanizeToken(solverPlan?.resolvedBackend ?? solverPlan?.backendKind ?? ctx.sessionFooter.requestedBackend)} />
          <InfoRow label="Mode" value={humanizeToken(solverPlan?.executionMode ?? ctx.session?.execution_mode)} />
          <InfoRow label="Precision" value={humanizeToken(solverPlan?.precision ?? ctx.session?.precision)} />
          <InfoRow label="Workload" value={workloadLabel} />
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {backendProfile && <StatusBadge label={backendProfile.label} />}
          {precisionProfile && <StatusBadge label={precisionProfile.label} />}
          {solverPlan?.demagEnabled && <StatusBadge label="Demag" />}
          {solverPlan?.exchangeEnabled && <StatusBadge label="Exchange" />}
        </div>
      </SidebarSection>
    </>
  );

  const renderSolverDefaults = () => (
    <>
      <SidebarSection title="Solver Defaults" icon="🧮" defaultOpen={true}>
        <div className="rounded-lg border border-border/35 bg-background/35 p-3 text-[0.74rem] leading-relaxed text-muted-foreground">
          These defaults define the baseline time integration and relaxation policy for newly authored stages. Stage-local overrides should be exceptional, not the main authoring path.
        </div>
        <div className="mt-3 grid gap-1">
          <InfoRow label="Integrator" value={integratorProfile?.label ?? humanizeToken(solverPlan?.integrator)} />
          <InfoRow label="Dt control" value={timestepModeForPlan(solverPlan)} />
          <InfoRow label="Precession" value={precessionModeForPlan(solverPlan)} />
          <InfoRow label="Gamma" value={solverPlan?.gyromagneticRatio != null ? `${fmtExp(solverPlan.gyromagneticRatio)} m/(A·s)` : "—"} />
          <InfoRow label="Relax algorithm" value={relaxationProfile?.label ?? humanizeToken(ctx.solverSettings.relaxAlgorithm)} />
        </div>
      </SidebarSection>
      <SidebarSection title="Integrator Defaults" icon="⏱" defaultOpen={true}>
        <IntegratorSettingsPanel
          settings={ctx.solverSettings}
          onChange={ctx.setSolverSettings}
          solverRunning={ctx.workspaceStatus === "running"}
        />
      </SidebarSection>
      <SidebarSection title="Relaxation Defaults" icon="🎯" defaultOpen={true}>
        <RelaxationSettingsPanel
          settings={ctx.solverSettings}
          onChange={ctx.setSolverSettings}
          solverRunning={ctx.workspaceStatus === "running"}
        />
      </SidebarSection>
    </>
  );

  const renderPhysicsDefaults = () => (
    <>
      <SidebarSection title="Physics Defaults" icon="🧲" defaultOpen={true}>
        <div className="rounded-lg border border-border/35 bg-background/35 p-3 text-[0.74rem] leading-relaxed text-muted-foreground">
          Configure the global Zeeman field inherited by authored stages and macros. Stage-level sweeps can override this baseline during execution.
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 @[980px]:grid-cols-3">
          <TextField
            label="Bx [T]"
            value={externalField ? String(externalField[0]) : ""}
            onchange={(event) => setExternalFieldComponent(0, event.target.value)}
            placeholder="0"
            mono
          />
          <TextField
            label="By [T]"
            value={externalField ? String(externalField[1]) : ""}
            onchange={(event) => setExternalFieldComponent(1, event.target.value)}
            placeholder="0"
            mono
          />
          <TextField
            label="Bz [T]"
            value={externalField ? String(externalField[2]) : ""}
            onchange={(event) => setExternalFieldComponent(2, event.target.value)}
            placeholder="0"
            mono
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" type="button" onClick={clearExternalField}>
            Disable External Field
          </Button>
        </div>
      </SidebarSection>
      <SidebarSection title="Current Zeeman Baseline" icon="🧭" defaultOpen={true}>
        <div className="grid gap-1">
          <InfoRow label="External B [T]" value={formatExternalField(externalField)} />
          <InfoRow
            label="Magnitude |B| [T]"
            value={
              externalField
                ? fmtExp(
                    Math.sqrt(
                      externalField[0] ** 2 +
                        externalField[1] ** 2 +
                        externalField[2] ** 2,
                    ),
                  )
                : "—"
            }
          />
        </div>
      </SidebarSection>
    </>
  );

  const renderOutputsDefaults = () => (
    <>
      <SidebarSection title="Outputs Defaults" icon="💾" defaultOpen={true}>
        <div className="rounded-lg border border-border/35 bg-background/35 p-3 text-[0.74rem] leading-relaxed text-muted-foreground">
          Stage-specific output authoring is not yet a first-class contract in the builder. For now this node exposes the inherited live output surface and current artifact availability, so the `Study` tree already has a dedicated place for future output policies instead of overloading the runtime panels.
        </div>
        <div className="mt-3 grid gap-1">
          <InfoRow label="Published quantities" value={`${ctx.quantities.length}`} />
          <InfoRow label="Artifacts" value={`${ctx.artifacts.length}`} />
          <InfoRow label="State I/O" value={ctx.stateIoBusy ? "busy" : "available"} />
          <InfoRow label="Current dt" value={fmtSIOrDash(ctx.effectiveDt, "s", ctx.hasSolverTelemetry)} />
        </div>
      </SidebarSection>
    </>
  );

  const renderStagesPanel = () => (
    <>
      <SidebarSection
        title="Stages"
        icon="🧩"
        badge={isBuilderAuthoringMode ? "authoring" : "read-only"}
        defaultOpen={true}
      >
        <div className="mb-3 rounded-lg border border-border/35 bg-background/35 p-3 text-[0.74rem] text-muted-foreground">
          This is the COMSOL-like stage authoring surface. Add, reorder and configure user-facing stages here. Backend `flat stages` are materialized artifacts derived from this sequence, not the primary editing surface.
        </div>
        {isBuilderAuthoringMode ? (
          <StudyBuilderWorkspace
            stages={ctx.studyStages}
            pipeline={ctx.studyPipeline}
            activeStageIndex={activeStageIndex}
            completedStageCount={completedStageCount}
            stageStatuses={stageStatuses}
            onChangeStages={(next) => {
              ctx.setStudyStages(next);
              syncCompatibilityState(ctx, next);
            }}
            onChangePipeline={(next) => ctx.setStudyPipeline(next)}
          />
        ) : (
          <div className="rounded-lg border border-border/35 bg-background/35 p-3 text-[0.74rem] text-muted-foreground">
            Stage authoring is available in <span className="font-semibold text-foreground">Model Builder</span>.
            <div className="mt-3">
              <Button size="sm" variant="outline" type="button" onClick={() => ctx.setWorkspaceMode("build")}>
                Switch To Model Builder
              </Button>
            </div>
          </div>
        )}
      </SidebarSection>
    </>
  );

  const renderStageSpecificContent = (
    node: StudyPipelineNode,
    context: Extract<StudyNodeContext, { kind: "study-stage" }>,
  ) => {
    const detail = context.detail ?? "overview";
    if (detail === "overview") {
      return (
        <>
          <StageInspector
            node={node}
            onRename={(value) => commitDocument(patchNode(authoringDocument, node.id, { label: value }))}
            onToggleEnabled={() => commitDocument(toggleNodeEnabled(authoringDocument, node.id))}
            onPatchConfig={patchSelectedNode}
            onPatchNotes={(value) => commitDocument(patchNode(authoringDocument, node.id, { notes: value }))}
            compiledStages={selectedCompiledStages}
            diagnostics={selectedDiagnostics}
          />
        </>
      );
    }

    if (detail === "solver") {
      if (node.node_kind !== "primitive") {
        return (
          <StageSectionNote
            title="Stage Solver"
            body="This macro stage expands into multiple backend execution steps. Solver details are inherited by the generated steps and are best reviewed in the materialized preview."
          />
        );
      }
      return (
        <SidebarSection title="Stage Solver" icon="⚙" defaultOpen={true}>
          <div className="grid grid-cols-1 gap-3 @[720px]:grid-cols-2">
            <SelectField
              label="Integrator"
              value={String(node.payload.integrator ?? "rk45")}
              onchange={(value) => patchSelectedNode({ integrator: value })}
              options={[
                { value: "heun", label: "Heun" },
                { value: "rk4", label: "RK4" },
                { value: "rk23", label: "RK23" },
                { value: "rk45", label: "RK45" },
                { value: "abm3", label: "ABM3" },
              ]}
            />
            <TextField
              label="Fixed dt [s]"
              value={String(node.payload.fixed_timestep ?? "")}
              onchange={(event) => patchSelectedNode({ fixed_timestep: event.target.value })}
              placeholder="adaptive / default"
              mono
            />
          </div>
        </SidebarSection>
      );
    }

    if (detail === "time-range") {
      if (node.node_kind !== "primitive" || node.stage_kind !== "run") {
        return <StageSectionNote title="Time Range" body="This node is only meaningful for primitive Run stages." />;
      }
      return (
        <SidebarSection title="Time Range" icon="⏱" defaultOpen={true}>
          <div className="grid grid-cols-1 gap-3 @[720px]:grid-cols-2">
            <TextField
              label="Run until [s]"
              value={String(node.payload.until_seconds ?? "")}
              onchange={(event) => patchSelectedNode({ until_seconds: event.target.value })}
              placeholder="1e-9"
              mono
            />
            <TextField
              label="Fixed dt [s]"
              value={String(node.payload.fixed_timestep ?? "")}
              onchange={(event) => patchSelectedNode({ fixed_timestep: event.target.value })}
              placeholder="adaptive / default"
              mono
            />
          </div>
        </SidebarSection>
      );
    }

    if (detail === "stop-criteria") {
      if (node.node_kind !== "primitive" || node.stage_kind !== "relax") {
        return <StageSectionNote title="Stop Criteria" body="This node is only meaningful for primitive Relax stages." />;
      }
      return (
        <SidebarSection title="Stop Criteria" icon="🎯" defaultOpen={true}>
          <div className="grid grid-cols-1 gap-3 @[720px]:grid-cols-2">
            <SelectField
              label="Relax algorithm"
              value={String(node.payload.relax_algorithm ?? "llg_overdamped")}
              onchange={(value) => patchSelectedNode({ relax_algorithm: value })}
              options={Object.entries(RELAXATION_PROFILES).map(([value, profile]) => ({
                value,
                label: profile.label,
              }))}
            />
            <TextField
              label="Max steps"
              value={String(node.payload.max_steps ?? "5000")}
              onchange={(event) => patchSelectedNode({ max_steps: event.target.value })}
              mono
            />
            <TextField
              label="Torque tolerance"
              value={String(node.payload.torque_tolerance ?? "1e-6")}
              onchange={(event) => patchSelectedNode({ torque_tolerance: event.target.value })}
              mono
            />
            <TextField
              label="Energy tolerance"
              value={String(node.payload.energy_tolerance ?? "")}
              onchange={(event) => patchSelectedNode({ energy_tolerance: event.target.value })}
              placeholder="disabled"
              mono
            />
          </div>
        </SidebarSection>
      );
    }

    if (detail === "equilibrium") {
      if (node.node_kind !== "primitive" || node.stage_kind !== "eigenmodes") {
        return <StageSectionNote title="Equilibrium" body="This node is only meaningful for primitive Eigensolve stages." />;
      }
      return (
        <SidebarSection title="Equilibrium" icon="🧲" defaultOpen={true}>
          <div className="grid grid-cols-1 gap-3 @[720px]:grid-cols-2">
            <SelectField
              label="Equilibrium source"
              value={String(node.payload.eigen_equilibrium_source ?? "relax")}
              onchange={(value) => patchSelectedNode({ eigen_equilibrium_source: value })}
              options={[
                { value: "relax", label: "From relax stage" },
                { value: "provided", label: "Provided state" },
                { value: "artifact", label: "Artifact file" },
              ]}
            />
            <TextField
              label="Spin-wave BC"
              value={String(node.payload.eigen_spin_wave_bc ?? "free")}
              onchange={(event) =>
                patchSelectedNode(
                  patchEigenBcConfig(node.payload, { kind: event.target.value }),
                )
              }
            />
          </div>
        </SidebarSection>
      );
    }

    if (detail === "operator") {
      if (node.node_kind !== "primitive" || node.stage_kind !== "eigenmodes") {
        return <StageSectionNote title="Operator & Spectrum" body="This node is only meaningful for primitive Eigensolve stages." />;
      }
      return (
        <SidebarSection title="Operator & Spectrum" icon="〰" defaultOpen={true}>
          <div className="grid grid-cols-1 gap-3 @[720px]:grid-cols-2">
            <TextField
              label="Mode count"
              value={String(node.payload.eigen_count ?? "10")}
              onchange={(event) => patchSelectedNode({ eigen_count: event.target.value })}
              mono
            />
            <SelectField
              label="Target"
              value={String(node.payload.eigen_target ?? "lowest")}
              onchange={(value) => patchSelectedNode({ eigen_target: value })}
              options={[
                { value: "lowest", label: "Lowest" },
                { value: "nearest", label: "Nearest" },
              ]}
            />
            <TextField
              label="Target frequency [Hz]"
              value={String(node.payload.eigen_target_frequency ?? "")}
              onchange={(event) => patchSelectedNode({ eigen_target_frequency: event.target.value })}
              placeholder="required for nearest"
              mono
            />
            <SelectField
              label="Normalization"
              value={String(node.payload.eigen_normalization ?? "unit_l2")}
              onchange={(value) => patchSelectedNode({ eigen_normalization: value })}
              options={[
                { value: "unit_l2", label: "Unit L2" },
                { value: "unit_max_amplitude", label: "Unit max amplitude" },
              ]}
            />
            <SelectField
              label="Damping"
              value={String(node.payload.eigen_damping_policy ?? "ignore")}
              onchange={(value) => patchSelectedNode({ eigen_damping_policy: value })}
              options={[
                { value: "ignore", label: "Ignore damping" },
                { value: "include", label: "Include damping" },
              ]}
            />
            <TextField
              label="k-vector"
              value={String(node.payload.eigen_k_vector ?? "")}
              onchange={(event) => patchSelectedNode({ eigen_k_vector: event.target.value })}
              placeholder="kx, ky, kz"
              mono
            />
            <SelectField
              label="Include demag"
              value={Boolean(node.payload.eigen_include_demag) ? "yes" : "no"}
              onchange={(value) => patchSelectedNode({ eigen_include_demag: value === "yes" })}
              options={[
                { value: "yes", label: "Enabled" },
                { value: "no", label: "Disabled" },
              ]}
            />
          </div>
        </SidebarSection>
      );
    }

    if (detail === "sweep") {
      if (node.node_kind !== "macro") {
        return <StageSectionNote title="Sweep Definition" body="This node is only meaningful for macro stages that expand into a sweep." />;
      }
      return (
        <SidebarSection title="Sweep Definition" icon="↕" defaultOpen={true}>
          <div className="grid grid-cols-1 gap-3 @[720px]:grid-cols-2">
            {"quantity" in node.config ? (
              <SelectField
                label="Quantity"
                value={String(node.config.quantity ?? "b_ext")}
                onchange={(value) => patchSelectedNode({ quantity: value })}
                options={[
                  { value: "b_ext", label: "External field" },
                  { value: "current", label: "Current" },
                ]}
              />
            ) : null}
            <TextField
              label="Axis"
              value={String(node.config.axis ?? "z")}
              onchange={(event) => patchSelectedNode({ axis: event.target.value })}
            />
            <TextField
              label="Start [mT]"
              value={String(node.config.start_mT ?? -100)}
              onchange={(event) => patchSelectedNode({ start_mT: Number(event.target.value) })}
              mono
            />
            <TextField
              label="Stop [mT]"
              value={String(node.config.stop_mT ?? 100)}
              onchange={(event) => patchSelectedNode({ stop_mT: Number(event.target.value) })}
              mono
            />
            <TextField
              label="Steps"
              value={String(node.config.steps ?? 11)}
              onchange={(event) => patchSelectedNode({ steps: Math.max(2, Number(event.target.value)) })}
              mono
            />
          </div>
        </SidebarSection>
      );
    }

    if (detail === "settle") {
      if (node.node_kind !== "macro") {
        return <StageSectionNote title="Settle Stage" body="This node is only meaningful for macro stages that generate a repeated settle step." />;
      }
      return (
        <SidebarSection title="Settle Stage" icon="🧲" defaultOpen={true}>
          <div className="grid grid-cols-1 gap-3 @[720px]:grid-cols-2">
            <SelectField
              label="Per-point settle"
              value={node.config.relax_each !== false ? "relax" : "run"}
              onchange={(value) => patchSelectedNode({ relax_each: value === "relax" })}
              options={[
                { value: "relax", label: "Relax each point" },
                { value: "run", label: "Run only" },
              ]}
            />
            {"save_point_state" in node.config ? (
              <SelectField
                label="Save point state"
                value={Boolean(node.config.save_point_state) ? "yes" : "no"}
                onchange={(value) => patchSelectedNode({ save_point_state: value === "yes" })}
                options={[
                  { value: "no", label: "No" },
                  { value: "yes", label: "Yes" },
                ]}
              />
            ) : null}
          </div>
        </SidebarSection>
      );
    }

    if (detail === "outputs") {
      return (
        <>
          <StageSectionNote
            title="Outputs"
            body="Stage-specific output authoring is still inherited from the broader builder/runtime contract. This dedicated node already exists so output policies can move here cleanly without overloading the runtime panels."
          />
          <StageMaterializedPreview stages={selectedCompiledStages} />
        </>
      );
    }

    if (detail === "materialized") {
      return <StageMaterializedPreview stages={selectedCompiledStages} />;
    }

    return <StageSectionNote title="Study Stage" body="No dedicated inspector exists for this stage node yet." />;
  };

  if (studyNode.kind === "simulation-root" || studyNode.kind === "study-root") {
    return renderStudyRoot();
  }
  if (studyNode.kind === "study-defaults") {
    return renderDefaultsOverview();
  }
  if (studyNode.kind === "study-runtime-defaults") {
    return renderRuntimeDefaults();
  }
  if (studyNode.kind === "study-solver-defaults") {
    return renderSolverDefaults();
  }
  if (studyNode.kind === "study-physics-defaults") {
    return renderPhysicsDefaults();
  }
  if (studyNode.kind === "study-outputs-defaults") {
    return renderOutputsDefaults();
  }
  if (studyNode.kind === "study-stages" || studyNode.kind === "study-stage-empty") {
    return renderStagesPanel();
  }

  if (studyNode.kind === "study-stage" && selectedAuthoringNode) {
    return renderStageSpecificContent(selectedAuthoringNode, studyNode);
  }

  return (
    <>
      <SidebarSection title="Study" icon="🧭" defaultOpen={true}>
        <div className="rounded-lg border border-border/35 bg-background/35 p-3 text-[0.74rem] leading-relaxed text-muted-foreground">
          Study routing could not resolve this node precisely, so the panel fell back to the stage authoring root.
        </div>
      </SidebarSection>
      {renderStagesPanel()}
    </>
  );
}
