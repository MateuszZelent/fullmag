"use client";

import {
  Activity,
  Database,
  FileOutput,
  Play,
  Timer,
  Workflow,
  Zap,
} from "lucide-react";
import { useContext, useMemo, useState } from "react";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { KernelContext } from "@/kernel/KernelContext";
import type { StageInitialStateChoice } from "@/kernel/runtime/studyStageInitialState";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import {
  inspectorValuesEqual,
  type InspectorFact,
  type InspectorNotice,
  type InspectorSpec,
} from "../../../template";
import {
  regionalFieldDriveSamplingContext,
} from "../../../panels/RegionalFieldDrivePanelModel";
import type { StudyStageModel } from "../../../panels/StudyInspectorPanelModel";
import {
  createDefaultStudyStageDraft,
  readStageTextureAssignments,
  validateStudyStageDraft,
  type StudyStageDraft,
} from "../../../panels/StudyStageAuthoringModel";
import {
  computeSamplingPlanMetrics,
  formatBytesBinary,
  formatFrequencyCompact,
  formatTimeCompact,
  PipelineStrip,
  SamplingPlanCard,
  TIME_UNITS_SI,
  type PipelineStripStep,
} from "../../../panels/study/ConnectedInspectorSpec";
import { useKernelStudyAuthoring } from "../../../panels/study/useConnectedStudyAuthoring";
import { SamplingDiagnostics } from "../../../panels/stages/SamplingDiagnostics";
import { formatEngineering } from "../../../panels/stages/samplingPresentation";
import {
  serializeStageEnabled,
  StageAutosaveRadixEditor,
  StageInitialStateRadixControl,
  StageLiveTelemetryPanel,
  StageSpecHost,
  StageTextureOverridesRow,
  StudyStageTelemetryBridge,
} from "../../../panels/stages/StageSharedControls";
import {
  resolveStudyWorkflowStateBefore,
  validateStudyWorkflow,
  type EffectiveStudyWorkflowState,
} from "../../../panels/stages/studyWorkflowState";
import {
  type StageValidationContext,
  stageBreadcrumbs,
  resolveStageMeta,
  DEFAULT_RUN_AUTOSAVE,
  type RunStageDraft,
  type RunWorkflowDisplayInfo,
} from "./stageShared";
export function RunStageInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedRunStageInspectorPanel selection={selection} />;
  }
  return <RunStageInspectorPanelView selection={selection} />;
}

function ConnectedRunStageInspectorPanel({ selection }: InspectorPanelProps) {
  const {
    commitSelectedStageDraft,
    executeSelectedStage,
    globalDraft,
    lastAuthoringError,
    pipelineStripSteps,
    runtimeStatus,
    sceneData,
    sceneRevision,
    selectedStageDraft,
    selectedStageIndex,
    stageDrafts,
  } = useKernelStudyAuthoring(selection);

  const hydratedBaseline = useMemo<RunStageDraft>(() => {
    const d: Partial<StudyStageDraft> =
      selectedStageDraft?.kind === "run" ? selectedStageDraft : {};
    const stageId =
      d.stageId ||
      (selection.ref?.type === "study-stage" && selection.ref.stageId
        ? selection.ref.stageId
        : `run_${selectedStageIndex + 1}`);
    return {
      stageId,
      stageEnabled: d.stageEnabled ?? true,
      untilSeconds: Number(d.untilSeconds) || 1e-9,
      legacyRunFixedTimestep: d.legacyRunFixedTimestep ?? "",
      stageAutosave: d.stageAutosave ?? DEFAULT_RUN_AUTOSAVE,
      stageMagnetizationAssignments: d.stageMagnetizationAssignments,
    };
  }, [selectedStageDraft, selectedStageIndex, selection.ref]);

  const workflowInfo = useMemo<RunWorkflowDisplayInfo>(() => {
    const wf: EffectiveStudyWorkflowState = resolveStudyWorkflowStateBefore(
      stageDrafts,
      selectedStageIndex,
    );
    const stageId = hydratedBaseline.stageId;
    const precedingDrives = stageDrafts
      .slice(0, Math.max(0, selectedStageIndex))
      .filter(
        (c) =>
          c.kind === "add_field_drive" &&
          c.fieldDrive.enabled &&
          (c.fieldDrive.activation.kind === "all_time_evolution" ||
            c.fieldDrive.activation.stage_ids.includes(stageId)),
      );
    const firstSinc = precedingDrives.find(
      (c) => c.fieldDrive.waveform.kind === "sinc_pulse",
    );
    const sincCutoffHz =
      firstSinc?.fieldDrive.waveform.kind === "sinc_pulse"
        ? firstSinc.fieldDrive.waveform.cutoff_hz
        : null;
    const solverDtS = regionalFieldDriveSamplingContext(sceneData, null).solverDtS;
    const effectiveSampling =
      wf.fftResponse?.analysis === "unsupported"
        ? null
        : wf.fftResponse?.analysis === "finite_k"
          ? (wf.outputs.find(
              (o) => o.quantity === "m" && o.outputKind === "field",
            ) ?? null)
          : wf.tableAutosave;
    const wfIssues = validateStudyWorkflow(stageDrafts)
      .filter((issue) => issue.index === selectedStageIndex)
      .map((issue) => issue.message);

    return {
      activeDriveSummary:
        precedingDrives.length > 0
          ? precedingDrives
              .map((c) => c.fieldDrive.name || c.stageId)
              .join(", ")
          : "No active preceding drive",
      activeFftSummary: wf.fftResponse
        ? wf.fftResponse.readOnly
          ? `Read-only imported ${wf.fftResponse.analysis} (${wf.fftResponse.sourceStageId})`
          : `ON: ${wf.fftResponse.analysis}, ${wf.fftResponse.responseComponent}, ${wf.fftResponse.window} (${wf.fftResponse.sourceStageId})`
        : "OFF",
      activeOutputsSummary:
        wf.outputs.length > 0
          ? wf.outputs
              .map(
                (output) =>
                  `${output.quantity} ${
                    output.everySeconds
                      ? `every ${formatEngineering(output.everySeconds, "s")}`
                      : "(auto cadence)"
                  } (${output.sourceStageId})`,
              )
              .join("; ")
          : "None — scalar table only unless Stage Autosave is enabled",
      effectiveSampling,
      fieldEveryS: wf.outputs[0]?.everySeconds ?? null,
      sincCutoffHz,
      solverDtLabel: solverDtS
        ? `${formatEngineering(solverDtS, "s")} — configured in Study › Execution`
        : "Configured globally in Study › Execution",
      tableColumnCount: (wf.tableAutosave?.quantities.length ?? 4) + 2,
      tablePeriodS: wf.tableAutosave?.samplePeriodS ?? null,
      tableQuantitiesSummary: wf.tableAutosave?.quantities.join(", ") || "None",
      tableSourceStageId: wf.tableAutosave?.sourceStageId ?? null,
      workflowWarnings: wfIssues,
    };
  }, [hydratedBaseline.stageId, sceneData, selectedStageIndex, stageDrafts]);

  const validationContext = useMemo<StageValidationContext>(
    () => ({
      activeLane: runtimeStatus?.capabilities.active_lane,
      algorithmsAvailable: runtimeStatus?.capabilities.algorithms_available,
      backend: globalDraft.requestedBackend,
      demagEnabled: globalDraft.demagEnabled,
      device: globalDraft.requestedDevice,
      mode: globalDraft.requestedMode,
      precision: globalDraft.requestedPrecision,
    }),
    [
      globalDraft.demagEnabled,
      globalDraft.requestedBackend,
      globalDraft.requestedDevice,
      globalDraft.requestedMode,
      globalDraft.requestedPrecision,
      runtimeStatus?.capabilities.active_lane,
      runtimeStatus?.capabilities.algorithms_available,
    ],
  );

  return (
    <StudyStageTelemetryBridge selection={selection}>
      {(selectedStageModel) => (
        <RunStageInspectorPanelView
          hydratedBaseline={hydratedBaseline}
          lastAuthoringError={lastAuthoringError}
          pipelineNodeId={selectedStageDraft?.pipelineNodeId}
          pipelineStripSteps={pipelineStripSteps}
          sceneData={sceneData}
          sceneRevision={sceneRevision}
          selection={selection}
          stageModel={selectedStageModel}
          validationContext={validationContext}
          workflowInfo={workflowInfo}
          onCommitStage={(draft) =>
            commitSelectedStageDraft(
              (base) => ({
                ...base,
                kind: "run",
                stageId: draft.stageId,
                stageEnabled: serializeStageEnabled(draft.stageEnabled, base),
                untilSeconds: String(draft.untilSeconds),
                legacyRunFixedTimestep: draft.legacyRunFixedTimestep,
                stageAutosave: draft.stageAutosave,
                stageMagnetizationAssignments: draft.stageMagnetizationAssignments,
              }),
              "run",
            )
          }
          onRunStage={(stageId, initialChoice) =>
            executeSelectedStage(stageId, initialChoice, "run")
          }
        />
      )}
    </StudyStageTelemetryBridge>
  );
}

function RunStageInspectorPanelView({
  hydratedBaseline,
  lastAuthoringError = null,
  onCommitStage,
  onRunStage,
  pipelineNodeId,
  pipelineStripSteps,
  sceneData = null,
  sceneRevision = null,
  selection,
  stageModel = null,
  validationContext,
  workflowInfo,
}: InspectorPanelProps & {
  hydratedBaseline?: RunStageDraft;
  lastAuthoringError?: string | null;
  onCommitStage?: (draft: RunStageDraft) => Promise<boolean>;
  onRunStage?: (stageId: string, initialChoice?: StageInitialStateChoice) => Promise<void>;
  pipelineNodeId?: string;
  pipelineStripSteps?: readonly PipelineStripStep[];
  sceneData?: SceneResource | null;
  sceneRevision?: number | null;
  stageModel?: StudyStageModel | null;
  validationContext?: StageValidationContext;
  workflowInfo?: RunWorkflowDisplayInfo;
}) {
  const kernel = useContext(KernelContext);
  const [initialChoice, setInitialChoice] = useState<StageInitialStateChoice>({
    kind: "default_for_target",
  });
  const { index, stageId: fallbackId } = resolveStageMeta(selection, "run");
  const stageId = hydratedBaseline?.stageId ?? fallbackId;
  const titleLabel = `Run ${index + 1}`;

  const fallbackBaseline = useMemo<RunStageDraft>(
    () => ({
      stageId,
      stageEnabled: true,
      untilSeconds: 10e-9,
      legacyRunFixedTimestep: "",
      stageAutosave: DEFAULT_RUN_AUTOSAVE,
      stageMagnetizationAssignments: undefined,
    }),
    [stageId],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const fallbackWorkflowInfo = useMemo<RunWorkflowDisplayInfo>(
    () => ({
      activeDriveSummary: "No active preceding drive",
      activeFftSummary: "OFF",
      activeOutputsSummary: "None — scalar table only unless Stage Autosave is enabled",
      effectiveSampling: {
        autoSampling: null,
        quantities: ["t", "step", "mx", "my", "mz"],
        samplePeriodS: 500e-15,
        samplingMode: "explicit",
        sourceDriveIds: [],
        sourceStageId: "tbl_clock",
      },
      fieldEveryS: null,
      sincCutoffHz: null,
      solverDtLabel: "Configured globally in Study › Execution",
      tableColumnCount: 6,
      tablePeriodS: 500e-15,
      tableQuantitiesSummary: "t, step, mx, my, mz",
      tableSourceStageId: "tbl_clock",
      workflowWarnings: [],
    }),
    [],
  );
  const resolvedWorkflow = workflowInfo ?? fallbackWorkflowInfo;

  const resolvedSteps = useMemo<readonly PipelineStripStep[]>(
    () =>
      pipelineStripSteps && pipelineStripSteps.length > 0
        ? pipelineStripSteps
        : [
            { id: "relax_1", index: 0, kind: "study.stage.relax", label: "Relax", status: "completed" },
            { id: stageId, index, kind: "study.stage.run", label: "Run", status: "ready" },
          ],
    [index, pipelineStripSteps, stageId],
  );

  const spec = useMemo<InspectorSpec<RunStageDraft>>(
    () => ({
      id: "study.stage.run",
      header: {
        breadcrumbs: stageBreadcrumbs(titleLabel),
        canFitView: true,
        primaryHeaderAction: {
          label: "Run up to here",
          icon: Play,
          onRun: async (ctx) => {
            if (!inspectorValuesEqual(ctx.draft, ctx.baseline) && onCommitStage) {
              const saved = await onCommitStage(ctx.draft);
              if (saved === false) return;
            }
            if (onRunStage) {
              await onRunStage(ctx.draft.stageId, initialChoice);
            } else {
              ctx.notify("Time evolution run queued", ctx.draft.stageId);
            }
          },
        },
      },
      identity: {
        domain: "study",
        icon: Play,
        title: () => titleLabel,
        kindLabel: "Time evolution stage",
        entityId: stageId,
        statePill: (d) =>
          !pipelineNodeId && d.legacyRunFixedTimestep.trim()
            ? { tone: "err", label: "Legacy fix_dt" }
            : d.stageEnabled
              ? { tone: "ok", label: "Ready" }
              : { tone: "neutral", label: "Skipped" },
      },
      facts: (d): readonly InspectorFact[] => {
        const metrics = computeSamplingPlanMetrics({
          durationS: d.untilSeconds,
          tablePeriodS: resolvedWorkflow.tablePeriodS,
          tableColumnCount: resolvedWorkflow.tableColumnCount,
          fieldEveryS: resolvedWorkflow.fieldEveryS,
        });
        return [
          { id: "dur", label: "Duration", value: formatTimeCompact(d.untilSeconds) },
          { id: "solver", label: "Solver", value: "Study global" },
          {
            id: "nyq",
            label: "Nyquist f_Nyq",
            value: metrics.nyquistHz ? formatFrequencyCompact(metrics.nyquistHz) : null,
          },
          {
            id: "zarr",
            label: "Est. Zarr",
            value: formatBytesBinary(metrics.totalZarrBytes),
          },
        ];
      },
      modeTabs: [
        { id: "setup", label: "Setup" },
        { id: "telemetry", label: "Telemetry", commitModeOverride: "readOnly" },
      ],
      notices: (d): readonly InspectorNotice<RunStageDraft>[] => {
        const list: InspectorNotice<RunStageDraft>[] = [];
        if (lastAuthoringError) {
          list.push({
            id: "authoring-error",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        if (!pipelineNodeId && d.legacyRunFixedTimestep.trim()) {
          list.push({
            id: "legacy-fix-dt",
            tone: "err",
            text: `Legacy Run-local fixed_timestep (${d.legacyRunFixedTimestep} s) must be moved to the global Study Execution solver settings before saving.`,
            quickFix: {
              label: "Clear legacy fix_dt",
              onApply: (ctx) => ctx.setField("legacyRunFixedTimestep", ""),
            },
          });
        }
        const metrics = computeSamplingPlanMetrics({
          durationS: d.untilSeconds,
          tablePeriodS: resolvedWorkflow.tablePeriodS,
          tableColumnCount: resolvedWorkflow.tableColumnCount,
          fieldEveryS: resolvedWorkflow.fieldEveryS,
        });
        if (
          metrics.nyquistHz !== null &&
          resolvedWorkflow.sincCutoffHz !== null &&
          resolvedWorkflow.sincCutoffHz > metrics.nyquistHz
        ) {
          list.push({
            id: "aliasing-risk",
            tone: "warn",
            text: `Aliasing risk: sinc cutoff ${formatFrequencyCompact(resolvedWorkflow.sincCutoffHz)} exceeds Nyquist frequency ${formatFrequencyCompact(metrics.nyquistHz)}.`,
          });
        }
        if (metrics.totalZarrBytes > 4 * 1024 ** 3) {
          list.push({
            id: "zarr-budget",
            tone: "warn",
            text: `Estimated Zarr output (${formatBytesBinary(metrics.totalZarrBytes)}) exceeds 4 GiB.`,
          });
        }
        for (let i = 0; i < resolvedWorkflow.workflowWarnings.length; i += 1) {
          const msg = resolvedWorkflow.workflowWarnings[i]!;
          if (!list.some((existing) => existing.text === msg)) {
            list.push({
              id: `workflow-issue-${i}`,
              tone: "warn",
              text: msg,
            });
          }
        }
        const stageDraft: StudyStageDraft = {
          ...createDefaultStudyStageDraft("run", index),
          stageId: d.stageId,
          stageEnabled: d.stageEnabled,
          untilSeconds: String(d.untilSeconds),
          legacyRunFixedTimestep: d.legacyRunFixedTimestep,
          stageAutosave: d.stageAutosave,
          stageMagnetizationAssignments: d.stageMagnetizationAssignments,
          ...(pipelineNodeId ? { pipelineNodeId } : {}),
        };
        const issues = validateStudyStageDraft(stageDraft, validationContext);
        for (let i = 0; i < issues.length; i += 1) {
          const issue = issues[i]!;
          if (
            issue.message.includes("fixed_timestep") &&
            list.some((existing) => existing.id === "legacy-fix-dt")
          ) {
            continue;
          }
          if (!list.some((existing) => existing.text === issue.message)) {
            list.push({
              id: `run-validation-${i}`,
              tone: issue.severity === "error" ? "err" : "warn",
              text: issue.message,
            });
          }
        }
        return list;
      },
      sections: [
        {
          id: "pipeline",
          title: "Pipeline",
          icon: Workflow,
          modeTabId: "setup",
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <PipelineStrip
                  currentIndex={index}
                  steps={resolvedSteps}
                  onSelectStep={(step) => {
                    if (step.selection) ctx.selectNode(step.selection);
                  }}
                />
              ),
            },
            {
              key: "stageId",
              label: "Stage ID",
              type: "text",
              mono: true,
              disabledReason: () =>
                pipelineNodeId
                  ? "Canonical pipeline stage IDs are managed by the pipeline graph."
                  : null,
              validate: (val) => (!val.trim() ? "Stage ID is required." : null),
            },
            {
              key: "stageEnabled",
              label: "Include in study",
              type: "switch",
            },
          ],
        },
        {
          id: "time-integrator",
          title: "Time & Integrator",
          icon: Timer,
          modeTabId: "setup",
          defaultOpen: true,
          rows: [
            {
              key: "untilSeconds",
              label: "Duration",
              symbol: (
                <>
                  t<sub>end</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ns",
              min: 0,
              minExclusive: true,
              scrub: "log",
            },
            {
              label: "Solver & timestep",
              type: "readonly",
              format: () => resolvedWorkflow.solverDtLabel,
            },
            {
              type: "custom",
              label: "Legacy fixed_timestep",
              wide: true,
              showWhen: (d) =>
                !pipelineNodeId && Boolean(d.legacyRunFixedTimestep.trim()),
              render: (ctx) => (
                <div className="flex items-center justify-between gap-2 rounded border border-fm-border-subtle p-2 text-xs">
                  <span className="font-mono">
                    {`fixed_timestep = ${ctx.draft.legacyRunFixedTimestep} s`}
                  </span>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => ctx.setField("legacyRunFixedTimestep", "")}
                  >
                    Clear legacy fix_dt
                  </Button>
                </div>
              ),
            },
          ],
          footer: (ctx) => (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() =>
                ctx.selectNode({
                  kind: "study.execution",
                  label: "Execution",
                  nodeId: "model:study:execution",
                  objectId: null,
                  ref: {
                    kind: "study.execution",
                    nodeId: "model:study:execution",
                    type: "study",
                  },
                })
              }
            >
              Configure in Study Execution
            </Button>
          ),
        },
        {
          id: "sampling-plan",
          title: "Field & Table Sampling Plan",
          icon: FileOutput,
          modeTabId: "setup",
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="grid gap-2">
                  <SamplingPlanCard
                    durationS={ctx.draft.untilSeconds}
                    fieldEveryS={resolvedWorkflow.fieldEveryS}
                    sincCutoffHz={resolvedWorkflow.sincCutoffHz}
                    tableColumnCount={resolvedWorkflow.tableColumnCount}
                    tablePeriodS={resolvedWorkflow.tablePeriodS}
                    tableSourceStageId={resolvedWorkflow.tableSourceStageId}
                  />
                  <SamplingDiagnostics
                    durationS={ctx.draft.untilSeconds}
                    sampling={resolvedWorkflow.effectiveSampling}
                  />
                </div>
              ),
            },
          ],
        },
        {
          id: "stage-autosave",
          title: "Stage Autosave",
          icon: Database,
          modeTabId: "setup",
          defaultOpen: false,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <StageAutosaveRadixEditor
                  draft={ctx.draft.stageAutosave}
                  owner="run"
                  onChange={(stageAutosave) =>
                    ctx.setField("stageAutosave", stageAutosave)
                  }
                />
              ),
            },
          ],
        },
        {
          id: "active-drives",
          title: "Active Drives, FFT & Initial State",
          icon: Zap,
          modeTabId: "setup",
          defaultOpen: false,
          rows: [
            {
              label: "Active field drives",
              type: "readonly",
              format: () => resolvedWorkflow.activeDriveSummary,
            },
            {
              label: "Table quantities",
              type: "readonly",
              mono: true,
              format: () => resolvedWorkflow.tableQuantitiesSummary,
            },
            {
              label: "Autosave outputs",
              type: "readonly",
              format: () => resolvedWorkflow.activeOutputsSummary,
            },
            {
              label: "FFT response state",
              type: "readonly",
              format: () => resolvedWorkflow.activeFftSummary,
            },
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <StageInitialStateRadixControl
                  choice={initialChoice}
                  hasAuthoredReset={Boolean(
                    readStageTextureAssignments(
                      ctx.draft.stageMagnetizationAssignments,
                    )?.length,
                  )}
                  onPreviewResult={
                    kernel?.savedResultsPlayback
                      ? (result) =>
                          kernel.savedResultsPlayback?.openStudyResult(result)
                      : undefined
                  }
                  sceneRevision={sceneRevision}
                  stageId={ctx.draft.stageId}
                  onChange={setInitialChoice}
                />
              ),
            },
            ...(sceneData
              ? [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: (ctx: {
                      draft: RunStageDraft;
                      setField: <K extends keyof RunStageDraft>(
                        k: K,
                        v: RunStageDraft[K],
                      ) => void;
                    }) => (
                      <StageTextureOverridesRow
                        scene={sceneData}
                        value={ctx.draft.stageMagnetizationAssignments}
                        onChange={(next) =>
                          ctx.setField("stageMagnetizationAssignments", next)
                        }
                      />
                    ),
                  },
                ]
              : []),
          ],
        },
        {
          id: "live-telemetry",
          title: "Live Progress & Trajectories",
          icon: Activity,
          modeTabId: "telemetry",
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: () => (
                <StageLiveTelemetryPanel
                  emptyDescription="Start the study or run up to this stage to stream ⟨m_x⟩, ⟨m_y⟩, ⟨m_z⟩ trajectories."
                  stageModel={stageModel}
                />
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        onApply: async (draft) => {
          if (onCommitStage) {
            return onCommitStage(draft);
          }
          return true;
        },
      },
    }),
    [
      index,
      initialChoice,
      kernel,
      lastAuthoringError,
      onCommitStage,
      onRunStage,
      pipelineNodeId,
      resolvedSteps,
      resolvedWorkflow,
      sceneData,
      sceneRevision,
      stageId,
      stageModel,
      titleLabel,
      validationContext,
    ],
  );

  return <StageSpecHost baseline={baseline} selection={selection} spec={spec} />;
}
