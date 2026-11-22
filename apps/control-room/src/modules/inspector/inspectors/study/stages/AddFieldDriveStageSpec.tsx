"use client";

import {
  Magnet,
  Waves,
  Workflow,
  Zap,
} from "lucide-react";
import { useContext, useMemo } from "react";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { validateFieldDriveDraft } from "@/shared/domain/physics/fieldDrive";
import { Button } from "@/shared/ui/Button";
import { Switch } from "@/shared/ui/Switch";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorFact, InspectorNotice, InspectorSpec } from "../../../template";
import {
  regionalFieldDriveSelectorOptions,
} from "../../../panels/RegionalFieldDrivePanelModel";
import {
  ANGLE_RAD_UNITS_SI,
  FIELD_TESLA_UNITS_SI,
  formatFrequencyCompact,
  FREQUENCY_UNITS_SI,
  LENGTH_UNITS_SI,
  PipelineStrip,
  TIME_UNITS_SI,
  type PipelineStripStep,
} from "../../../panels/study/ConnectedInspectorSpec";
import { useKernelStudyAuthoring } from "../../../panels/study/useConnectedStudyAuthoring";
import { SamplingDiagnostics } from "../../../panels/stages/SamplingDiagnostics";
import {
  serializeStageEnabled,
  StageSpecHost,
} from "../../../panels/stages/StageSharedControls";
import type {
  EffectiveStudyTableAutosave,
} from "../../../panels/stages/studyWorkflowState";
import { stageBreadcrumbs, resolveStageMeta, fallbackPipelineSteps } from "./stageShared";
import {
  type AddFieldDriveDraft,
  buildAddFieldDriveHydratedBaseline,
  buildFieldDriveResourceFromDraft,
  parsePiecewisePoints,
  resolveAddFieldDriveSamplingContext,
  SincPulseChart,
} from "./SincPulseChartAndDriveModel";
export function AddFieldDriveStageInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedAddFieldDriveStageInspectorPanel selection={selection} />;
  }
  return <AddFieldDriveStageInspectorPanelView selection={selection} />;
}

function ConnectedAddFieldDriveStageInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const {
    commitSelectedStageDraft,
    lastAuthoringError,
    pipelineStripSteps,
    sceneData,
    selectedStageDraft,
    selectedStageIndex,
    stageDrafts,
  } = useKernelStudyAuthoring(selection);

  const availableRunIds = useMemo(() => {
    const following = stageDrafts
      .slice(selectedStageIndex + 1)
      .filter((s) => s.kind === "run")
      .map((s) => s.stageId);
    if (following.length > 0) return following;
    return stageDrafts.filter((s) => s.kind === "run").map((s) => s.stageId);
  }, [selectedStageIndex, stageDrafts]);

  const samplingContext = useMemo(
    () =>
      resolveAddFieldDriveSamplingContext({
        sceneData,
        selectedStageDraft,
        selectedStageIndex,
        stageDrafts,
      }),
    [sceneData, selectedStageDraft, selectedStageIndex, stageDrafts],
  );

  const hydratedBaseline = useMemo<AddFieldDriveDraft>(
    () =>
      buildAddFieldDriveHydratedBaseline({
        sceneData,
        selectedStageDraft,
        selectedStageIndex,
        selection,
      }),
    [sceneData, selectedStageDraft, selectedStageIndex, selection],
  );
  return (
    <AddFieldDriveStageInspectorPanelView
      followingRunIds={availableRunIds}
      hydratedBaseline={hydratedBaseline}
      lastAuthoringError={lastAuthoringError}
      pipelineNodeId={selectedStageDraft?.pipelineNodeId}
      pipelineStripSteps={pipelineStripSteps}
      samplingContext={samplingContext}
      sceneData={sceneData}
      selection={selection}
      onCommitStage={(draft) =>
        commitSelectedStageDraft(
          (base) => ({
            ...base,
            kind: "add_field_drive",
            stageId: draft.stageId,
            stageEnabled: serializeStageEnabled(draft.stageEnabled, base),
            fieldDrive: buildFieldDriveResourceFromDraft(
              draft,
              base.fieldDrive,
            ),
          }),
          "add_field_drive",
        )
      }
    />
  );
}

function AddFieldDriveStageInspectorPanelView({
  followingRunIds = [],
  hydratedBaseline,
  lastAuthoringError = null,
  onCommitStage,
  pipelineNodeId,
  pipelineStripSteps,
  samplingContext,
  sceneData = null,
  selection,
}: InspectorPanelProps & {
  followingRunIds?: readonly string[];
  hydratedBaseline?: AddFieldDriveDraft;
  lastAuthoringError?: string | null;
  onCommitStage?: (draft: AddFieldDriveDraft) => Promise<boolean>;
  pipelineNodeId?: string;
  pipelineStripSteps?: readonly PipelineStripStep[];
  samplingContext?: {
    durationS: number | null;
    effectiveSampling: EffectiveStudyTableAutosave | null;
    samplePeriodS: number | null;
    solverDtS: number | null;
    targetRunStageId: string | null;
  };
  sceneData?: SceneResource | null;
}) {
  const { index, stageId: fallbackId } = resolveStageMeta(selection, "add_field_drive");
  const stageId = hydratedBaseline?.stageId ?? fallbackId;
  const titleLabel = `Add Field Drive ${index + 1}`;
  const selectorOptions = useMemo(
    () => regionalFieldDriveSelectorOptions(sceneData),
    [sceneData],
  );

  const fallbackBaseline = useMemo<AddFieldDriveDraft>(
    () => ({
      stageId,
      stageEnabled: true,
      driveEnabled: true,
      driveName: "Uniform transverse k0 sinc antenna",
      driveId: stageId,
      activationScope: "all_time_evolution",
      selectedRunStageIds: [],
      amplitudeTesla: 1e-3,
      direction: [0, 1, 0],
      targetDomain: "global",
      targetObjectId: "",
      targetRegionId: "",
      spatialProfile: "uniform",
      spatialAxis: [1, 0, 0],
      spatialPeriodM: 100e-9,
      spatialCenterM: 0,
      spatialWidthText: "",
      spatialWindow: "none",
      maskObjectId: "",
      maskEnvelopeKind: "uniform",
      waveformKind: "sinc_pulse",
      cutoffHz: 40e9,
      pulseCenterS: 50e-12,
      waveformAmplitude: 1,
      sineFrequencyHz: 10e9,
      sinePhaseRad: 0,
      sineOffset: 0,
      pulseOnS: 10e-12,
      pulseOffS: 100e-12,
      piecewisePointsText: "0, 0\n1e-9, 1",
      timeOrigin: "stage_local",
    }),
    [stageId],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const resolvedSteps = useMemo<readonly PipelineStripStep[]>(
    () =>
      pipelineStripSteps && pipelineStripSteps.length > 0
        ? pipelineStripSteps
        : fallbackPipelineSteps(
            stageId,
            index,
            "study.stage.add_field_drive",
            "Add field drive",
          ),
    [index, pipelineStripSteps, stageId],
  );

  const spec = useMemo<InspectorSpec<AddFieldDriveDraft>>(() => {
    const hasSceneObjects = sceneData !== null && selectorOptions.objects.length > 0;
    const objectOptions = selectorOptions.objects.map((o) => ({
      value: o.id,
      label: o.label,
    }));

    return {
      id: "study.stage.add_field_drive",
      header: {
        breadcrumbs: stageBreadcrumbs(titleLabel),
        canFitView: true,
      },
      identity: {
        domain: "study",
        icon: Zap,
        title: (d) => d.driveName,
        renameFieldKey: "driveName",
        kindLabel: "Regional field drive instruction",
        entityId: stageId,
        statePill: (d) =>
          d.driveEnabled
            ? { tone: "ok", label: "0 s config" }
            : { tone: "neutral", label: "Drive OFF" },
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "dur", label: "Duration", value: "0 s (config)" },
        { id: "wf", label: "Waveform", value: d.waveformKind.replace(/_/g, " ") },
        { id: "amp", label: "Amplitude B₀", value: `${(d.amplitudeTesla * 1e3).toFixed(2)} mT` },
        {
          id: "fc",
          label: "Cutoff fc",
          value: d.waveformKind === "sinc_pulse" ? formatFrequencyCompact(d.cutoffHz) : null,
        },
      ],
      notices: (d) => {
        const list: InspectorNotice<AddFieldDriveDraft>[] = [];
        if (lastAuthoringError) {
          list.push({
            id: "authoring-error",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        if (
          d.waveformKind === "sinc_pulse" &&
          d.pulseCenterS < 6 / Math.max(d.cutoffHz, 1)
        ) {
          list.push({
            id: "sinc-truncation",
            tone: "warn",
            text: "Pulse center t₀ is shorter than 6 / fc, truncating the leading sinc lobe at t = 0.",
            quickFix: {
              label: "Set t₀ = 8 / fc",
              onApply: (ctx) => ctx.setField("pulseCenterS", 8 / ctx.draft.cutoffHz),
            },
          });
        }
        const driveCandidate = buildFieldDriveResourceFromDraft(d);
        const driveErrors = validateFieldDriveDraft(driveCandidate);
        for (let i = 0; i < driveErrors.length; i += 1) {
          list.push({
            id: `drive-validation-${i}`,
            tone: "err",
            text: driveErrors[i]!,
          });
        }
        return list;
      },
      sections: [
        {
          id: "pipeline",
          title: "Pipeline & Activation",
          icon: Workflow,
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
              key: "driveEnabled",
              label: "Enable field drive",
              type: "switch",
            },
            ...(pipelineNodeId
              ? [
                  {
                    key: "stageEnabled" as const,
                    label: "Include pipeline node",
                    type: "switch" as const,
                  },
                ]
              : []),
            {
              key: "driveId",
              label: "Drive ID",
              type: "text",
              mono: true,
              validate: (val) => (!val.trim() ? "Drive ID is required." : null),
            },
            {
              key: "activationScope",
              label: "Activation scope",
              type: "segmented",
              structural: true,
              options: [
                { value: "all_time_evolution", label: "All following Runs" },
                { value: "stage_ids", label: "Selected Runs" },
              ],
            },
            {
              type: "custom",
              label: "Target Run stages",
              wide: true,
              showWhen: (d) => d.activationScope === "stage_ids",
              render: (ctx) => {
                const candidateRunIds = Array.from(
                  new Set([...followingRunIds, ...ctx.draft.selectedRunStageIds]),
                );
                return candidateRunIds.length === 0 ? (
                  <div className="text-xs text-fm-muted">
                    Add a Run stage in Study › Stages to bind specific Run stage IDs.
                  </div>
                ) : (
                  <div className="grid gap-1.5 text-xs">
                    {candidateRunIds.map((runId) => {
                      const active = ctx.draft.selectedRunStageIds.includes(runId);
                      return (
                        <div
                          className="flex items-center justify-between gap-2"
                          key={runId}
                        >
                          <span className="font-mono">{runId}</span>
                          <Switch
                            aria-label={`Activate drive in ${runId}`}
                            checked={active}
                            onCheckedChange={(checked) =>
                              ctx.setField(
                                "selectedRunStageIds",
                                checked
                                  ? [...ctx.draft.selectedRunStageIds, runId]
                                  : ctx.draft.selectedRunStageIds.filter(
                                      (id) => id !== runId,
                                    ),
                              )
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                );
              },
            },
          ],
        },
        {
          id: "spatial-target",
          title: "Spatial Target & Field Vector",
          icon: Magnet,
          defaultOpen: true,
          rows: [
            {
              key: "amplitudeTesla",
              label: "Amplitude",
              symbol: (
                <>
                  B<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: FIELD_TESLA_UNITS_SI,
              defaultDisplayUnit: "mT",
              min: 0,
              scrub: "log",
            },
            {
              key: "direction",
              label: "Direction",
              symbol: (
                <>
                  ê<sub>B</sub>
                </>
              ),
              type: "vector3",
              normalizeAction: true,
            },
            {
              key: "targetDomain",
              label: "Target domain",
              type: "segmented",
              structural: true,
              options: [
                { value: "global", label: "Global" },
                { value: "object", label: "Object" },
                { value: "region", label: "Region" },
              ],
            },
            ...(hasSceneObjects
              ? [
                  {
                    key: "targetObjectId" as const,
                    label: "Target object",
                    type: "select" as const,
                    structural: true,
                    showWhen: (d: AddFieldDriveDraft) => d.targetDomain !== "global",
                    options: [
                      { value: "", label: "Select an object…" },
                      ...objectOptions,
                      ...(baseline.targetObjectId &&
                      !objectOptions.some((o) => o.value === baseline.targetObjectId)
                        ? [{ value: baseline.targetObjectId, label: baseline.targetObjectId }]
                        : []),
                    ],
                  },
                  {
                    type: "custom" as const,
                    label: "Target region",
                    showWhen: (d: AddFieldDriveDraft) => d.targetDomain === "region",
                    render: (ctx: {
                      draft: AddFieldDriveDraft;
                      setField: <K extends keyof AddFieldDriveDraft>(
                        k: K,
                        v: AddFieldDriveDraft[K],
                      ) => void;
                    }) => {
                      const regionChoices =
                        selectorOptions.regionsByObject[ctx.draft.targetObjectId] ?? [];
                      const allRegions =
                        ctx.draft.targetRegionId &&
                        !regionChoices.some((r) => r.id === ctx.draft.targetRegionId)
                          ? [
                              ...regionChoices,
                              {
                                id: ctx.draft.targetRegionId,
                                label: ctx.draft.targetRegionId,
                              },
                            ]
                          : regionChoices;
                      return (
                        <div className="grid gap-1 text-xs">
                          <div className="flex flex-wrap gap-1">
                            {allRegions.length > 0 ? (
                              allRegions.map((reg) => (
                                <Button
                                  key={reg.id}
                                  size="sm"
                                  type="button"
                                  variant={
                                    ctx.draft.targetRegionId === reg.id
                                      ? "primary"
                                      : "secondary"
                                  }
                                  onClick={() =>
                                    ctx.setField("targetRegionId", reg.id)
                                  }
                                >
                                  {reg.label}
                                </Button>
                              ))
                            ) : (
                              <span className="text-fm-muted">
                                {ctx.draft.targetObjectId
                                  ? "No regions declared on selected object."
                                  : "Select a target object first."}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    },
                  },
                ]
              : [
                  {
                    key: "targetObjectId" as const,
                    label: "Target object",
                    type: "text" as const,
                    mono: true,
                    showWhen: (d: AddFieldDriveDraft) => d.targetDomain !== "global",
                  },
                  {
                    key: "targetRegionId" as const,
                    label: "Target region",
                    type: "text" as const,
                    mono: true,
                    showWhen: (d: AddFieldDriveDraft) => d.targetDomain === "region",
                  },
                ]),
            {
              key: "spatialProfile",
              label: "Spatial profile",
              type: "select",
              structural: true,
              options: [
                { value: "uniform", label: "Uniform" },
                { value: "sinc", label: "Spatial sinc (finite-k)" },
                { value: "geometry_mask", label: "Geometry object mask" },
              ],
            },
            ...(hasSceneObjects
              ? [
                  {
                    key: "maskObjectId" as const,
                    label: "Mask geometry object",
                    type: "select" as const,
                    showWhen: (d: AddFieldDriveDraft) =>
                      d.spatialProfile === "geometry_mask",
                    options: [
                      { value: "", label: "Select mask geometry…" },
                      ...objectOptions,
                      ...(baseline.maskObjectId &&
                      !objectOptions.some((o) => o.value === baseline.maskObjectId)
                        ? [{ value: baseline.maskObjectId, label: baseline.maskObjectId }]
                        : []),
                    ],
                  },
                ]
              : [
                  {
                    key: "maskObjectId" as const,
                    label: "Mask geometry object",
                    type: "text" as const,
                    mono: true,
                    showWhen: (d: AddFieldDriveDraft) =>
                      d.spatialProfile === "geometry_mask",
                  },
                ]),
            {
              key: "maskEnvelopeKind",
              label: "Mask spatial envelope",
              type: "segmented",
              structural: true,
              showWhen: (d) => d.spatialProfile === "geometry_mask",
              options: [
                { value: "uniform", label: "Uniform" },
                { value: "sinc", label: "Spatial sinc" },
              ],
            },
            {
              key: "spatialAxis",
              label: "Spatial sinc axis",
              type: "vector3",
              normalizeAction: true,
              showWhen: (d) =>
                d.spatialProfile === "sinc" ||
                (d.spatialProfile === "geometry_mask" &&
                  d.maskEnvelopeKind === "sinc"),
            },
            {
              key: "spatialPeriodM",
              label: "Spatial period",
              symbol: (
                <>
                  λ<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS_SI,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) =>
                d.spatialProfile === "sinc" ||
                (d.spatialProfile === "geometry_mask" &&
                  d.maskEnvelopeKind === "sinc"),
            },
            {
              key: "spatialCenterM",
              label: "Spatial center",
              type: "quantity",
              units: LENGTH_UNITS_SI,
              defaultDisplayUnit: "nm",
              showWhen: (d) =>
                d.spatialProfile === "sinc" ||
                (d.spatialProfile === "geometry_mask" &&
                  d.maskEnvelopeKind === "sinc"),
            },
            {
              key: "spatialWidthText",
              label: "Spatial width (m, optional)",
              type: "text",
              mono: true,
              placeholder: "Blank for unbounded envelope",
              showWhen: (d) =>
                d.spatialProfile === "sinc" ||
                (d.spatialProfile === "geometry_mask" &&
                  d.maskEnvelopeKind === "sinc"),
              validate: (val) =>
                val.trim() && (!Number.isFinite(Number(val)) || Number(val) <= 0)
                  ? "Spatial width must be positive when set."
                  : null,
            },
            {
              key: "spatialWindow",
              label: "Spatial window",
              type: "segmented",
              showWhen: (d) =>
                d.spatialProfile === "sinc" ||
                (d.spatialProfile === "geometry_mask" &&
                  d.maskEnvelopeKind === "sinc"),
              options: [
                { value: "none", label: "None" },
                { value: "hann", label: "Hann" },
                { value: "hamming", label: "Hamming" },
                { value: "blackman", label: "Blackman" },
              ],
            },
          ],
        },
        {
          id: "waveform",
          title: "Time Waveform & Spectrum Preview",
          icon: Waves,
          defaultOpen: true,
          rows: [
            {
              key: "waveformKind",
              label: "Waveform",
              type: "select",
              structural: true,
              options: [
                { value: "constant", label: "Constant" },
                { value: "sinusoidal", label: "Sinusoidal" },
                { value: "pulse", label: "Rectangular pulse" },
                { value: "piecewise_linear", label: "Piecewise linear" },
                { value: "sinc_pulse", label: "Sinc pulse" },
              ],
            },
            {
              key: "cutoffHz",
              label: "Cutoff frequency",
              symbol: (
                <>
                  f<sub>c</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS_SI,
              defaultDisplayUnit: "GHz",
              min: 0,
              minExclusive: true,
              scrub: "log",
              showWhen: (d) => d.waveformKind === "sinc_pulse",
            },
            {
              key: "pulseCenterS",
              label: "Pulse center",
              symbol: (
                <>
                  t<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
              showWhen: (d) => d.waveformKind === "sinc_pulse",
            },
            {
              key: "waveformAmplitude",
              label: "Waveform scale a",
              type: "number",
              step: 0.1,
              showWhen: (d) => d.waveformKind === "sinc_pulse",
            },
            {
              key: "sineFrequencyHz",
              label: "Drive frequency",
              symbol: (
                <>
                  f<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS_SI,
              defaultDisplayUnit: "GHz",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.waveformKind === "sinusoidal",
            },
            {
              key: "sinePhaseRad",
              label: "Initial phase",
              symbol: (
                <>
                  φ<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: ANGLE_RAD_UNITS_SI,
              defaultDisplayUnit: "deg",
              showWhen: (d) => d.waveformKind === "sinusoidal",
            },
            {
              key: "sineOffset",
              label: "DC offset",
              type: "number",
              step: 0.01,
              showWhen: (d) => d.waveformKind === "sinusoidal",
            },
            {
              key: "pulseOnS",
              label: "Pulse on time",
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
              showWhen: (d) => d.waveformKind === "pulse",
            },
            {
              key: "pulseOffS",
              label: "Pulse off time",
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.waveformKind === "pulse",
              validate: (val, d) =>
                val <= d.pulseOnS ? "Pulse off time must exceed pulse on time." : null,
            },
            {
              key: "piecewisePointsText",
              label: "Points (time_s, value; one pair per line)",
              type: "expression",
              multiline: true,
              showWhen: (d) => d.waveformKind === "piecewise_linear",
              validate: (val) => parsePiecewisePoints(val).error,
            },
            {
              key: "timeOrigin",
              label: "Time origin",
              type: "segmented",
              showWhen: (d) => d.waveformKind !== "constant",
              options: [
                { value: "stage_local", label: "Stage local (t = 0)" },
                { value: "absolute", label: "Absolute time" },
              ],
            },
            {
              type: "custom",
              wide: true,
              showWhen: (d) => d.waveformKind === "sinc_pulse",
              render: (ctx) => (
                <div className="grid gap-2">
                  <SincPulseChart
                    amplitudeTesla={ctx.draft.amplitudeTesla}
                    cutoffHz={ctx.draft.cutoffHz}
                    durationS={samplingContext?.durationS ?? null}
                    samplePeriodS={samplingContext?.samplePeriodS ?? null}
                    solverDtS={samplingContext?.solverDtS ?? null}
                    t0Seconds={ctx.draft.pulseCenterS}
                    waveformAmplitude={ctx.draft.waveformAmplitude}
                  />
                  {samplingContext ? (
                    <SamplingDiagnostics
                      durationS={samplingContext.durationS}
                      sampling={samplingContext.effectiveSampling}
                    />
                  ) : null}
                </div>
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
    };
  }, [
    baseline.maskObjectId,
    baseline.targetObjectId,
    followingRunIds,
    index,
    lastAuthoringError,
    onCommitStage,
    pipelineNodeId,
    resolvedSteps,
    samplingContext,
    sceneData,
    selectorOptions.objects,
    selectorOptions.regionsByObject,
    stageId,
    titleLabel,
  ]);

  return (
    <StageSpecHost
      baseline={baseline}
      selection={selection}
      spec={spec}
      deriveFieldPatch={(key, value, nextDraft) => {
        if (key === "targetObjectId") {
          const nextObj = String(value ?? "");
          const validRegions = selectorOptions.regionsByObject[nextObj] ?? [];
          if (
            nextDraft.targetRegionId &&
            !validRegions.some((r) => r.id === nextDraft.targetRegionId)
          ) {
            return { targetRegionId: validRegions[0]?.id ?? "" };
          }
        }
        return null;
      }}
    />
  );
}
