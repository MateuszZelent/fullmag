import type {
  FieldDriveListResource,
  RegionalFieldDriveResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { ScientificEChartProps } from "@/shared/charts/ScientificEChart";

import { regionalFieldDriveSamplingContext } from "../../../panels/RegionalFieldDrivePanelModel";

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

export const UNSELECTED_OBJECT = "__select_object__";
export const UNSELECTED_REGION = "__select_region__";

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

export function buildFieldDrivePreviewChartOption(
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

export function normalizeRegionalListResource(
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

export function extractDriveIds(rawData: unknown): string[] {
  if (!rawData || typeof rawData !== "object") return [];
  const rec = rawData as { drives?: Array<{ id?: unknown }>; items?: Array<{ id?: unknown }> };
  const list = Array.isArray(rec.drives)
    ? rec.drives
    : Array.isArray(rec.items)
      ? rec.items
      : [];
  return list.flatMap((item) => (typeof item?.id === "string" ? [item.id] : []));
}

export function resolveStarterWaveformPreset(selection: Selection): FieldDriveWaveformKind | null {
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

export function draftActivationResource(
  draft: Pick<FieldDriveSpecDraft, "stageScopeKind" | "selectedStageIds">,
): DriveActivationResource {
  return draft.stageScopeKind === "stage_ids"
    ? { kind: "stage_ids", stage_ids: [...draft.selectedStageIds] }
    : { kind: "all_time_evolution" };
}

export function resolveDraftNyquistHz(
  scene: SceneResource | null,
  draft: Pick<FieldDriveSpecDraft, "stageScopeKind" | "selectedStageIds">,
): number | null {
  const sampling = regionalFieldDriveSamplingContext(scene, draftActivationResource(draft));
  const legacyStudyOutputDtS = asPositiveNumber(asRecord(scene?.study)?.output_dt_s);
  const samplePeriodS = sampling.samplePeriodS ?? legacyStudyOutputDtS;
  return samplePeriodS ? 1 / (2 * samplePeriodS) : null;
}

export function buildCanonicalRegionalResourceFromDraft(
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

export function hydrateRegionalDraftFromResource(
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
