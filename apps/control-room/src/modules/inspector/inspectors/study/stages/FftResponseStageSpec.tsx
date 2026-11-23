"use client";

import { Timer, Waves } from "lucide-react";
import { useContext, useMemo } from "react";

import { KernelContext } from "@/kernel/KernelContext";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorFact, InspectorNotice, InspectorSpec } from "../../../template";
import {
  PipelineStrip,
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
  type EffectiveStudyTableAutosave,
} from "../../../panels/stages/studyWorkflowState";
import { stageBreadcrumbs, resolveStageMeta, fallbackPipelineSteps } from "./stageShared";
interface FftResponseDraft {
  stageId: string;
  stageEnabled: boolean;
  enabled: boolean;
  analysis: "gamma" | "finite_k" | "unsupported";
  responseComponent: "mx" | "my" | "mz";
  detrend: "none" | "mean" | "linear";
  floorFraction: number;
  probeCount: number;
  analysisXMinM: string;
  analysisXMaxM: string;
  readOnly: boolean;
}

export function FftResponseStageInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedFftResponseStagePanel selection={selection} />;
  }
  return <FftResponseStageInspectorPanelView selection={selection} />;
}

function ConnectedFftResponseStagePanel({ selection }: InspectorPanelProps) {
  const {
    commitSelectedStageDraft,
    lastAuthoringError,
    pipelineStripSteps,
    selectedStageDraft,
    selectedStageIndex,
    stageDrafts,
  } = useKernelStudyAuthoring(selection);

  const effectiveClockInfo = useMemo(() => {
    const stateBefore = resolveStudyWorkflowStateBefore(
      stageDrafts,
      selectedStageIndex,
    );
    const nextRunIdx = stageDrafts.findIndex(
      (s, i) => i > selectedStageIndex && s.kind === "run",
    );
    const effectiveState =
      nextRunIdx >= 0
        ? resolveStudyWorkflowStateBefore(stageDrafts, nextRunIdx)
        : stateBefore;
    const nextRun = nextRunIdx >= 0 ? stageDrafts[nextRunIdx] : null;
    const dur = Number(nextRun?.untilSeconds);
    return {
      durationS: Number.isFinite(dur) && dur > 0 ? dur : null,
      followingRunId: nextRun?.stageId ?? null,
      hDriveFieldClock:
        effectiveState.outputs.find(
          (o) => o.quantity === "H_drive" && o.outputKind === "field",
        ) ?? null,
      mFieldClock:
        effectiveState.outputs.find(
          (o) => o.quantity === "m" && o.outputKind === "field",
        ) ?? null,
      tableClock: effectiveState.tableAutosave,
    };
  }, [selectedStageIndex, stageDrafts]);

  const hydratedBaseline = useMemo<FftResponseDraft>(() => {
    const d =
      selectedStageDraft?.kind === "fft_response" ? selectedStageDraft : null;
    const f = d?.fftResponse;
    const stageId =
      d?.stageId ||
      (selection.ref?.type === "study-stage" && selection.ref.stageId
        ? selection.ref.stageId
        : `fft_response_${selectedStageIndex + 1}`);
    const analysis: FftResponseDraft["analysis"] =
      f?.analysis === "finite_k"
        ? "finite_k"
        : f?.analysis === "unsupported"
          ? "unsupported"
          : "gamma";
    const responseComponent: FftResponseDraft["responseComponent"] =
      analysis === "finite_k" && f?.responseComponent === "mx"
        ? "mx"
        : f?.responseComponent === "mz"
          ? "mz"
          : "my";
    return {
      stageId,
      stageEnabled: d?.stageEnabled ?? true,
      enabled: f?.enabled ?? true,
      analysis,
      responseComponent,
      detrend:
        f?.detrend === "none" || f?.detrend === "mean" ? f.detrend : "linear",
      floorFraction: Number(f?.susceptibilityFloorFraction) || 1e-6,
      probeCount: Number(f?.probeCount) || 128,
      analysisXMinM: f?.analysisXMinM ?? "",
      analysisXMaxM: f?.analysisXMaxM ?? "",
      readOnly: f?.readOnly ?? analysis === "unsupported",
    };
  }, [selectedStageDraft, selectedStageIndex, selection.ref]);

  return (
    <FftResponseStageInspectorPanelView
      clockInfo={effectiveClockInfo}
      hydratedBaseline={hydratedBaseline}
      lastAuthoringError={lastAuthoringError}
      pipelineNodeId={selectedStageDraft?.pipelineNodeId}
      pipelineStripSteps={pipelineStripSteps}
      selection={selection}
      onCommitStage={(draft) =>
        commitSelectedStageDraft(
          (base) => ({
            ...base,
            kind: "fft_response",
            stageId: draft.stageId,
            stageEnabled: serializeStageEnabled(draft.stageEnabled, base),
            fftResponse: draft.readOnly
              ? base.fftResponse
              : {
                  ...base.fftResponse,
                  enabled: draft.enabled,
                  analysis: draft.analysis === "finite_k" ? "finite_k" : "gamma",
                  responseComponent:
                    draft.analysis === "gamma" &&
                    draft.responseComponent === "mx"
                      ? "my"
                      : draft.responseComponent,
                  detrend: draft.detrend,
                  susceptibilityFloorFraction: String(draft.floorFraction),
                  probeCount: String(draft.probeCount),
                  analysisXMinM: draft.analysisXMinM.trim(),
                  analysisXMaxM: draft.analysisXMaxM.trim(),
                },
          }),
          "fft_response",
        )
      }
    />
  );
}

function FftResponseStageInspectorPanelView({
  clockInfo,
  hydratedBaseline,
  lastAuthoringError = null,
  onCommitStage,
  pipelineNodeId,
  pipelineStripSteps,
  selection,
}: InspectorPanelProps & {
  clockInfo?: {
    durationS: number | null;
    followingRunId: string | null;
    hDriveFieldClock: EffectiveStudyAutosaveOutput | null;
    mFieldClock: EffectiveStudyAutosaveOutput | null;
    tableClock: EffectiveStudyTableAutosave | null;
  };
  hydratedBaseline?: FftResponseDraft;
  lastAuthoringError?: string | null;
  onCommitStage?: (draft: FftResponseDraft) => Promise<boolean>;
  pipelineNodeId?: string;
  pipelineStripSteps?: readonly PipelineStripStep[];
}) {
  const { index, stageId: fallbackId } = resolveStageMeta(selection, "fft_response");
  const stageId = hydratedBaseline?.stageId ?? fallbackId;
  const titleLabel = `FFT Response ${index + 1}`;

  const fallbackBaseline = useMemo<FftResponseDraft>(
    () => ({
      stageId,
      stageEnabled: true,
      enabled: true,
      analysis: "gamma",
      responseComponent: "my",
      detrend: "linear",
      floorFraction: 1e-6,
      probeCount: 128,
      analysisXMinM: "",
      analysisXMaxM: "",
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
            "study.stage.fft_response",
            "FFT response",
          ),
    [index, pipelineStripSteps, stageId],
  );

  const spec = useMemo<InspectorSpec<FftResponseDraft>>(
    () => ({
      id: "study.stage.fft_response",
      header: { breadcrumbs: stageBreadcrumbs(titleLabel) },
      identity: {
        domain: "study",
        icon: Waves,
        title: () => titleLabel,
        kindLabel: "Spin-wave FFT postprocessing instruction (0 s)",
        entityId: stageId,
        statePill: (d) =>
          d.readOnly
            ? { tone: "info", label: "Read-only" }
            : d.enabled
              ? { tone: "ok", label: "FFT ON" }
              : { tone: "neutral", label: "FFT OFF" },
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "dur", label: "Duration", value: "0 s (config)" },
        {
          id: "mode",
          label: "Analysis",
          value:
            d.analysis === "finite_k"
              ? "Finite-k S(kx, f)"
              : d.analysis === "unsupported"
                ? "Preserved custom"
                : "Gamma (k = 0)",
        },
        { id: "comp", label: "Component", value: d.responseComponent },
        { id: "win", label: "Window", value: "Hann" },
      ],
      notices: (d) => {
        const list: InspectorNotice<FftResponseDraft>[] = [];
        if (lastAuthoringError) {
          list.push({
            id: "authoring-error",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        if (d.readOnly || d.analysis === "unsupported") {
          list.push({
            id: "readonly-fft",
            tone: "warn",
            text: "Imported FFT response request is unsupported by this editor and is preserved losslessly in read-only mode.",
          });
        }
        if (d.enabled && d.analysis === "finite_k" && !d.readOnly) {
          list.push({
            id: "finite-k-info",
            tone: "info",
            text: "Finite-k response requires FEM tet4/FP64 field snapshots of m and H_drive on matching time clocks.",
          });
        }
        if (
          clockInfo &&
          d.enabled &&
          d.analysis === "gamma" &&
          !clockInfo.tableClock
        ) {
          list.push({
            id: "missing-table-clock",
            tone: "warn",
            text: "FFT response requires a preceding Table Autosave ON stage to define Δt_sample before the following Run.",
          });
        }
        if (
          clockInfo &&
          d.enabled &&
          d.analysis === "finite_k" &&
          (!clockInfo.mFieldClock || !clockInfo.hDriveFieldClock)
        ) {
          list.push({
            id: "missing-finite-k-clocks",
            tone: "warn",
            text: "Finite-k response requires preceding 3D field Autosave instructions for both m and H_drive.",
          });
        }
        return list;
      },
      sections: [
        {
          id: "fft-config",
          title: "Spectral Transform Configuration",
          icon: Waves,
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
                  ? "Imported FFT request is preserved read-only."
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
                d.readOnly ? "Imported FFT request is preserved read-only." : null,
            },
            {
              key: "enabled",
              label: "Compute response FFT",
              type: "switch",
              structural: true,
              disabledReason: (d) =>
                d.readOnly ? "Imported FFT request is preserved read-only." : null,
            },
            {
              key: "analysis",
              label: "Analysis mode",
              type: "segmented",
              structural: true,
              disabledReason: (d) =>
                d.readOnly ? "Imported FFT request is preserved read-only." : null,
              showWhen: (d) => d.enabled && d.analysis !== "unsupported",
              options: [
                { value: "gamma", label: "Uniform k = 0 FMR" },
                { value: "finite_k", label: "Finite-k S(kₓ, f)" },
              ],
            },
            {
              key: "responseComponent",
              label: "Response component",
              type: "segmented",
              disabledReason: (d) =>
                d.readOnly ? "Imported FFT request is preserved read-only." : null,
              showWhen: (d) => d.enabled && d.analysis === "gamma",
              options: [
                { value: "my", label: "my" },
                { value: "mz", label: "mz" },
              ],
            },
            {
              key: "responseComponent",
              label: "Response component",
              type: "segmented",
              disabledReason: (d) =>
                d.readOnly ? "Imported FFT request is preserved read-only." : null,
              showWhen: (d) => d.enabled && d.analysis === "finite_k",
              options: [
                { value: "mx", label: "mx" },
                { value: "my", label: "my" },
                { value: "mz", label: "mz" },
              ],
            },
            {
              key: "detrend",
              label: "Detrending",
              type: "select",
              disabledReason: (d) =>
                d.readOnly ? "Imported FFT request is preserved read-only." : null,
              showWhen: (d) => d.enabled && d.analysis === "gamma",
              options: [
                { value: "none", label: "None" },
                { value: "mean", label: "Subtract mean" },
                { value: "linear", label: "Subtract linear trend" },
              ],
            },
            {
              key: "floorFraction",
              label: "Susceptibility floor",
              type: "number",
              min: 0,
              max: 0.99,
              scrub: "log",
              disabledReason: (d) =>
                d.readOnly ? "Imported FFT request is preserved read-only." : null,
              showWhen: (d) => d.enabled && d.analysis === "gamma",
            },
            {
              key: "probeCount",
              label: "Spatial probe count",
              symbol: (
                <>
                  N<sub>x</sub>
                </>
              ),
              type: "number",
              integer: true,
              min: 4,
              max: 2048,
              disabledReason: (d) =>
                d.readOnly ? "Imported FFT request is preserved read-only." : null,
              showWhen: (d) => d.enabled && d.analysis === "finite_k",
            },
            {
              key: "analysisXMinM",
              label: "Lower x bound (m, blank = full geometry)",
              type: "text",
              mono: true,
              placeholder: "Infer from geometry bounds",
              disabledReason: (d) =>
                d.readOnly ? "Imported FFT request is preserved read-only." : null,
              showWhen: (d) => d.enabled && d.analysis === "finite_k",
              validate: (val) =>
                val.trim() && !Number.isFinite(Number(val))
                  ? "Lower x bound must be a finite number in metres or left blank."
                  : null,
            },
            {
              key: "analysisXMaxM",
              label: "Upper x bound (m, blank = full geometry)",
              type: "text",
              mono: true,
              placeholder: "Infer from geometry bounds",
              disabledReason: (d) =>
                d.readOnly ? "Imported FFT request is preserved read-only." : null,
              showWhen: (d) => d.enabled && d.analysis === "finite_k",
              validate: (val, d) => {
                if (!val.trim()) return null;
                const upper = Number(val);
                if (!Number.isFinite(upper)) {
                  return "Upper x bound must be a finite number in metres or left blank.";
                }
                if (d.analysisXMinM.trim()) {
                  const lower = Number(d.analysisXMinM);
                  if (Number.isFinite(lower) && upper <= lower) {
                    return "Upper x bound must exceed lower x bound.";
                  }
                }
                return null;
              },
            },
          ],
        },
        {
          id: "effective-response-clock",
          title: "Effective Response Clock",
          icon: Timer,
          defaultOpen: true,
          rows: [
            {
              label: "Clock source",
              type: "readonly",
              mono: true,
              format: (d) =>
                d.analysis === "unsupported"
                  ? "not inferred for preserved request"
                  : d.analysis === "finite_k"
                    ? (clockInfo?.mFieldClock?.sourceStageId ??
                      "no m field autosave before following Run")
                    : (clockInfo?.tableClock?.sourceStageId ??
                      "no Table Autosave ON stage before following Run"),
            },
            {
              label: "H_drive field clock",
              type: "readonly",
              mono: true,
              showWhen: (d) => d.analysis === "finite_k",
              format: () =>
                clockInfo?.hDriveFieldClock?.sourceStageId ??
                "missing H_drive field autosave",
            },
            {
              label: "Following Run",
              type: "readonly",
              mono: true,
              format: () => clockInfo?.followingRunId ?? "none",
            },
            {
              type: "custom",
              wide: true,
              render: (ctx) => {
                const effectiveSampling =
                  ctx.draft.analysis === "unsupported"
                    ? null
                    : ctx.draft.analysis === "finite_k"
                      ? (clockInfo?.mFieldClock ?? null)
                      : (clockInfo?.tableClock ?? null);
                return (
                  <SamplingDiagnostics
                    durationS={clockInfo?.durationS ?? null}
                    sampling={effectiveSampling}
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
      clockInfo,
      index,
      lastAuthoringError,
      onCommitStage,
      pipelineNodeId,
      resolvedSteps,
      stageId,
      titleLabel,
    ],
  );

  return (
    <StageSpecHost
      baseline={baseline}
      selection={selection}
      spec={spec}
      deriveFieldPatch={(key, value, nextDraft) => {
        if (
          key === "analysis" &&
          value === "gamma" &&
          nextDraft.responseComponent === "mx"
        ) {
          return { responseComponent: "my" as const };
        }
        return null;
      }}
    />
  );
}
