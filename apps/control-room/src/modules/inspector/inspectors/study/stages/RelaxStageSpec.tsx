"use client";

import {
  Activity,
  Compass,
  Database,
  Gauge,
  Play,
  Timer,
  Workflow,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { KernelContext } from "@/kernel/KernelContext";
import type { StageInitialStateChoice } from "@/kernel/runtime/studyStageInitialState";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import {
  inspectorValuesEqual,
  type InspectorFact,
  type InspectorNotice,
  type InspectorSpec,
} from "../../../template";
import type { StudyStageModel } from "../../../panels/StudyInspectorPanelModel";
import {
  readStageTextureAssignments,
  relaxationAlgorithmAvailability,
  validateStudyStageDraft,
  type StudyStageDraft,
} from "../../../panels/StudyStageAuthoringModel";
import {
  ENERGY_JOULE_UNITS_SI,
  PipelineStrip,
  TIME_UNITS_SI,
  TORQUE_APM_UNITS_SI,
  type PipelineStripStep,
} from "../../../panels/study/ConnectedInspectorSpec";
import { useKernelStudyAuthoring } from "../../../panels/study/useConnectedStudyAuthoring";
import {
  StageAutosaveRadixEditor,
  StageInitialStateRadixControl,
  StageLiveTelemetryPanel,
  StageSpecHost,
  StageTextureOverridesRow,
  StudyStageTelemetryBridge,
} from "../../../panels/stages/StageSharedControls";
import {
  type StageValidationContext,
  stageBreadcrumbs,
  resolveStageMeta,
  type RelaxStageDraft,
  DEFAULT_RELAX_AUTOSAVE,
  toRelaxStudyStageDraft,
} from "./stageShared";
export function RelaxStageInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedRelaxStageInspectorPanel selection={selection} />;
  }
  return <RelaxStageInspectorPanelView selection={selection} />;
}

function ConnectedRelaxStageInspectorPanel({ selection }: InspectorPanelProps) {
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
  } = useKernelStudyAuthoring(selection);

  const hydratedBaseline = useMemo<RelaxStageDraft>(() => {
    const d: Partial<StudyStageDraft> =
      selectedStageDraft?.kind === "relax" ? selectedStageDraft : {};
    const stageId =
      d.stageId ||
      (selection.ref?.type === "study-stage" && selection.ref.stageId
        ? selection.ref.stageId
        : `relax_${selectedStageIndex + 1}`);
    const method: RelaxStageDraft["method"] =
      d.algorithm === "nonlinear_cg" ||
      d.algorithm === "llg_overdamped" ||
      d.algorithm === "tangent_plane_implicit"
        ? d.algorithm
        : "projected_gradient_bb";
    const integrator: RelaxStageDraft["integrator"] =
      d.solver === "rk23" || d.solver === "rk45" || d.solver === "heun"
        ? d.solver
        : "";
    return {
      stageId,
      stageEnabled: d.stageEnabled ?? true,
      method,
      torqueToleranceApm: Number(d.torqueTolerance) || 100,
      energyToleranceJ: d.energyTolerance?.trim()
        ? Number(d.energyTolerance) || 0
        : 0,
      maxSteps: Number(d.maxSteps) || 50000,
      maxRelaxationTimeS: d.maxRelaxationTime?.trim()
        ? Number(d.maxRelaxationTime) || 0
        : 0,
      maxPhysicalTimeS: d.maxPhysicalTime?.trim()
        ? Number(d.maxPhysicalTime) || 0
        : 0,
      maxPseudotimeS: d.maxPseudotime?.trim()
        ? Number(d.maxPseudotime) || 0
        : 0,
      relaxAlpha: Number(d.relaxAlpha) || 1.0,
      integrator,
      timestepMode:
        d.timestepMode === "fixed" || d.timestepMode === "adaptive"
          ? d.timestepMode
          : "auto",
      dtS: Number(d.dt) || 1e-13,
      dtMinS: Number(d.dtMin) || 1e-15,
      dtMaxS: Number(d.dtMax) || 1e-11,
      toleranceMode: d.toleranceMode === "advanced" ? "advanced" : "max_error",
      maxVectorError: Number(d.maxError) || 1e-5,
      atol: Number(d.atol) || 1e-7,
      rtol: Number(d.rtol) || 1e-5,
      safety: Number(d.safety) || 0.9,
      growthLimit: Number(d.growthLimit) || 2,
      shrinkLimit: Number(d.shrinkLimit) || 0.2,
      maxSpinRotation: d.maxSpinRotation ?? "",
      normTolerance: d.normTolerance ?? "",
      demagIntervalS: d.demagInterval?.trim()
        ? Number(d.demagInterval) || 0
        : 0,
      fieldEverySteps: d.fieldEvery ?? "",
      stageAutosave: d.stageAutosave ?? DEFAULT_RELAX_AUTOSAVE,
      stageMagnetizationAssignments: d.stageMagnetizationAssignments,
      deviceLabel: `Requested ${globalDraft.requestedDevice || "auto"}`,
    };
  }, [globalDraft.requestedDevice, selectedStageDraft, selectedStageIndex, selection.ref]);

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
        <RelaxStageInspectorPanelView
          hydratedBaseline={hydratedBaseline}
          lastAuthoringError={lastAuthoringError}
          pipelineNodeId={selectedStageDraft?.pipelineNodeId}
          pipelineStripSteps={pipelineStripSteps}
          sceneData={sceneData}
          sceneRevision={sceneRevision}
          selection={selection}
          stageModel={selectedStageModel}
          validationContext={validationContext}
          onCommitStage={(draft) =>
            commitSelectedStageDraft(
              (base) => toRelaxStudyStageDraft(draft, base),
              "relax",
            )
          }
          onRunStage={(stageId, initialChoice) =>
            executeSelectedStage(stageId, initialChoice, "relax")
          }
        />
      )}
    </StudyStageTelemetryBridge>
  );
}

function RelaxStageInspectorPanelView({
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
}: InspectorPanelProps & {
  hydratedBaseline?: RelaxStageDraft;
  lastAuthoringError?: string | null;
  onCommitStage?: (draft: RelaxStageDraft) => Promise<boolean>;
  onRunStage?: (stageId: string, initialChoice?: StageInitialStateChoice) => Promise<void>;
  pipelineNodeId?: string;
  pipelineStripSteps?: readonly PipelineStripStep[];
  sceneData?: SceneResource | null;
  sceneRevision?: number | null;
  stageModel?: StudyStageModel | null;
  validationContext?: StageValidationContext;
}) {
  const kernel = useContext(KernelContext);
  const [initialChoice, setInitialChoice] = useState<StageInitialStateChoice>({
    kind: "default_for_target",
  });
  const { index, stageId: fallbackId } = resolveStageMeta(selection, "relax");
  const stageId = hydratedBaseline?.stageId ?? fallbackId;
  const titleLabel = `Relax ${index + 1}`;

  const fallbackBaseline = useMemo<RelaxStageDraft>(
    () => ({
      stageId,
      stageEnabled: true,
      method: "projected_gradient_bb",
      torqueToleranceApm: 100,
      energyToleranceJ: 0,
      maxSteps: 50000,
      maxRelaxationTimeS: 5e-9,
      maxPhysicalTimeS: 0,
      maxPseudotimeS: 0,
      relaxAlpha: 1.0,
      integrator: "",
      timestepMode: "fixed",
      dtS: 1e-13,
      dtMinS: 1e-15,
      dtMaxS: 1e-11,
      toleranceMode: "max_error",
      maxVectorError: 1e-5,
      atol: 1e-7,
      rtol: 1e-5,
      safety: 0.9,
      growthLimit: 2,
      shrinkLimit: 0.2,
      maxSpinRotation: "",
      normTolerance: "",
      demagIntervalS: 0,
      fieldEverySteps: "",
      stageAutosave: DEFAULT_RELAX_AUTOSAVE,
      stageMagnetizationAssignments: undefined,
      deviceLabel: "Auto → GPU",
    }),
    [stageId],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const resolvedSteps = useMemo<readonly PipelineStripStep[]>(
    () =>
      pipelineStripSteps && pipelineStripSteps.length > 0
        ? pipelineStripSteps
        : [
            { id: stageId, index, kind: "study.stage.relax", label: "Relax", status: "ready" },
            { id: "run_next", index: index + 1, kind: "study.stage.run", label: "Run", status: "ready" },
          ],
    [index, pipelineStripSteps, stageId],
  );

  const methodDisabledReason = useCallback(
    (algorithm: string): string | undefined => {
      if (!validationContext) return undefined;
      const avail = relaxationAlgorithmAvailability(algorithm, validationContext);
      return avail.supported ? undefined : (avail.reason ?? "Unavailable in active session");
    },
    [validationContext],
  );

  const spec = useMemo<InspectorSpec<RelaxStageDraft>>(
    () => ({
      id: "study.stage.relax",
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
              ctx.notify("Relaxation queued", ctx.draft.stageId);
            }
          },
        },
      },
      identity: {
        domain: "study",
        icon: Play,
        title: () => titleLabel,
        kindLabel: "Relaxation stage",
        entityId: stageId,
        statePill: (d) =>
          d.stageEnabled ? { tone: "ok", label: "Ready" } : { tone: "neutral", label: "Skipped" },
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "pos", label: "Position", value: `${index + 1} in pipeline` },
        {
          id: "method",
          label: "Method",
          value:
            d.method === "projected_gradient_bb"
              ? "Projected grad BB"
              : d.method === "nonlinear_cg"
                ? "Nonlinear CG"
                : d.method === "tangent_plane_implicit"
                  ? "Tangent implicit"
                  : "Damped LLG",
        },
        {
          id: "tol",
          label: "Stop |m×B|",
          value: `${(d.torqueToleranceApm * 4 * Math.PI * 1e-7 * 1e3).toFixed(3)} mT`,
        },
        { id: "dev", label: "Device", value: d.deviceLabel },
      ],
      modeTabs: [
        { id: "setup", label: "Setup" },
        { id: "telemetry", label: "Telemetry", commitModeOverride: "readOnly" },
      ],
      notices: (d): readonly InspectorNotice<RelaxStageDraft>[] => {
        const list: InspectorNotice<RelaxStageDraft>[] = [];
        if (lastAuthoringError) {
          list.push({
            id: "authoring-error",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        const stageDraft = toRelaxStudyStageDraft(d);
        if (pipelineNodeId) stageDraft.pipelineNodeId = pipelineNodeId;
        const issues = validateStudyStageDraft(stageDraft, validationContext);
        for (let i = 0; i < issues.length; i += 1) {
          const issue = issues[i]!;
          list.push({
            id: `relax-validation-${i}`,
            tone: issue.severity === "error" ? "err" : "warn",
            text: issue.message,
          });
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
            {
              label: "State handoff",
              type: "readonly",
              format: () => "In-place equilibrium state passed to next stage",
            },
          ],
        },
        {
          id: "method-stop",
          title: "Method & Stop Criteria",
          icon: Gauge,
          modeTabId: "setup",
          defaultOpen: true,
          rows: [
            {
              key: "method",
              label: "Method",
              type: "select",
              structural: true,
              options: [
                {
                  value: "projected_gradient_bb",
                  label: "LLG Projected Gradient (BB)",
                  disabledReason: methodDisabledReason("projected_gradient_bb"),
                },
                {
                  value: "nonlinear_cg",
                  label: "Nonlinear Conjugate Gradient",
                  disabledReason: methodDisabledReason("nonlinear_cg"),
                },
                {
                  value: "llg_overdamped",
                  label: "Damped LLG Precessional-Free",
                  disabledReason: methodDisabledReason("llg_overdamped"),
                },
                {
                  value: "tangent_plane_implicit",
                  label: "Tangent-Plane Implicit (FEM CPU extended)",
                  disabledReason: methodDisabledReason("tangent_plane_implicit"),
                },
              ],
            },
            {
              key: "torqueToleranceApm",
              label: "Max torque |m × B|",
              symbol: (
                <>
                  τ<sub>tol</sub>
                </>
              ),
              type: "quantity",
              units: TORQUE_APM_UNITS_SI,
              defaultDisplayUnit: "mT",
              min: 0,
              minExclusive: true,
              scrub: "log",
            },
            {
              key: "energyToleranceJ",
              label: "Energy tolerance (0 = unset)",
              symbol: (
                <>
                  ε<sub>E</sub>
                </>
              ),
              type: "quantity",
              units: ENERGY_JOULE_UNITS_SI,
              defaultDisplayUnit: "J",
              min: 0,
              scrub: "log",
            },
            {
              key: "maxSteps",
              label: "Step limit",
              symbol: (
                <>
                  N<sub>max</sub>
                </>
              ),
              type: "number",
              integer: true,
              min: 1,
              max: 10000000,
            },
            {
              key: "maxRelaxationTimeS",
              label: "Max relaxation time (0 = unset)",
              symbol: (
                <>
                  t<sub>relax</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ns",
              min: 0,
              showWhen: (d) => d.method === "llg_overdamped",
            },
            {
              key: "maxPhysicalTimeS",
              label: "Max physical time (0 = unset)",
              symbol: (
                <>
                  t<sub>max</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ns",
              min: 0,
              showWhen: (d) => d.method === "llg_overdamped",
            },
            {
              key: "maxPseudotimeS",
              label: "Max pseudotime (0 = unset)",
              symbol: (
                <>
                  τ<sub>max</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ns",
              min: 0,
            },
          ],
        },
        {
          id: "llg-integrator",
          title: "Damped LLG Integrator",
          icon: Timer,
          modeTabId: "setup",
          defaultOpen: true,
          showWhen: (d) => d.method === "llg_overdamped",
          rows: [
            {
              key: "relaxAlpha",
              label: "Relaxation damping",
              symbol: (
                <>
                  α<sub>relax</sub>
                </>
              ),
              type: "number",
              min: 0.01,
              max: 10,
              step: 0.1,
            },
            {
              key: "integrator",
              label: "Integrator",
              type: "select",
              structural: true,
              options: [
                { value: "", label: "Inherit from Study" },
                { value: "rk23", label: "RK23 Bogacki–Shampine" },
                { value: "rk45", label: "RK45 Dormand–Prince" },
                { value: "heun", label: "Heun" },
              ],
            },
            {
              key: "timestepMode",
              label: "Timestep mode",
              type: "segmented",
              structural: true,
              options: [
                { value: "auto", label: "Auto" },
                { value: "fixed", label: "Fixed" },
                { value: "adaptive", label: "Adaptive" },
              ],
            },
            {
              key: "dtS",
              label: "Timestep",
              symbol: "Δt",
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
              minExclusive: true,
              scrub: "log",
              showWhen: (d) => d.timestepMode !== "auto",
            },
            {
              key: "dtMinS",
              label: "Min timestep",
              symbol: (
                <>
                  Δt<sub>min</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "fs",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.timestepMode === "adaptive",
            },
            {
              key: "dtMaxS",
              label: "Max timestep",
              symbol: (
                <>
                  Δt<sub>max</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.timestepMode === "adaptive",
            },
            {
              key: "toleranceMode",
              label: "Tolerance mode",
              type: "segmented",
              structural: true,
              showWhen: (d) => d.timestepMode === "adaptive",
              options: [
                { value: "max_error", label: "Max vector error" },
                { value: "advanced", label: "Advanced atol/rtol" },
              ],
            },
            {
              key: "maxVectorError",
              label: "Maximum embedded vector error",
              type: "number",
              min: 1e-12,
              max: 1e-1,
              scrub: "log",
              showWhen: (d) =>
                d.timestepMode === "adaptive" && d.toleranceMode === "max_error",
            },
            {
              key: "atol",
              label: "Absolute tolerance (atol)",
              type: "number",
              min: 1e-15,
              max: 1e-2,
              scrub: "log",
              showWhen: (d) =>
                d.timestepMode === "adaptive" && d.toleranceMode === "advanced",
            },
            {
              key: "rtol",
              label: "Relative tolerance (rtol)",
              type: "number",
              min: 1e-15,
              max: 1e-2,
              scrub: "log",
              showWhen: (d) =>
                d.timestepMode === "adaptive" && d.toleranceMode === "advanced",
            },
            {
              key: "safety",
              label: "Safety factor",
              type: "number",
              min: 0.1,
              max: 1,
              step: 0.05,
              showWhen: (d) =>
                d.timestepMode === "adaptive" && d.toleranceMode === "advanced",
            },
            {
              key: "growthLimit",
              label: "Growth limit",
              type: "number",
              min: 1,
              max: 20,
              showWhen: (d) =>
                d.timestepMode === "adaptive" && d.toleranceMode === "advanced",
            },
            {
              key: "shrinkLimit",
              label: "Shrink limit",
              type: "number",
              min: 0.01,
              max: 1,
              step: 0.05,
              showWhen: (d) =>
                d.timestepMode === "adaptive" && d.toleranceMode === "advanced",
            },
            {
              key: "maxSpinRotation",
              label: "Max spin rotation (rad, optional)",
              type: "text",
              mono: true,
              placeholder: "Blank to omit",
              showWhen: (d) =>
                d.timestepMode === "adaptive" && d.toleranceMode === "advanced",
            },
            {
              key: "normTolerance",
              label: "Norm tolerance (optional)",
              type: "text",
              mono: true,
              placeholder: "Blank to omit",
              showWhen: (d) =>
                d.timestepMode === "adaptive" && d.toleranceMode === "advanced",
            },
            {
              key: "demagIntervalS",
              label: "Demag update interval (0 = every step)",
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
            },
            ...(!pipelineNodeId
              ? [
                  {
                    key: "fieldEverySteps" as const,
                    label: "Push field every N steps",
                    type: "text" as const,
                    mono: true,
                    placeholder: "Blank to omit",
                  },
                ]
              : []),
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
                  owner="relax"
                  onChange={(stageAutosave) =>
                    ctx.setField("stageAutosave", stageAutosave)
                  }
                />
              ),
            },
          ],
        },
        {
          id: "initial-state",
          title: "Initial State & Overrides",
          icon: Compass,
          modeTabId: "setup",
          defaultOpen: false,
          rows: [
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
                      draft: RelaxStageDraft;
                      setField: <K extends keyof RelaxStageDraft>(
                        k: K,
                        v: RelaxStageDraft[K],
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
          id: "telemetry-convergence",
          title: "Convergence & Telemetry",
          icon: Activity,
          modeTabId: "telemetry",
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: () => (
                <StageLiveTelemetryPanel
                  emptyDescription="Run this relaxation stage to record max torque |m × B| and energy convergence telemetry."
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
      methodDisabledReason,
      onCommitStage,
      onRunStage,
      pipelineNodeId,
      resolvedSteps,
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
