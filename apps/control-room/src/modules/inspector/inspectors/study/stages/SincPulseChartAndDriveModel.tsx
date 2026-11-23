"use client";

import type { EChartsOption } from "echarts";
import { useCallback, useMemo } from "react";

import type { RegionalFieldDriveResource, SceneResource } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  ScientificEChart,
  type ResolvedChartThemePalette,
} from "@/shared/charts/ScientificEChart";
import { buildSincPulsePreview } from "@/shared/domain/physics/sincPulsePreview";

import {
  regionalFieldDriveSamplingContext,
} from "../../../panels/RegionalFieldDrivePanelModel";
import {
  createDefaultStudyStageDraft,
  type StudyStageDraft,
} from "../../../panels/StudyStageAuthoringModel";
import { formatEngineering } from "../../../panels/stages/samplingPresentation";
import { resolveStudyWorkflowStateBefore } from "../../../panels/stages/studyWorkflowState";
export function SincPulseChart({
  amplitudeTesla,
  cutoffHz,
  durationS = null,
  nyquistHz,
  samplePeriodS = null,
  solverDtS = null,
  t0Seconds,
  waveformAmplitude = 1,
}: {
  amplitudeTesla: number;
  cutoffHz: number;
  durationS?: number | null;
  nyquistHz?: number;
  samplePeriodS?: number | null;
  solverDtS?: number | null;
  t0Seconds: number;
  waveformAmplitude?: number;
}) {
  const effectiveSamplePeriodS =
    samplePeriodS ??
    (typeof nyquistHz === "number" && Number.isFinite(nyquistHz) && nyquistHz > 0
      ? 1 / (2 * nyquistHz)
      : null);

  const previewModel = useMemo(
    () =>
      buildSincPulsePreview({
        cutoffHz,
        t0S: t0Seconds,
        waveformAmplitude,
        fieldAmplitudeT: amplitudeTesla,
        samplePeriodS: effectiveSamplePeriodS,
        durationS,
      }),
    [
      amplitudeTesla,
      cutoffHz,
      durationS,
      effectiveSamplePeriodS,
      t0Seconds,
      waveformAmplitude,
    ],
  );

  const optionBuilder = useCallback(
    (palette: ResolvedChartThemePalette): EChartsOption => {
      const timeSeries: [number, number][] =
        previewModel.waveform.length > 0
          ? previewModel.waveform.map((pt) => [pt.timeS * 1e12, pt.value * 1e3])
          : [
              [0, 0],
              [t0Seconds * 1e12, amplitudeTesla * waveformAmplitude * 1e3],
            ];
      const spectrumSeries: [number, number][] =
        previewModel.spectrum.length > 0
          ? previewModel.spectrum.map((pt) => [
              pt.frequencyHz / 1e9,
              pt.magnitude * 1e3,
            ])
          : [[cutoffHz / 1e9, 0]];

      return {
        animation: false,
        backgroundColor: "transparent",
        grid: [
          { left: 48, right: 14, top: 18, height: "35%" },
          { left: 48, right: 14, top: "63%", height: "28%" },
        ],
        tooltip: {
          trigger: "axis",
          backgroundColor: palette.tooltipBackground,
          borderColor: palette.borderControl,
          textStyle: { color: palette.textPrimary, fontSize: palette.fontSize },
        },
        xAxis: [
          {
            gridIndex: 0,
            type: "value",
            name: "t (ps)",
            nameLocation: "middle",
            nameGap: 16,
            axisLabel: { color: palette.textSecondary, fontSize: palette.fontSize },
            splitLine: { lineStyle: { color: palette.borderSubtle } },
          },
          {
            gridIndex: 1,
            type: "value",
            name: "f (GHz)",
            nameLocation: "middle",
            nameGap: 16,
            axisLabel: { color: palette.textSecondary, fontSize: palette.fontSize },
            splitLine: { lineStyle: { color: palette.borderSubtle } },
          },
        ],
        yAxis: [
          {
            gridIndex: 0,
            type: "value",
            name: "B(t) [mT]",
            axisLabel: { color: palette.textSecondary, fontSize: palette.fontSize },
            splitLine: { lineStyle: { color: palette.borderSubtle } },
          },
          {
            gridIndex: 1,
            type: "value",
            name: "|FFT(B)|",
            axisLabel: { color: palette.textSecondary, fontSize: palette.fontSize },
            splitLine: { lineStyle: { color: palette.borderSubtle } },
          },
        ],
        series: [
          {
            xAxisIndex: 0,
            yAxisIndex: 0,
            name: `B(t) (t0 = ${formatEngineering(t0Seconds, "s")})`,
            type: "line",
            showSymbol: false,
            data: timeSeries,
            lineStyle: { color: palette.accent, width: 2 },
          },
          {
            xAxisIndex: 1,
            yAxisIndex: 1,
            name: `|FFT(B)| (fc = ${(cutoffHz / 1e9).toFixed(2)} GHz)`,
            type: "line",
            showSymbol: false,
            data: spectrumSeries,
            lineStyle: { color: palette.series[1] ?? palette.info, width: 1.75 },
          },
        ],
      };
    },
    [amplitudeTesla, cutoffHz, previewModel.spectrum, previewModel.waveform, t0Seconds, waveformAmplitude],
  );

  return (
    <div className="grid gap-2 text-xs" role="group" aria-label="Sinc pulse and source FFT preview">
      <ScientificEChart
        ariaLabel="Sinc pulse time waveform B(t) and sampled source spectrum |FFT(B)|"
        height={240}
        optionBuilder={optionBuilder}
      />
      <div className="grid grid-cols-2 gap-1.5 rounded border border-fm-border-subtle p-2 tabular-nums">
        <div>
          <span className="text-fm-muted">Samples N: </span>
          <span>{previewModel.sampleCount}</span>
        </div>
        <div>
          <span className="text-fm-muted">Δt_sample: </span>
          <span>{formatEngineering(previewModel.samplePeriodS, "s")}</span>
        </div>
        <div>
          <span className="text-fm-muted">Nyquist: </span>
          <span>{formatEngineering(previewModel.nyquistHz, "Hz")}</span>
        </div>
        <div>
          <span className="text-fm-muted">Δf: </span>
          <span>{formatEngineering(previewModel.frequencyResolutionHz, "Hz")}</span>
        </div>
        {solverDtS ? (
          <div className="col-span-2">
            <span className="text-fm-muted">Solver Δt: </span>
            <span>{formatEngineering(solverDtS, "s")}</span>
          </div>
        ) : null}
      </div>
      <div className="text-fm-muted">{previewModel.symmetryMessage}</div>
      <div className="text-fm-muted">{previewModel.nyquistMessage}</div>
    </div>
  );
}

export type SpatialSincWindowKind = "none" | "hann" | "hamming" | "blackman";

export interface AddFieldDriveDraft {
  stageId: string;
  stageEnabled: boolean;
  driveEnabled: boolean;
  driveName: string;
  driveId: string;
  activationScope: "all_time_evolution" | "stage_ids";
  selectedRunStageIds: readonly string[];
  amplitudeTesla: number;
  direction: readonly [number, number, number];
  targetDomain: "global" | "object" | "region";
  targetObjectId: string;
  targetRegionId: string;
  spatialProfile: "uniform" | "sinc" | "geometry_mask";
  spatialAxis: readonly [number, number, number];
  spatialPeriodM: number;
  spatialCenterM: number;
  spatialWidthText: string;
  spatialWindow: SpatialSincWindowKind;
  maskObjectId: string;
  maskEnvelopeKind: "uniform" | "sinc";
  waveformKind: "constant" | "sinusoidal" | "pulse" | "piecewise_linear" | "sinc_pulse";
  cutoffHz: number;
  pulseCenterS: number;
  waveformAmplitude: number;
  sineFrequencyHz: number;
  sinePhaseRad: number;
  sineOffset: number;
  pulseOnS: number;
  pulseOffS: number;
  piecewisePointsText: string;
  timeOrigin: "stage_local" | "absolute";
}

export function parsePiecewisePoints(raw: string): {
  points: number[][];
  error: string | null;
} {
  const lines = raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return {
      points: [],
      error: "Enter at least two (time_s, value) pairs on separate lines.",
    };
  }
  const points: number[][] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const pair = lines[i]!
      .split(/[ ,;]+/)
      .filter(Boolean)
      .map(Number);
    if (pair.length !== 2 || !pair.every(Number.isFinite)) {
      return {
        points: [],
        error: `Line ${i + 1} must contain two finite numbers: time_s, value.`,
      };
    }
    if (i > 0 && pair[0]! <= points[i - 1]![0]!) {
      return {
        points: [],
        error: "Piecewise-linear timestamps must be strictly increasing.",
      };
    }
    points.push([pair[0]!, pair[1]!]);
  }
  return { points, error: null };
}

export function normalizeSincWindow(raw: string | undefined): SpatialSincWindowKind {
  if (raw === "hann" || raw === "hamming" || raw === "blackman") {
    return raw;
  }
  return "none";
}

export function buildFieldDriveResourceFromDraft(
  draft: AddFieldDriveDraft,
  baseDrive?: RegionalFieldDriveResource,
): RegionalFieldDriveResource {
  const dirNorm = Math.hypot(
    draft.direction[0],
    draft.direction[1],
    draft.direction[2],
  );
  const unitDirection: [number, number, number] =
    Number.isFinite(dirNorm) && dirNorm > 1e-12
      ? [
          draft.direction[0] / dirNorm,
          draft.direction[1] / dirNorm,
          draft.direction[2] / dirNorm,
        ]
      : [0, 0, 0];
  const sincEnvelope: Extract<
    RegionalFieldDriveResource["spatial_profile"],
    { kind: "sinc" }
  > = {
    kind: "sinc",
    axis: [draft.spatialAxis[0], draft.spatialAxis[1], draft.spatialAxis[2]],
    period_m: draft.spatialPeriodM,
    center_m: draft.spatialCenterM,
    ...(draft.spatialWidthText.trim()
      ? { width_m: Number(draft.spatialWidthText) }
      : {}),
    window: draft.spatialWindow,
  };
  const spatial_profile: RegionalFieldDriveResource["spatial_profile"] =
    draft.spatialProfile === "sinc"
      ? sincEnvelope
      : draft.spatialProfile === "geometry_mask"
        ? {
            kind: "geometry_mask",
            object_id: draft.maskObjectId,
            envelope:
              draft.maskEnvelopeKind === "sinc"
                ? sincEnvelope
                : { kind: "uniform" },
          }
        : { kind: "uniform" };
  const target: RegionalFieldDriveResource["target"] =
    draft.targetDomain === "object"
      ? { kind: "object", object_id: draft.targetObjectId }
      : draft.targetDomain === "region"
        ? {
            kind: "region",
            object_id: draft.targetObjectId,
            region_id: draft.targetRegionId,
          }
        : { kind: "global" };
  const activation: RegionalFieldDriveResource["activation"] =
    draft.activationScope === "stage_ids"
      ? { kind: "stage_ids", stage_ids: [...draft.selectedRunStageIds] }
      : { kind: "all_time_evolution" };
  const parsedPiecewise = parsePiecewisePoints(draft.piecewisePointsText);
  const waveform: RegionalFieldDriveResource["waveform"] =
    draft.waveformKind === "constant"
      ? { kind: "constant" }
      : draft.waveformKind === "sinusoidal"
        ? {
            kind: "sinusoidal",
            frequency_hz: draft.sineFrequencyHz,
            phase_rad: draft.sinePhaseRad,
            offset: draft.sineOffset,
          }
        : draft.waveformKind === "pulse"
          ? {
              kind: "pulse",
              t_on: draft.pulseOnS,
              t_off: draft.pulseOffS,
            }
          : draft.waveformKind === "piecewise_linear"
            ? {
                kind: "piecewise_linear",
                points:
                  parsedPiecewise.points.length >= 2
                    ? parsedPiecewise.points
                    : baseDrive?.waveform.kind === "piecewise_linear"
                      ? baseDrive.waveform.points
                      : [
                          [0, 0],
                          [1e-9, 1],
                        ],
              }
            : {
                kind: "sinc_pulse",
                amplitude: draft.waveformAmplitude,
                cutoff_hz: draft.cutoffHz,
                t0: draft.pulseCenterS,
              };

  return {
    ...(baseDrive ?? createDefaultStudyStageDraft("add_field_drive", 0).fieldDrive),
    kind: "regional",
    id: draft.driveId,
    name: draft.driveName,
    enabled: draft.driveEnabled,
    amplitude_B_T: draft.amplitudeTesla,
    direction: unitDirection,
    target,
    spatial_profile,
    time_origin: draft.timeOrigin,
    activation,
    waveform,
  };
}

export function resolveAddFieldDriveSamplingContext({
  sceneData,
  selectedStageDraft,
  selectedStageIndex,
  stageDrafts,
}: {
  sceneData: SceneResource | null;
  selectedStageDraft: StudyStageDraft | null;
  selectedStageIndex: number;
  stageDrafts: readonly StudyStageDraft[];
}) {
    const activeDrive =
      selectedStageDraft?.kind === "add_field_drive"
        ? selectedStageDraft.fieldDrive
        : null;
    const solverDtS = regionalFieldDriveSamplingContext(
      sceneData,
      activeDrive?.activation ?? null,
    ).solverDtS;
    const subsequentRuns = stageDrafts
      .map((candidate, index) => ({ candidate, index }))
      .slice(selectedStageIndex + 1)
      .filter(({ candidate }) => candidate.kind === "run");
    const activeIds = new Set(
      activeDrive?.activation.kind === "stage_ids"
        ? activeDrive.activation.stage_ids
        : [],
    );
    const targetRun =
      activeDrive?.activation.kind === "stage_ids"
        ? (subsequentRuns.find(({ candidate }) => activeIds.has(candidate.stageId)) ??
          null)
        : (subsequentRuns[0] ?? null);
    const effectiveWorkflow = targetRun
      ? resolveStudyWorkflowStateBefore(stageDrafts, targetRun.index)
      : null;
    const rawDuration = Number(targetRun?.candidate.untilSeconds);
    return {
      durationS: Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null,
      effectiveSampling: effectiveWorkflow?.tableAutosave ?? null,
      samplePeriodS: effectiveWorkflow?.tableAutosave?.samplePeriodS ?? null,
      solverDtS,
      targetRunStageId: targetRun?.candidate.stageId ?? null,
    };
}

export function buildAddFieldDriveHydratedBaseline({
  sceneData,
  selectedStageDraft,
  selectedStageIndex,
  selection,
}: {
  sceneData: SceneResource | null;
  selectedStageDraft: StudyStageDraft | null;
  selectedStageIndex: number;
  selection: Selection;
}): AddFieldDriveDraft {
    const d =
      selectedStageDraft?.kind === "add_field_drive"
        ? selectedStageDraft
        : null;
    const fd = d?.fieldDrive;
    const stageId =
      d?.stageId ||
      (selection.ref?.type === "study-stage" && selection.ref.stageId
        ? selection.ref.stageId
        : `add_field_drive_${selectedStageIndex + 1}`);
    const dir =
      fd && Array.isArray(fd.direction) && fd.direction.length === 3
        ? ([
            Number(fd.direction[0]) || 0,
            Number(fd.direction[1]) || 0,
            Number(fd.direction[2]) || 0,
          ] as const)
        : ([0, 1, 0] as const);
    const sp = fd?.spatial_profile;
    const sincSp =
      sp?.kind === "sinc"
        ? sp
        : sp?.kind === "geometry_mask" && sp.envelope.kind === "sinc"
          ? sp.envelope
          : null;
    const wf = fd?.waveform;
    const firstSceneObjId = sceneData?.objects?.[0]?.id ?? "";
    return {
      stageId,
      stageEnabled: d?.stageEnabled ?? true,
      driveEnabled: fd?.enabled ?? true,
      driveName: fd?.name?.trim() ? fd.name : "Uniform transverse k0 sinc antenna",
      driveId: fd?.id?.trim() ? fd.id : stageId,
      activationScope:
        fd?.activation.kind === "stage_ids" ? "stage_ids" : "all_time_evolution",
      selectedRunStageIds:
        fd?.activation.kind === "stage_ids" ? fd.activation.stage_ids : [],
      amplitudeTesla: typeof fd?.amplitude_B_T === "number" ? fd.amplitude_B_T : 1e-3,
      direction: dir,
      targetDomain:
        fd?.target.kind === "object"
          ? "object"
          : fd?.target.kind === "region"
            ? "region"
            : "global",
      targetObjectId:
        fd?.target.kind === "object" || fd?.target.kind === "region"
          ? fd.target.object_id
          : firstSceneObjId,
      targetRegionId: fd?.target.kind === "region" ? fd.target.region_id : "",
      spatialProfile:
        sp?.kind === "sinc"
          ? "sinc"
          : sp?.kind === "geometry_mask"
            ? "geometry_mask"
            : "uniform",
      spatialAxis:
        sincSp && Array.isArray(sincSp.axis) && sincSp.axis.length === 3
          ? [sincSp.axis[0] ?? 1, sincSp.axis[1] ?? 0, sincSp.axis[2] ?? 0]
          : [1, 0, 0],
      spatialPeriodM: sincSp?.period_m ?? 100e-9,
      spatialCenterM: sincSp?.center_m ?? 0,
      spatialWidthText:
        sincSp?.width_m !== undefined && sincSp?.width_m !== null
          ? String(sincSp.width_m)
          : "",
      spatialWindow: normalizeSincWindow(sincSp?.window),
      maskObjectId: sp?.kind === "geometry_mask" ? sp.object_id : firstSceneObjId,
      maskEnvelopeKind:
        sp?.kind === "geometry_mask" && sp.envelope.kind === "sinc"
          ? "sinc"
          : "uniform",
      waveformKind: wf?.kind ?? "sinc_pulse",
      cutoffHz: wf?.kind === "sinc_pulse" ? wf.cutoff_hz : 40e9,
      pulseCenterS: wf?.kind === "sinc_pulse" ? (wf.t0 ?? 50e-12) : 50e-12,
      waveformAmplitude:
        wf?.kind === "sinc_pulse" ? (wf.amplitude ?? 1) : 1,
      sineFrequencyHz: wf?.kind === "sinusoidal" ? wf.frequency_hz : 10e9,
      sinePhaseRad: wf?.kind === "sinusoidal" ? (wf.phase_rad ?? 0) : 0,
      sineOffset: wf?.kind === "sinusoidal" ? (wf.offset ?? 0) : 0,
      pulseOnS: wf?.kind === "pulse" ? wf.t_on : 10e-12,
      pulseOffS: wf?.kind === "pulse" ? wf.t_off : 100e-12,
      piecewisePointsText:
        wf?.kind === "piecewise_linear"
          ? wf.points.map((pt) => pt.join(", ")).join("\n")
          : "0, 0\n1e-9, 1",
      timeOrigin: fd?.time_origin === "absolute" ? "absolute" : "stage_local",
    };
}
