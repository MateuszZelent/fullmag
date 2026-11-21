"use client";

import {
  Activity,
  Plus,
  Radio,
  Sliders,
  Trash2,
  Waves,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  MODEL_FIELD_DRIVES_PATH,
  MODEL_MASK_FIELD_DRIVES_PATH,
  MODEL_PHYSICS_GRAPH_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import type {
  FieldDriveCreateRequest,
  FieldDriveReplaceRequest,
  MaskFieldDriveCreateRequest,
  MaskFieldDriveReplaceRequest,
  MaskFieldDriveResource,
  MaskFunctionResource,
  MaskTermResource,
  RegionalFieldDriveResource,
} from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { useFieldDrivesResource } from "@/kernel/resources/fieldDriveResources";
import {
  publishCommittedSceneResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useMaskFieldDrivesResource } from "@/kernel/resources/maskAntennaResources";
import {
  ScientificEChart,
  type ResolvedChartThemePalette,
} from "@/shared/charts/ScientificEChart";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type {
  InspectorFact,
  InspectorNotice,
  InspectorSpec,
} from "../../template";
import {
  ANGLE_UNITS,
  buildRootSelection,
  fallbackRevision,
  FIELD_TESLA_UNITS,
  FREQUENCY_UNITS,
  LENGTH_UNITS,
  normalizeVector3,
  SpecInspectorHost,
  TIME_UNITS,
  vectorNorm,
} from "../model-roots/SpecInspectorHost";

/* ── Waveform & Spatial Mask Types ── */

export type FieldDriveWaveformKind =
  | "sinc_pulse"
  | "sinusoidal"
  | "gaussian_pulse"
  | "chirp"
  | "constant"
  | "piecewise_linear"
  | "custom_expression";

export type FieldDriveSpatialKind =
  | "uniform"
  | "sinc"
  | "gaussian"
  | "geometry_mask"
  | "mask_function";

export interface PiecewiseWaypointRow {
  readonly _rowId: string;
  readonly timeS: number;
  readonly scale: number;
}

export interface FieldDriveSpecDraft {
  driveId: string;
  driveFamily: "regional" | "mask";
  exists: boolean;
  name: string;
  enabled: boolean;
  targetScopeKey: string;
  amplitudeVecT: readonly [number, number, number];
  spatialKind: FieldDriveSpatialKind;
  spatialAxis: readonly [number, number, number];
  spatialPeriodM: number;
  spatialWidthM: number;
  spatialCenterM: number;
  spatialMaskExpr: string;
  waveformKind: FieldDriveWaveformKind;
  cutoffFreqHz: number;
  carrierFreqHz: number;
  chirpStopFreqHz: number;
  timeCenterS: number;
  pulseSigmaS: number;
  phaseRad: number;
  piecewisePoints: readonly PiecewiseWaypointRow[];
  waveformExpr: string;
  stageScopeKind: "all_dynamic" | "selected_stages";
  selectedStageIds: readonly string[];
  nyquistHz: number | null;
  preservedRaw: Record<string, unknown> | null;
}

let nextWaypointSeq = 1;
export function createPiecewiseWaypoint(
  timeS: number,
  scale: number,
  id?: string,
): PiecewiseWaypointRow {
  return {
    _rowId: id ?? `pw-pt-${nextWaypointSeq++}`,
    timeS,
    scale,
  };
}

/* ── Pure Waveform Sampler & Spectrum Estimator (Exported for Unit Tests) ── */

export function evaluateFieldDriveEnvelopeAtTime(
  draft: Pick<
    FieldDriveSpecDraft,
    | "waveformKind"
    | "cutoffFreqHz"
    | "carrierFreqHz"
    | "chirpStopFreqHz"
    | "timeCenterS"
    | "pulseSigmaS"
    | "phaseRad"
    | "piecewisePoints"
  >,
  tSec: number,
): number {
  switch (draft.waveformKind) {
    case "constant":
      return 1;
    case "sinusoidal":
      return Math.sin(2 * Math.PI * draft.carrierFreqHz * tSec + draft.phaseRad);
    case "sinc_pulse": {
      const x = 2 * Math.PI * draft.cutoffFreqHz * (tSec - draft.timeCenterS);
      return Math.abs(x) < 1e-12 ? 1 : Math.sin(x) / x;
    }
    case "gaussian_pulse": {
      const sigma = Math.max(draft.pulseSigmaS, 1e-15);
      const u = (tSec - draft.timeCenterS) / sigma;
      return (
        Math.exp(-0.5 * u * u) *
        Math.cos(2 * Math.PI * draft.carrierFreqHz * (tSec - draft.timeCenterS) + draft.phaseRad)
      );
    }
    case "chirp": {
      const span = Math.max(2 * draft.timeCenterS, 1e-12);
      const k = (draft.chirpStopFreqHz - draft.carrierFreqHz) / span;
      return Math.sin(
        2 * Math.PI * (draft.carrierFreqHz * tSec + 0.5 * k * tSec * tSec) + draft.phaseRad,
      );
    }
    case "piecewise_linear": {
      const pts = [...draft.piecewisePoints].sort((a, b) => a.timeS - b.timeS);
      if (pts.length === 0) return 0;
      if (tSec <= pts[0]!.timeS) return pts[0]!.scale;
      if (tSec >= pts.at(-1)!.timeS) return pts.at(-1)!.scale;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        if (tSec >= a.timeS && tSec <= b.timeS) {
          const dt = b.timeS - a.timeS;
          return dt <= 0 ? a.scale : a.scale + ((tSec - a.timeS) / dt) * (b.scale - a.scale);
        }
      }
      return 0;
    }
    default:
      return Math.sin(2 * Math.PI * draft.carrierFreqHz * tSec);
  }
}

export function estimateFieldDriveMaxFrequencyHz(
  draft: Pick<FieldDriveSpecDraft, "waveformKind" | "cutoffFreqHz" | "carrierFreqHz" | "chirpStopFreqHz" | "pulseSigmaS">,
): number {
  switch (draft.waveformKind) {
    case "sinc_pulse":
      return draft.cutoffFreqHz;
    case "sinusoidal":
      return draft.carrierFreqHz;
    case "chirp":
      return Math.max(draft.carrierFreqHz, draft.chirpStopFreqHz);
    case "gaussian_pulse":
      return draft.carrierFreqHz + 1 / (2 * Math.PI * Math.max(draft.pulseSigmaS, 1e-15));
    default:
      return 0;
  }
}

/* ── Live B(t) / |B(f)| Preview Widget (<ScientificEChart>) ── */

function FieldDriveWaveformPreview({ draft }: { draft: FieldDriveSpecDraft }) {
  const [chartDomain, setChartDomain] = useState<"time" | "spectrum">("time");
  const peakMt = vectorNorm(draft.amplitudeVecT) * 1e3;

  const { timeXsNs, timeYsMt, freqXsGhz, freqYsNorm } = useMemo(() => {
    const n = 96;
    const tMax = Math.max(2.5 * draft.timeCenterS, 2e-9);
    const tXs: number[] = [];
    const tYs: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * tMax;
      tXs.push(Number((t * 1e9).toFixed(3)));
      tYs.push(Number((peakMt * evaluateFieldDriveEnvelopeAtTime(draft, t)).toFixed(4)));
    }

    const fMaxGhz = Math.max(
      (estimateFieldDriveMaxFrequencyHz(draft) * 1.6) / 1e9,
      draft.nyquistHz ? (draft.nyquistHz * 1.25) / 1e9 : 25,
      10,
    );
    const m = 48;
    const fXs: number[] = [];
    const fYs: number[] = [];
    const dt = tMax / n;
    let maxMag = 1e-12;
    const rawMags: number[] = [];
    for (let k = 0; k <= m; k++) {
      const fHz = ((k / m) * fMaxGhz) * 1e9;
      fXs.push(Number((fHz / 1e9).toFixed(2)));
      let re = 0;
      let im = 0;
      for (let i = 0; i < n; i++) {
        const t = i * dt;
        const val = tYs[i]!;
        const ang = -2 * Math.PI * fHz * t;
        re += val * Math.cos(ang);
        im += val * Math.sin(ang);
      }
      const mag = Math.hypot(re, im);
      rawMags.push(mag);
      if (mag > maxMag) maxMag = mag;
    }
    for (const mag of rawMags) {
      fYs.push(Number((mag / maxMag).toFixed(4)));
    }
    return { timeXsNs: tXs, timeYsMt: tYs, freqXsGhz: fXs, freqYsNorm: fYs };
  }, [draft, peakMt]);

  const optionBuilder = useMemo(
    () => (palette: ResolvedChartThemePalette) => {
      if (chartDomain === "time") {
        return {
          grid: { left: 46, right: 12, top: 14, bottom: 26 },
          tooltip: { trigger: "axis" as const },
          xAxis: {
            type: "category" as const,
            data: timeXsNs,
            name: "t (ns)",
            nameLocation: "middle" as const,
            nameGap: 18,
          },
          yAxis: {
            type: "value" as const,
            name: "B (mT)",
          },
          series: [
            {
              type: "line" as const,
              smooth: false,
              showSymbol: false,
              data: timeYsMt,
              lineStyle: { color: palette.series[0], width: 1.75 },
              areaStyle: { color: palette.fieldBackground },
            },
          ],
        };
      }
      return {
        grid: { left: 46, right: 12, top: 14, bottom: 26 },
        tooltip: { trigger: "axis" as const },
        xAxis: {
          type: "category" as const,
          data: freqXsGhz,
          name: "f (GHz)",
          nameLocation: "middle" as const,
          nameGap: 18,
        },
        yAxis: {
          type: "value" as const,
          name: "|B(f)| / max",
          min: 0,
          max: 1.05,
        },
        series: [
          {
            type: "line" as const,
            smooth: true,
            showSymbol: false,
            data: freqYsNorm,
            lineStyle: { color: palette.series[1], width: 1.75 },
            areaStyle: { color: palette.fieldBackground },
          },
        ],
      };
    },
    [chartDomain, freqXsGhz, freqYsNorm, timeXsNs, timeYsMt],
  );

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2"
      data-slot="field-drive-preview"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-[var(--fm-text)]">
          Excitation preview ({peakMt.toFixed(2)} mT peak)
        </span>
        <SegmentedControl
          aria-label="Waveform preview domain"
          options={[
            { value: "time", label: "Time B(t)" },
            { value: "spectrum", label: "Spectrum |B(f)|" },
          ]}
          value={chartDomain}
          onValueChange={(next) => setChartDomain(next)}
        />
      </div>
      <ScientificEChart
        ariaLabel={
          chartDomain === "time"
            ? "Prescribed magnetic field waveform B(t) in milliTesla versus nanoseconds"
            : "Normalized Fourier amplitude spectrum |B(f)| versus frequency in gigahertz"
        }
        height={152}
        optionBuilder={optionBuilder}
      />
    </div>
  );
}

/* ── FieldDriveInspectorPanel (`physics.field-drive`) ── */

function extractDrivesList(resourceData: unknown): Record<string, unknown>[] {
  if (!resourceData || typeof resourceData !== "object") return [];
  const rec = resourceData as { drives?: unknown[]; items?: unknown[] };
  const arr = Array.isArray(rec.drives)
    ? rec.drives
    : Array.isArray(rec.items)
      ? rec.items
      : [];
  return arr as Record<string, unknown>[];
}

function asObjRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function FieldDriveInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const regionalDrives = useFieldDrivesResource();
  const maskDrives = useMaskFieldDrivesResource();

  const driveRef = selection.ref?.type === "physics-field-drive" ? selection.ref : null;
  const isDraftNew = Boolean(driveRef?.draft);
  const requestedKind = driveRef?.fieldDriveKind === "mask" ? "mask" : "regional";
  const requestedId =
    driveRef?.fieldDriveId ??
    (!isDraftNew ? selection.nodeId?.split(":").at(-1) ?? null : null);

  const matchedRegional = useMemo(() => {
    if (isDraftNew) return null;
    const list = extractDrivesList(regionalDrives.data);
    if (requestedId) {
      return list.find((d) => d.id === requestedId) ?? null;
    }
    return requestedKind === "regional" ? list[0] ?? null : null;
  }, [isDraftNew, regionalDrives.data, requestedId, requestedKind]);

  const matchedMask = useMemo(() => {
    if (isDraftNew || matchedRegional) return null;
    const list = extractDrivesList(maskDrives.data);
    if (requestedId) {
      return list.find((d) => d.id === requestedId) ?? null;
    }
    return requestedKind === "mask" ? list[0] ?? null : null;
  }, [isDraftNew, maskDrives.data, matchedRegional, requestedId, requestedKind]);

  const targetOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [
      { value: "global::", label: "Global domain (uniform / spatial mask)" },
    ];
    for (const obj of scene.data?.objects ?? []) {
      if (obj.role === "airbox" || obj.role === "air") continue;
      opts.push({
        value: `object::${obj.id}`,
        label: `${obj.name ?? obj.id} (whole object)`,
      });
      for (const reg of obj.regions ?? []) {
        opts.push({
          value: `region::${obj.id}::${reg.region_id}`,
          label: `${obj.name ?? obj.id} / ${reg.name ?? reg.region_id}`,
        });
      }
    }
    return opts;
  }, [scene.data?.objects]);

  const stageOptions = useMemo(() => {
    const studyRec = (scene.data?.study ?? null) as Record<string, unknown> | null;
    const stages = Array.isArray(studyRec?.stages)
      ? (studyRec.stages as Record<string, unknown>[])
      : [];
    return stages.map((st, idx) => {
      const id = String(st.id ?? `stage-${idx + 1}`);
      return { value: id, label: String(st.name ?? st.kind ?? id) };
    });
  }, [scene.data?.study]);

  const nyquistHz = useMemo(() => {
    const studyRec = (scene.data?.study ?? null) as Record<string, unknown> | null;
    const dtOut = typeof studyRec?.output_dt_s === "number" ? studyRec.output_dt_s : null;
    return dtOut && dtOut > 0 ? 1 / (2 * dtOut) : 25e9;
  }, [scene.data?.study]);

  const baseline = useMemo<FieldDriveSpecDraft>(() => {
    const raw = matchedRegional ?? matchedMask;
    const driveFamily: "regional" | "mask" = matchedMask
      ? "mask"
      : matchedRegional
        ? "regional"
        : requestedKind;
    const driveId = String(raw?.id ?? requestedId ?? "field-drive-1");
    const wf = asObjRecord(raw?.waveform);
    const sp = asObjRecord(raw?.spatial_profile);
    const target = asObjRecord(raw?.target);

    let targetScopeKey = "global::";
    if (target.kind === "region" && target.object_id && target.region_id) {
      targetScopeKey = `region::${String(target.object_id)}::${String(target.region_id)}`;
    } else if (target.kind === "object" && target.object_id) {
      targetScopeKey = `object::${String(target.object_id)}`;
    } else if (typeof raw?.object_id === "string") {
      targetScopeKey = `object::${raw.object_id}`;
    }

    const ampRaw: readonly [number, number, number] =
      typeof raw?.amplitude_B_T === "number" && Array.isArray(raw?.direction)
        ? [
            (Number(raw.direction[0]) || 0) * raw.amplitude_B_T,
            (Number(raw.direction[1]) || 0) * raw.amplitude_B_T,
            (Number(raw.direction[2]) || 0) * raw.amplitude_B_T,
          ]
        : Array.isArray(raw?.amplitude_t ?? raw?.polarization_t ?? raw?.field_t)
          ? ([
              Number(((raw?.amplitude_t ?? raw?.polarization_t ?? raw?.field_t) as unknown[])[0]) ||
                0,
              Number(((raw?.amplitude_t ?? raw?.polarization_t ?? raw?.field_t) as unknown[])[1]) ||
                0,
              Number(((raw?.amplitude_t ?? raw?.polarization_t ?? raw?.field_t) as unknown[])[2]) ||
                0,
            ] as const)
          : [0.002, 0, 0];

    const rawWfKind = String(wf.kind ?? "sinc_pulse");
    const waveformKind: FieldDriveWaveformKind =
      rawWfKind === "sinusoidal" ||
      rawWfKind === "gaussian_pulse" ||
      rawWfKind === "chirp" ||
      rawWfKind === "constant" ||
      rawWfKind === "piecewise_linear" ||
      rawWfKind === "custom_expression"
        ? rawWfKind
        : rawWfKind === "pulse"
          ? "gaussian_pulse"
          : "sinc_pulse";

    const rawSpKind = String(sp.kind ?? (driveFamily === "mask" ? "mask_function" : "uniform"));
    const spatialKind: FieldDriveSpatialKind =
      rawSpKind === "sinc" ||
      rawSpKind === "gaussian" ||
      rawSpKind === "geometry_mask" ||
      rawSpKind === "mask_function"
        ? rawSpKind
        : rawSpKind === "gaussian_plane_wave"
          ? "gaussian"
          : "uniform";

    const rawTerms = Array.isArray(raw?.terms) ? (raw.terms as Record<string, unknown>[]) : [];
    const firstTerm = rawTerms[0] ?? null;
    const firstMaskFn = asObjRecord(asObjRecord(firstTerm?.mask).function);
    const firstMaskOutputs = Array.isArray(firstMaskFn.outputs) ? firstMaskFn.outputs : [];
    const firstTimeFn = asObjRecord(firstTerm?.time);
    const firstTimeOutputs = Array.isArray(firstTimeFn.outputs) ? firstTimeFn.outputs : [];

    const rawPts = Array.isArray(wf.points) ? (wf.points as unknown[]) : null;
    const piecewisePoints: readonly PiecewiseWaypointRow[] =
      rawPts && rawPts.length >= 2
        ? rawPts.map((pt, idx) => {
            const pair = Array.isArray(pt) ? pt : [0, 0];
            return {
              _rowId: `pw-${driveId}-${idx}`,
              timeS: Number(pair[0]) || 0,
              scale: Number(pair[1]) || 0,
            };
          })
        : [
            createPiecewiseWaypoint(0, 0, "pw-0"),
            createPiecewiseWaypoint(0.2e-9, 1, "pw-1"),
            createPiecewiseWaypoint(1.0e-9, 1, "pw-2"),
            createPiecewiseWaypoint(1.2e-9, 0, "pw-3"),
          ];

    return {
      driveId,
      driveFamily,
      exists: Boolean(raw),
      name: String(raw?.name ?? selection.label ?? "Sinc Excitation Drive"),
      enabled: raw?.enabled !== false,
      targetScopeKey,
      amplitudeVecT: [
        Number(ampRaw[0]) || 0,
        Number(ampRaw[1]) || 0,
        Number(ampRaw[2]) || 0,
      ],
      spatialKind,
      spatialAxis: [1, 0, 0],
      spatialPeriodM:
        typeof sp.period_m === "number"
          ? sp.period_m
          : typeof sp.wavelength_m === "number"
            ? sp.wavelength_m
            : 200e-9,
      spatialWidthM:
        typeof sp.width_m === "number"
          ? sp.width_m
          : typeof sp.sigma_x_m === "number"
            ? sp.sigma_x_m
            : 100e-9,
      spatialCenterM:
        typeof sp.center_m === "number"
          ? sp.center_m
          : typeof sp.center_x_m === "number"
            ? sp.center_x_m
            : 0,
      spatialMaskExpr:
        typeof sp.expression === "string"
          ? sp.expression
          : typeof firstMaskOutputs[0] === "string"
            ? firstMaskOutputs[0]
            : "exp(-((x / 50e-9) ** 2))",
      waveformKind:
        typeof firstTimeOutputs[0] === "string" && !raw?.waveform
          ? "custom_expression"
          : waveformKind,
      cutoffFreqHz: typeof wf.cutoff_hz === "number" ? wf.cutoff_hz : 20e9,
      carrierFreqHz: typeof wf.frequency_hz === "number" ? wf.frequency_hz : 10e9,
      chirpStopFreqHz: typeof wf.stop_frequency_hz === "number" ? wf.stop_frequency_hz : 25e9,
      timeCenterS: typeof wf.t0 === "number" ? wf.t0 : 0.5e-9,
      pulseSigmaS: typeof wf.sigma_s === "number" ? wf.sigma_s : 0.1e-9,
      phaseRad: typeof wf.phase_rad === "number" ? wf.phase_rad : 0,
      piecewisePoints,
      waveformExpr:
        typeof wf.expression === "string"
          ? wf.expression
          : typeof firstTimeOutputs[0] === "string"
            ? firstTimeOutputs[0]
            : "sin(2 * pi * 10e9 * t)",
      stageScopeKind: "all_dynamic",
      selectedStageIds: [],
      nyquistHz,
      preservedRaw: raw,
    };
  }, [
    matchedMask,
    matchedRegional,
    nyquistHz,
    requestedId,
    requestedKind,
    selection.label,
  ]);

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
          { id: "drive", label: baseline.name },
        ],
        searchable: true,
        // Mandatory Delete Field Drive action backed by AlertDialog confirmation!
        ...(baseline.exists
          ? {
              deleteAction: {
                label: "Delete Field Drive",
                confirmTitle: (d) => `Delete field drive "${d.name}"?`,
                confirmDescription:
                  "Deleting this field drive permanently removes its spatial profile and B(t) excitation from the session model.",
                onDelete: async (ctx) => {
                  let deletedRev: number | undefined;
                  if (ctx.draft.driveFamily === "mask") {
                    const res = await kernel.api.model.deleteMaskFieldDrive(
                      ctx.draft.driveId,
                      { base_revision: scene.data?.revision ?? null },
                    );
                    deletedRev = res.scene_revision;
                    publishCommittedSceneResource(
                      kernel.resources,
                      res.committed_scene,
                      res.scene_revision,
                    );
                    kernel.resources.invalidate(
                      MODEL_MASK_FIELD_DRIVES_PATH,
                      res.scene_revision,
                    );
                  } else {
                    const res = await kernel.api.model.deleteFieldDrive(ctx.draft.driveId, {
                      base_revision: scene.data?.revision ?? null,
                    });
                    deletedRev = res.scene_revision;
                    publishCommittedSceneResource(
                      kernel.resources,
                      res.committed_scene,
                      res.scene_revision,
                    );
                    kernel.resources.invalidate(MODEL_FIELD_DRIVES_PATH, res.scene_revision);
                  }
                  kernel.resources.invalidate(
                    MODEL_PHYSICS_GRAPH_PATH,
                    fallbackRevision(deletedRev),
                  );
                  ctx.selectNode(
                    buildRootSelection(
                      "physics.field-drives",
                      "model:physics:field-drives",
                      "Field Drives",
                    ),
                  );
                },
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Radio,
        title: (d) => d.name,
        renameFieldKey: "name",
        kindLabel:
          baseline.driveFamily === "mask"
            ? "Spatial mask field drive"
            : "Regional magnetic field drive",
        entityId: baseline.driveId,
        statePill: (d) =>
          !d.exists
            ? { tone: "info", label: "New draft" }
            : d.enabled
              ? { tone: "ok", label: "Active" }
              : { tone: "degraded", label: "Disabled" },
      },
      facts: (d): readonly InspectorFact[] => {
        const fMax = estimateFieldDriveMaxFrequencyHz(d);
        return [
          {
            id: "b0",
            label: "Peak |B₀|",
            value: `${(vectorNorm(d.amplitudeVecT) * 1e3).toFixed(2)} mT`,
          },
          { id: "wf", label: "Waveform", value: d.waveformKind.replace(/_/g, " ") },
          {
            id: "fmax",
            label: "Bandwidth",
            value: fMax > 0 ? `${(fMax / 1e9).toFixed(1)} GHz` : "DC",
            tone: d.nyquistHz && fMax > d.nyquistHz ? "warn" : "ok",
          },
        ];
      },
      notices: (d): readonly InspectorNotice<FieldDriveSpecDraft>[] => {
        const fMax = estimateFieldDriveMaxFrequencyHz(d);
        if (d.nyquistHz && fMax > d.nyquistHz) {
          return [
            {
              id: "nyquist-aliasing-guard",
              tone: "warn",
              title: "Excitation exceeds output Nyquist frequency",
              text: `Drive bandwidth (${(fMax / 1e9).toFixed(1)} GHz) exceeds f_Nyq = ${(
                d.nyquistHz / 1e9
              ).toFixed(1)} GHz; decrease output Δt on Run stage or lower f_cut.`,
            },
          ];
        }
        return [];
      },
      sections: [
        {
          id: "fd-preview-waveform",
          title: "Temporal waveform B(t) & spectrum",
          icon: Waves,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => <FieldDriveWaveformPreview draft={ctx.draft} />,
            },
            {
              key: "name",
              type: "text",
              label: "Drive name",
              validate: (v) => (v.trim().length === 0 ? "Drive name is required." : null),
            },
            {
              key: "enabled",
              type: "switch",
              label: "Excitation enabled",
            },
            {
              key: "amplitudeVecT",
              type: "vector3",
              label: "Peak field vector",
              symbol: <>B<sub>0</sub></>,
              units: FIELD_TESLA_UNITS,
              defaultDisplayUnit: "mT",
              axisPresets: true,
              validate: (vec) =>
                vectorNorm(vec) < 1e-12
                  ? "Peak excitation amplitude vector B₀ must be non-zero."
                  : null,
            },
            {
              key: "waveformKind",
              type: "select",
              label: "Temporal waveform family",
              structural: true,
              options: [
                { value: "sinc_pulse", label: "Band-limited sinc pulse (broadband FMR / SW)" },
                { value: "sinusoidal", label: "Harmonic continuous wave sin(2πft + φ)" },
                { value: "gaussian_pulse", label: "Modulated Gaussian wavepacket" },
                { value: "chirp", label: "Linear frequency-swept chirp" },
                { value: "constant", label: "Static step / DC bias" },
                { value: "piecewise_linear", label: "Piecewise-linear envelope table" },
                { value: "custom_expression", label: "Analytic formula f(t)" },
              ],
            },
            {
              key: "cutoffFreqHz",
              type: "quantity",
              label: "Cutoff frequency",
              symbol: <>f<sub>cut</sub></>,
              units: FREQUENCY_UNITS,
              defaultDisplayUnit: "GHz",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.waveformKind === "sinc_pulse",
            },
            {
              key: "carrierFreqHz",
              type: "quantity",
              label: "Carrier / start frequency",
              symbol: <>f<sub>0</sub></>,
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
              key: "chirpStopFreqHz",
              type: "quantity",
              label: "Chirp stop frequency",
              symbol: <>f<sub>1</sub></>,
              units: FREQUENCY_UNITS,
              defaultDisplayUnit: "GHz",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.waveformKind === "chirp",
            },
            {
              key: "timeCenterS",
              type: "quantity",
              label: "Pulse center / delay time",
              symbol: <>t<sub>0</sub></>,
              units: TIME_UNITS,
              defaultDisplayUnit: "ns",
              min: 0,
              showWhen: (d) =>
                d.waveformKind === "sinc_pulse" ||
                d.waveformKind === "gaussian_pulse" ||
                d.waveformKind === "chirp",
            },
            {
              key: "pulseSigmaS",
              type: "quantity",
              label: "Gaussian RMS width",
              symbol: <>&sigma;<sub>t</sub></>,
              units: TIME_UNITS,
              defaultDisplayUnit: "ps",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.waveformKind === "gaussian_pulse",
            },
            {
              key: "phaseRad",
              type: "quantity",
              label: "Carrier phase",
              symbol: <>&phi;</>,
              units: ANGLE_UNITS,
              defaultDisplayUnit: "deg",
              showWhen: (d) =>
                d.waveformKind === "sinusoidal" ||
                d.waveformKind === "gaussian_pulse" ||
                d.waveformKind === "chirp",
            },
            {
              type: "custom",
              wide: true,
              showWhen: (d) => d.waveformKind === "piecewise_linear",
              render: (ctx) => (
                <div className="flex flex-col gap-1.5" data-slot="piecewise-waypoints">
                  {ctx.draft.piecewisePoints.map((pt, idx) => (
                    <div key={pt._rowId} className="flex items-center gap-1.5">
                      <span className="w-6 font-mono text-xs text-[var(--fm-text-muted)]">
                        P{idx + 1}
                      </span>
                      <Input
                        aria-label={`Waypoint ${idx + 1} time (ns)`}
                        defaultValue={String(Number((pt.timeS * 1e9).toFixed(4)))}
                        onBlur={(e) => {
                          const v = Number(e.currentTarget.value);
                          if (Number.isFinite(v)) {
                            ctx.setField(
                              "piecewisePoints",
                              ctx.draft.piecewisePoints.map((it) =>
                                it._rowId === pt._rowId ? { ...it, timeS: v * 1e-9 } : it,
                              ),
                            );
                          }
                        }}
                      />
                      <Input
                        aria-label={`Waypoint ${idx + 1} scale`}
                        defaultValue={String(pt.scale)}
                        onBlur={(e) => {
                          const v = Number(e.currentTarget.value);
                          if (Number.isFinite(v)) {
                            ctx.setField(
                              "piecewisePoints",
                              ctx.draft.piecewisePoints.map((it) =>
                                it._rowId === pt._rowId ? { ...it, scale: v } : it,
                              ),
                            );
                          }
                        }}
                      />
                      <Button
                        aria-label={`Remove waypoint ${idx + 1}`}
                        disabled={ctx.draft.piecewisePoints.length <= 2}
                        size="icon"
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          ctx.setField(
                            "piecewisePoints",
                            ctx.draft.piecewisePoints.filter((it) => it._rowId !== pt._rowId),
                          )
                        }
                      >
                        <Trash2 aria-hidden="true" size={12} />
                      </Button>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      const last = ctx.draft.piecewisePoints.at(-1);
                      ctx.setField("piecewisePoints", [
                        ...ctx.draft.piecewisePoints,
                        createPiecewiseWaypoint((last?.timeS ?? 0) + 0.5e-9, 0),
                      ]);
                    }}
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Add Waypoint</span>
                  </Button>
                </div>
              ),
            },
            {
              key: "waveformExpr",
              type: "expression",
              label: "Analytic temporal formula g(t)",
              allowedVariables: ["t", "pi"],
              showWhen: (d) => d.waveformKind === "custom_expression",
              validate: (v) => (v.trim().length === 0 ? "Waveform formula is required." : null),
            },
          ],
        },
        {
          id: "fd-spatial-mask",
          title: "Target scope & spatial excitation mask",
          icon: Activity,
          defaultOpen: true,
          rows: [
            {
              key: "targetScopeKey",
              type: "select",
              label: "Target domain / object / region",
              options: targetOptions,
            },
            {
              key: "spatialKind",
              type: "select",
              label: "Spatial envelope profile",
              structural: true,
              options: [
                { value: "uniform", label: "Uniform across target" },
                { value: "sinc", label: "Wavevector-selective sinc(2πx / λ)" },
                { value: "gaussian", label: "Localized Gaussian spot / strip" },
                { value: "geometry_mask", label: "3D antenna geometry mask" },
                { value: "mask_function", label: "Analytic spatial mask m(x, y, z)" },
              ],
            },
            {
              key: "spatialAxis",
              type: "vector3",
              label: "Wavevector / modulation axis",
              axisPresets: true,
              normalizeAction: true,
              showWhen: (d) => d.spatialKind === "sinc" || d.spatialKind === "gaussian",
            },
            {
              key: "spatialPeriodM",
              type: "quantity",
              label: "Spatial period (λ_min)",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.spatialKind === "sinc",
            },
            {
              key: "spatialWidthM",
              type: "quantity",
              label: "Envelope FWHM / spot width",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.spatialKind === "gaussian" || d.spatialKind === "sinc",
            },
            {
              key: "spatialCenterM",
              type: "quantity",
              label: "Spatial center coordinate",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              showWhen: (d) => d.spatialKind === "gaussian" || d.spatialKind === "sinc",
            },
            {
              key: "spatialMaskExpr",
              type: "expression",
              label: "Spatial mask expression f(x, y, z)",
              allowedVariables: ["x", "y", "z"],
              showWhen: (d) => d.spatialKind === "mask_function",
              validate: (v) =>
                v.trim().length === 0 ? "Spatial mask expression is required." : null,
            },
          ],
        },
        {
          id: "fd-stage-activation",
          title: "Study stage activation",
          icon: Sliders,
          defaultOpen: false,
          rows: [
            {
              key: "stageScopeKind",
              type: "segmented",
              label: "Active stages",
              structural: true,
              options: [
                { value: "all_dynamic", label: "All dynamic stages" },
                { value: "selected_stages", label: "Selected stages" },
              ],
            },
            {
              key: "selectedStageIds",
              type: "toggles",
              label: "Participating stages",
              showWhen: (d) =>
                d.stageScopeKind === "selected_stages" && stageOptions.length > 0,
              options: stageOptions,
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        cleanMessage: () => "Field drive matches committed SceneDocument",
        onApply: async (draft) => {
          type FieldTarget = RegionalFieldDriveResource["target"];
          type SpatialProfile = RegionalFieldDriveResource["spatial_profile"];
          type TimeDependence = RegionalFieldDriveResource["waveform"];
          type DriveActivation = RegionalFieldDriveResource["activation"];
          type TimeOrigin = RegionalFieldDriveResource["time_origin"];
          type MaskShape = MaskFieldDriveResource["shape"];
          type MaskFrame = MaskFieldDriveResource["frame"];

          const parts = draft.targetScopeKey.split("::");
          const target: FieldTarget =
            parts[0] === "region" && parts[1] && parts[2]
              ? { kind: "region", object_id: parts[1], region_id: parts[2] }
              : parts[0] === "object" && parts[1]
                ? { kind: "object", object_id: parts[1] }
                : { kind: "global" };

          const activation: DriveActivation =
            draft.stageScopeKind === "selected_stages" && draft.selectedStageIds.length > 0
              ? { kind: "stage_ids", stage_ids: [...draft.selectedStageIds] }
              : { kind: "all_time_evolution" };

          const rawOrigin = (draft.preservedRaw as { time_origin?: unknown } | null)?.time_origin;
          const time_origin: TimeOrigin = rawOrigin === "absolute" ? "absolute" : "stage_local";

          const routeToMask =
            draft.driveFamily === "mask" ||
            draft.waveformKind === "custom_expression" ||
            draft.spatialKind === "mask_function";

          let committedRev: number | undefined;
          if (routeToMask) {
            const rawShape = asObjRecord(draft.preservedRaw?.shape);
            const shape: MaskShape =
              rawShape.kind === "sphere" && typeof rawShape.radius === "number"
                ? {
                    kind: "sphere",
                    center: Array.isArray(rawShape.center)
                      ? rawShape.center.map((v) => Number(v) || 0)
                      : [0, 0, 0],
                    radius: rawShape.radius,
                  }
                : rawShape.kind === "cylinder" &&
                    typeof rawShape.radius === "number" &&
                    typeof rawShape.height === "number"
                  ? {
                      kind: "cylinder",
                      axis: Array.isArray(rawShape.axis)
                        ? rawShape.axis.map((v) => Number(v) || 0)
                        : [0, 0, 1],
                      center: Array.isArray(rawShape.center)
                        ? rawShape.center.map((v) => Number(v) || 0)
                        : [0, 0, 0],
                      height: rawShape.height,
                      radius: rawShape.radius,
                    }
                  : {
                      kind: "box",
                      center: Array.isArray(rawShape.center)
                        ? rawShape.center.map((v) => Number(v) || 0)
                        : [0, 0, 0],
                      size: Array.isArray(rawShape.size)
                        ? rawShape.size.map((v) => Number(v) || 1e-6)
                        : [1e-6, 1e-6, 1e-7],
                    };
            const rawPos = draft.preservedRaw?.position_m;
            const position_m: number[] = Array.isArray(rawPos)
              ? rawPos.map((v) => Number(v) || 0)
              : [0, 0, 0];
            const frame: MaskFrame =
              draft.preservedRaw?.frame === "world" ? "world" : "local";

            const spatialFactor =
              draft.spatialKind === "mask_function" ? draft.spatialMaskExpr.trim() : "1.0";
            const [bx, by, bz] = draft.amplitudeVecT;
            const timeFn: MaskFunctionResource | null =
              draft.waveformKind === "custom_expression"
                ? {
                    expression_version: "field_expr.v1",
                    outputs: [draft.waveformExpr.trim()],
                  }
                : null;
            const synthesizedTerms: MaskTermResource[] = [
              {
                mask: {
                  kind: "function",
                  function: {
                    expression_version: "field_expr.v1",
                    outputs: [
                      `(${bx}) * (${spatialFactor})`,
                      `(${by}) * (${spatialFactor})`,
                      `(${bz}) * (${spatialFactor})`,
                    ],
                  },
                },
                ...(timeFn ? { time: timeFn } : {}),
              },
            ];

            const maskDrive: MaskFieldDriveResource = {
              schema_version: "mask_field_drive.v1",
              id: draft.driveId,
              name: draft.name.trim(),
              enabled: draft.enabled,
              target,
              shape,
              position_m,
              frame,
              terms: synthesizedTerms,
              time_origin,
              activation,
            };
            const maskReq: MaskFieldDriveCreateRequest & MaskFieldDriveReplaceRequest = {
              base_revision: scene.data?.revision ?? null,
              drive: maskDrive,
            };
            const res =
              draft.exists && draft.driveFamily === "mask"
                ? await kernel.api.model.replaceMaskFieldDrive(draft.driveId, maskReq)
                : await kernel.api.model.createMaskFieldDrive(maskReq);
            committedRev = res.scene_revision;
            publishCommittedSceneResource(
              kernel.resources,
              res.committed_scene,
              res.scene_revision,
            );
            kernel.resources.invalidate(MODEL_MASK_FIELD_DRIVES_PATH, res.scene_revision);
          } else {
            let waveform: TimeDependence;
            switch (draft.waveformKind) {
              case "constant":
                waveform = { kind: "constant" };
                break;
              case "sinusoidal":
                waveform = {
                  kind: "sinusoidal",
                  frequency_hz: draft.carrierFreqHz,
                  phase_rad: draft.phaseRad,
                };
                break;
              case "piecewise_linear":
                waveform = {
                  kind: "piecewise_linear",
                  points: draft.piecewisePoints.map((p) => [p.timeS, p.scale]),
                };
                break;
              case "gaussian_pulse":
              case "chirp": {
                const sampleCount = 65;
                const tMax = Math.max(2.5 * draft.timeCenterS, 2e-9);
                const points: number[][] = [];
                for (let i = 0; i < sampleCount; i++) {
                  const t = (i / (sampleCount - 1)) * tMax;
                  points.push([t, evaluateFieldDriveEnvelopeAtTime(draft, t)]);
                }
                waveform = { kind: "piecewise_linear", points };
                break;
              }
              default:
                waveform = {
                  kind: "sinc_pulse",
                  cutoff_hz: draft.cutoffFreqHz,
                  t0: draft.timeCenterS,
                };
                break;
            }

            const spatial_profile: SpatialProfile =
              draft.spatialKind === "sinc"
                ? {
                    kind: "sinc",
                    axis: normalizeVector3(draft.spatialAxis, [1, 0, 0]),
                    period_m: draft.spatialPeriodM,
                    width_m: draft.spatialWidthM,
                    center_m: draft.spatialCenterM,
                  }
                : draft.spatialKind === "gaussian"
                  ? {
                      kind: "gaussian_plane_wave",
                      carrier_origin_x_m: 0,
                      carrier_phase_rad: 0,
                      center_x_m: draft.spatialCenterM,
                      center_y_m: 0,
                      sigma_x_m: draft.spatialWidthM,
                      sigma_y_m: draft.spatialWidthM,
                      wavelength_m: Math.max(draft.spatialPeriodM, 1e-7),
                    }
                  : draft.spatialKind === "geometry_mask"
                    ? {
                        kind: "geometry_mask",
                        object_id:
                          parts[1] || scene.data?.objects?.[0]?.id || "antenna-1",
                        envelope: { kind: "uniform" },
                      }
                    : { kind: "uniform" };

            const regionalDrive: RegionalFieldDriveResource = {
              id: draft.driveId,
              kind: "regional",
              name: draft.name.trim(),
              enabled: draft.enabled,
              amplitude_B_T: vectorNorm(draft.amplitudeVecT),
              direction: normalizeVector3(draft.amplitudeVecT, [1, 0, 0]),
              target,
              spatial_profile,
              waveform,
              time_origin,
              activation,
            };
            const regionalReq: FieldDriveCreateRequest & FieldDriveReplaceRequest = {
              base_revision: scene.data?.revision ?? null,
              drive: regionalDrive,
            };
            const res = draft.exists
              ? await kernel.api.model.replaceFieldDrive(draft.driveId, regionalReq)
              : await kernel.api.model.createFieldDrive(regionalReq);
            committedRev = res.scene_revision;
            publishCommittedSceneResource(
              kernel.resources,
              res.committed_scene,
              res.scene_revision,
            );
            kernel.resources.invalidate(MODEL_FIELD_DRIVES_PATH, res.scene_revision);
          }
          const finalRev = fallbackRevision(committedRev);
          kernel.resources.invalidate(MODEL_SCENE_PATH, finalRev);
          kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, finalRev);
          return true;
        },
      },
    }),
    [
      baseline.driveFamily,
      baseline.driveId,
      baseline.exists,
      baseline.name,
      kernel.api.model,
      kernel.resources,
      scene.data?.objects,
      scene.data?.revision,
      stageOptions,
      targetOptions,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
