"use client";

import { useMemo } from "react";
import { resolveFemDiscretization } from "@/src/domain/capabilities";
import type { MeshPeriodicPairEntry } from "@/src/api/types";
import { usePeriodicPairs, useStageExecution } from "@/src/hooks/resources";
import { fmtExp } from "@/lib/format";
import { getFemElementCount, getFemNodeCount } from "@/lib/session/femTopology";
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
import { useCommand, useTransport, useViewport } from "../../runs/control-room/context-hooks";
import {
  selectSolverPlan,
  selectSolverSettings,
  selectStudyPipeline,
  selectStudyStages,
  useDocumentStore,
} from "@/features/document/store/useDocumentStore";
import {
  selectFemMesh,
  selectResourceRevisions,
  selectSession,
  useSessionRuntimeStore,
} from "@/features/session-runtime/store/useSessionRuntimeStore";
import { useSelectionActions } from "@/features/selection";
import { Button } from "../../ui/button";
import MetricTile from "../../ui/MetricTile";
import SelectField from "../../ui/SelectField";
import TextField from "../../ui/TextField";
import {
  RELAXATION_PROFILES,
} from "./profiles";
import {
  humanizeToken,
  studyKindForPlan,
} from "./helpers";
import { InfoRow, SidebarSection, StatusBadge } from "./primitives";
import { buildRelaxationInspectorState } from "./relaxationInspector";

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

function parsePairIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function formatPairIdsInput(value: unknown): string {
  return parsePairIds(value).join(", ");
}

function isPeriodicPairOk(pair: MeshPeriodicPairEntry): boolean {
  return pair.status.toLowerCase() === "ok";
}

function periodicPairTone(pair: MeshPeriodicPairEntry): "success" | "warn" | "default" {
  if (isPeriodicPairOk(pair)) return "success";
  return pair.unpaired_source_node_count > 0 || pair.unpaired_destination_node_count > 0
    ? "warn"
    : "default";
}

function formatPairResidual(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : `${fmtExp(value)} m`;
}

function formatPairMarkers(pair: MeshPeriodicPairEntry): string {
  const source = pair.source_marker || `marker ${pair.marker_a}`;
  const destination = pair.destination_marker || `marker ${pair.marker_b}`;
  return `${source} -> ${destination}`;
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
      <div className="rounded-lg border border-border/10 bg-card/40 p-3 text-[0.74rem] leading-relaxed text-muted-foreground">
        {body}
      </div>
    </SidebarSection>
  );
}

function StageMaterializedPreview({ stages }: { stages: ScriptBuilderStageState[] }) {
  return (
    <SidebarSection title="Materialized Preview" icon="🧱" defaultOpen={true}>
      {stages.length === 0 ? (
        <div className="rounded-lg border border-border/10 bg-card/40 p-3 text-[0.74rem] text-muted-foreground">
          This node does not currently materialize to backend execution steps.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {stages.map((stage, index) => (
            <div
              key={`${stage.kind}-${stage.entrypoint_kind}-${index}`}
              className="rounded-lg border border-border/10 bg-card/40 p-3"
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
  const selectionActions = useSelectionActions();
  const solverPlan = useDocumentStore(selectSolverPlan);
  const solverSettings = useDocumentStore(selectSolverSettings);
  const setSolverSettings = useDocumentStore((state) => state.setSolverSettings);
  const studyStages = useDocumentStore(selectStudyStages);
  const studyPipeline = useDocumentStore(selectStudyPipeline);
  const setStudyStages = useDocumentStore((state) => state.setStudyStages);
  const setStudyPipeline = useDocumentStore((state) => state.setStudyPipeline);
  const session = useSessionRuntimeStore(selectSession);
  const femMesh = useSessionRuntimeStore(selectFemMesh);
  const resourceRevisions = useSessionRuntimeStore(selectResourceRevisions);
  const sceneResourceSessionKey = session?.session_id ?? null;
  /* Backward-compatible ctx composed from granular hooks */
  const ctx = {
    ...selectionActions,
    solverPlan,
    solverSettings,
    setSolverSettings,
    studyStages,
    studyPipeline,
    setStudyStages,
    setStudyPipeline,
    femMesh,
    sceneResourceSessionKey,
    resourceRevisions,
    totalCells: viewport.totalCells,
    workspaceMode: viewport.workspaceStage,
    setWorkspaceMode: viewport.setWorkspaceStage,
    isFemBackend: cmd.isFemBackend,
    domainCapabilities: cmd.domainCapabilities,
    activity: cmd.activity,
    workspaceStatus: cmd.workspaceStatus,
    sessionFooter: cmd.sessionFooter,
    runtimeEngineLabel: cmd.runtimeEngineLabel,
    session,
    engineLog: cmd.engineLog,
    setRunUntilInput: cmd.setRunUntilInput,
    quantities: cmd.quantities,
    artifacts: cmd.artifacts,
    stateIoBusy: cmd.stateIoBusy,
    effectiveDt: transport.effectiveDt,
    hasSolverTelemetry: transport.hasSolverTelemetry,
    scalarRows: transport.scalarRows,
  };
  const periodicPairsResource = usePeriodicPairs({
    enabled: true,
    sessionKey: ctx.sceneResourceSessionKey ?? ctx.session?.session_id ?? null,
    revision: ctx.resourceRevisions?.mesh_revision ?? ctx.resourceRevisions?.mesh_build_revision ?? null,
  });
  const stageExecutionResource = useStageExecution({
    enabled: true,
    sessionKey: ctx.sceneResourceSessionKey ?? ctx.session?.session_id ?? null,
    revision: ctx.resourceRevisions?.stages_revision ?? null,
  });
  const periodicPairs = periodicPairsResource.periodicPairs?.pairs ?? [];
  const studyNode = useMemo(
    () => parseStudyNodeContext(nodeId) ?? STUDY_ROOT_NODE,
    [nodeId],
  );
  const femDiscretization = resolveFemDiscretization(ctx.domainCapabilities, false);
  const femNodeCount = ctx.femMesh ? getFemNodeCount(ctx.femMesh) : 0;
  const femElementCount = ctx.femMesh ? getFemElementCount(ctx.femMesh) : 0;
  const workloadLabel = femDiscretization && ctx.femMesh
    ? `${femNodeCount.toLocaleString('en-US')} nodes · ${femElementCount.toLocaleString('en-US')} tets`
    : ctx.totalCells && ctx.totalCells > 0
      ? `${ctx.totalCells.toLocaleString('en-US')} cells`
      : "—";
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

  const selectedStageIndexes = useMemo(() => {
    if (studyNode.kind !== "study-stage") return [];
    if (studyNode.source === "pipeline" && selectedAuthoringNode) {
      const entry = findMaterializedEntry(materialized.map, selectedAuthoringNode.id);
      return entry?.stageIndexes ?? [];
    }
    const flatIndex = Number(studyNode.stageKey);
    return Number.isFinite(flatIndex) && ctx.studyStages[flatIndex] ? [flatIndex] : [];
  }, [ctx.studyStages, materialized.map, selectedAuthoringNode, studyNode]);

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

  const renderStudyRoot = () => (
    <>
      <SidebarSection
        title="Study"
        icon="🧭"
        badge={`${authoringDocument.nodes.length} stages`}
        defaultOpen={true}
      >
        <div className="rounded-lg border border-border/10 bg-card/40 p-3 text-[0.74rem] leading-relaxed text-muted-foreground">
          Study focuses on stage authoring, stage materialization and stage outputs. Physics and runtime defaults are configured outside this branch to avoid semantic duplication.
        </div>
        <div className="mt-3 grid gap-1">
          <InfoRow label="Study kind" value={studyKindForPlan(solverPlan)} />
          <InfoRow label="Stages" value={`${authoringDocument.nodes.length}`} />
          <InfoRow label="Compiled steps" value={`${materialized.stages.length}`} />
          <InfoRow label="Workspace status" value={humanizeToken(ctx.workspaceStatus)} />
          <InfoRow label="Active workload" value={workloadLabel} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
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

  const renderStagesPanel = () => (
    <>
      <SidebarSection
        title="Stages"
        icon="🧩"
        badge="authoring"
        defaultOpen={true}
      >
        <div className="mb-3 rounded-lg border border-border/10 bg-card/40 p-3 text-[0.74rem] text-muted-foreground">
          This is the COMSOL-like stage authoring surface. Add, reorder and configure user-facing stages here. Backend `flat stages` are materialized artifacts derived from this sequence, not the primary editing surface.
        </div>
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
              label={node.stage_kind === "relax" ? "Solver / integrator" : "Integrator"}
              value={String(node.payload.integrator ?? (node.stage_kind === "relax" ? "auto" : "rk45"))}
              onchange={(value) => patchSelectedNode({ integrator: value })}
              options={[
                { value: "auto", label: "Auto (RK23 for relax)" },
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
      const torqueToleranceText = String(node.payload.torque_tolerance ?? "");
      const legacyTorqueDefault = torqueToleranceText.trim() === "1e-6";
      const stageIndex = selectedStageIndexes[0] ?? null;
      const stageRecord =
        stageIndex != null
          ? stageExecutionResource.stageExecution?.stages[stageIndex] ?? null
          : null;
      const stageStatus =
        stageIndex != null
          ? stageExecutionResource.stageExecution?.stage_statuses[stageIndex] ?? null
          : null;
      const relaxRuntime = buildRelaxationInspectorState({
        payload: node.payload,
        stageExecutionRecord: stageRecord,
        stageStatus,
        scalarRows: ctx.scalarRows,
        liveState: transport.liveState,
      });
      return (
        <SidebarSection title="Stop Criteria" icon="🎯" defaultOpen={true}>
          {legacyTorqueDefault ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[0.72rem] leading-relaxed text-amber-100">
              This relax stage still carries the stale legacy torque default `1e-6 A/m`.
              That threshold is much stricter than the canonical `1e-4 A/m` product default and can
              push already-relaxed layouts all the way to `max_steps`.
              <div className="mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => patchSelectedNode({ torque_tolerance: "1e-4" })}
                >
                  Use canonical 1e-4 A/m
                </Button>
              </div>
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-3 @[720px]:grid-cols-2">
            <MetricTile
              label={relaxRuntime.overviewLabel}
              value={
                relaxRuntime.overviewAuxValue
                  ? `${relaxRuntime.overviewValue} · ${relaxRuntime.overviewAuxValue}`
                  : relaxRuntime.overviewValue
              }
              detail={relaxRuntime.overviewDetail}
              progress={relaxRuntime.overviewProgress ?? undefined}
              tone={relaxRuntime.overviewTone}
            />
            <MetricTile
              label="Runtime stop record"
              value={relaxRuntime.lastStopLabel}
              detail={relaxRuntime.lastStopDetail}
              progress={
                stageRecord?.reason != null || stageStatus === "completed" || stageStatus === "done"
                  ? 100
                  : undefined
              }
              tone={
                stageRecord?.reason === "backend_error"
                  ? "danger"
                  : stageRecord?.reason === "max_steps" ||
                      stageRecord?.reason === "max_pseudotime" ||
                      stageRecord?.reason === "max_physical_time"
                    ? "warn"
                    : "default"
              }
            />
          </div>
          <div className="rounded-lg border border-border/10 bg-card/35 p-3 text-[0.72rem] leading-relaxed text-muted-foreground">
            {relaxRuntime.semantics}
          </div>
          {relaxRuntime.metrics.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 @[720px]:grid-cols-2">
              {relaxRuntime.metrics.map((metric) => (
                <MetricTile
                  key={metric.key}
                  label={metric.label}
                  value={metric.value}
                  detail={metric.detail}
                  progress={metric.progress ?? undefined}
                  tone={metric.tone}
                />
              ))}
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-3 @[720px]:grid-cols-2">
            <SelectField
              label="Relax algorithm"
              value={String(node.payload.relax_algorithm ?? "llg_overdamped")}
              onchange={(value) => patchSelectedNode({ relax_algorithm: value })}
              options={Object.entries(RELAXATION_PROFILES).map(([value, profile]) => ({
                value,
                label: value === "tangent_plane_implicit" ? `${profile.label} (planned)` : profile.label,
                disabled: value === "tangent_plane_implicit",
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
              value={String(node.payload.torque_tolerance ?? "1e-4")}
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
            <TextField
              label="Adaptive max error"
              value={String(node.payload.max_error ?? "")}
              onchange={(event) => patchSelectedNode({ max_error: event.target.value })}
              placeholder="RK23/RK45 only"
              mono
            />
            <TextField
              label="Max pseudotime [s]"
              value={String(node.payload.max_pseudotime_s ?? "")}
              onchange={(event) => patchSelectedNode({ max_pseudotime_s: event.target.value })}
              mono
            />
            <TextField
              label="Max physical time [s]"
              value={String(node.payload.max_physical_time_s ?? "")}
              onchange={(event) => patchSelectedNode({ max_physical_time_s: event.target.value })}
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
      const bcConfig = eigenBcConfig(node.payload);
      const bcKind = String(node.payload.eigen_spin_wave_bc ?? "free");
      const isPeriodicBc = ["periodic", "floquet"].includes(bcKind);
      const selectedPairIds = parsePairIds(bcConfig.pair_ids);
      const okPairIds = periodicPairs.filter(isPeriodicPairOk).map((pair) => pair.pair_id);
      const setPairIds = (pairIds: string[]) => {
        patchSelectedNode(patchEigenBcConfig(node.payload, { pair_ids: pairIds }));
      };
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
              value={bcKind}
              onchange={(event) =>
                patchSelectedNode(
                  patchEigenBcConfig(node.payload, { kind: event.target.value }),
                )
              }
            />
            {isPeriodicBc ? (
              <TextField
                label="Periodic pair IDs"
                value={formatPairIdsInput(bcConfig.pair_ids)}
                onchange={(event) =>
                  setPairIds(parsePairIds(event.target.value))
                }
                placeholder="x_periodic, y_periodic"
                mono
              />
            ) : null}
            {bcKind === "floquet" ? (
              <TextField
                label="Phase convention"
                value={String(
                  bcConfig.phase_convention
                    ?? "exp_minus_i_k_dot_delta_r",
                )}
                onchange={(event) =>
                  patchSelectedNode(
                    patchEigenBcConfig(node.payload, {
                      phase_convention: event.target.value,
                    }),
                  )
                }
                mono
              />
            ) : null}
          </div>
          {isPeriodicBc ? (
            <div className="mt-3 rounded-lg border border-border/10 bg-card/30 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">
                    Periodic Pair Diagnostics
                  </div>
                  <div className="mt-1 text-[0.72rem] text-muted-foreground">
                    {selectedPairIds.length
                      ? `Selected: ${selectedPairIds.join(", ")}`
                      : "No periodic pair selected for this eigensolve stage."}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => void periodicPairsResource.refresh()}
                >
                  Refresh
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  disabled={okPairIds.length === 0}
                  onClick={() => setPairIds(okPairIds)}
                >
                  Use OK pairs
                </Button>
              </div>
              {periodicPairsResource.loading ? (
                <div className="mt-3 text-[0.72rem] text-muted-foreground">
                  Loading periodic pair artifact...
                </div>
              ) : periodicPairsResource.error ? (
                <div className="mt-3 text-[0.72rem] text-warning">
                  Failed to load periodic pair diagnostics.
                </div>
              ) : periodicPairs.length === 0 ? (
                <div className="mt-3 text-[0.72rem] text-muted-foreground">
                  No periodic_pairs.v1 artifact is available for the current mesh.
                </div>
              ) : (
                <div className="mt-3 grid gap-2">
                  {periodicPairs.map((pair) => {
                    const selected = selectedPairIds.includes(pair.pair_id);
                    return (
                      <div
                        key={pair.pair_id}
                        className="rounded-md border border-border/10 bg-background/35 p-2"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-foreground">
                            {pair.pair_id}
                          </span>
                          <StatusBadge label={pair.status} tone={periodicPairTone(pair)} dot />
                          {selected ? <StatusBadge label="selected" tone="accent" /> : null}
                          <Button
                            size="sm"
                            variant="ghost"
                            type="button"
                            className="ml-auto h-7 px-2 text-xs"
                            onClick={() => setPairIds([pair.pair_id])}
                          >
                            Use
                          </Button>
                        </div>
                        <div className="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 text-[0.68rem] text-muted-foreground @[720px]:grid-cols-2">
                          <div>
                            <span className="font-semibold uppercase tracking-wider">Markers </span>
                            <span className="font-mono">{formatPairMarkers(pair)}</span>
                          </div>
                          <div>
                            <span className="font-semibold uppercase tracking-wider">Paired </span>
                            <span className="font-mono">{pair.paired_node_count.toLocaleString()}</span>
                          </div>
                          <div>
                            <span className="font-semibold uppercase tracking-wider">Unpaired </span>
                            <span className="font-mono">
                              {pair.unpaired_source_node_count.toLocaleString()} / {pair.unpaired_destination_node_count.toLocaleString()}
                            </span>
                          </div>
                          <div>
                            <span className="font-semibold uppercase tracking-wider">Max residual </span>
                            <span className="font-mono">{formatPairResidual(pair.max_residual_m)}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
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
            <TextField
              label="k-path"
              value={String(node.payload.eigen_k_path ?? "")}
              onchange={(event) => patchSelectedNode({ eigen_k_path: event.target.value })}
              placeholder="Γ:0,0,0; X:3.14e7,0,0 | samples=41"
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
  if (studyNode.kind === "study-stages" || studyNode.kind === "study-stage-empty") {
    return renderStagesPanel();
  }

  if (studyNode.kind === "study-stage" && selectedAuthoringNode) {
    return renderStageSpecificContent(selectedAuthoringNode, studyNode);
  }

  return (
    <>
      <SidebarSection title="Study" icon="🧭" defaultOpen={true}>
        <div className="rounded-lg border border-border/10 bg-card/40 p-3 text-[0.74rem] leading-relaxed text-muted-foreground">
          Study routing could not resolve this node precisely, so the panel fell back to the stage authoring root.
        </div>
      </SidebarSection>
      {renderStagesPanel()}
    </>
  );
}
