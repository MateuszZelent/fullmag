"use client";

import { Copy, X } from "lucide-react";
import { useState } from "react";
import type { ChartRangePreference } from "@/kernel/workspace/liveChartPreferences";
import { liveChartPreset, type LiveChartPresetId } from "@/shared/analysis-charts/liveChartPresets";
import { Button } from "@/shared/ui/Button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";

export interface ChartPointPhysicalValues {
  readonly xSI: number;
  readonly xUnit: string;
  readonly ySI: number;
  readonly yUnit: string;
}

export interface ResolvedPointReadout {
  readonly hasPhysicalX: boolean;
  readonly xSI: number | null;
  readonly xUnit: string;
  readonly hasPhysicalY: boolean;
  readonly ySI: number | null;
  readonly yUnit: string;
}

export interface ChartInspectorDraft {
  presetId: string;
  windowMode: string;
  followTail: boolean;
}

export const DEFAULT_CHART_DRAFT: ChartInspectorDraft = {
  presetId: "magnetization",
  windowMode: "follow",
  followTail: true,
};

const TIME_DISPLAY_SCALES: Record<string, number> = {
  fs: 1e15,
  ps: 1e12,
  ns: 1e9,
  us: 1e6,
  ms: 1e3,
  s: 1,
};

export function formatPhysicalTimeValue(seconds: number, displayUnit: string): string {
  const scale = TIME_DISPLAY_SCALES[displayUnit] ?? 1e9;
  const scaled = seconds * scale;
  return Number(scaled.toPrecision(6)).toString();
}

export function formatPhysicalScalar(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) >= 1e5 || (value !== 0 && Math.abs(value) < 1e-4)) {
    return value.toExponential(5);
  }
  return Number(value.toPrecision(6)).toString();
}

export function inferAxisUnit(axisId: string | null | undefined): string {
  if (!axisId) return "s";
  const lower = axisId.toLowerCase();
  if (lower === "t" || lower === "time" || lower.endsWith("_s")) return "s";
  if (lower === "f" || lower.includes("freq") || lower.endsWith("_hz")) {
    return "Hz";
  }
  if (lower.endsWith("_ghz")) return "GHz";
  if (lower.endsWith("_mt")) return "mT";
  if (lower === "b" || lower.endsWith("_t")) return "T";
  if (lower === "step" || lower === "index") return "step";
  return "";
}

export function inferSeriesUnit(
  quantity: string | null | undefined,
  explicitUnits?: Readonly<Record<string, string>>,
): string {
  if (quantity && explicitUnits?.[quantity]) {
    const u = explicitUnits[quantity]!;
    return u === "1" ? "" : u;
  }
  if (!quantity) return "";
  const lower = quantity.toLowerCase();
  if (
    lower.startsWith("e_") ||
    lower === "energy" ||
    lower.includes("energies:") ||
    lower.endsWith("_j")
  ) {
    return "J";
  }
  if (lower.endsWith("_apm") || lower.endsWith("_a_per_m")) return "A/m";
  if (lower.includes("torque") && lower.endsWith("_mt")) return "mT";
  if (lower.endsWith("_hz")) return "Hz";
  if (lower.endsWith("_mt")) return "mT";
  if (lower.endsWith("_t")) return "T";
  return "";
}

export function PointPhysicalReadoutCard({
  onClearPoint,
  onCopyPoint,
  pointIndexLabel,
  readout,
  seriesLabel,
}: {
  onClearPoint: () => void;
  onCopyPoint: (text: string) => void;
  pointIndexLabel?: string;
  readout: ResolvedPointReadout;
  seriesLabel: string;
}) {
  const isTimeAxis = readout.hasPhysicalX && readout.xUnit === "s";
  const [timeUnit, setTimeUnit] = useState("ns");

  const formattedX =
    readout.hasPhysicalX && readout.xSI !== null
      ? isTimeAxis
        ? formatPhysicalTimeValue(readout.xSI, timeUnit)
        : formatPhysicalScalar(readout.xSI)
      : (pointIndexLabel ?? "—");

  const displayXUnit = isTimeAxis
    ? timeUnit
    : readout.xUnit && readout.xUnit !== "1"
      ? readout.xUnit
      : "";

  const formattedY =
    readout.hasPhysicalY && readout.ySI !== null
      ? formatPhysicalScalar(readout.ySI)
      : "—";
  const displayYUnit =
    readout.yUnit && readout.yUnit !== "1" ? readout.yUnit : "";

  const xWithUnit = displayXUnit
    ? `${formattedX} ${displayXUnit}`
    : formattedX;
  const yWithUnit = displayYUnit
    ? `${formattedY} ${displayYUnit}`
    : formattedY;

  return (
    <div
      className="grid gap-2 rounded border border-fm-border p-2.5 text-xs"
      data-slot="chart-point-physical-readout"
    >
      <div className="flex items-center justify-between gap-2 tabular-nums">
        <span className="text-fm-muted">
          {readout.hasPhysicalX
            ? `X (${isTimeAxis ? "Time t" : "Axis"})`
            : "Sample"}
        </span>
        <div className="flex items-center gap-1.5">
          <span className="font-mono font-semibold">{formattedX}</span>
          {isTimeAxis ? (
            <div className="w-20">
              <Select value={timeUnit} onValueChange={setTimeUnit}>
                <SelectTrigger
                  aria-label="Point X time unit"
                  density="compact"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fs">fs</SelectItem>
                  <SelectItem value="ps">ps</SelectItem>
                  <SelectItem value="ns">ns</SelectItem>
                  <SelectItem value="us">us</SelectItem>
                  <SelectItem value="ms">ms</SelectItem>
                  <SelectItem value="s">s</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : displayXUnit ? (
            <span className="text-fm-muted">{displayXUnit}</span>
          ) : null}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 tabular-nums">
        <span className="text-fm-muted">Y ({seriesLabel})</span>
        <span className="font-mono font-semibold">{yWithUnit}</span>
      </div>

      {readout.hasPhysicalX && readout.hasPhysicalY ? (
        <div className="flex items-center justify-between gap-2 border-t border-fm-border pt-1.5 tabular-nums">
          <span className="text-fm-muted">Physical (X, Y)</span>
          <span className="font-mono">
            ({xWithUnit}, {yWithUnit})
          </span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => onCopyPoint(`${xWithUnit}, ${yWithUnit}`)}
        >
          <Copy aria-hidden="true" size={13} />
          <span>Copy Point</span>
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={onClearPoint}
        >
          <X aria-hidden="true" size={13} />
          <span>Clear point selection</span>
        </Button>
      </div>
    </div>
  );
}

export function rangePreferenceFromMode(mode: string): ChartRangePreference {
  if (mode === "tailRows") return { mode: "tailRows", rows: 120 };
  if (mode === "tailTime") return { mode: "tailTime", durationS: 1e-9 };
  if (mode === "fullDecimated") return { mode: "fullDecimated" };
  return { mode: "follow" };
}

export function buildLiveChartSeriesOptions(
  presetId: LiveChartPresetId,
  persistedSeriesIds: readonly string[] | undefined,
): readonly { id: string; quantity: string }[] {
  const preset = liveChartPreset(presetId);
  const merged =
    preset.defaultSeriesIds.length > 0
      ? [
          ...new Set([
            ...preset.defaultSeriesIds,
            ...(persistedSeriesIds ?? []),
          ]),
        ]
      : [...(persistedSeriesIds ?? [])];
  return merged.map((id) => ({
    id,
    quantity: id.split(":").at(-1) ?? id,
  }));
}
