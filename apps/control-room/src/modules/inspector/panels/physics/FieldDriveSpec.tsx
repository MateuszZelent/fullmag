"use client";

import {
  Activity,
  Compass,
  Plus,
  Radio,
  Sliders,
  Trash2,
  Waves,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  MODEL_FIELD_DRIVES_PATH,
  MODEL_PHYSICS_GRAPH_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import type {
  FieldDriveListResource,
  RegionalFieldDriveResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import {
  captureAuthoringMutationFence,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { useFieldDrivesResource } from "@/kernel/resources/fieldDriveResources";
import {
  publishCommittedSceneResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useMaskFieldDrivesResource } from "@/kernel/resources/maskAntennaResources";
import { useRuntimeCommandControlResourceData } from "@/kernel/resources/studyRuntimeResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { ScientificEChart, type ScientificEChartProps } from "@/shared/charts/ScientificEChart";
import { validateFieldDriveDraft } from "@/shared/domain/physics/fieldDrive";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  type InspectorFact,
  type InspectorNotice,
  type InspectorSpec,
} from "../../template";
import {
  ANGLE_UNITS,
  buildRootSelection,
  fallbackRevision,
  FIELD_TESLA_UNITS,
  FREQUENCY_UNITS,
  LENGTH_UNITS,
  SpecInspectorHost,
  TIME_UNITS,
} from "../model-roots/SpecInspectorHost";
import {
  commitRegionalFieldDrive,
  createRegionalFieldDriveDraft,
  regionalFieldDriveSamplingContext,
  regionalFieldDriveSelectorOptions,
  resolveRegionalFieldDrivePanelModel,
} from "../RegionalFieldDrivePanelModel";

import { FieldDriveMaskInspectorPanel } from "./FieldDriveMaskSpec";

/* ── Derived Schema Types & Constants ── */

type DriveActivationResource = RegionalFieldDriveResource["activation"];
type FieldSpatialProfileResource = RegionalFieldDriveResource["spatial_profile"];
type FieldTargetResource = RegionalFieldDriveResource["target"];
type TimeDependenceResource = RegionalFieldDriveResource["waveform"];
type FieldEnvelopeResource = Extract<
  FieldSpatialProfileResource,
  { kind: "geometry_mask" }
>["envelope"];
type ChartOptionResult = ReturnType<ScientificEChartProps["optionBuilder"]>;

const UNSELECTED_OBJECT = "__select_object__";
const UNSELECTED_REGION = "__select_region__";

export type FieldDriveWaveformKind =
  | "sinc_pulse"
  | "sinusoidal"
  | "pulse"
  | "gaussian_pulse"
  | "chirp"
  | "piecewise_linear"
  | "constant";

export type FieldDriveSpatialKind =
  | "uniform"
  | "sinc"
  | "geometry_mask"
  | "gaussian_plane_wave";

export interface PiecewiseWaypointRow {
  readonly _rowId: string;
  timeS: number;
  scale: number;
}

export interface FieldDriveSpecDraft extends Record<string, unknown> {
  driveId: string;
  exists: boolean;
  name: string;
  enabled: boolean;
  /* Target scope */
  targetKind: "global" | "object" | "region";
  targetObjectId: string;
  targetRegionId: string;
  /* Stage activation */
  stageScopeKind: "all_dynamic" | "stage_ids";
  selectedStageIds: readonly string[];
  /* Spatial profile */
  spatialKind: FieldDriveSpatialKind;
  spatialAxis: readonly [number, number, number];
  spatialPeriodM: number;
  spatialCenterM: number;
  spatialWidthEnabled: boolean;
  spatialWidthM: number;
  spatialWindow: "none" | "hann";
  maskObjectId: string;
  maskEnvelopeKind: "uniform" | "sinc";
  /* Gaussian plane wave spatial parameters */
  gpwWavelengthM: number;
  gpwSigmaXM: number;
  gpwSigmaYM: number;
  gpwCenterXM: number;
  gpwCenterYM: number;
  gpwCarrierOriginXM: number;
  gpwCarrierPhaseRad: number;
  /* Field amplitude & unit direction */
  amplitudeBT: number;
  direction: readonly [number, number, number];
  /* Time origin & waveform */
  timeOrigin: "stage_local" | "absolute";
  waveformKind: FieldDriveWaveformKind;
  cutoffFreqHz: number;
  sincAmplitude: number;
  carrierFreqHz: number;
  sinusoidalOffset: number;
  pulseOnS: number;
  pulseOffS: number;
  chirpStopFreqHz: number;
  timeCenterS: number;
  pulseSigmaS: number;
  phaseRad: number;
  piecewisePoints: readonly PiecewiseWaypointRow[];
  /* Live preview tab */
  previewDomain: "time" | "spectrum";
}

let nextWaypointSeq = 1;
export function createPiecewiseWaypoint(timeS = 0, scale = 0): PiecewiseWaypointRow {
  const id = `fd-wp-${nextWaypointSeq}`;
  nextWaypointSeq += 1;
  return { _rowId: id, timeS, scale };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function asTuple3(
  value: unknown,
  fallback: readonly [number, number, number],
): readonly [number, number, number] {
  if (Array.isArray(value) && value.length >= 3) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    const z = Number(value[2]);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      return [x, y, z];
    }
  }
  return fallback;
}

function vectorNorm(v: readonly [number, number, number]): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalizeTuple3(
  v: readonly [number, number, number],
  fallback: readonly [number, number, number] = [0, 1, 0],
): [number, number, number] {
  const n = vectorNorm(v);
  if (!(n > 1e-30)) return [fallback[0], fallback[1], fallback[2]];
  return [v[0] / n, v[1] / n, v[2] / n];
}

function sincNormalized(x: number): number {
  if (Math.abs(x) < 1e-9) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

export type FieldDriveEnvelopeInput = Pick<
  FieldDriveSpecDraft,
  | "waveformKind"
  | "cutoffFreqHz"
  | "carrierFreqHz"
  | "chirpStopFreqHz"
  | "timeCenterS"
  | "pulseSigmaS"
  | "phaseRad"
  | "piecewisePoints"
> &
  Partial<
    Pick<
      FieldDriveSpecDraft,
      "sincAmplitude" | "sinusoidalOffset" | "pulseOnS" | "pulseOffS"
    >
  >;

/**
 * Evaluates dimensionless temporal envelope `f(t)` at `tS` (SI seconds).
 */
export function evaluateFieldDriveEnvelopeAtTime(
  draft: FieldDriveEnvelopeInput,
  tS: number,
): number {
  switch (draft.waveformKind) {
    case "constant":
      return 1;
    case "sinusoidal": {
      const offset = typeof draft.sinusoidalOffset === "number" ? draft.sinusoidalOffset : 0;
      return Math.sin(2 * Math.PI * draft.carrierFreqHz * tS + draft.phaseRad) + offset;
    }
    case "pulse": {
      const tOn = typeof draft.pulseOnS === "number" ? draft.pulseOnS : 0;
      const tOff = typeof draft.pulseOffS === "number" ? draft.pulseOffS : 1e-9;
      return tS >= tOn && tS < tOff ? 1 : 0;
    }
    case "sinc_pulse": {
      const amp = typeof draft.sincAmplitude === "number" ? draft.sincAmplitude : 1;
      const x = 2 * draft.cutoffFreqHz * (tS - draft.timeCenterS);
      return amp * sincNormalized(x);
    }
    case "gaussian_pulse": {
      const sigma = Math.max(draft.pulseSigmaS, 1e-15);
      const u = (tS - draft.timeCenterS) / sigma;
      const env = Math.exp(-0.5 * u * u);
      if (draft.carrierFreqHz > 0) {
        return env * Math.cos(2 * Math.PI * draft.carrierFreqHz * (tS - draft.timeCenterS) + draft.phaseRad);
      }
      return env;
    }
    case "chirp": {
      const windowS = Math.max(6 * draft.pulseSigmaS, 1e-12);
      const tRel = Math.min(Math.max(tS, 0), windowS);
      const f0 = draft.carrierFreqHz;
      const f1 = draft.chirpStopFreqHz;
      const k = (f1 - f0) / windowS;
      const phase = 2 * Math.PI * (f0 * tRel + 0.5 * k * tRel * tRel) + draft.phaseRad;
      return Math.sin(phase);
    }
    case "piecewise_linear": {
      const pts = [...draft.piecewisePoints].sort((a, b) => a.timeS - b.timeS);
      if (pts.length === 0) return 0;
      if (tS <= pts[0]!.timeS) return pts[0]!.scale;
      if (tS >= pts[pts.length - 1]!.timeS) return pts[pts.length - 1]!.scale;
      for (let i = 0; i < pts.length - 1; i += 1) {
        const p0 = pts[i]!;
        const p1 = pts[i + 1]!;
        if (tS >= p0.timeS && tS <= p1.timeS) {
          const dt = Math.max(p1.timeS - p0.timeS, 1e-18);
          const alpha = (tS - p0.timeS) / dt;
          return p0.scale + alpha * (p1.scale - p0.scale);
        }
      }
      return 0;
    }
  }
}

export function estimateFieldDriveMaxFrequencyHz(draft: FieldDriveEnvelopeInput): number {
  switch (draft.waveformKind) {
    case "constant":
      return 0;
    case "sinusoidal":
      return draft.carrierFreqHz;
    case "sinc_pulse":
      return draft.cutoffFreqHz;
    case "pulse": {
      const tOn = typeof draft.pulseOnS === "number" ? draft.pulseOnS : 0;
      const tOff = typeof draft.pulseOffS === "number" ? draft.pulseOffS : 1e-9;
      const width = Math.max(tOff - tOn, 1e-15);
      return 1 / width;
    }
    case "gaussian_pulse":
      return draft.carrierFreqHz + 1 / (2 * Math.PI * Math.max(draft.pulseSigmaS, 1e-15));
    case "chirp":
      return Math.max(draft.carrierFreqHz, draft.chirpStopFreqHz);
    case "piecewise_linear": {
      const pts = [...draft.piecewisePoints].sort((a, b) => a.timeS - b.timeS);
      if (pts.length < 2) return 0;
      let minDt = Infinity;
      for (let i = 0; i < pts.length - 1; i += 1) {
        const dt = pts[i + 1]!.timeS - pts[i]!.timeS;
        if (dt > 1e-15 && dt < minDt) minDt = dt;
      }
      return Number.isFinite(minDt) ? 0.5 / minDt : 0;
    }
  }
}

function buildFieldDrivePreviewChartOption(
  draft: FieldDriveSpecDraft,
  nyquistHz: number | null,
): ChartOptionResult {
  const peakMt = draft.amplitudeBT * 1e3;
  const maxFreq = Math.max(estimateFieldDriveMaxFrequencyHz(draft), 1e9);
  const tSpanS =
    draft.waveformKind === "piecewise_linear" && draft.piecewisePoints.length >= 2
      ? Math.max(
          Math.max(...draft.piecewisePoints.map((p) => p.timeS)) -
            Math.min(...draft.piecewisePoints.map((p) => p.timeS)),
          1e-12,
        ) * 1.2
      : draft.waveformKind === "pulse"
        ? Math.max((draft.pulseOffS - Math.min(draft.pulseOnS, 0)) * 1.5, 2e-9)
        : draft.waveformKind === "sinc_pulse" || draft.waveformKind === "gaussian_pulse"
          ? Math.max(2 * draft.timeCenterS, 10 / maxFreq, 1e-9)
          : Math.max(4 / maxFreq, 1e-9);

  const sampleCount = 128;
  const dtS = tSpanS / sampleCount;
  const timesNs: number[] = [];
  const signalMt: number[] = [];
  for (let i = 0; i <= sampleCount; i += 1) {
    const t = i * dtS;
    timesNs.push(Number((t * 1e9).toPrecision(4)));
    signalMt.push(Number((peakMt * evaluateFieldDriveEnvelopeAtTime(draft, t)).toPrecision(5)));
  }

  if (draft.previewDomain === "time") {
    return {
      animation: false,
      grid: { left: 48, right: 16, top: 18, bottom: 32 },
      tooltip: { trigger: "axis" },
      xAxis: {
        type: "category",
        name: "t (ns)",
        nameLocation: "middle",
        nameGap: 20,
        data: timesNs,
        axisLabel: { fontSize: 12 },
      },
      yAxis: {
        type: "value",
        name: "|B| (mT)",
        axisLabel: { fontSize: 12 },
        splitLine: { lineStyle: { opacity: 0.18 } },
      },
      series: [
        {
          name: "|B_ext|(t)",
          type: "line",
          showSymbol: false,
          smooth: draft.waveformKind !== "pulse" && draft.waveformKind !== "piecewise_linear",
          data: signalMt,
          areaStyle: { opacity: 0.12 },
          lineStyle: { width: 1.75 },
        },
      ],
    };
  }

  const fMaxPlotHz = Math.max(maxFreq * 1.8, (nyquistHz ?? 25e9) * 1.15, 5e9);
  const fBins = 64;
  const freqsGhz: number[] = [];
  const magArb: number[] = [];
  for (let k = 0; k <= fBins; k += 1) {
    const fHz = (k / fBins) * fMaxPlotHz;
    let re = 0;
    let im = 0;
    for (let n = 0; n <= sampleCount; n += 1) {
      const t = n * dtS;
      const s = signalMt[n] ?? 0;
      const ang = -2 * Math.PI * fHz * t;
      re += s * Math.cos(ang);
      im += s * Math.sin(ang);
    }
    const mag = Math.hypot(re, im) / (sampleCount + 1);
    freqsGhz.push(Number((fHz * 1e-9).toPrecision(4)));
    magArb.push(Number(mag.toPrecision(4)));
  }

  return {
    animation: false,
    grid: { left: 48, right: 16, top: 18, bottom: 32 },
    tooltip: { trigger: "axis" },
    xAxis: {
      type: "category",
      name: "f (GHz)",
      nameLocation: "middle",
      nameGap: 20,
      data: freqsGhz,
      axisLabel: { fontSize: 12 },
    },
    yAxis: {
      type: "value",
      name: "|B(f)| (mT)",
      axisLabel: { fontSize: 12 },
      splitLine: { lineStyle: { opacity: 0.18 } },
    },
    series: [
      {
        name: "Spectrum |B(f)|",
        type: "line",
        showSymbol: false,
        data: magArb,
        areaStyle: { opacity: 0.16 },
        lineStyle: { width: 1.75 },
      },
    ],
  };
}

/* ── Resource Normalization & Nyquist Resolution ── */

function normalizeRegionalListResource(
  rawData: unknown,
  fallbackRevisionNum: number | null,
): FieldDriveListResource | null {
  if (!rawData || typeof rawData !== "object") return null;
  const rec = rawData as {
    drives?: RegionalFieldDriveResource[];
    items?: RegionalFieldDriveResource[];
    scene_revision?: number;
  };
  const drives = Array.isArray(rec.drives)
    ? rec.drives
    : Array.isArray(rec.items)
      ? rec.items
      : [];
  const scene_revision =
    typeof rec.scene_revision === "number"
      ? rec.scene_revision
      : (fallbackRevisionNum ?? 0);
  return { drives, scene_revision };
}

function extractDriveIds(rawData: unknown): string[] {
  if (!rawData || typeof rawData !== "object") return [];
  const rec = rawData as { drives?: Array<{ id?: unknown }>; items?: Array<{ id?: unknown }> };
  const list = Array.isArray(rec.drives)
    ? rec.drives
    : Array.isArray(rec.items)
      ? rec.items
      : [];
  return list.flatMap((item) => (typeof item?.id === "string" ? [item.id] : []));
}

function resolveStarterWaveformPreset(selection: Selection): FieldDriveWaveformKind | null {
  const refRec = asRecord(selection.ref);
  const explicitPreset =
    typeof refRec?.waveformPreset === "string"
      ? refRec.waveformPreset
      : typeof refRec?.presetWaveform === "string"
        ? refRec.presetWaveform
        : null;
  const nodeId = selection.nodeId ?? "";
  const suffix = nodeId.includes(":draft:") ? (nodeId.split(":").at(-1) ?? "") : "";
  const token = (explicitPreset ?? suffix).trim().toLowerCase();

  if (token === "sinc_pulse" || token === "sinc") return "sinc_pulse";
  if (token === "sinusoidal" || token === "harmonic") return "sinusoidal";
  if (token === "gaussian_pulse" || token === "gaussian") return "gaussian_pulse";
  if (token === "pulse" || token === "step") return "pulse";
  if (token === "piecewise_linear" || token === "piecewise") return "piecewise_linear";
  if (token === "constant") return "constant";

  const label = (selection.label ?? "").toLowerCase();
  if (label.includes("sinc")) return "sinc_pulse";
  if (label.includes("harmonic") || label.includes("sinusoid")) return "sinusoidal";
  if (label.includes("gaussian")) return "gaussian_pulse";
  if (label.includes("step pulse")) return "pulse";
  return null;
}

function draftActivationResource(draft: Pick<FieldDriveSpecDraft, "stageScopeKind" | "selectedStageIds">): DriveActivationResource {
  return draft.stageScopeKind === "stage_ids"
    ? { kind: "stage_ids", stage_ids: [...draft.selectedStageIds] }
    : { kind: "all_time_evolution" };
}

function resolveDraftNyquistHz(
  scene: SceneResource | null,
  draft: Pick<FieldDriveSpecDraft, "stageScopeKind" | "selectedStageIds">,
): number | null {
  const sampling = regionalFieldDriveSamplingContext(scene, draftActivationResource(draft));
  const legacyStudyOutputDtS = asPositiveNumber(asRecord(scene?.study)?.output_dt_s);
  const samplePeriodS = sampling.samplePeriodS ?? legacyStudyOutputDtS;
  return samplePeriodS ? 1 / (2 * samplePeriodS) : null;
}

function buildCanonicalRegionalResourceFromDraft(
  draft: FieldDriveSpecDraft,
): RegionalFieldDriveResource {
  const target: FieldTargetResource =
    draft.targetKind === "region"
      ? {
          kind: "region",
          object_id: draft.targetObjectId === UNSELECTED_OBJECT ? "" : draft.targetObjectId.trim(),
          region_id: draft.targetRegionId === UNSELECTED_REGION ? "" : draft.targetRegionId.trim(),
        }
      : draft.targetKind === "object"
        ? {
            kind: "object",
            object_id:
              draft.targetObjectId === UNSELECTED_OBJECT ? "" : draft.targetObjectId.trim(),
          }
        : { kind: "global" };

  const sincEnvelope: Extract<FieldEnvelopeResource, { kind: "sinc" }> = {
    kind: "sinc",
    axis: [...draft.spatialAxis],
    period_m: draft.spatialPeriodM,
    center_m: draft.spatialCenterM,
    width_m: draft.spatialWidthEnabled ? draft.spatialWidthM : null,
    window: draft.spatialWindow,
  };

  let spatial_profile: FieldSpatialProfileResource;
  switch (draft.spatialKind) {
    case "sinc":
      spatial_profile = sincEnvelope;
      break;
    case "geometry_mask":
      spatial_profile = {
        kind: "geometry_mask",
        object_id: draft.maskObjectId === UNSELECTED_OBJECT ? "" : draft.maskObjectId.trim(),
        envelope: draft.maskEnvelopeKind === "sinc" ? sincEnvelope : { kind: "uniform" },
      };
      break;
    case "gaussian_plane_wave":
      spatial_profile = {
        kind: "gaussian_plane_wave",
        wavelength_m: draft.gpwWavelengthM,
        sigma_x_m: draft.gpwSigmaXM,
        sigma_y_m: draft.gpwSigmaYM,
        center_x_m: draft.gpwCenterXM,
        center_y_m: draft.gpwCenterYM,
        carrier_origin_x_m: draft.gpwCarrierOriginXM,
        carrier_phase_rad: draft.gpwCarrierPhaseRad,
      };
      break;
    case "uniform":
    default:
      spatial_profile = { kind: "uniform" };
      break;
  }

  let waveform: TimeDependenceResource;
  switch (draft.waveformKind) {
    case "constant":
      waveform = { kind: "constant" };
      break;
    case "sinusoidal":
      waveform = {
        kind: "sinusoidal",
        frequency_hz: draft.carrierFreqHz,
        phase_rad: draft.phaseRad,
        offset: draft.sinusoidalOffset,
      };
      break;
    case "pulse":
      waveform = {
        kind: "pulse",
        t_on: draft.pulseOnS,
        t_off: draft.pulseOffS,
      };
      break;
    case "sinc_pulse":
      waveform = {
        kind: "sinc_pulse",
        cutoff_hz: draft.cutoffFreqHz,
        t0: draft.timeCenterS,
        amplitude: draft.sincAmplitude,
      };
      break;
    case "piecewise_linear": {
      const pts = draft.piecewisePoints.map((p) => [p.timeS, p.scale]);
      waveform = { kind: "piecewise_linear", points: pts };
      break;
    }
    case "gaussian_pulse":
    case "chirp": {
      const samplePts = 64;
      const tEnd = Math.max(draft.timeCenterS * 2, 6 * draft.pulseSigmaS, 1e-9);
      const pts: number[][] = [];
      for (let i = 0; i <= samplePts; i += 1) {
        const t = (i / samplePts) * tEnd;
        pts.push([t, evaluateFieldDriveEnvelopeAtTime(draft, t)]);
      }
      waveform = { kind: "piecewise_linear", points: pts };
      break;
    }
  }

  const norm = vectorNorm(draft.direction);
  const direction: number[] =
    norm > 1e-30
      ? [draft.direction[0] / norm, draft.direction[1] / norm, draft.direction[2] / norm]
      : [0, 0, 0];

  return {
    id: draft.driveId.trim(),
    kind: "regional",
    name: draft.name.trim(),
    enabled: draft.enabled,
    amplitude_B_T: draft.amplitudeBT,
    direction,
    target,
    spatial_profile,
    waveform,
    time_origin: draft.timeOrigin,
    activation: draftActivationResource(draft),
  };
}

function hydrateRegionalDraftFromResource(
  raw: RegionalFieldDriveResource | Record<string, unknown>,
  exists: boolean,
  presetWaveform: FieldDriveWaveformKind | null,
): FieldDriveSpecDraft {
  const rec = raw as Record<string, unknown>;
  const id = typeof rec.id === "string" ? rec.id : "field-drive";
  const name = typeof rec.name === "string" ? rec.name : id;
  const enabled = rec.enabled !== false;

  /* Amplitude & direction (supports canonical amplitude_B_T + direction and legacy amplitude_t 3-vector) */
  let amplitudeBT = 1e-3;
  let direction: readonly [number, number, number] = [0, 1, 0];
  if (typeof rec.amplitude_B_T === "number" && Number.isFinite(rec.amplitude_B_T)) {
    amplitudeBT = rec.amplitude_B_T;
    direction = normalizeTuple3(asTuple3(rec.direction, [0, 1, 0]), [0, 1, 0]);
  } else if (Array.isArray(rec.amplitude_t) && rec.amplitude_t.length >= 3) {
    const vec = asTuple3(rec.amplitude_t, [0.001, 0, 0]);
    amplitudeBT = vectorNorm(vec);
    direction = normalizeTuple3(vec, [1, 0, 0]);
  } else if (typeof rec.amplitude_t === "number" && Number.isFinite(rec.amplitude_t)) {
    amplitudeBT = Math.abs(rec.amplitude_t);
    direction = normalizeTuple3(asTuple3(rec.direction, [1, 0, 0]), [1, 0, 0]);
  }

  /* Target */
  const targetRec = asRecord(rec.target);
  const rawTargetKind = typeof targetRec?.kind === "string" ? targetRec.kind : "global";
  const targetKind: "global" | "object" | "region" =
    rawTargetKind === "region" ? "region" : rawTargetKind === "object" ? "object" : "global";
  const targetObjectId =
    targetKind !== "global" && typeof targetRec?.object_id === "string" && targetRec.object_id
      ? targetRec.object_id
      : UNSELECTED_OBJECT;
  const targetRegionId =
    targetKind === "region" && typeof targetRec?.region_id === "string" && targetRec.region_id
      ? targetRec.region_id
      : UNSELECTED_REGION;

  /* Stage activation */
  const activationRec = asRecord(rec.activation);
  const stageScopeKind: "all_dynamic" | "stage_ids" =
    activationRec?.kind === "stage_ids" ? "stage_ids" : "all_dynamic";
  const selectedStageIds: string[] =
    activationRec?.kind === "stage_ids" && Array.isArray(activationRec.stage_ids)
      ? activationRec.stage_ids.flatMap((s) => (typeof s === "string" ? [s] : []))
      : [];

  /* Spatial profile */
  const spRec = asRecord(rec.spatial_profile);
  const rawSpKind = typeof spRec?.kind === "string" ? spRec.kind : "uniform";
  const spatialKind: FieldDriveSpatialKind =
    rawSpKind === "sinc" || rawSpKind === "geometry_mask" || rawSpKind === "gaussian_plane_wave"
      ? rawSpKind
      : "uniform";

  const envRec = spatialKind === "geometry_mask" ? asRecord(spRec?.envelope) : null;
  const maskEnvelopeKind: "uniform" | "sinc" =
    envRec?.kind === "sinc" ? "sinc" : "uniform";
  const sincSource = spatialKind === "sinc" ? spRec : maskEnvelopeKind === "sinc" ? envRec : null;

  const spatialAxis = asTuple3(sincSource?.axis, [1, 0, 0]);
  const spatialPeriodM = asFiniteNumber(sincSource?.period_m, 100e-9);
  const spatialCenterM = asFiniteNumber(sincSource?.center_m, 0);
  const spatialWidthEnabled =
    typeof sincSource?.width_m === "number" && Number.isFinite(sincSource.width_m);
  const spatialWidthM = spatialWidthEnabled
    ? Number(sincSource?.width_m)
    : 500e-9;
  const spatialWindow: "none" | "hann" =
    sincSource?.window === "hann" ? "hann" : "none";

  const maskObjectId =
    spatialKind === "geometry_mask" && typeof spRec?.object_id === "string" && spRec.object_id
      ? spRec.object_id
      : UNSELECTED_OBJECT;

  const gpwWavelengthM = asFiniteNumber(spRec?.wavelength_m, 200e-9);
  const gpwSigmaXM = asFiniteNumber(spRec?.sigma_x_m, 50e-9);
  const gpwSigmaYM = asFiniteNumber(spRec?.sigma_y_m, 50e-9);
  const gpwCenterXM = asFiniteNumber(spRec?.center_x_m, 0);
  const gpwCenterYM = asFiniteNumber(spRec?.center_y_m, 0);
  const gpwCarrierOriginXM = asFiniteNumber(spRec?.carrier_origin_x_m, 0);
  const gpwCarrierPhaseRad = asFiniteNumber(spRec?.carrier_phase_rad, 0);

  /* Time origin */
  const timeOrigin: "stage_local" | "absolute" =
    rec.time_origin === "absolute" ? "absolute" : "stage_local";

  /* Waveform */
  const wfRec = asRecord(rec.waveform ?? rec.time_dependence);
  const rawWfKind = typeof wfRec?.kind === "string" ? wfRec.kind : "constant";
  const waveformKind: FieldDriveWaveformKind =
    !exists && presetWaveform
      ? presetWaveform
      : rawWfKind === "sinc_pulse" ||
          rawWfKind === "sinusoidal" ||
          rawWfKind === "pulse" ||
          rawWfKind === "piecewise_linear" ||
          rawWfKind === "constant" ||
          rawWfKind === "gaussian_pulse" ||
          rawWfKind === "chirp"
        ? rawWfKind
        : "constant";

  let resolvedName = name;
  if (!exists && presetWaveform) {
    if (presetWaveform === "sinc_pulse" && name === "Global field drive") {
      resolvedName = "Sinc pulse drive";
    } else if (presetWaveform === "sinusoidal" && name === "Global field drive") {
      resolvedName = "Harmonic drive";
    } else if (presetWaveform === "gaussian_pulse" && name === "Global field drive") {
      resolvedName = "Gaussian pulse drive";
    } else if (presetWaveform === "pulse" && name === "Global field drive") {
      resolvedName = "Step pulse drive";
    }
  }

  const cutoffFreqHz = asFiniteNumber(wfRec?.cutoff_hz ?? wfRec?.cutoff_frequency_hz, 20e9);
  const sincAmplitude = asFiniteNumber(wfRec?.amplitude, 1);
  const carrierFreqHz = asFiniteNumber(wfRec?.frequency_hz, 1e9);
  const sinusoidalOffset = asFiniteNumber(wfRec?.offset, 0);
  const pulseOnS = asFiniteNumber(wfRec?.t_on, 0);
  const pulseOffS = asFiniteNumber(wfRec?.t_off, 1e-9);
  const chirpStopFreqHz = asFiniteNumber(wfRec?.stop_frequency_hz, 25e9);
  const timeCenterS = asFiniteNumber(wfRec?.t0 ?? wfRec?.center_s, 50e-12);
  const pulseSigmaS = asFiniteNumber(wfRec?.sigma_s ?? wfRec?.width_s, 0.1e-9);
  const phaseRad = asFiniteNumber(wfRec?.phase_rad, 0);

  const rawPoints = Array.isArray(wfRec?.points) ? wfRec.points : [];
  const piecewisePoints: PiecewiseWaypointRow[] =
    rawPoints.length > 0
      ? rawPoints.map((pt, idx) => {
          if (Array.isArray(pt) && pt.length >= 2) {
            return {
              _rowId: `fd-wp-src-${idx}`,
              timeS: asFiniteNumber(pt[0], idx * 1e-9),
              scale: asFiniteNumber(pt[1], 0),
            };
          }
          const ptRec = asRecord(pt);
          return {
            _rowId: `fd-wp-src-${idx}`,
            timeS: asFiniteNumber(ptRec?.time_s, idx * 1e-9),
            scale: asFiniteNumber(ptRec?.value ?? ptRec?.scale, 0),
          };
        })
      : [
          { _rowId: "fd-wp-0", timeS: 0, scale: 0 },
          { _rowId: "fd-wp-1", timeS: 1e-9, scale: 1 },
        ];

  return {
    driveId: id,
    exists,
    name: resolvedName,
    enabled,
    targetKind,
    targetObjectId,
    targetRegionId,
    stageScopeKind,
    selectedStageIds,
    spatialKind,
    spatialAxis,
    spatialPeriodM,
    spatialCenterM,
    spatialWidthEnabled,
    spatialWidthM,
    spatialWindow,
    maskObjectId,
    maskEnvelopeKind,
    gpwWavelengthM,
    gpwSigmaXM,
    gpwSigmaYM,
    gpwCenterXM,
    gpwCenterYM,
    gpwCarrierOriginXM,
    gpwCarrierPhaseRad,
    amplitudeBT,
    direction,
    timeOrigin,
    waveformKind,
    cutoffFreqHz,
    sincAmplitude,
    carrierFreqHz,
    sinusoidalOffset,
    pulseOnS,
    pulseOffS,
    chirpStopFreqHz,
    timeCenterS,
    pulseSigmaS,
    phaseRad,
    piecewisePoints,
    previewDomain: "time",
  };
}

/* ── Controlled Sub-Components (Shared UI Primitives Only) ── */

function AddRunStageButton({ scene }: { scene: SceneResource | null }) {
  const kernel = useKernel();
  const hasResourceSubscription = typeof kernel.resources?.subscribe === "function";
  const runtimeResourceData = useRuntimeCommandControlResourceData({
    enabled: hasResourceSubscription,
  });
  const context = useMemo(
    () =>
      createCommandContext("inspector", kernel, {
        resourceData: {
          ...runtimeResourceData,
          ...(scene ? { [MODEL_SCENE_PATH]: scene } : {}),
        },
        feedback: "foreground",
        sourceDetail: "FieldDriveSpec.empty-stages",
      }),
    [kernel, runtimeResourceData, scene],
  );

  const hasRegistryLookup = typeof kernel.commands.get === "function";
  const command = hasRegistryLookup ? kernel.commands.get("study.add-run-stage") : null;
  if (hasRegistryLookup && !command) return null;

  const enabled =
    typeof kernel.commands.isEnabled === "function"
      ? kernel.commands.isEnabled("study.add-run-stage", context)
      : true;
  const disabledReason = !enabled ? (command?.disabledReason?.(context) ?? null) : null;

  return (
    <Button
      disabled={!enabled}
      disabledReason={disabledReason}
      size="sm"
      type="button"
      variant="secondary"
      onClick={() => {
        void kernel.commands.execute("study.add-run-stage", context);
      }}
    >
      <Plus aria-hidden="true" size={12} />
      <span>Add run stage</span>
    </Button>
  );
}

function ControlledPiecewiseWaypointsEditor({
  points,
  onChange,
  onParseErrorChange,
}: {
  points: readonly PiecewiseWaypointRow[];
  onChange: (next: readonly PiecewiseWaypointRow[]) => void;
  onParseErrorChange?: (error: string | null) => void;
}) {
  const [rawByCell, setRawByCell] = useState<Record<string, { expected: number; text: string }>>(
    {},
  );

  const updateErrorState = (
    cells: Record<string, { expected: number; text: string }>,
    currentPoints: readonly PiecewiseWaypointRow[],
  ) => {
    for (const pt of currentPoints) {
      for (const field of ["time", "scale"] as const) {
        const cell = cells[`${pt._rowId}:${field}`];
        if (!cell) continue;
        if (cell.text.trim().length === 0 || !Number.isFinite(Number(cell.text))) {
          onParseErrorChange?.("Piecewise-linear points require finite numeric values.");
          return;
        }
      }
    }
    onParseErrorChange?.(null);
  };

  return (
    <div className="flex flex-col gap-1.5" data-slot="piecewise-waypoints-editor">
      <div className="grid grid-cols-[auto_1fr_1fr_auto] items-center gap-1.5 text-xs font-medium text-[var(--fm-text-muted)]">
        <span className="w-6">#</span>
        <span>Time t (ns)</span>
        <span>Scale f(t)</span>
        <span className="w-7" />
      </div>
      {points.map((pt, idx) => {
        const expectedTimeNs = Number((pt.timeS * 1e9).toPrecision(6));
        const expectedScale = pt.scale;
        const timeKey = `${pt._rowId}:time`;
        const scaleKey = `${pt._rowId}:scale`;
        const timeCell = rawByCell[timeKey];
        const scaleCell = rawByCell[scaleKey];
        const timeValue =
          timeCell && Object.is(timeCell.expected, expectedTimeNs)
            ? timeCell.text
            : String(expectedTimeNs);
        const scaleValue =
          scaleCell && Object.is(scaleCell.expected, expectedScale)
            ? scaleCell.text
            : String(expectedScale);

        const timeInvalid =
          timeValue.trim().length === 0 || !Number.isFinite(Number(timeValue));
        const scaleInvalid =
          scaleValue.trim().length === 0 || !Number.isFinite(Number(scaleValue));

        return (
          <div
            key={pt._rowId}
            className="grid grid-cols-[auto_1fr_1fr_auto] items-center gap-1.5"
          >
            <span className="w-6 font-mono text-xs text-[var(--fm-text-muted)]">
              P{idx + 1}
            </span>
            <Input
              aria-invalid={timeInvalid ? "true" : "false"}
              aria-label={`Waypoint ${idx + 1} time (ns)`}
              autoComplete="off"
              className="font-mono text-xs"
              inputMode="decimal"
              type="text"
              value={timeValue}
              onChange={(event) => {
                const nextText = event.target.value;
                const parsed = Number(nextText);
                const isValid = nextText.trim().length > 0 && Number.isFinite(parsed);
                const nextTimeS = isValid ? parsed * 1e-9 : pt.timeS;
                const nextExpectedNs = Number((nextTimeS * 1e9).toPrecision(6));
                const nextPoints = isValid
                  ? points.map((row) =>
                      row._rowId === pt._rowId ? { ...row, timeS: nextTimeS } : row,
                    )
                  : points;
                const nextCells = {
                  ...rawByCell,
                  [timeKey]: { expected: nextExpectedNs, text: nextText },
                };
                setRawByCell(nextCells);
                if (isValid) onChange(nextPoints);
                updateErrorState(nextCells, nextPoints);
              }}
            />
            <Input
              aria-invalid={scaleInvalid ? "true" : "false"}
              aria-label={`Waypoint ${idx + 1} scale`}
              autoComplete="off"
              className="font-mono text-xs"
              inputMode="decimal"
              type="text"
              value={scaleValue}
              onChange={(event) => {
                const nextText = event.target.value;
                const parsed = Number(nextText);
                const isValid = nextText.trim().length > 0 && Number.isFinite(parsed);
                const nextScale = isValid ? parsed : pt.scale;
                const nextPoints = isValid
                  ? points.map((row) =>
                      row._rowId === pt._rowId ? { ...row, scale: nextScale } : row,
                    )
                  : points;
                const nextCells = {
                  ...rawByCell,
                  [scaleKey]: { expected: nextScale, text: nextText },
                };
                setRawByCell(nextCells);
                if (isValid) onChange(nextPoints);
                updateErrorState(nextCells, nextPoints);
              }}
            />
            <Button
              aria-label={`Remove waypoint ${idx + 1}`}
              disabled={points.length <= 2}
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => {
                const filtered = points.filter((row) => row._rowId !== pt._rowId);
                onChange(filtered);
                updateErrorState(rawByCell, filtered);
              }}
            >
              <Trash2 aria-hidden="true" size={12} />
            </Button>
          </div>
        );
      })}
      <div>
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => {
            const lastT = points[points.length - 1]?.timeS ?? 0;
            onChange([...points, createPiecewiseWaypoint(lastT + 0.5e-9, 0)]);
          }}
        >
          <Plus aria-hidden="true" size={12} />
          <span>Add waypoint</span>
        </Button>
      </div>
    </div>
  );
}

/* ── Regional Field Drive Panel Hosted in Canonical InspectorTemplate ── */

function RegionalFieldDriveInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const regionalResource = useFieldDrivesResource();
  const maskResource = useMaskFieldDrivesResource();

  const normalizedRegional = useMemo(
    () => normalizeRegionalListResource(regionalResource.data, scene.data?.revision ?? null),
    [regionalResource.data, scene.data?.revision],
  );
  const maskIds = useMemo(() => extractDriveIds(maskResource.data), [maskResource.data]);

  const normalizedSelection = useMemo<Selection>(() => {
    if (selection.ref?.type === "physics-field-drive") return selection;
    const isDraftNode = Boolean(selection.nodeId?.includes(":draft"));
    const fallbackId = !isDraftNode ? (selection.nodeId?.split(":").at(-1) ?? undefined) : undefined;
    return {
      ...selection,
      ref: {
        ...(isDraftNode ? { draft: true } : {}),
        ...(fallbackId ? { fieldDriveId: fallbackId } : {}),
        kind: "physics.field-drive",
        nodeId: selection.nodeId ?? "model:physics:field-drive:draft",
        type: "physics-field-drive",
      },
    };
  }, [selection]);

  const model = useMemo(() => {
    const resolved = resolveRegionalFieldDrivePanelModel(
      normalizedSelection,
      normalizedRegional,
    );
    const sourceObjectId =
      normalizedSelection.ref?.type === "physics-field-drive"
        ? normalizedSelection.ref.sourceObjectId
        : undefined;
    if (resolved.mode === "create") {
      const baseCreated = createRegionalFieldDriveDraft(
        normalizedRegional?.drives ?? [],
        sourceObjectId,
      );
      const takenIds = new Set([
        ...(normalizedRegional?.drives ?? []).map((item) => item.id),
        ...maskIds,
      ]);
      let uniqueId = baseCreated.id;
      if (takenIds.has(uniqueId)) {
        let suffix = 2;
        while (takenIds.has(`field-drive-${suffix}`)) {
          suffix += 1;
        }
        uniqueId = `field-drive-${suffix}`;
      }
      return {
        ...resolved,
        drive: uniqueId === baseCreated.id ? baseCreated : { ...baseCreated, id: uniqueId },
        sceneRevision: resolved.sceneRevision ?? scene.data?.revision ?? null,
      };
    }
    return {
      ...resolved,
      sceneRevision: resolved.sceneRevision ?? scene.data?.revision ?? null,
    };
  }, [maskIds, normalizedRegional, normalizedSelection, scene.data?.revision]);

  const presetWaveform = useMemo(
    () => (model.mode === "create" ? resolveStarterWaveformPreset(selection) : null),
    [model.mode, selection],
  );

  const selectorOptions = useMemo(
    () => regionalFieldDriveSelectorOptions(scene.data ?? null),
    [scene.data],
  );

  const existingIdsExcludingCurrent = useMemo(() => {
    const set = new Set<string>(maskIds);
    for (const item of normalizedRegional?.drives ?? []) {
      if (model.mode === "found" && item.id === model.driveId) continue;
      set.add(item.id);
    }
    return set;
  }, [maskIds, model.driveId, model.mode, normalizedRegional?.drives]);

  const baselineSignature = JSON.stringify([
    model.drive ?? null,
    model.mode,
    model.driveId ?? null,
    presetWaveform,
  ]);
  const baseline = useMemo<FieldDriveSpecDraft>(() => {
    if (model.drive) {
      return hydrateRegionalDraftFromResource(
        model.drive,
        model.mode === "found",
        presetWaveform,
      );
    }
    const fallbackDraft = createRegionalFieldDriveDraft([], undefined);
    return {
      ...hydrateRegionalDraftFromResource(fallbackDraft, false, presetWaveform),
      driveId: model.driveId ?? fallbackDraft.id,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baselineSignature]);

  const selectionKey =
    selection.nodeId ??
    `physics.field-drive:regional:${model.mode === "create" ? "draft" : (model.driveId ?? "none")}`;

  const [scopedErrors, setScopedErrors] = useState<{
    key: string;
    conflictNotice: string | null;
    waypointParseError: string | null;
  }>({
    key: selectionKey,
    conflictNotice: null,
    waypointParseError: null,
  });

  const conflictNotice =
    scopedErrors.key === selectionKey ? scopedErrors.conflictNotice : null;
  const waypointParseError =
    scopedErrors.key === selectionKey ? scopedErrors.waypointParseError : null;

  const setConflictNotice = useCallback(
    (msg: string | null) => {
      setScopedErrors((prev) => ({
        key: selectionKey,
        conflictNotice: msg,
        waypointParseError: prev.key === selectionKey ? prev.waypointParseError : null,
      }));
    },
    [selectionKey],
  );
  const setWaypointParseError = useCallback(
    (msg: string | null) => {
      setScopedErrors((prev) => ({
        key: selectionKey,
        conflictNotice: prev.key === selectionKey ? prev.conflictNotice : null,
        waypointParseError: msg,
      }));
    },
    [selectionKey],
  );

  const sessionScopeKey = kernel.commands.getSessionScopeKey?.() ?? null;
  const editable = model.mode === "create" || model.mode === "found";

  const pendingNavigationRef = useRef<Omit<Selection, "moduleSource"> | null>(null);

  const handleApply = useCallback(
    async (d: FieldDriveSpecDraft): Promise<boolean> => {
      if (!editable) return false;
      if (d.stageScopeKind === "stage_ids" && d.selectedStageIds.length === 0) {
        throw new Error("Select at least one run stage.");
      }
      if (waypointParseError && d.waveformKind === "piecewise_linear") {
        throw new Error(waypointParseError);
      }
      const submitted = buildCanonicalRegionalResourceFromDraft(d);
      const domainErrors = validateFieldDriveDraft(submitted);
      if (domainErrors.length > 0) {
        throw new Error(domainErrors[0]!);
      }

      const context = captureAuthoringMutationFence(
        createCommandContext("inspector", kernel, {
          resourceData: scene.data ? { [MODEL_SCENE_PATH]: scene.data } : undefined,
          selection: typeof kernel.selection?.get === "function" ? kernel.selection : undefined,
          sourceDetail: "FieldDriveSpec.regional.save",
        }),
      );
      const scopeKey = context.sessionScopeKey;
      if (!scopeKey || context.isCurrentSessionScope?.() === false) {
        throw new Error("An active session is required to save this field drive.");
      }
      setConflictNotice(null);

      const writeMode = d.exists ? "found" : "create";

      try {
        const response = await runAuthoringMutationWithHistory(
          context,
          `${writeMode === "create" ? "Create" : "Update"} field drive ${submitted.id}`,
          ({ baseRevision }) => {
            const committedRevision =
              baseRevision ?? model.sceneRevision ?? scene.data?.revision ?? null;
            if (
              typeof committedRevision !== "number" ||
              !Number.isSafeInteger(committedRevision) ||
              committedRevision < 0
            ) {
              throw new Error(
                "The scene revision is unavailable. Refetch before changing the drive.",
              );
            }
            return commitRegionalFieldDrive(
              kernel.api.model,
              writeMode,
              committedRevision,
              submitted,
              { sessionScopeKey: scopeKey },
            );
          },
        );
        if (context.isCurrentSessionScope?.() === false) return false;
        const rev = response.scene_revision;
        if (response.committed_scene && typeof response.committed_scene === "object") {
          publishCommittedSceneResource(
            kernel.resources,
            response.committed_scene as Parameters<typeof publishCommittedSceneResource>[1],
            rev,
          );
        }
        kernel.resources.invalidate(MODEL_FIELD_DRIVES_PATH, rev);
        kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, fallbackRevision(rev));
        invalidateAuthoringMutationDependents(kernel.resources, "interaction", rev);

        if (writeMode === "create") {
          const nodeId = `model:physics:field-drives:${submitted.id}`;
          pendingNavigationRef.current = {
            kind: "physics.field-drive",
            label: submitted.name || submitted.id,
            nodeId,
            objectId: null,
            ref: {
              fieldDriveId: submitted.id,
              kind: "physics.field-drive",
              nodeId,
              type: "physics-field-drive",
            },
          };
        }
        return true;
      } catch (error) {
        if (context.isCurrentSessionScope?.() === false) return false;
        const status = (error as { status?: number } | null)?.status;
        const msg = error instanceof Error ? error.message : String(error);
        if (status === 409 || /conflict|revision/i.test(msg)) {
          kernel.resources.invalidate(MODEL_FIELD_DRIVES_PATH, fallbackRevision(undefined));
          kernel.resources.invalidate(MODEL_SCENE_PATH, fallbackRevision(undefined));
          setConflictNotice(
            "Scene revision changed concurrently while saving. Reload the latest scene version or apply again.",
          );
        }
        throw error instanceof Error ? error : new Error(msg);
      }
    },
    [editable, kernel, model.sceneRevision, scene.data, setConflictNotice, waypointParseError],
  );

  const lockReason = !editable
    ? "Selected field drive is not present in the current scene."
    : !sessionScopeKey
      ? "An active session is required to modify this field drive."
      : null;

  const handleDelete = useCallback(
    async (d: FieldDriveSpecDraft) => {
      if (!d.exists || !d.driveId) return;
      const context = captureAuthoringMutationFence(
        createCommandContext("inspector", kernel, {
          resourceData: scene.data ? { [MODEL_SCENE_PATH]: scene.data } : undefined,
          selection: typeof kernel.selection?.get === "function" ? kernel.selection : undefined,
          sourceDetail: "FieldDriveSpec.regional.delete",
        }),
      );
      const scopeKey = context.sessionScopeKey;
      const ack = await runAuthoringMutationWithHistory(
        context,
        `Delete field drive ${d.driveId}`,
        ({ baseRevision }) => {
          const committedRevision =
            baseRevision ?? model.sceneRevision ?? scene.data?.revision ?? null;
          return kernel.api.model.deleteFieldDrive(
            d.driveId,
            { base_revision: committedRevision },
            scopeKey ? { sessionScopeKey: scopeKey } : undefined,
          );
        },
      );
      if (context.isCurrentSessionScope?.() === false) return;
      const rev = ack?.scene_revision;
      if (ack?.committed_scene && typeof ack.committed_scene === "object") {
        publishCommittedSceneResource(
          kernel.resources,
          ack.committed_scene as Parameters<typeof publishCommittedSceneResource>[1],
          rev,
        );
      }
      kernel.resources.invalidate(MODEL_FIELD_DRIVES_PATH, rev);
      kernel.resources.invalidate(MODEL_SCENE_PATH, rev);
      kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, fallbackRevision(rev));
      invalidateAuthoringMutationDependents(kernel.resources, "interaction", rev);
      kernel.selection.set(
        buildRootSelection("physics.field-drives", "model:physics:field-drives", "Field Drives"),
        "inspector",
      );
    },
    [kernel, model.sceneRevision, scene.data],
  );

  const objectSelectOptions = useMemo(() => {
    const opts = [{ value: UNSELECTED_OBJECT, label: "Select an object" }];
    const seen = new Set<string>();
    for (const obj of selectorOptions.objects) {
      seen.add(obj.id);
      opts.push({ value: obj.id, label: obj.label });
    }
    for (const candidate of [baseline.targetObjectId, baseline.maskObjectId]) {
      if (candidate && candidate !== UNSELECTED_OBJECT && !seen.has(candidate)) {
        seen.add(candidate);
        opts.push({ value: candidate, label: candidate });
      }
    }
    return opts;
  }, [baseline.maskObjectId, baseline.targetObjectId, selectorOptions.objects]);

  const regionSelectOptions = useMemo(() => {
    const opts = [{ value: UNSELECTED_REGION, label: "Select a region" }];
    const seen = new Set<string>();
    for (const regions of Object.values(selectorOptions.regionsByObject)) {
      for (const reg of regions) {
        if (!seen.has(reg.id)) {
          seen.add(reg.id);
          opts.push({ value: reg.id, label: reg.label });
        }
      }
    }
    const cur = baseline.targetRegionId;
    if (cur && cur !== UNSELECTED_REGION && !seen.has(cur)) {
      opts.push({ value: cur, label: cur });
    }
    return opts;
  }, [baseline.targetRegionId, selectorOptions.regionsByObject]);

  const stageOptions = useMemo(
    () =>
      selectorOptions.timeEvolutionStages.map((st) => ({
        value: st.id,
        label: st.label,
      })),
    [selectorOptions.timeEvolutionStages],
  );

  const spec = useMemo<InspectorSpec<FieldDriveSpecDraft>>(
    () => ({
      id: "physics.field-drive",
      header: {
        breadcrumbs: [
          {
            id: "drives",
            label: "Field Drives",
            selection: buildRootSelection(
              "physics.field-drives",
              "model:physics:field-drives",
              "Field Drives",
            ),
          },
          { id: "drive", label: baseline.name || baseline.driveId },
        ],
        searchable: true,
        ...(baseline.exists
          ? {
              deleteAction: {
                label: "Delete Field Drive",
                confirmTitle: (d) => `Delete field drive "${d.name}"?`,
                confirmDescription:
                  "Deleting this field drive permanently removes its spatial-temporal excitation profile from all study stages.",
                onDelete: async (ctx) => {
                  await handleDelete(ctx.draft);
                },
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Radio,
        title: (d) => d.name || d.driveId,
        renameFieldKey: "name",
        kindLabel: "Regional external field drive",
        entityId: baseline.driveId,
        statePill: (d) =>
          !editable
            ? { tone: "warn", label: "Not in scene" }
            : !d.exists
              ? { tone: "info", label: "Configured" }
              : d.enabled
                ? { tone: "ok", label: "Active" }
                : { tone: "degraded", label: "Disabled" },
      },
      facts: (d): readonly InspectorFact[] => {
        const maxFreqGhz = estimateFieldDriveMaxFrequencyHz(d) * 1e-9;
        return [
          {
            id: "peak",
            label: "Peak |B|",
            value: `${(d.amplitudeBT * 1e3).toFixed(2)} mT`,
          },
          {
            id: "waveform",
            label: "Waveform",
            value: d.waveformKind.replace(/_/g, " "),
          },
          {
            id: "fmax",
            label: "Max f",
            value: maxFreqGhz > 0 ? `${maxFreqGhz.toFixed(2)} GHz` : "DC",
          },
          {
            id: "spatial",
            label: "Spatial",
            value: d.spatialKind.replace(/_/g, " "),
          },
        ];
      },
      notices: (d): readonly InspectorNotice<FieldDriveSpecDraft>[] => {
        const list: InspectorNotice<FieldDriveSpecDraft>[] = [];
        if (!editable) {
          list.push({
            id: "regional-missing",
            tone: "warn",
            title: "Field drive not found in scene",
            text: "Select an existing field drive from Field Drives or create a new excitation.",
          });
        }
        if (conflictNotice) {
          list.push({
            id: "regional-conflict",
            tone: "warn",
            title: "Concurrent scene update",
            text: conflictNotice,
            quickFix: {
              label: "Reload latest version",
              onApply: (ctx) => {
                kernel.resources.invalidate(MODEL_FIELD_DRIVES_PATH, fallbackRevision(undefined));
                kernel.resources.invalidate(MODEL_SCENE_PATH, fallbackRevision(undefined));
                setConflictNotice(null);
                ctx.patchDraft(baseline);
              },
            },
          });
        }
        const nyquistHz = resolveDraftNyquistHz(scene.data ?? null, d);
        const maxFreqHz = estimateFieldDriveMaxFrequencyHz(d);
        if (nyquistHz !== null && maxFreqHz > nyquistHz) {
          list.push({
            id: "nyquist-aliasing",
            tone: "warn",
            title: "Excitation exceeds output Nyquist frequency",
            text: `Drive spectral content reaches ${(maxFreqHz * 1e-9).toFixed(2)} GHz, above the saved output Nyquist limit f_Nyq = ${(nyquistHz * 1e-9).toFixed(2)} GHz.`,
            focusFieldKey:
              d.waveformKind === "sinc_pulse" ? "cutoffFreqHz" : "carrierFreqHz",
            quickFix:
              d.waveformKind === "sinc_pulse"
                ? {
                    label: "Clamp to Nyquist",
                    onApply: (ctx) => ctx.setField("cutoffFreqHz", 0.8 * nyquistHz),
                  }
                : undefined,
          });
        }
        return list;
      },
      sections: [
        {
          id: "drive-scope",
          title: "Identity, target & stage activation",
          icon: Sliders,
          defaultOpen: true,
          rows: [
            {
              key: "driveId",
              type: "text",
              mono: true,
              label: "ID",
              showWhen: (d) => !d.exists,
              validate: (v, d) => {
                const trimmed = v.trim();
                if (trimmed.length === 0) return "Enter a drive ID.";
                if (!d.exists && existingIdsExcludingCurrent.has(trimmed)) {
                  return `Field drive "${trimmed}" already exists.`;
                }
                return null;
              },
            },
            {
              type: "readonly",
              mono: true,
              label: "ID",
              showWhen: (d) => d.exists,
              format: (d) => d.driveId,
            },
            {
              key: "name",
              type: "text",
              label: "Name",
              validate: (v) => (v.trim().length === 0 ? "Enter a drive name." : null),
            },
            {
              key: "enabled",
              type: "switch",
              label: "Enabled",
            },
            {
              key: "targetKind",
              type: "select",
              label: "Target",
              structural: true,
              options: [
                { value: "global", label: "Global" },
                { value: "object", label: "Object" },
                { value: "region", label: "Region" },
              ],
            },
            {
              key: "targetObjectId",
              type: "select",
              label: "Object",
              structural: true,
              showWhen: (d) => d.targetKind !== "global",
              options: objectSelectOptions,
              validate: (v, d) =>
                d.targetKind !== "global" && (v === UNSELECTED_OBJECT || v.trim().length === 0)
                  ? "Select an object."
                  : null,
            },
            {
              key: "targetRegionId",
              type: "select",
              label: "Stable region",
              showWhen: (d) => d.targetKind === "region",
              options: regionSelectOptions,
              validate: (v, d) =>
                d.targetKind === "region" && (v === UNSELECTED_REGION || v.trim().length === 0)
                  ? "Select a region."
                  : null,
            },
            {
              key: "stageScopeKind",
              type: "segmented",
              label: "Stage activation",
              structural: true,
              options: [
                { value: "all_dynamic", label: "All time stages" },
                { value: "stage_ids", label: "Selected stages" },
              ],
            },
            {
              key: "selectedStageIds",
              type: "toggles",
              label: "Participating stages",
              showWhen: (d) => d.stageScopeKind === "stage_ids" && stageOptions.length > 0,
              options: stageOptions,
              validate: (v, d) =>
                d.stageScopeKind === "stage_ids" && v.length === 0
                  ? "Select at least one run stage."
                  : null,
            },
            {
              type: "custom",
              wide: true,
              showWhen: (d) => d.stageScopeKind === "stage_ids" && stageOptions.length === 0,
              render: () => (
                <div
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2 text-xs text-[var(--fm-text-muted)]"
                  data-slot="empty-run-stages-cta"
                >
                  <span>
                    No run stage with a stable ID is available. Add a run stage before assigning
                    this drive.
                  </span>
                  <AddRunStageButton scene={scene.data ?? null} />
                </div>
              ),
            },
          ],
        },
        {
          id: "drive-spatial",
          title: "Spatial modulation profile",
          icon: Compass,
          defaultOpen: true,
          rows: [
            {
              key: "spatialKind",
              type: "select",
              label: "Spatial profile",
              structural: true,
              options: [
                { value: "uniform", label: "Uniform" },
                { value: "sinc", label: "Spatial sinc" },
                { value: "geometry_mask", label: "Geometry mask" },
                { value: "gaussian_plane_wave", label: "Gaussian plane wave" },
              ],
            },
            {
              key: "maskObjectId",
              type: "select",
              label: "Mask geometry",
              structural: true,
              showWhen: (d) => d.spatialKind === "geometry_mask",
              options: objectSelectOptions,
            },
            {
              key: "maskEnvelopeKind",
              type: "segmented",
              label: "Envelope",
              structural: true,
              showWhen: (d) => d.spatialKind === "geometry_mask",
              options: [
                { value: "uniform", label: "Uniform" },
                { value: "sinc", label: "Spatial sinc" },
              ],
            },
            {
              key: "spatialAxis",
              type: "vector3",
              label: "Wavevector axis",
              symbol: (
                <>
                  ê<sub>k</sub>
                </>
              ),
              axisPresets: true,
              normalizeAction: true,
              showWhen: (d) =>
                d.spatialKind === "sinc" ||
                (d.spatialKind === "geometry_mask" && d.maskEnvelopeKind === "sinc"),
            },
            {
              key: "spatialPeriodM",
              type: "quantity",
              label: "Spatial period",
              symbol: <>λ</>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) =>
                d.spatialKind === "sinc" ||
                (d.spatialKind === "geometry_mask" && d.maskEnvelopeKind === "sinc"),
            },
            {
              key: "spatialCenterM",
              type: "quantity",
              label: "Spatial center",
              symbol: (
                <>
                  x<sub>0</sub>
                </>
              ),
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              showWhen: (d) =>
                d.spatialKind === "sinc" ||
                (d.spatialKind === "geometry_mask" && d.maskEnvelopeKind === "sinc"),
            },
            {
              key: "spatialWidthEnabled",
              type: "switch",
              label: "Limit spatial width",
              showWhen: (d) =>
                d.spatialKind === "sinc" ||
                (d.spatialKind === "geometry_mask" && d.maskEnvelopeKind === "sinc"),
            },
            {
              key: "spatialWidthM",
              type: "quantity",
              label: "Spatial width",
              symbol: <>W</>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) =>
                (d.spatialKind === "sinc" ||
                  (d.spatialKind === "geometry_mask" && d.maskEnvelopeKind === "sinc")) &&
                d.spatialWidthEnabled,
            },
            {
              key: "spatialWindow",
              type: "segmented",
              label: "Window",
              showWhen: (d) =>
                d.spatialKind === "sinc" ||
                (d.spatialKind === "geometry_mask" && d.maskEnvelopeKind === "sinc"),
              options: [
                { value: "none", label: "None" },
                { value: "hann", label: "Hann" },
              ],
            },
            /* Gaussian plane wave spatial parameters */
            {
              key: "gpwWavelengthM",
              type: "quantity",
              label: "Carrier wavelength",
              symbol: <>λ</>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.spatialKind === "gaussian_plane_wave",
            },
            {
              key: "gpwSigmaXM",
              type: "quantity",
              label: "Beam waist X",
              symbol: (
                <>
                  σ<sub>x</sub>
                </>
              ),
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.spatialKind === "gaussian_plane_wave",
            },
            {
              key: "gpwSigmaYM",
              type: "quantity",
              label: "Beam waist Y",
              symbol: (
                <>
                  σ<sub>y</sub>
                </>
              ),
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.spatialKind === "gaussian_plane_wave",
            },
            {
              key: "gpwCenterXM",
              type: "quantity",
              label: "Beam center X",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              showWhen: (d) => d.spatialKind === "gaussian_plane_wave",
            },
            {
              key: "gpwCenterYM",
              type: "quantity",
              label: "Beam center Y",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              showWhen: (d) => d.spatialKind === "gaussian_plane_wave",
            },
            {
              key: "gpwCarrierOriginXM",
              type: "quantity",
              label: "Carrier origin X",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              showWhen: (d) => d.spatialKind === "gaussian_plane_wave",
            },
            {
              key: "gpwCarrierPhaseRad",
              type: "quantity",
              label: "Carrier phase",
              units: ANGLE_UNITS,
              defaultDisplayUnit: "deg",
              showWhen: (d) => d.spatialKind === "gaussian_plane_wave",
            },
          ],
        },
        {
          id: "drive-waveform",
          title: "Field vector, time origin & waveform",
          icon: Waves,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => {
                const nyquistHz = resolveDraftNyquistHz(scene.data ?? null, ctx.draft);
                return (
                  <div className="flex flex-col gap-2" data-slot="field-drive-preview">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-[var(--fm-text-muted)]">
                        Interactive excitation preview
                      </span>
                      <SegmentedControl
                        aria-label="Excitation preview domain"
                        options={[
                          { value: "time", label: "Time B(t)" },
                          { value: "spectrum", label: "Spectrum |B(f)|" },
                        ]}
                        value={ctx.draft.previewDomain}
                        onValueChange={(next) =>
                          ctx.setField("previewDomain", next as "time" | "spectrum")
                        }
                      />
                    </div>
                    <ScientificEChart
                      ariaLabel="Field drive waveform and spectrum preview"
                      className="w-full rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)]"
                      height={176}
                      optionBuilder={() =>
                        buildFieldDrivePreviewChartOption(ctx.draft, nyquistHz)
                      }
                    />
                  </div>
                );
              },
            },
            {
              key: "amplitudeBT",
              type: "quantity",
              label: "Amplitude",
              symbol: (
                <>
                  B<sub>0</sub>
                </>
              ),
              units: FIELD_TESLA_UNITS,
              defaultDisplayUnit: "mT",
              min: 0,
            },
            {
              key: "direction",
              type: "vector3",
              label: "Direction",
              symbol: (
                <>
                  ê<sub>B</sub>
                </>
              ),
              axisPresets: true,
              normalizeAction: true,
            },
            {
              key: "timeOrigin",
              type: "segmented",
              label: "Time origin",
              options: [
                { value: "stage_local", label: "Stage local" },
                { value: "absolute", label: "Absolute" },
              ],
            },
            {
              key: "waveformKind",
              type: "select",
              label: "Waveform",
              structural: true,
              options: [
                { value: "sinc_pulse", label: "Sinc pulse" },
                { value: "sinusoidal", label: "Sinusoidal" },
                { value: "pulse", label: "Pulse (step t_on → t_off)" },
                { value: "piecewise_linear", label: "Piecewise linear" },
                { value: "constant", label: "Constant" },
                { value: "gaussian_pulse", label: "Gaussian pulse (synthesized)" },
                { value: "chirp", label: "Linear chirp (synthesized)" },
              ],
            },
            /* Sinc pulse */
            {
              key: "cutoffFreqHz",
              type: "quantity",
              label: "Cutoff frequency",
              symbol: (
                <>
                  f<sub>c</sub>
                </>
              ),
              units: FREQUENCY_UNITS,
              defaultDisplayUnit: "GHz",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.waveformKind === "sinc_pulse",
            },
            {
              key: "timeCenterS",
              type: "quantity",
              label: "Center time",
              symbol: (
                <>
                  t<sub>0</sub>
                </>
              ),
              units: TIME_UNITS,
              defaultDisplayUnit: "ns",
              showWhen: (d) =>
                d.waveformKind === "sinc_pulse" || d.waveformKind === "gaussian_pulse",
            },
            {
              key: "sincAmplitude",
              type: "number",
              label: "Waveform amplitude",
              symbol: <>a</>,
              showWhen: (d) => d.waveformKind === "sinc_pulse",
            },
            /* Sinusoidal */
            {
              key: "carrierFreqHz",
              type: "quantity",
              label: "Frequency",
              symbol: <>f</>,
              units: FREQUENCY_UNITS,
              defaultDisplayUnit: "GHz",
              min: 0,
              minExclusive: true,
              showWhen: (d) =>
                d.waveformKind === "sinusoidal" ||
                d.waveformKind === "gaussian_pulse" ||
                d.waveformKind === "chirp",
            },
            {
              key: "phaseRad",
              type: "quantity",
              label: "Phase",
              symbol: <>φ</>,
              units: ANGLE_UNITS,
              defaultDisplayUnit: "deg",
              showWhen: (d) =>
                d.waveformKind === "sinusoidal" ||
                d.waveformKind === "gaussian_pulse" ||
                d.waveformKind === "chirp",
            },
            {
              key: "sinusoidalOffset",
              type: "number",
              label: "Offset",
              showWhen: (d) => d.waveformKind === "sinusoidal",
            },
            /* Canonical step pulse (t_on, t_off) */
            {
              key: "pulseOnS",
              type: "quantity",
              label: "On time",
              symbol: (
                <>
                  t<sub>on</sub>
                </>
              ),
              units: TIME_UNITS,
              defaultDisplayUnit: "ns",
              showWhen: (d) => d.waveformKind === "pulse",
            },
            {
              key: "pulseOffS",
              type: "quantity",
              label: "Off time",
              symbol: (
                <>
                  t<sub>off</sub>
                </>
              ),
              units: TIME_UNITS,
              defaultDisplayUnit: "ns",
              showWhen: (d) => d.waveformKind === "pulse",
              validate: (v, d) =>
                v <= d.pulseOnS ? "Pulse off time must be greater than on time." : null,
            },
            /* Gaussian / Chirp synthesis controls */
            {
              key: "chirpStopFreqHz",
              type: "quantity",
              label: "Chirp stop frequency",
              symbol: (
                <>
                  f<sub>1</sub>
                </>
              ),
              units: FREQUENCY_UNITS,
              defaultDisplayUnit: "GHz",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.waveformKind === "chirp",
            },
            {
              key: "pulseSigmaS",
              type: "quantity",
              label: "Pulse width σ",
              symbol: (
                <>
                  σ<sub>t</sub>
                </>
              ),
              units: TIME_UNITS,
              defaultDisplayUnit: "ns",
              min: 1e-15,
              showWhen: (d) =>
                d.waveformKind === "gaussian_pulse" || d.waveformKind === "chirp",
            },
            /* Controlled Piecewise-linear waypoints */
            {
              type: "custom",
              wide: true,
              showWhen: (d) => d.waveformKind === "piecewise_linear",
              render: (ctx) => (
                <ControlledPiecewiseWaypointsEditor
                  points={ctx.draft.piecewisePoints}
                  onChange={(next) => ctx.setField("piecewisePoints", next)}
                  onParseErrorChange={setWaypointParseError}
                />
              ),
            },
          ],
        },
        {
          id: "drive-diagnostics",
          title: "Spectral & sampling diagnostics",
          icon: Activity,
          defaultOpen: false,
          rows: [
            {
              type: "readonly",
              label: "Estimated max frequency",
              mono: true,
              format: (d) =>
                `${(estimateFieldDriveMaxFrequencyHz(d) * 1e-9).toFixed(3)} GHz`,
            },
            {
              type: "readonly",
              label: "Output Nyquist frequency",
              mono: true,
              format: (d) => {
                const nyquistHz = resolveDraftNyquistHz(scene.data ?? null, d);
                return nyquistHz !== null
                  ? `${(nyquistHz * 1e-9).toFixed(3)} GHz`
                  : "No table cadence configured";
              },
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        allowCleanApply: (d) => !d.exists,
        cleanMessage: () => "Field drive matches committed SceneDocument",
        lockReason: () => lockReason,
        onApply: async (d) => {
          pendingNavigationRef.current = null;
          return handleApply(d);
        },
        onRevert: () => {
          setConflictNotice(null);
          setWaypointParseError(null);
        },
      },
    }),
    [
      baseline,
      conflictNotice,
      editable,
      existingIdsExcludingCurrent,
      handleApply,
      handleDelete,
      kernel.resources,
      lockReason,
      objectSelectOptions,
      regionSelectOptions,
      scene.data,
      setConflictNotice,
      setWaypointParseError,
      stageOptions,
    ],
  );

  const hostOptions = useMemo(
    () => ({
      onApplied: () => {
        if (pendingNavigationRef.current) {
          const target = pendingNavigationRef.current;
          pendingNavigationRef.current = null;
          kernel.selection.set(target, "inspector");
        }
      },
    }),
    [kernel.selection],
  );

  return (
    <SpecInspectorHost
      baseline={baseline}
      options={hostOptions}
      selection={selection}
      spec={spec}
    />
  );
}

/* ── Top-Level Router: Mask Antenna vs Regional Field Drive ── */

export function FieldDriveInspectorPanel({ selection }: InspectorPanelProps) {
  const regionalResource = useFieldDrivesResource();
  const maskResource = useMaskFieldDrivesResource();

  const driveRef =
    selection.ref?.type === "physics-field-drive" ? selection.ref : null;
  const explicitMask =
    driveRef?.fieldDriveKind === "mask" ||
    Boolean(selection.nodeId?.startsWith("model:physics:mask-antenna")) ||
    Boolean(selection.nodeId?.endsWith(":mask"));

  const isDraft = Boolean(driveRef?.draft) || Boolean(selection.nodeId?.includes(":draft"));
  const requestedId =
    driveRef?.fieldDriveId ??
    (!isDraft ? (selection.nodeId?.split(":").at(-1) ?? null) : null);

  const regionalIds = useMemo(
    () => new Set(extractDriveIds(regionalResource.data)),
    [regionalResource.data],
  );
  const maskIds = useMemo(
    () => new Set(extractDriveIds(maskResource.data)),
    [maskResource.data],
  );

  const isMask =
    explicitMask ||
    (!isDraft &&
      Boolean(requestedId) &&
      !regionalIds.has(requestedId!) &&
      maskIds.has(requestedId!));

  if (isMask) {
    return <FieldDriveMaskInspectorPanel selection={selection} />;
  }
  return <RegionalFieldDriveInspectorPanel selection={selection} />;
}
