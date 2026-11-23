"use client";

import {
  Activity,
  CheckCircle2,
  Gauge,
  History,
  Pause,
  Play,
  Sigma,
  SkipForward,
  Square,
  Workflow,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import {
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
  SIMULATION_COMMANDS_PATH,
} from "@/kernel/api/apiPaths";
import type { SolverStatusResource } from "@/kernel/api/apiTypes";
import { KernelContext } from "@/kernel/KernelContext";
import type {
  ActiveLaneCapabilitySnapshot,
} from "@/kernel/resources/useActiveLaneCapabilities";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorFact, InspectorNotice, InspectorSpec } from "../../template";
import { ProjectBatchesSection } from "../../panels/ProjectBatchesSection";
import { ProjectRunsSection } from "../../panels/ProjectRunsSection";
import type { StudyInspectorModel } from "../../panels/StudyInspectorPanelModel";
import type { StudyStageDraft } from "../../panels/StudyStageAuthoringModel";
import {
  ConnectedInspectorSpec,
  PipelineStrip,
  type PipelineStripStep,
} from "../../panels/study/ConnectedInspectorSpec";
import {
  buildStudyCommandContext,
  useKernelStudyAuthoring,
  useKernelStudyRuntimeTelemetry,
} from "../../panels/study/useConnectedStudyAuthoring";
import {
  type StudyRootDraft,
  DEFAULT_PIPELINE_STEPS,
  studyBreadcrumbs,
  hasSubscribableResourceStore,
  cleanProvenanceToken,
} from "./studyShared";
import {
  ConnectedCommandDetailModal,
  ConnectedReadinessBridge,
  StudyRootRuntimeTelemetryCard,
} from "./StudyRootTelemetryViews";
export function StudyRootInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedStudyRootInspectorPanel selection={selection} />;
  }
  return (
    <StudyRootInspectorPanelView
      runtimeModel={null}
      sceneData={null}
      selection={selection}
    />
  );
}

function ConnectedStudyRootInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const {
    commitStudyMetadata,
    executeSelectedStage,
    executeStudyCommand,
    lastAuthoringError,
    pipelineStripSteps,
    runtimeStatus,
    sceneData,
    stageDrafts,
  } = useKernelStudyAuthoring(selection);
  const { model, solverStatus } = useKernelStudyRuntimeTelemetry(selection);
  const [readinessData, setReadinessData] = useState<Record<string, unknown> | null>(
    null,
  );
  const canSubscribeResources = hasSubscribableResourceStore(kernel);

  return (
    <>
      {canSubscribeResources ? (
        <ConnectedReadinessBridge onReadiness={setReadinessData} />
      ) : null}
      <StudyRootInspectorPanelView
        activeLane={runtimeStatus?.capabilities?.active_lane ?? null}
        commitStudyMetadata={commitStudyMetadata}
        executeSelectedStage={executeSelectedStage}
        executeStudyCommand={executeStudyCommand}
        lastAuthoringError={lastAuthoringError}
        pipelineStripSteps={pipelineStripSteps}
        readinessData={readinessData}
        runtimeModel={model}
        sceneData={sceneData as unknown as Record<string, unknown> | null}
        selection={selection}
        solverStatus={solverStatus}
        stageDrafts={stageDrafts}
      />
    </>
  );
}

function StudyRootInspectorPanelView({
  activeLane = null,
  commitStudyMetadata,
  executeSelectedStage,
  executeStudyCommand,
  lastAuthoringError = null,
  pipelineStripSteps,
  readinessData = null,
  runtimeModel,
  sceneData,
  selection,
  solverStatus = null,
  stageDrafts,
}: InspectorPanelProps & {
  activeLane?: ActiveLaneCapabilitySnapshot | null;
  commitStudyMetadata?: (studyPatch: Record<string, unknown>) => Promise<boolean>;
  executeSelectedStage?: (stageId: string) => Promise<void>;
  executeStudyCommand?: (commandId: string, input?: Record<string, unknown>) => Promise<void>;
  lastAuthoringError?: string | null;
  pipelineStripSteps?: readonly PipelineStripStep[];
  readinessData?: Record<string, unknown> | null;
  runtimeModel: StudyInspectorModel | null;
  sceneData: Record<string, unknown> | null;
  solverStatus?: SolverStatusResource | null;
  stageDrafts?: readonly StudyStageDraft[];
}) {
  const kernel = useContext(KernelContext);
  const canSubscribeResources = hasSubscribableResourceStore(kernel);
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(null);

  const peekedData = (
    kernel?.resources as unknown as
      | { peek?: (key: string) => { data?: Record<string, unknown> | null } | undefined }
      | undefined
  )?.peek?.(MODEL_SCENE_PATH)?.data ?? null;
  const peekedReadiness = (
    kernel?.resources as unknown as
      | { peek?: (key: string) => { data?: Record<string, unknown> | null } | undefined }
      | undefined
  )?.peek?.(MODEL_READINESS_PATH)?.data ?? null;
  const activeSceneData = sceneData ?? peekedData;
  const activeReadiness = readinessData ?? peekedReadiness;
  const sceneStudy = (activeSceneData?.study ?? null) as Record<string, unknown> | null;
  const rawStages = Array.isArray(sceneStudy?.stages) ? sceneStudy.stages : null;

  const preflightBlockers = useMemo<readonly string[]>(() => {
    if (!activeReadiness) return [];
    const out: string[] = [];
    if (Array.isArray(activeReadiness.blockers)) {
      for (const b of activeReadiness.blockers) {
        if (typeof b === "string") out.push(b);
        else if (
          b &&
          typeof b === "object" &&
          typeof (b as { message?: unknown }).message === "string"
        ) {
          out.push((b as { message: string }).message);
        }
      }
    }
    if (Array.isArray(activeReadiness.issues)) {
      for (const issue of activeReadiness.issues) {
        if (
          issue &&
          typeof issue === "object" &&
          (issue as { severity?: unknown }).severity === "error" &&
          typeof (issue as { message?: unknown }).message === "string"
        ) {
          out.push((issue as { message: string }).message);
        }
      }
    }
    return out;
  }, [activeReadiness]);

  const isRunning = useMemo(() => {
    const state = runtimeModel?.runtime.state?.toLowerCase() ?? "";
    return state === "running" || state === "queued" || state === "preparing";
  }, [runtimeModel?.runtime.state]);

  const baseline = useMemo<StudyRootDraft>(() => {
    const steps: PipelineStripStep[] =
      pipelineStripSteps !== undefined
        ? [...pipelineStripSteps]
        : rawStages
          ? rawStages.map((raw, idx) => {
              const item = (raw ?? {}) as Record<string, unknown>;
              const kindStr = String(item.kind ?? "relax").toLowerCase();
              const stageId = String(item.stage_id ?? item.id ?? `stage_${idx + 1}`);
              const routeKind = `study.stage.${kindStr}`;
              return {
                id: stageId,
                index: idx,
                kind: routeKind,
                label: kindStr.replace(/_/g, " "),
                status: "ready" as const,
                selection: {
                  kind: routeKind,
                  label: `${kindStr} ${idx + 1}`,
                  nodeId: `model:study:stages:stage:${stageId}`,
                  objectId: null,
                  ref: {
                    kind: "study.stage.action" as const,
                    nodeId: `model:study:stages:stage:${stageId}`,
                    stageId,
                    stageIndex: idx,
                    type: "study-stage" as const,
                  },
                },
              };
            })
          : [...DEFAULT_PIPELINE_STEPS];

    const skippedCount = stageDrafts
      ? stageDrafts.filter(
          (d) => d.stageEnabled === false || d.pipelineEnabled === false,
        ).length
      : 0;
    const activeCount = Math.max(0, steps.length - skippedCount);

    const rawObjects = Array.isArray(activeSceneData?.objects)
      ? (activeSceneData.objects as Array<Record<string, unknown>>)
      : null;
    const magnetCount = rawObjects
      ? rawObjects.filter((obj) => !obj.role || obj.role === "magnet").length
      : 1;

    const rawTrigger = sceneStudy?.execution_trigger;
    const executionTrigger: StudyRootDraft["executionTrigger"] =
      rawTrigger === "auto_run" ? "auto_run" : "wait_for_compute";

    let laneSummary = "FDM · Auto → GPU (FP64)";
    if (runtimeModel) {
      const prov = runtimeModel.runtime.runtimeProvenance;
      const backend =
        cleanProvenanceToken(prov?.resolved.backend) ??
        cleanProvenanceToken(
          activeLane?.resolved?.backend ?? activeLane?.resolved?.discretization,
        ) ??
        cleanProvenanceToken(activeLane?.requested?.backend) ??
        cleanProvenanceToken(runtimeModel.requested.backend) ??
        "auto";
      const device =
        cleanProvenanceToken(prov?.resolved.device) ??
        cleanProvenanceToken(activeLane?.resolved?.device) ??
        cleanProvenanceToken(activeLane?.requested?.device) ??
        cleanProvenanceToken(runtimeModel.requested.device) ??
        "auto";
      const precision =
        cleanProvenanceToken(prov?.resolved.precision) ??
        cleanProvenanceToken(activeLane?.resolved?.precision) ??
        cleanProvenanceToken(activeLane?.requested?.precision) ??
        cleanProvenanceToken(runtimeModel.requested.precision) ??
        "double";
      laneSummary = `${backend} · ${device} (${precision})`;
    }

    return {
      name:
        typeof sceneStudy?.name === "string" && sceneStudy.name.trim()
          ? sceneStudy.name
          : "Main study",
      executionTrigger,
      computeScope: "full_study",
      targetEndStageId: steps.at(-1)?.id ?? "run_main",
      isRunning,
      preflightErrorCount: preflightBlockers.length,
      activeStageCount: activeCount,
      skippedStageCount: skippedCount,
      magnetCount,
      laneSummary,
      lastRunLabel:
        runtimeModel?.runtime.runId && runtimeModel.runtime.runId !== "none"
          ? runtimeModel.runtime.runId
          : null,
      sceneRevision:
        typeof activeSceneData?.revision === "number"
          ? activeSceneData.revision
          : 1,
      pipelineSteps: steps,
    };
  }, [
    activeLane,
    activeSceneData,
    isRunning,
    pipelineStripSteps,
    preflightBlockers.length,
    rawStages,
    runtimeModel,
    sceneStudy,
    stageDrafts,
  ]);

  const executeKernelCommand = useCallback(
    async (
      commandId: string,
      fallbackMessage: string,
      notify: (msg: string) => void,
      input?: Record<string, unknown>,
    ) => {
      if (executeStudyCommand) {
        await executeStudyCommand(commandId, input);
        return;
      }
      if (kernel) {
        await kernel.commands.execute(
          commandId,
          buildStudyCommandContext(kernel, {
            sceneData: activeSceneData,
            sourceDetail: "study.root",
          }),
          input,
        );
      } else {
        notify(fallbackMessage);
      }
    },
    [activeSceneData, executeStudyCommand, kernel],
  );

  const runScopedStudyCompute = useCallback(
    async (draft: StudyRootDraft, notify: (msg: string, detail?: string) => void) => {
      if (!kernel) {
        notify(
          draft.isRunning ? "Study stop requested" : "Study compute requested",
          SIMULATION_COMMANDS_PATH,
        );
        return;
      }
      if (draft.isRunning) {
        await executeKernelCommand("study.stop", "Stop requested", notify);
        return;
      }
      if (draft.computeScope === "up_to_stage" && draft.targetEndStageId) {
        if (executeSelectedStage) {
          await executeSelectedStage(draft.targetEndStageId);
          return;
        }
        const targetStep = draft.pipelineSteps.find(
          (step) => step.id === draft.targetEndStageId,
        );
        if (
          targetStep?.kind === "study.stage.run" ||
          targetStep?.kind === "study.stage.relax"
        ) {
          await executeKernelCommand(
            "study.execute-stage",
            "Stage compute requested",
            notify,
            {
              initialState: { kind: "default_for_target" },
              stageId: draft.targetEndStageId,
            },
          );
        } else {
          await executeKernelCommand("study.run", "Compute queued", notify);
        }
        return;
      }
      if (draft.computeScope === "from_checkpoint") {
        await executeKernelCommand("study.resume", "Resume requested", notify);
        return;
      }
      await executeKernelCommand("study.run", "Compute queued", notify);
    },
    [executeKernelCommand, executeSelectedStage, kernel],
  );

  const spec = useMemo<InspectorSpec<StudyRootDraft>>(
    () => ({
      id: "study.root",
      header: {
        breadcrumbs: studyBreadcrumbs(),
        canFitView: true,
        primaryHeaderAction: {
          label: baseline.isRunning ? "Stop Study" : "Compute Study",
          icon: baseline.isRunning ? Square : Play,
          variant: baseline.isRunning ? "destructive" : "secondary",
          ...(baseline.isRunning
            ? {
                confirm: {
                  title: "Stop active study run?",
                  description:
                    "Stopping halts the solver at the next step boundary while keeping completed stage outputs.",
                  confirmLabel: "Stop Study",
                },
              }
            : {}),
          onRun: async (ctx) => {
            await runScopedStudyCompute(ctx.draft, ctx.notify);
          },
        },
      },
      identity: {
        domain: "study",
        icon: Workflow,
        title: (draft) => draft.name,
        renameFieldKey: "name",
        kindLabel: "Study workflow",
        entityId: "study:main",
        statePill: (draft) => {
          if (draft.isRunning) return { tone: "live", label: "Running" };
          if (draft.preflightErrorCount > 0) {
            return { tone: "err", label: `${draft.preflightErrorCount} issues` };
          }
          return { tone: "ok", label: "Ready" };
        },
      },
      facts: (draft): readonly InspectorFact[] => [
        { id: "lane", label: "Lane", value: draft.laneSummary, tone: "info" },
        {
          id: "stages",
          label: "Stages",
          value:
            draft.skippedStageCount > 0
              ? `${draft.activeStageCount} active (${draft.skippedStageCount} skipped)`
              : `${draft.activeStageCount} active`,
        },
        {
          id: "objects",
          label: "Objects",
          value: `${draft.magnetCount} ${draft.magnetCount === 1 ? "magnet" : "magnets"}`,
        },
        { id: "lastRun", label: "Last run", value: draft.lastRunLabel },
      ],
      notices: (): readonly InspectorNotice<StudyRootDraft>[] => {
        const list: InspectorNotice<StudyRootDraft>[] = preflightBlockers.map(
          (msg, idx) => ({
            id: `preflight-${idx}`,
            tone: "err",
            text: msg,
          }),
        );
        if (lastAuthoringError) {
          list.unshift({
            id: "study-root-err",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        return list;
      },
      sections: [
        {
          id: "run-control",
          title: "Run control",
          icon: Play,
          defaultOpen: true,
          summary: (d) =>
            d.executionTrigger === "auto_run" ? "Auto-run on Apply" : "Wait for Compute",
          rows: [
            {
              key: "executionTrigger",
              label: "Execution trigger",
              type: "segmented",
              options: [
                { value: "wait_for_compute", label: "Wait for Compute" },
                { value: "auto_run", label: "Auto-run on Apply" },
              ],
            },
            {
              key: "computeScope",
              label: "Compute scope",
              type: "select",
              structural: true,
              options: [
                { value: "full_study", label: "All enabled stages" },
                { value: "up_to_stage", label: "Up to stage…" },
                { value: "from_checkpoint", label: "Resume from latest checkpoint" },
              ],
            },
            {
              key: "targetEndStageId",
              label: "Target end stage",
              type: "select",
              showWhen: (d) => d.computeScope === "up_to_stage",
              options: baseline.pipelineSteps.map((step) => ({
                value: step.id,
                label: `${step.index + 1}. ${step.label} (${step.id})`,
              })),
            },
            {
              label: "Solver lifecycle",
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    type="button"
                    variant="primary"
                    onClick={() =>
                      void runScopedStudyCompute(ctx.draft, ctx.notify)
                    }
                  >
                    <Play aria-hidden="true" size={13} />
                    <span>Compute</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      void executeKernelCommand(
                        "study.build-and-run",
                        "Build + Study queued",
                        ctx.notify,
                      )
                    }
                  >
                    <Play aria-hidden="true" size={13} />
                    <span>Build + Study</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      void executeKernelCommand(
                        "study.cancel-build-and-run",
                        "Cancel Build + Study requested",
                        ctx.notify,
                      )
                    }
                  >
                    <Square aria-hidden="true" size={13} />
                    <span>Cancel Build + Study</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      void executeKernelCommand(
                        "study.pause",
                        "Pause requested",
                        ctx.notify,
                      )
                    }
                  >
                    <Pause aria-hidden="true" size={13} />
                    <span>Pause</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      void executeKernelCommand(
                        "study.resume",
                        "Resume requested",
                        ctx.notify,
                      )
                    }
                  >
                    <Play aria-hidden="true" size={13} />
                    <span>Resume</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      void executeKernelCommand(
                        "study.skip",
                        "Skip stage requested",
                        ctx.notify,
                      )
                    }
                  >
                    <SkipForward aria-hidden="true" size={13} />
                    <span>Skip</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="danger"
                    onClick={() =>
                      void executeKernelCommand(
                        "study.stop",
                        "Stop requested",
                        ctx.notify,
                      )
                    }
                  >
                    <Square aria-hidden="true" size={13} />
                    <span>Stop</span>
                  </Button>
                </div>
              ),
            },
            {
              label: "Postprocess",
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      void executeKernelCommand(
                        "study.compute-observables",
                        "Observable postprocessing queued",
                        ctx.notify,
                      )
                    }
                  >
                    <Gauge aria-hidden="true" size={13} />
                    <span>Compute observables</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      void executeKernelCommand(
                        "study.compute-energies",
                        "Energy postprocessing queued",
                        ctx.notify,
                      )
                    }
                  >
                    <Sigma aria-hidden="true" size={13} />
                    <span>Compute energies</span>
                  </Button>
                </div>
              ),
            },
          ],
        },
        ...(runtimeModel
          ? [
              {
                id: "runtime-telemetry",
                title: "Runtime Telemetry & Provenance",
                icon: Activity,
                defaultOpen: true,
                summary: () => runtimeModel.runtime.state,
                rows: [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <StudyRootRuntimeTelemetryCard
                        activeLane={activeLane}
                        runtimeModel={runtimeModel}
                        solverStatus={solverStatus}
                        onSelectCommandId={setSelectedCommandId}
                      />
                    ),
                  },
                ],
              },
            ]
          : []),
        {
          id: "pipeline-summary",
          title: "Pipeline summary",
          icon: Workflow,
          defaultOpen: true,
          summary: (d) => `${d.activeStageCount} stages`,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <PipelineStrip
                  steps={ctx.draft.pipelineSteps}
                  onSelectStep={(step) => {
                    if (step.selection) ctx.selectNode(step.selection);
                  }}
                />
              ),
            },
            {
              label: "Pipeline order",
              type: "custom",
              render: (ctx) => (
                <Button
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    ctx.selectNode({
                      kind: "study.stages",
                      label: "Stages",
                      nodeId: "model:study:stages",
                      objectId: null,
                      ref: {
                        kind: "study.stages",
                        nodeId: "model:study:stages",
                        type: "study",
                      },
                    })
                  }
                >
                  Open Stages manager →
                </Button>
              ),
            },
          ],
        },
        {
          id: "readiness-checklist",
          title: "Readiness checklist",
          icon: CheckCircle2,
          defaultOpen: false,
          summary: (d) =>
            d.preflightErrorCount > 0
              ? `${d.preflightErrorCount} preflight issues`
              : "Preflight ready",
          rows: [
            {
              label: "Geometry & Materials",
              type: "readonly",
              format: (d) =>
                `Ready (${d.magnetCount} magnetic ${d.magnetCount === 1 ? "body" : "bodies"})`,
            },
            {
              label: "Execution lane",
              type: "readonly",
              format: (d) => d.laneSummary,
            },
            {
              label: "Stage sequence",
              type: "readonly",
              format: (d) =>
                d.skippedStageCount > 0
                  ? `${d.activeStageCount} active · ${d.skippedStageCount} skipped`
                  : `${d.activeStageCount} ordered pipeline steps`,
            },
          ],
        },
        ...(canSubscribeResources
          ? [
              {
                id: "project-runs-batches",
                title: "Project Runs & Batches",
                icon: History,
                defaultOpen: false,
                rows: [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <div className="grid gap-3">
                        <ProjectRunsSection />
                        <ProjectBatchesSection />
                      </div>
                    ),
                  },
                ],
              },
            ]
          : []),
      ],
      details: (draft) => [
        { label: "Scene revision", value: `rev ${draft.sceneRevision}`, mono: true },
        { label: "Commands endpoint", value: SIMULATION_COMMANDS_PATH, mono: true },
      ],
      commitBar: {
        mode: "immediate",
        statusMessage: (d) => `Ready to compute scene revision ${d.sceneRevision}`,
      },
    }),
    [
      activeLane,
      baseline.isRunning,
      baseline.pipelineSteps,
      canSubscribeResources,
      executeKernelCommand,
      lastAuthoringError,
      preflightBlockers,
      runScopedStudyCompute,
      runtimeModel,
      solverStatus,
    ],
  );

  return (
    <>
      <ConnectedInspectorSpec
        baseline={baseline}
        selection={selection}
        spec={spec}
        onAfterFieldChange={(key, value) => {
          if (!commitStudyMetadata) return;
          if (key === "name" && typeof value === "string" && value.trim()) {
            void commitStudyMetadata({ name: value.trim() });
          } else if (key === "executionTrigger" && typeof value === "string") {
            void commitStudyMetadata({ execution_trigger: value });
          }
        }}
      />
      {canSubscribeResources && selectedCommandId ? (
        <ConnectedCommandDetailModal
          commandId={selectedCommandId}
          onClose={() => setSelectedCommandId(null)}
        />
      ) : null}
    </>
  );
}
