"use client";

import {
  Activity,
  Database,
  FileOutput,
  Timer,
} from "lucide-react";
import { useContext, useMemo } from "react";

import { KernelContext } from "@/kernel/KernelContext";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorFact, InspectorNotice, InspectorSpec } from "../../../template";
import {
  formatFrequencyCompact,
  formatTimeCompact,
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
import {
  resolveStudyWorkflowStateBefore,
  type EffectiveStudyTableAutosave,
} from "../../../panels/stages/studyWorkflowState";
import { stageBreadcrumbs, resolveStageMeta, fallbackPipelineSteps } from "./stageShared";
const TABLE_QUANTITY_PRESETS = [
  "t",
  "step",
  "mx",
  "my",
  "mz",
  "E_tot",
  "e_drive",
  "max_torque",
  "q_top",
] as const;

interface TableAutosaveDraft {
  stageId: string;
  stageEnabled: boolean;
  enabled: boolean;
  samplingMode: "explicit" | "auto_sinc_cutoff";
  samplePeriodS: number;
  tableQuantities: string;
  readOnly: boolean;
}

function splitCsvTokens(csv: string): string[] {
  return csv
    .split(",")
    .map((q) => q.trim())
    .filter(Boolean);
}

function toggleCsvQuantity(csv: string, token: string): string {
  const existing = splitCsvTokens(csv);
  if (existing.includes(token)) {
    return existing.filter((item) => item !== token).join(", ");
  }
  return [...existing, token].join(", ");
}

export function TableAutosaveStageInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedTableAutosaveStagePanel selection={selection} />;
  }
  return <TableAutosaveStageInspectorPanelView selection={selection} />;
}

function ConnectedTableAutosaveStagePanel({ selection }: InspectorPanelProps) {
  const {
    commitSelectedStageDraft,
    lastAuthoringError,
    pipelineStripSteps,
    selectedStageDraft,
    selectedStageIndex,
    stageDrafts,
  } = useKernelStudyAuthoring(selection);

  const clockContext = useMemo(() => {
    const stateBefore = resolveStudyWorkflowStateBefore(
      stageDrafts,
      selectedStageIndex,
    );
    const nextRunIndex = stageDrafts.findIndex(
      (s, i) => i > selectedStageIndex && s.kind === "run",
    );
    const nextRun = nextRunIndex >= 0 ? stageDrafts[nextRunIndex] : null;
    const effectiveState =
      nextRunIndex >= 0
        ? resolveStudyWorkflowStateBefore(stageDrafts, nextRunIndex)
        : null;
    const parsedDur = Number(nextRun?.untilSeconds);
    return {
      durationS: Number.isFinite(parsedDur) && parsedDur > 0 ? parsedDur : null,
      effectiveSampling: effectiveState?.tableAutosave ?? null,
      followingRunId: nextRun?.stageId ?? null,
      previousClockStageId: stateBefore.tableAutosave?.sourceStageId ?? null,
    };
  }, [selectedStageIndex, stageDrafts]);

  const hydratedBaseline = useMemo<TableAutosaveDraft>(() => {
    const d =
      selectedStageDraft?.kind === "table_autosave" ? selectedStageDraft : null;
    const ta = d?.tableAutosave;
    const stageId =
      d?.stageId ||
      (selection.ref?.type === "study-stage" && selection.ref.stageId
        ? selection.ref.stageId
        : `table_autosave_${selectedStageIndex + 1}`);
    return {
      stageId,
      stageEnabled: d?.stageEnabled ?? true,
      enabled: ta?.enabled ?? true,
      samplingMode:
        ta?.samplingMode === "auto_sinc_cutoff"
          ? "auto_sinc_cutoff"
          : "explicit",
      samplePeriodS: Number(ta?.samplePeriodS) || 5e-13,
      tableQuantities: ta?.tableQuantities ?? "t, step, mx, my, mz, e_drive",
      readOnly: ta?.readOnly ?? false,
    };
  }, [selectedStageDraft, selectedStageIndex, selection.ref]);

  return (
    <TableAutosaveStageInspectorPanelView
      clockContext={clockContext}
      hydratedBaseline={hydratedBaseline}
      lastAuthoringError={lastAuthoringError}
      pipelineNodeId={selectedStageDraft?.pipelineNodeId}
      pipelineStripSteps={pipelineStripSteps}
      selection={selection}
      onCommitStage={(draft) =>
        commitSelectedStageDraft(
          (base) => ({
            ...base,
            kind: "table_autosave",
            stageId: draft.stageId,
            stageEnabled: serializeStageEnabled(draft.stageEnabled, base),
            tableAutosave: draft.readOnly
              ? base.tableAutosave
              : {
                  ...base.tableAutosave,
                  enabled: draft.enabled,
                  samplingMode: draft.samplingMode,
                  samplePeriodS: String(draft.samplePeriodS),
                  tableQuantities: draft.tableQuantities,
                },
          }),
          "table_autosave",
        )
      }
    />
  );
}

function TableAutosaveStageInspectorPanelView({
  clockContext,
  hydratedBaseline,
  lastAuthoringError = null,
  onCommitStage,
  pipelineNodeId,
  pipelineStripSteps,
  selection,
}: InspectorPanelProps & {
  clockContext?: {
    durationS: number | null;
    effectiveSampling: EffectiveStudyTableAutosave | null;
    followingRunId: string | null;
    previousClockStageId: string | null;
  };
  hydratedBaseline?: TableAutosaveDraft;
  lastAuthoringError?: string | null;
  onCommitStage?: (draft: TableAutosaveDraft) => Promise<boolean>;
  pipelineNodeId?: string;
  pipelineStripSteps?: readonly PipelineStripStep[];
}) {
  const { index, stageId: fallbackId } = resolveStageMeta(selection, "table_autosave");
  const stageId = hydratedBaseline?.stageId ?? fallbackId;
  const titleLabel = `Table Autosave ${index + 1}`;

  const fallbackBaseline = useMemo<TableAutosaveDraft>(
    () => ({
      stageId,
      stageEnabled: true,
      enabled: true,
      samplingMode: "explicit",
      samplePeriodS: 5e-13,
      tableQuantities: "t, step, mx, my, mz, e_drive",
      readOnly: false,
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
            "study.stage.table_autosave",
            "Table autosave",
          ),
    [index, pipelineStripSteps, stageId],
  );

  const spec = useMemo<InspectorSpec<TableAutosaveDraft>>(
    () => ({
      id: "study.stage.table_autosave",
      header: {
        breadcrumbs: stageBreadcrumbs(titleLabel),
      },
      identity: {
        domain: "study",
        icon: FileOutput,
        title: () => titleLabel,
        kindLabel: "Table sampling clock (0 s)",
        entityId: stageId,
        statePill: (d) =>
          d.readOnly
            ? { tone: "info", label: "Read-only" }
            : d.enabled
              ? { tone: "ok", label: "Clock ON" }
              : { tone: "neutral", label: "Clock OFF" },
      },
      facts: (d): readonly InspectorFact[] => {
        const cols = splitCsvTokens(d.tableQuantities);
        return [
          { id: "dur", label: "Duration", value: "0 s (config)" },
          {
            id: "dt",
            label: "Δt_sample",
            value: d.enabled
              ? d.samplingMode === "auto_sinc_cutoff"
                ? "Auto (sinc fc)"
                : formatTimeCompact(d.samplePeriodS)
              : "Stopped",
          },
          {
            id: "nyq",
            label: "Nyquist f_Nyq",
            value:
              d.enabled && d.samplingMode === "explicit" && d.samplePeriodS > 0
                ? formatFrequencyCompact(1 / (2 * d.samplePeriodS))
                : null,
          },
          { id: "cols", label: "Columns", value: `${cols.length} scalars` },
        ];
      },
      notices: (d) => {
        const list: InspectorNotice<TableAutosaveDraft>[] = [];
        if (lastAuthoringError) {
          list.push({
            id: "authoring-error",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        if (d.readOnly) {
          list.push({
            id: "readonly-table-policy",
            tone: "warn",
            text: "Imported table sampling policy is unsupported by this editor and is preserved losslessly in read-only mode.",
          });
        }
        return list;
      },
      sections: [
        {
          id: "clock-config",
          title: "Table Clock Configuration",
          icon: Timer,
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
              disabledReason: (d) =>
                d.readOnly
                  ? "Imported table policy is preserved read-only."
                  : pipelineNodeId
                    ? "Canonical pipeline stage IDs are managed by the pipeline graph."
                    : null,
              validate: (val) => (!val.trim() ? "Stage ID is required." : null),
            },
            {
              key: "stageEnabled",
              label: "Include in study",
              type: "switch",
              disabledReason: (d) =>
                d.readOnly ? "Imported table policy is preserved read-only." : null,
            },
            {
              label: "Previous clock state",
              type: "readonly",
              format: () => clockContext?.previousClockStageId ?? "OFF",
            },
            {
              key: "enabled",
              label: "Enable table clock",
              type: "switch",
              structural: true,
              disabledReason: (d) =>
                d.readOnly ? "Imported table policy is preserved read-only." : null,
            },
            {
              key: "samplingMode",
              label: "Sampling mode",
              type: "segmented",
              structural: true,
              disabledReason: (d) =>
                d.readOnly ? "Imported table policy is preserved read-only." : null,
              showWhen: (d) => d.enabled,
              options: [
                { value: "explicit", label: "Explicit Δt" },
                { value: "auto_sinc_cutoff", label: "Auto from sinc fc" },
              ],
            },
            {
              key: "samplePeriodS",
              label: "Sample period",
              symbol: (
                <>
                  Δt<sub>sample</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
              minExclusive: true,
              scrub: "log",
              disabledReason: (d) =>
                d.readOnly ? "Imported table policy is preserved read-only." : null,
              showWhen: (d) => d.enabled && d.samplingMode === "explicit",
            },
            {
              key: "tableQuantities",
              label: "Table quantities (comma-separated)",
              type: "text",
              mono: true,
              placeholder: "t, step, mx, my, mz, region:cap:mx",
              disabledReason: (d) =>
                d.readOnly ? "Imported table policy is preserved read-only." : null,
              showWhen: (d) => d.enabled,
              validate: (val, d) =>
                d.enabled && !d.readOnly && splitCsvTokens(val).length === 0
                  ? "Enter at least one table quantity."
                  : null,
            },
            {
              type: "custom",
              label: "Quick quantity presets",
              wide: true,
              showWhen: (d) => d.enabled && !d.readOnly,
              render: (ctx) => {
                const activeSet = new Set(splitCsvTokens(ctx.draft.tableQuantities));
                return (
                  <div className="flex flex-wrap gap-1">
                    {TABLE_QUANTITY_PRESETS.map((preset) => (
                      <Button
                        key={preset}
                        size="sm"
                        type="button"
                        variant={activeSet.has(preset) ? "primary" : "secondary"}
                        onClick={() =>
                          ctx.setField(
                            "tableQuantities",
                            toggleCsvQuantity(ctx.draft.tableQuantities, preset),
                          )
                        }
                      >
                        {preset}
                      </Button>
                    ))}
                  </div>
                );
              },
            },
          ],
        },
        {
          id: "response-fft-clock",
          title: "Response FFT Clock",
          icon: Activity,
          defaultOpen: true,
          rows: [
            {
              label: "Following Run",
              type: "readonly",
              mono: true,
              format: () => clockContext?.followingRunId ?? "none",
            },
            {
              type: "custom",
              wide: true,
              render: (ctx) => {
                const previewSampling: EffectiveStudyTableAutosave | null =
                  clockContext?.effectiveSampling ??
                  (ctx.draft.enabled
                    ? {
                        autoSampling: null,
                        quantities: splitCsvTokens(ctx.draft.tableQuantities),
                        samplePeriodS:
                          ctx.draft.samplingMode === "explicit"
                            ? ctx.draft.samplePeriodS
                            : null,
                        samplingMode: ctx.draft.samplingMode,
                        sourceDriveIds: [],
                        sourceStageId: ctx.draft.stageId,
                      }
                    : null);
                return (
                  <SamplingDiagnostics
                    durationS={clockContext?.durationS ?? null}
                    sampling={previewSampling}
                  />
                );
              },
            },
          ],
        },
      ],
      commitBar: {
        mode: baseline.readOnly ? "readOnly" : "staged",
        onApply: async (draft) => {
          if (onCommitStage) {
            return onCommitStage(draft);
          }
          return true;
        },
      },
    }),
    [
      baseline.readOnly,
      clockContext,
      index,
      lastAuthoringError,
      onCommitStage,
      pipelineNodeId,
      resolvedSteps,
      stageId,
      titleLabel,
    ],
  );

  return <StageSpecHost baseline={baseline} selection={selection} spec={spec} />;
}


const SAVE_STATE_FORMAT_PRESETS: ReadonlyArray<{
  readonly value: string;
  readonly label: string;
}> = [
  { value: "", label: "Default" },
  { value: "zarr", label: "zarr" },
  { value: "ovf", label: "ovf" },
  { value: "npz", label: "npz" },
  { value: "hdf5", label: "hdf5" },
  { value: "fms", label: "fms" },
];

interface SaveStateDraft {
  stageId: string;
  stageEnabled: boolean;
  artifactName: string;
  format: string;
  dataset: string;
}

export function SaveStateStageInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedSaveStateStagePanel selection={selection} />;
  }
  return <SaveStateStageInspectorPanelView selection={selection} />;
}

function ConnectedSaveStateStagePanel({ selection }: InspectorPanelProps) {
  const {
    commitSelectedStageDraft,
    lastAuthoringError,
    pipelineStripSteps,
    selectedStageDraft,
    selectedStageIndex,
  } = useKernelStudyAuthoring(selection);

  const hydratedBaseline = useMemo<SaveStateDraft>(() => {
    const d =
      selectedStageDraft?.kind === "save_state" ? selectedStageDraft : null;
    const stageId =
      d?.stageId ||
      (selection.ref?.type === "study-stage" && selection.ref.stageId
        ? selection.ref.stageId
        : `save_state_${selectedStageIndex + 1}`);
    return {
      stageId,
      stageEnabled: d?.stageEnabled ?? true,
      artifactName: d?.artifactName || "state_snapshot",
      format: d ? d.format : "",
      dataset: d ? d.dataset : "",
    };
  }, [selectedStageDraft, selectedStageIndex, selection.ref]);

  return (
    <SaveStateStageInspectorPanelView
      hydratedBaseline={hydratedBaseline}
      lastAuthoringError={lastAuthoringError}
      pipelineNodeId={selectedStageDraft?.pipelineNodeId}
      pipelineStripSteps={pipelineStripSteps}
      selection={selection}
      onCommitStage={(draft) =>
        commitSelectedStageDraft(
          (base) => ({
            ...base,
            kind: "save_state",
            stageId: draft.stageId,
            stageEnabled: serializeStageEnabled(draft.stageEnabled, base),
            artifactName: draft.artifactName,
            format: draft.format.trim(),
            dataset: draft.dataset.trim(),
          }),
          "save_state",
        )
      }
    />
  );
}

function SaveStateStageInspectorPanelView({
  hydratedBaseline,
  lastAuthoringError = null,
  onCommitStage,
  pipelineNodeId,
  pipelineStripSteps,
  selection,
}: InspectorPanelProps & {
  hydratedBaseline?: SaveStateDraft;
  lastAuthoringError?: string | null;
  onCommitStage?: (draft: SaveStateDraft) => Promise<boolean>;
  pipelineNodeId?: string;
  pipelineStripSteps?: readonly PipelineStripStep[];
}) {
  const { index, stageId: fallbackId } = resolveStageMeta(selection, "save_state");
  const stageId = hydratedBaseline?.stageId ?? fallbackId;
  const titleLabel = `Save State ${index + 1}`;

  const fallbackBaseline = useMemo<SaveStateDraft>(
    () => ({
      stageId,
      stageEnabled: true,
      artifactName: "state_snapshot",
      format: "",
      dataset: "",
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
            "study.stage.save_state",
            "Save state",
          ),
    [index, pipelineStripSteps, stageId],
  );

  const spec = useMemo<InspectorSpec<SaveStateDraft>>(
    () => ({
      id: "study.stage.save_state",
      header: { breadcrumbs: stageBreadcrumbs(titleLabel) },
      identity: {
        domain: "study",
        icon: Database,
        title: () => titleLabel,
        kindLabel: "State snapshot instruction (0 s)",
        entityId: stageId,
        statePill: () => ({ tone: "ok", label: "0 s snapshot" }),
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "dur", label: "Duration", value: "0 s (config)" },
        { id: "art", label: "Artifact", value: d.artifactName },
        {
          id: "fmt",
          label: "Format",
          value: d.format.trim() ? d.format.trim().toUpperCase() : "Session default",
        },
      ],
      notices: () =>
        lastAuthoringError
          ? [{ id: "authoring-error", tone: "err", text: lastAuthoringError }]
          : [],
      sections: [
        {
          id: "snapshot-target",
          title: "Snapshot Output Target",
          icon: Database,
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
            { key: "stageEnabled", label: "Include in study", type: "switch" },
            {
              key: "artifactName",
              label: "Artifact name",
              type: "text",
              mono: true,
              validate: (val) => (!val.trim() ? "Artifact name is required." : null),
            },
            {
              key: "format",
              label: "Archive format (blank = session default)",
              type: "text",
              mono: true,
              placeholder: "zarr, ovf, npz, hdf5, or blank",
            },
            {
              type: "custom",
              label: "Format presets",
              wide: true,
              render: (ctx) => (
                <div className="flex flex-wrap gap-1">
                  {SAVE_STATE_FORMAT_PRESETS.map((preset) => (
                    <Button
                      key={preset.value || "__default"}
                      size="sm"
                      type="button"
                      variant={
                        ctx.draft.format.trim() === preset.value
                          ? "primary"
                          : "secondary"
                      }
                      onClick={() => ctx.setField("format", preset.value)}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
              ),
            },
            {
              key: "dataset",
              label: "Dataset key (optional)",
              type: "text",
              mono: true,
              placeholder: "Blank for default magnetization dataset",
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
      lastAuthoringError,
      onCommitStage,
      pipelineNodeId,
      resolvedSteps,
      stageId,
      titleLabel,
    ],
  );

  return <StageSpecHost baseline={baseline} selection={selection} spec={spec} />;
}


export { AutosaveStageInspectorPanel } from "./FieldAutosaveStageSpec";
