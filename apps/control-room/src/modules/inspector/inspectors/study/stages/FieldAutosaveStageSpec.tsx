"use client";

import { Database } from "lucide-react";
import { useContext, useMemo } from "react";

import { KernelContext } from "@/kernel/KernelContext";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorFact, InspectorNotice, InspectorSpec } from "../../../template";
import {
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
  type EffectiveStudyAutosaveOutput,
} from "../../../panels/stages/studyWorkflowState";
import { stageBreadcrumbs, resolveStageMeta, fallbackPipelineSteps } from "./stageShared";
const AUTOSAVE_QUANTITY_PRESETS = [
  "m",
  "B_eff",
  "B_demag",
  "B_exch",
  "H_drive",
  "e_total",
  "q_density",
] as const;

interface AutosaveDraft {
  stageId: string;
  stageEnabled: boolean;
  actionMode: "enable" | "disable" | "clear_all";
  quantity: string;
  outputKind: "field" | "scalar";
  samplingMode: "explicit" | "auto_sinc_cutoff";
  everySeconds: number;
  readOnly: boolean;
}

export function AutosaveStageInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedAutosaveStagePanel selection={selection} />;
  }
  return <AutosaveStageInspectorPanelView selection={selection} />;
}

function ConnectedAutosaveStagePanel({ selection }: InspectorPanelProps) {
  const {
    commitSelectedStageDraft,
    lastAuthoringError,
    pipelineStripSteps,
    selectedStageDraft,
    selectedStageIndex,
    stageDrafts,
  } = useKernelStudyAuthoring(selection);

  const hydratedBaseline = useMemo<AutosaveDraft>(() => {
    const d =
      selectedStageDraft?.kind === "autosave" ? selectedStageDraft : null;
    const a = d?.autosave;
    const stageId =
      d?.stageId ||
      (selection.ref?.type === "study-stage" && selection.ref.stageId
        ? selection.ref.stageId
        : `autosave_${selectedStageIndex + 1}`);
    return {
      stageId,
      stageEnabled: d?.stageEnabled ?? true,
      actionMode: a?.clearAll
        ? "clear_all"
        : a?.enabled === false
          ? "disable"
          : "enable",
      quantity: a?.clearAll ? "" : a?.quantity || "m",
      outputKind: a?.outputKind === "scalar" ? "scalar" : "field",
      samplingMode:
        a?.samplingMode === "auto_sinc_cutoff"
          ? "auto_sinc_cutoff"
          : "explicit",
      everySeconds: Number(a?.everySeconds) || 2e-12,
      readOnly: a?.readOnly ?? false,
    };
  }, [selectedStageDraft, selectedStageIndex, selection.ref]);

  const workflowContext = useMemo(() => {
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
      activeOutputsBefore:
        stateBefore.outputs.length > 0
          ? stateBefore.outputs.map((o) => o.quantity).join(", ")
          : "none",
      durationS: Number.isFinite(parsedDur) && parsedDur > 0 ? parsedDur : null,
      effectiveOutputs: effectiveState?.outputs ?? [],
      followingRunId: nextRun?.stageId ?? null,
    };
  }, [selectedStageIndex, stageDrafts]);

  return (
    <AutosaveStageInspectorPanelView
      hydratedBaseline={hydratedBaseline}
      lastAuthoringError={lastAuthoringError}
      pipelineNodeId={selectedStageDraft?.pipelineNodeId}
      pipelineStripSteps={pipelineStripSteps}
      selection={selection}
      workflowContext={workflowContext}
      onCommitStage={(draft) =>
        commitSelectedStageDraft(
          (base) => ({
            ...base,
            kind: "autosave",
            stageId: draft.stageId,
            stageEnabled: serializeStageEnabled(draft.stageEnabled, base),
            autosave: draft.readOnly
              ? base.autosave
              : {
                  ...base.autosave,
                  clearAll: draft.actionMode === "clear_all",
                  enabled: draft.actionMode === "enable",
                  quantity:
                    draft.actionMode === "clear_all"
                      ? ""
                      : draft.quantity.trim(),
                  outputKind: draft.outputKind,
                  samplingMode: draft.samplingMode,
                  everySeconds: String(draft.everySeconds),
                },
          }),
          "autosave",
        )
      }
    />
  );
}

function AutosaveStageInspectorPanelView({
  hydratedBaseline,
  lastAuthoringError = null,
  onCommitStage,
  pipelineNodeId,
  pipelineStripSteps,
  selection,
  workflowContext,
}: InspectorPanelProps & {
  hydratedBaseline?: AutosaveDraft;
  lastAuthoringError?: string | null;
  onCommitStage?: (draft: AutosaveDraft) => Promise<boolean>;
  pipelineNodeId?: string;
  pipelineStripSteps?: readonly PipelineStripStep[];
  workflowContext?: {
    activeOutputsBefore: string;
    durationS: number | null;
    effectiveOutputs: readonly EffectiveStudyAutosaveOutput[];
    followingRunId: string | null;
  };
}) {
  const { index, stageId: fallbackId } = resolveStageMeta(selection, "autosave");
  const stageId = hydratedBaseline?.stageId ?? fallbackId;
  const titleLabel = `Autosave ${index + 1}`;

  const fallbackBaseline = useMemo<AutosaveDraft>(
    () => ({
      stageId,
      stageEnabled: true,
      actionMode: "enable",
      quantity: "m",
      outputKind: "field",
      samplingMode: "explicit",
      everySeconds: 2e-12,
      readOnly: false,
    }),
    [stageId],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const resolvedSteps = useMemo<readonly PipelineStripStep[]>(
    () =>
      pipelineStripSteps && pipelineStripSteps.length > 0
        ? pipelineStripSteps
        : fallbackPipelineSteps(stageId, index, "study.stage.autosave", "Autosave"),
    [index, pipelineStripSteps, stageId],
  );

  const spec = useMemo<InspectorSpec<AutosaveDraft>>(
    () => ({
      id: "study.stage.autosave",
      header: { breadcrumbs: stageBreadcrumbs(titleLabel) },
      identity: {
        domain: "study",
        icon: Database,
        title: () => titleLabel,
        kindLabel: "Field / scalar autosave instruction (0 s)",
        entityId: stageId,
        statePill: (d) =>
          d.readOnly
            ? { tone: "info", label: "Read-only" }
            : { tone: "ok", label: "0 s config" },
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "dur", label: "Duration", value: "0 s (config)" },
        {
          id: "qty",
          label: "Quantity",
          value: d.actionMode === "clear_all" ? "Clear all" : d.quantity || "—",
        },
        {
          id: "carrier",
          label: "Carrier",
          value: d.outputKind === "field" ? "3D Field" : "Scalar",
        },
        {
          id: "cadence",
          label: "Cadence",
          value:
            d.actionMode === "enable"
              ? d.samplingMode === "auto_sinc_cutoff"
                ? "Auto (sinc fc)"
                : formatTimeCompact(d.everySeconds)
              : null,
        },
      ],
      notices: (d) => {
        const list: InspectorNotice<AutosaveDraft>[] = [];
        if (lastAuthoringError) {
          list.push({
            id: "authoring-error",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        if (d.readOnly) {
          list.push({
            id: "readonly-autosave",
            tone: "warn",
            text: "Imported autosave output payload is unsupported by this editor and is preserved losslessly in read-only mode.",
          });
        }
        return list;
      },
      sections: [
        {
          id: "autosave-config",
          title: "Periodic Output Configuration",
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
              disabledReason: (d) =>
                d.readOnly
                  ? "Imported autosave output is preserved read-only."
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
                d.readOnly ? "Imported autosave output is preserved read-only." : null,
            },
            {
              label: "Currently active outputs",
              type: "readonly",
              mono: true,
              format: () => workflowContext?.activeOutputsBefore ?? "none",
            },
            {
              key: "actionMode",
              label: "Action mode",
              type: "segmented",
              structural: true,
              disabledReason: (d) =>
                d.readOnly ? "Imported autosave output is preserved read-only." : null,
              options: [
                { value: "enable", label: "Enable" },
                { value: "disable", label: "Disable one" },
                { value: "clear_all", label: "Clear all" },
              ],
            },
            {
              key: "quantity",
              label: "Quantity",
              type: "text",
              mono: true,
              placeholder: "m, B_eff, H_drive, region:cap:m",
              disabledReason: (d) =>
                d.readOnly ? "Imported autosave output is preserved read-only." : null,
              showWhen: (d) => d.actionMode !== "clear_all",
              validate: (val, d) =>
                d.actionMode !== "clear_all" && !d.readOnly && !val.trim()
                  ? "Quantity name is required unless clearing all outputs."
                  : null,
            },
            {
              type: "custom",
              label: "Standard quantities",
              wide: true,
              showWhen: (d) => d.actionMode !== "clear_all" && !d.readOnly,
              render: (ctx) => (
                <div className="flex flex-wrap gap-1">
                  {AUTOSAVE_QUANTITY_PRESETS.map((preset) => (
                    <Button
                      key={preset}
                      size="sm"
                      type="button"
                      variant={
                        ctx.draft.quantity.trim() === preset
                          ? "primary"
                          : "secondary"
                      }
                      onClick={() => ctx.setField("quantity", preset)}
                    >
                      {preset}
                    </Button>
                  ))}
                </div>
              ),
            },
            {
              key: "outputKind",
              label: "Output carrier",
              type: "segmented",
              disabledReason: (d) =>
                d.readOnly ? "Imported autosave output is preserved read-only." : null,
              showWhen: (d) => d.actionMode === "enable",
              options: [
                { value: "field", label: "Spatial 3D field" },
                { value: "scalar", label: "Reduced scalar" },
              ],
            },
            {
              key: "samplingMode",
              label: "Sampling mode",
              type: "segmented",
              structural: true,
              disabledReason: (d) =>
                d.readOnly ? "Imported autosave output is preserved read-only." : null,
              showWhen: (d) => d.actionMode === "enable",
              options: [
                { value: "explicit", label: "Explicit Δt" },
                { value: "auto_sinc_cutoff", label: "Auto from sinc fc" },
              ],
            },
            {
              key: "everySeconds",
              label: "Save interval",
              symbol: (
                <>
                  Δt<sub>out</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
              minExclusive: true,
              scrub: "log",
              disabledReason: (d) =>
                d.readOnly ? "Imported autosave output is preserved read-only." : null,
              showWhen: (d) => d.actionMode === "enable" && d.samplingMode === "explicit",
            },
            {
              type: "custom",
              wide: true,
              showWhen: (d) => d.actionMode === "enable",
              render: (ctx) => {
                const matched =
                  workflowContext?.effectiveOutputs.find(
                    (o) => o.quantity === ctx.draft.quantity.trim(),
                  ) ?? {
                    autoSampling: null,
                    everySeconds:
                      ctx.draft.samplingMode === "explicit"
                        ? ctx.draft.everySeconds
                        : null,
                    outputKind: ctx.draft.outputKind,
                    quantity: ctx.draft.quantity.trim() || "m",
                    samplingMode: ctx.draft.samplingMode,
                    sourceDriveIds: [],
                    sourceStageId: ctx.draft.stageId,
                  };
                return (
                  <SamplingDiagnostics
                    durationS={workflowContext?.durationS ?? null}
                    sampling={matched}
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
      index,
      lastAuthoringError,
      onCommitStage,
      pipelineNodeId,
      resolvedSteps,
      stageId,
      titleLabel,
      workflowContext,
    ],
  );

  return (
    <StageSpecHost
      baseline={baseline}
      selection={selection}
      spec={spec}
      deriveFieldPatch={(key, value, nextDraft) => {
        if (
          key === "actionMode" &&
          value !== "clear_all" &&
          !nextDraft.quantity.trim()
        ) {
          return { quantity: "m" };
        }
        return null;
      }}
    />
  );
}
