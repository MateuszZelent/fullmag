"use client";

import { useEffect, useMemo, useState } from "react";
import StatusBar from "@/components/shell/StatusBar";
import { resolveFemDiscretization } from "@/src/domain/capabilities";
import {
  fmtDuration,
  fmtSIOrDash,
  fmtStepValue,
  materializationProgressFromMessage,
  resolveStudyStageExecutionState,
} from "./shared";
import { extractFemCpuThreadSummary } from "./helpers";
import {
  selectRequestedRuntimeSelection,
  selectSolverPlan,
  selectSolverSettings,
  selectStudyStages,
  useDocumentStore,
} from "@/features/document/store/useDocumentStore";
import {
  selectFemMesh,
  selectMeshWorkspace,
  useSessionRuntimeStore,
} from "@/features/session-runtime/store/useSessionRuntimeStore";
import { useCommand, useTransport, useViewport } from "./context-hooks";

interface ControlRoomStatusBarProps {
  meshBuildGenerating: boolean;
}

function parsePositiveNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveFiniteMin(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.min(...values);
}

function resolveFiniteMax(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.max(...values);
}

export default function ControlRoomStatusBar({ meshBuildGenerating }: ControlRoomStatusBarProps) {
  const transport = useTransport();
  const viewport = useViewport();
  const command = useCommand();
  const solverPlan = useDocumentStore(selectSolverPlan);
  const solverSettings = useDocumentStore(selectSolverSettings);
  const studyStages = useDocumentStore(selectStudyStages);
  const requestedRuntimeSelection = useDocumentStore(selectRequestedRuntimeSelection);
  const femMesh = useSessionRuntimeStore(selectFemMesh);
  const meshWorkspace = useSessionRuntimeStore(selectMeshWorkspace);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!transport.sessionStartedAt || transport.sessionFinishedAt > transport.sessionStartedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [transport.sessionStartedAt, transport.sessionFinishedAt]);

  const elapsed = transport.sessionStartedAt
    ? (transport.sessionFinishedAt > transport.sessionStartedAt
        ? transport.sessionFinishedAt - transport.sessionStartedAt
        : now - transport.sessionStartedAt)
    : 0;
  const stepsPerSec = elapsed > 0 ? (transport.effectiveStep / elapsed) * 1000 : 0;
  const femDiscretization = resolveFemDiscretization(
    command.domainCapabilities,
    command.isFemBackend,
  );
  const femCpuThreadSummary = useMemo(
    () => extractFemCpuThreadSummary(command.engineLog),
    [command.engineLog],
  );
  const commandSolverIntegrators = solverPlan?.integrator ?? solverSettings.integrator;
  const commandAdaptiveDtMin = solverPlan?.adaptive?.dtMin;
  const commandAdaptiveDtMax = solverPlan?.adaptive?.dtMax;
  const commandFixedDtFromPlan = solverPlan?.fixedTimestep;
  const commandFixedDtFromSettings = parsePositiveNumber(solverSettings.fixedTimestep);
  const commandSolverDtSamples = useMemo(
    () =>
      transport.scalarRows
        .slice(-128)
        .map((row) => row.solver_dt)
        .filter(isPositiveFinite),
    [transport.scalarRows],
  );
  const commandMinDt = useMemo(() => {
    if (!transport.hasSolverTelemetry) return null;
    return isPositiveFinite(commandAdaptiveDtMin)
      ? commandAdaptiveDtMin
      : resolveFiniteMin(commandSolverDtSamples);
  }, [commandAdaptiveDtMin, transport.hasSolverTelemetry, commandSolverDtSamples]);
  const commandMaxDt = useMemo(() => {
    if (!transport.hasSolverTelemetry) return null;
    return isPositiveFinite(commandAdaptiveDtMax)
      ? commandAdaptiveDtMax
      : resolveFiniteMax(commandSolverDtSamples);
  }, [commandAdaptiveDtMax, transport.hasSolverTelemetry, commandSolverDtSamples]);
  const commandFixedDt = useMemo(() => {
    if (isPositiveFinite(commandFixedDtFromPlan)) {
      return commandFixedDtFromPlan;
    }
    return commandFixedDtFromSettings;
  }, [commandFixedDtFromPlan, commandFixedDtFromSettings]);
  const footerPipeline = useMemo(() => {
    const meshPhases = meshWorkspace?.mesh_pipeline_status ?? [];
    const doneMeshPhases = meshPhases.filter((phase) => phase.status === "done").length;
    const activeMeshPhase = meshPhases.find((phase) => phase.status === "active");
    if (command.workspaceStatus === "bootstrapping") {
      return {
        label: "Bootstrap pipeline",
        detail: command.activity.detail,
        mode: "indeterminate" as const,
        value: undefined,
      };
    }
    if (command.workspaceStatus === "materializing_script") {
      const progress = materializationProgressFromMessage(command.activity.detail ?? null);
      return {
        label: activeMeshPhase ? `Mesh pipeline · ${activeMeshPhase.label}` : "Materialization pipeline",
        detail: activeMeshPhase?.detail ?? command.activity.detail,
        mode: "determinate" as const,
        value: progress,
      };
    }
    if (meshPhases.length > 0 && meshBuildGenerating) {
      const activeIndex = meshPhases.findIndex((phase) => phase.status === "active");
      const completed = doneMeshPhases + (activeIndex >= 0 ? 0.5 : 0);
      return {
        label: activeMeshPhase ? `Mesh pipeline · ${activeMeshPhase.label}` : "Mesh pipeline",
        detail: activeMeshPhase?.detail ?? command.activity.detail,
        mode: "determinate" as const,
        value: Math.min(100, (completed / meshPhases.length) * 100),
      };
    }
    return {
      label: "Workspace pipeline",
      detail: command.activity.detail,
      mode: "determinate" as const,
      value: command.workspaceStatus === "running" || command.workspaceStatus === "completed" || command.workspaceStatus === "awaiting_command" ? 100 : 0,
    };
  }, [
    command.activity.detail,
    meshWorkspace?.mesh_pipeline_status,
    command.workspaceStatus,
    meshBuildGenerating,
  ]);
  const footerStage = useMemo(() => {
    const stages = studyStages ?? [];
    const resolved = resolveStudyStageExecutionState({
      stageExecution: command.stageExecution,
      totalStages: stages.length,
      workspaceStatus: command.workspaceStatus,
      activityLabel: command.activity.label,
    });
    const declaredTotal = resolved.declaredTotal;
    if (declaredTotal <= 0) {
      return {
        label: "Study stages",
        detail: "No scripted stages declared",
        mode: "idle" as const,
        value: undefined,
      };
    }
    const completedStages = resolved.completedStageIndexes.length;
    const activeStageNumber =
      resolved.activeStageIndex != null ? resolved.activeStageIndex + 1 : completedStages;
    const inFlightWeight =
      resolved.activeStageIndex != null && command.workspaceStatus === "running"
        ? 0.5
        : command.workspaceStatus === "completed" || command.workspaceStatus === "awaiting_command"
          ? 0
          : 0;
    const progress = Math.min(100, ((completedStages + inFlightWeight) / declaredTotal) * 100);
    const activeStageKind =
      resolved.activeStageKind ??
      (resolved.activeStageIndex != null
        ? stages[resolved.activeStageIndex]?.kind ?? null
        : null);
    return {
      label: `Study stages ${Math.max(activeStageNumber, completedStages)}/${declaredTotal}`,
      detail:
        resolved.activeStageIndex != null
          ? `Running ${activeStageKind ?? "stage"}`
          : activeStageKind ?? stages[Math.max(0, completedStages - 1)]?.kind ?? "Waiting for first scripted stage",
      mode: "determinate" as const,
      value: command.workspaceStatus === "completed" || command.workspaceStatus === "awaiting_command" ? 100 : progress,
    };
  }, [command.activity.label, command.stageExecution, studyStages, command.workspaceStatus]);

  const step = transport.effectiveLiveState?.step ?? command.run?.total_steps ?? 0;
  const time = transport.effectiveLiveState?.time ?? command.run?.final_time ?? 0;

  return (
    <StatusBar
      connection={command.connection}
      step={step}
      stepDisplay={fmtStepValue(step, transport.hasSolverTelemetry)}
      simTime={fmtSIOrDash(time, "s", transport.hasSolverTelemetry)}
      wallTime={elapsed > 0 ? fmtDuration(elapsed) : "—"}
      throughput={stepsPerSec > 0 ? `${stepsPerSec.toFixed(1)} st/s` : "—"}
      backend={command.session?.requested_backend ?? ""}
      runtimeEngine={command.runtimeEngineLabel ?? undefined}
      runtimeGpuLabel={command.runtimeEngineGpuLabel ?? undefined}
      precision={command.session?.precision ?? ""}
      requestedCpuThreads={command.session?.requested_cpu_threads ?? requestedRuntimeSelection.requested_cpu_threads ?? null}
      resolvedCpuThreads={command.session?.resolved_cpu_threads ?? null}
      requestedFemOmpThreads={femCpuThreadSummary?.requestedOmpThreads ?? null}
      effectiveFemOmpThreads={femCpuThreadSummary?.effectiveOmpThreads ?? null}
      status={command.workspaceStatus}
      activityLabel={command.activity.label}
      activityDetail={command.activity.detail}
      progressMode={command.activity.progressMode}
      progressValue={command.activity.progressValue}
      commandMessage={command.commandMessage}
      commandState={
        command.activeCommandState === "acknowledged"
          ? "progress"
          : command.activeCommandState === "completed"
            ? "success"
            : command.activeCommandState === "rejected"
              ? "rejected"
              : undefined
      }
      displayLabel={viewport.selectedQuantityLabel}
      displayDetail={
        viewport.selectedScalarValue != null
          ? `${viewport.selectedScalarValue.toExponential(4)} ${viewport.selectedQuantityUnit ?? ""}`.trim()
          : viewport.isVectorQuantity
            ? viewport.requestedPreviewComponent
            : "scalar"
      }
      previewPending={viewport.previewBusy}
      runtimeCanAcceptCommands={command.runtimeCanAcceptCommands}
      pipelineLabel={footerPipeline.label}
      pipelineDetail={footerPipeline.detail}
      pipelineProgressMode={footerPipeline.mode}
      pipelineProgressValue={footerPipeline.value}
      stageLabel={footerStage.label}
      stageDetail={footerStage.detail}
      stageProgressMode={footerStage.mode}
      stageProgressValue={footerStage.value}
      eTotalSpark={transport.eTotalSpark}
      dmDtSpark={transport.dmDtSpark}
      hasSolverTelemetry={transport.hasSolverTelemetry}
      solverDt={transport.effectiveDt}
      solverMinDt={commandMinDt}
      solverMaxDt={commandMaxDt}
      solverFixedDt={commandFixedDt}
      solverIntegrator={commandSolverIntegrators}
      nodeCount={femDiscretization && femMesh
        ? `${femMesh.nodes.length.toLocaleString()} nodes`
        : viewport.totalCells && viewport.totalCells > 0
          ? `${viewport.totalCells.toLocaleString()} cells`
          : undefined}
    />
  );
}
