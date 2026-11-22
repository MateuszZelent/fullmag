"use client";

import {
  Activity,
  Copy,
  Download,
  ExternalLink,
  LineChart,
  Pin,
  PinOff,
  Radio,
  RotateCcw,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useCallback, useContext, useMemo, useState } from "react";

import { KernelContext } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { analysisWorkspaceStore } from "@/kernel/workspace/analysisWorkspace";
import type { AnalysisSurface } from "@/kernel/workspace/analysisViewPreferences";
import type { ChartRangePreference } from "@/kernel/workspace/liveChartPreferences";
import { quickChartWorkspaceStore } from "@/kernel/workspace/quickChartWorkspace";
import { useAnalysisViewPreferencesHydration } from "@/kernel/workspace/useAnalysisViewPreferencesHydration";
import { useAnalysisWorkspaceSelector } from "@/kernel/workspace/useAnalysisWorkspace";
import { useLiveChartPreferencesHydration } from "@/kernel/workspace/useLiveChartPreferencesHydration";
import { useQuickChartWorkspaceSelector } from "@/kernel/workspace/useQuickChartWorkspace";
import { QuickChartResourceView } from "@/shared/analysis-charts/QuickChartResourceView";
import {
  LIVE_CHART_PRESETS,
  isLiveChartPresetId,
  liveChartPreset,
  type LiveChartPresetId,
} from "@/shared/analysis-charts/liveChartPresets";
import { resolveLiveChartSelectedSeriesIds } from "@/shared/analysis-charts/liveChartSelection";
import { Button } from "@/shared/ui/Button";
import { Checkbox } from "@/shared/ui/Checkbox";
import { Input } from "@/shared/ui/Input";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { Switch } from "@/shared/ui/Switch";

import type { InspectorPanelProps } from "../inspectorTypes";
import type { InspectorSpec } from "../template";
import { ConnectedInspectorSpec } from "./study/ConnectedInspectorSpec";

export interface ChartPointPhysicalValues {
  readonly xSI: number;
  readonly xUnit: string;
  readonly ySI: number;
  readonly yUnit: string;
}

interface ResolvedPointReadout {
  readonly hasPhysicalX: boolean;
  readonly xSI: number | null;
  readonly xUnit: string;
  readonly hasPhysicalY: boolean;
  readonly ySI: number | null;
  readonly yUnit: string;
}

interface ChartInspectorDraft {
  presetId: string;
  windowMode: string;
  followTail: boolean;
}

const DEFAULT_CHART_DRAFT: ChartInspectorDraft = {
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

function formatPhysicalTimeValue(seconds: number, displayUnit: string): string {
  const scale = TIME_DISPLAY_SCALES[displayUnit] ?? 1e9;
  const scaled = seconds * scale;
  return Number(scaled.toPrecision(6)).toString();
}

function formatPhysicalScalar(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) >= 1e5 || (value !== 0 && Math.abs(value) < 1e-4)) {
    return value.toExponential(5);
  }
  return Number(value.toPrecision(6)).toString();
}

function inferAxisUnit(axisId: string | null | undefined): string {
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

function inferSeriesUnit(
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

function PointPhysicalReadoutCard({
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

function rangePreferenceFromMode(mode: string): ChartRangePreference {
  if (mode === "tailRows") return { mode: "tailRows", rows: 120 };
  if (mode === "tailTime") return { mode: "tailTime", durationS: 1e-9 };
  if (mode === "fullDecimated") return { mode: "fullDecimated" };
  return { mode: "follow" };
}

function buildLiveChartSeriesOptions(
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

/* ── 1. live.chart — Live Chart Inspector ────────────────────────────────── */

export function LiveChartTemplatePanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const ref = selection.ref?.type === "live-chart" ? selection.ref : null;
  const descriptorId = ref?.descriptorId ?? "magnetization";
  const presetId: LiveChartPresetId = isLiveChartPresetId(descriptorId)
    ? descriptorId
    : "custom";
  const preset = liveChartPreset(presetId);
  const preferences = useLiveChartPreferencesHydration(presetId);
  const descriptor = preferences.descriptor;

  const seriesOptions = useMemo(
    () => buildLiveChartSeriesOptions(presetId, descriptor?.selectedSeriesIds),
    [descriptor?.selectedSeriesIds, presetId],
  );
  const selectedSeriesIds = resolveLiveChartSelectedSeriesIds(
    descriptor?.selectedSeriesIds ?? preset.defaultSeriesIds,
    seriesOptions,
    preset.defaultSeriesIds,
  );
  const selectedSeriesIdSet = useMemo(
    () => new Set(selectedSeriesIds),
    [selectedSeriesIds],
  );

  const axisId = descriptor?.xAxisId ?? preset.xAxisId;
  const fixedFrom =
    descriptor?.range.mode === "fixed" ? descriptor.range.fromSI : null;
  const fixedTo =
    descriptor?.range.mode === "fixed" ? descriptor.range.toSI : null;

  const persistedRangeKey = `${presetId}:${axisId}:${fixedFrom ?? ""}:${fixedTo ?? ""}`;
  const [rangeDraft, setRangeDraft] = useState<{
    key: string;
    start: string | null;
    end: string | null;
  }>({ key: persistedRangeKey, start: null, end: null });
  const activeRangeDraft =
    rangeDraft.key === persistedRangeKey
      ? rangeDraft
      : { key: persistedRangeKey, start: null, end: null };
  const rangeStartText =
    activeRangeDraft.start ?? (fixedFrom !== null ? String(fixedFrom) : "0");
  const rangeEndText =
    activeRangeDraft.end ??
    (fixedTo !== null ? String(fixedTo) : axisId === "t" ? "1e-9" : "100");
  const [rangeError, setRangeError] = useState<string | null>(null);

  const executeLiveChartCommand = useCallback(
    (commandId: string, input?: Record<string, unknown>) => {
      if (!kernel) return;
      void kernel.commands.execute(
        commandId,
        createCommandContext("inspector", kernel, {
          sourceDetail: "live-chart-inspector",
        }),
        input,
      );
    },
    [kernel],
  );

  const handleApplyFixedRange = useCallback(() => {
    const fromSI = Number(rangeStartText);
    const toSI = Number(rangeEndText);
    if (!Number.isFinite(fromSI) || !Number.isFinite(toSI) || fromSI >= toSI) {
      setRangeError("Enter finite range bounds with start < end.");
      return;
    }
    setRangeError(null);
    executeLiveChartCommand("live-charts.set-range", {
      descriptorId: presetId,
      range: { mode: "fixed", fromSI, toSI },
    });
  }, [executeLiveChartCommand, presetId, rangeEndText, rangeStartText]);

  const handleClearRange = useCallback(() => {
    setRangeError(null);
    setRangeDraft({ key: persistedRangeKey, start: null, end: null });
    executeLiveChartCommand("live-charts.set-range", {
      descriptorId: presetId,
      range: { mode: "follow" },
    });
  }, [executeLiveChartCommand, persistedRangeKey, presetId]);

  const handleAfterFieldChange = useCallback(
    <K extends keyof ChartInspectorDraft & string>(
      key: K,
      value: ChartInspectorDraft[K],
    ) => {
      if (key === "presetId" && typeof value === "string") {
        executeLiveChartCommand("live-charts.set-preset", {
          descriptorId: value,
        });
      } else if (key === "followTail" && typeof value === "boolean") {
        executeLiveChartCommand("live-charts.set-live-mode", {
          descriptorId: presetId,
          liveMode: value ? "following" : "paused",
        });
      } else if (key === "windowMode" && typeof value === "string") {
        if (value === "fixed") return;
        executeLiveChartCommand("live-charts.set-range", {
          descriptorId: presetId,
          range: rangePreferenceFromMode(value),
        });
      }
    },
    [executeLiveChartCommand, presetId],
  );

  const windowMode = descriptor?.range.mode ?? "follow";
  const followTail = descriptor?.liveMode !== "paused";
  const presetSelectOptions = useMemo(
    () =>
      Object.values(LIVE_CHART_PRESETS).map((entry) => ({
        value: entry.id,
        label: entry.title,
      })),
    [],
  );

  const spec = useMemo<InspectorSpec<ChartInspectorDraft>>(
    () => ({
      id: `live.chart:${presetId}`,
      header: {
        breadcrumbs: [
          { id: "live", label: "Live Telemetry" },
          { id: "chart", label: selection.label || "Live Chart" },
        ],
        canFitView: true,
        fitCommandId: "live-charts.fit",
        ...(kernel
          ? {
              primaryHeaderAction: {
                label: "Open Live Charts",
                icon: ExternalLink,
                onRun: () => executeLiveChartCommand("live-charts.open"),
              },
              extraMenuActions: [
                {
                  id: "export-csv",
                  label: "Export CSV",
                  icon: Download,
                  onSelect: () =>
                    executeLiveChartCommand("live-charts.export.csv"),
                },
                {
                  id: "export-tsv",
                  label: "Export TSV",
                  icon: Download,
                  onSelect: () =>
                    executeLiveChartCommand("live-charts.export.tsv"),
                },
                {
                  id: "export-png",
                  label: "Export PNG",
                  icon: Download,
                  onSelect: () =>
                    executeLiveChartCommand("live-charts.export.png"),
                },
              ],
            }
          : {}),
      },
      identity: {
        domain: "study",
        icon: Radio,
        title: () => selection.label || `Live ${preset.title} chart`,
        kindLabel: "Streaming time-domain telemetry plot",
        entityId: descriptorId,
        statePill: (d) => ({
          tone: d.followTail ? "live" : "warn",
          label: d.followTail ? "Following" : "Paused",
        }),
      },
      facts: (d) => [
        { id: "preset", label: "Preset", value: d.presetId },
        { id: "window", label: "Window", value: d.windowMode },
        {
          id: "signals",
          label: "Signals",
          value: String(selectedSeriesIds.length),
        },
        { id: "xaxis", label: "X Axis", value: axisId },
      ],
      sections: [
        {
          id: "live-display",
          title: "Display",
          icon: Activity,
          defaultOpen: true,
          rows: [
            {
              type: "select",
              key: "presetId",
              label: "Preset",
              options: presetSelectOptions,
            },
            {
              type: "switch",
              key: "followTail",
              label: "Follow live solver tail",
            },
            {
              type: "select",
              key: "windowMode",
              label: "Time window",
              options: [
                ...(descriptor?.range.mode === "fixed"
                  ? [
                      {
                        value: "fixed",
                        label: "Selected range",
                        disabledReason: "Zoomed range active",
                      },
                    ]
                  : []),
                { value: "follow", label: "Follow tail" },
                { value: "tailRows", label: "Last 120 rows" },
                { value: "tailTime", label: "Last 1 ns" },
                { value: "fullDecimated", label: "Full, decimated" },
              ],
            },
            ...(descriptor?.range.mode === "fixed"
              ? [
                  {
                    type: "readonly" as const,
                    label: `Selected range (${descriptor.xAxisId})`,
                    format: () =>
                      `${descriptor.range.mode === "fixed" ? descriptor.range.fromSI.toPrecision(6) : ""} … ${descriptor.range.mode === "fixed" ? descriptor.range.toSI.toPrecision(6) : ""}`,
                  },
                ]
              : []),
            {
              type: "custom",
              label: `Step / axis range (${axisId})`,
              wide: true,
              render: () => (
                <div className="grid gap-2 text-xs">
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      aria-label={`Range start (${axisId})`}
                      placeholder="Start"
                      type="text"
                      value={rangeStartText}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setRangeDraft((prev) => ({
                          key: persistedRangeKey,
                          start: value,
                          end:
                            prev.key === persistedRangeKey ? prev.end : null,
                        }));
                      }}
                    />
                    <Input
                      aria-label={`Range end (${axisId})`}
                      placeholder="End"
                      type="text"
                      value={rangeEndText}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setRangeDraft((prev) => ({
                          key: persistedRangeKey,
                          start:
                            prev.key === persistedRangeKey ? prev.start : null,
                          end: value,
                        }));
                      }}
                    />
                  </div>
                  {rangeError ? (
                    <p className="text-xs text-fm-danger" role="alert">
                      {rangeError}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={handleApplyFixedRange}
                    >
                      Apply range
                    </Button>
                    <Button
                      disabled={descriptor?.range.mode !== "fixed"}
                      size="sm"
                      type="button"
                      variant="ghost"
                      onClick={handleClearRange}
                    >
                      <RotateCcw aria-hidden="true" size={13} />
                      <span>Clear range</span>
                    </Button>
                  </div>
                </div>
              ),
            },
            {
              type: "custom",
              label: "Signals",
              wide: true,
              render: () =>
                seriesOptions.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    {seriesOptions.map((series) => {
                      const checked = selectedSeriesIdSet.has(series.id);
                      return (
                        <label
                          className="flex items-center gap-2 text-xs"
                          key={series.id}
                        >
                          <Checkbox
                            aria-label={`Show ${series.quantity}`}
                            checked={checked}
                            onChange={() => {
                              const next = checked
                                ? selectedSeriesIds.filter(
                                    (id) => id !== series.id,
                                  )
                                : [...selectedSeriesIds, series.id];
                              executeLiveChartCommand(
                                "live-charts.set-selected-series",
                                {
                                  descriptorId: presetId,
                                  selectedSeriesIds: next,
                                },
                              );
                            }}
                          />
                          <span>{series.quantity}</span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-fm-muted">
                    Select signals from the chart legend.
                  </p>
                ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "liveViewport",
        hasOverrides: (d, b) =>
          JSON.stringify(d) !== JSON.stringify(b) ||
          descriptor?.range.mode === "fixed" ||
          descriptor?.liveMode === "paused",
        onResetDisplay: () => {
          const resetRange: ChartRangePreference = { mode: "follow" };
          executeLiveChartCommand("live-charts.set-live-mode", {
            descriptorId: presetId,
            liveMode: "following",
          });
          executeLiveChartCommand("live-charts.set-range", {
            descriptorId: presetId,
            range: resetRange,
          });
        },
      },
    }),
    [
      axisId,
      descriptor,
      descriptorId,
      executeLiveChartCommand,
      handleApplyFixedRange,
      handleClearRange,
      kernel,
      persistedRangeKey,
      preset.title,
      presetId,
      presetSelectOptions,
      rangeEndText,
      rangeError,
      rangeStartText,
      selectedSeriesIdSet,
      selectedSeriesIds,
      selection.label,
      seriesOptions,
    ],
  );

  return (
    <ConnectedInspectorSpec
      baseline={{
        ...DEFAULT_CHART_DRAFT,
        presetId,
        windowMode,
        followTail,
      }}
      selection={selection}
      spec={spec}
      onAfterFieldChange={handleAfterFieldChange}
    />
  );
}

/* ── 2. live.chart-point — Live Chart Point Inspector ────────────────────── */

export function LiveChartPointTemplatePanel({
  selection,
  testPointValues,
}: InspectorPanelProps & {
  testPointValues?: ChartPointPhysicalValues;
}) {
  const kernel = useContext(KernelContext);
  const pointRef =
    selection.ref?.type === "live-chart-point" ? selection.ref : null;
  const descriptorId = pointRef?.descriptorId ?? "magnetization";
  const presetId: LiveChartPresetId = isLiveChartPresetId(descriptorId)
    ? descriptorId
    : "custom";
  const preset = liveChartPreset(presetId);
  const preferences = useLiveChartPreferencesHydration(presetId);
  const descriptor = preferences.descriptor;

  const seriesOptions = useMemo(
    () => buildLiveChartSeriesOptions(presetId, descriptor?.selectedSeriesIds),
    [descriptor?.selectedSeriesIds, presetId],
  );
  const selectedSeriesIds = resolveLiveChartSelectedSeriesIds(
    descriptor?.selectedSeriesIds ?? preset.defaultSeriesIds,
    seriesOptions,
    preset.defaultSeriesIds,
  );
  const selectedSeriesIdSet = useMemo(
    () => new Set(selectedSeriesIds),
    [selectedSeriesIds],
  );

  const seriesLabel = pointRef?.seriesId ?? "m_y";
  const axisId = descriptor?.xAxisId ?? preset.xAxisId;

  const executeLiveChartCommand = useCallback(
    (commandId: string, input?: Record<string, unknown>) => {
      if (!kernel) return;
      void kernel.commands.execute(
        commandId,
        createCommandContext("inspector", kernel, {
          sourceDetail: "live-chart-point-inspector",
        }),
        input,
      );
    },
    [kernel],
  );

  // Never fabricate physical X/Y when the selection ref only carries pointIndex/revision.
  const resolvedReadout = useMemo<ResolvedPointReadout>(() => {
    if (testPointValues) {
      return {
        hasPhysicalX: true,
        xSI: testPointValues.xSI,
        xUnit: testPointValues.xUnit === "1" ? "" : testPointValues.xUnit,
        hasPhysicalY: true,
        ySI: testPointValues.ySI,
        yUnit: testPointValues.yUnit === "1" ? "" : testPointValues.yUnit,
      };
    }
    const rawRef = (selection.ref ?? {}) as Record<string, unknown>;
    const hasRefX =
      typeof rawRef.x === "number" && Number.isFinite(rawRef.x);
    const hasRefY =
      typeof rawRef.y === "number" && Number.isFinite(rawRef.y);
    const labelNumberMatch = selection.label?.match(
      /([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*$/i,
    );
    const parsedLabelY = labelNumberMatch
      ? Number(labelNumberMatch[1])
      : Number.NaN;
    const hasParsedY = Number.isFinite(parsedLabelY);

    return {
      hasPhysicalX: hasRefX,
      xSI: hasRefX ? (rawRef.x as number) : null,
      xUnit: inferAxisUnit(axisId),
      hasPhysicalY: hasRefY || hasParsedY,
      ySI: hasRefY ? (rawRef.y as number) : hasParsedY ? parsedLabelY : null,
      yUnit: inferSeriesUnit(seriesLabel, descriptor?.displayUnits),
    };
  }, [
    axisId,
    descriptor?.displayUnits,
    selection.label,
    selection.ref,
    seriesLabel,
    testPointValues,
  ]);

  const handleClearPointSelection = useCallback(() => {
    if (!kernel) return;
    const parentNodeId = `live:chart:${descriptorId}`;
    kernel.selection.set(
      {
        kind: "live.chart",
        label: "Live Chart",
        nodeId: parentNodeId,
        objectId: null,
        ref: {
          descriptorId,
          kind: "live.chart",
          nodeId: parentNodeId,
          type: "live-chart",
        },
      },
      "inspector",
    );
  }, [descriptorId, kernel]);

  const windowMode = descriptor?.range.mode ?? "follow";
  const followTail = descriptor?.liveMode !== "paused";
  const presetSelectOptions = useMemo(
    () =>
      Object.values(LIVE_CHART_PRESETS).map((entry) => ({
        value: entry.id,
        label: entry.title,
      })),
    [],
  );

  const spec = useMemo<InspectorSpec<ChartInspectorDraft>>(
    () => ({
      id: `live.chart-point:${descriptorId}:${pointRef?.pointIndex ?? 0}`,
      header: {
        breadcrumbs: [
          {
            id: "live",
            label: "Live Chart",
            selection: {
              kind: "live.chart",
              label: "Live Chart",
              nodeId: `live:chart:${descriptorId}`,
              objectId: null,
              ref: {
                descriptorId,
                kind: "live.chart",
                nodeId: `live:chart:${descriptorId}`,
                type: "live-chart",
              },
            },
          },
          { id: "chart", label: descriptorId },
          { id: "pt", label: `Point #${pointRef?.pointIndex ?? 0}` },
        ],
      },
      identity: {
        domain: "study",
        icon: Activity,
        title: () => `${seriesLabel} · Point #${pointRef?.pointIndex ?? 0}`,
        kindLabel: "Selected live-chart sample",
        entityId: descriptorId,
        statePill: () => ({ tone: "ok", label: "Selected point" }),
      },
      facts: () => [
        { id: "series", label: "Series", value: seriesLabel },
        {
          id: "idx",
          label: "Point",
          value: String(pointRef?.pointIndex ?? 0),
        },
        ...(pointRef?.revision !== undefined
          ? [
              {
                id: "rev",
                label: "Revision",
                value: String(pointRef.revision),
              },
            ]
          : []),
        ...(resolvedReadout.hasPhysicalX && resolvedReadout.xSI !== null
          ? [
              {
                id: "x",
                label: resolvedReadout.xUnit === "s" ? "Time t" : "X",
                value:
                  resolvedReadout.xUnit === "s"
                    ? `${formatPhysicalTimeValue(resolvedReadout.xSI, "ns")} ns`
                    : `${formatPhysicalScalar(resolvedReadout.xSI)}${resolvedReadout.xUnit ? ` ${resolvedReadout.xUnit}` : ""}`,
              },
            ]
          : []),
      ],
      sections: [
        {
          id: "selected-point",
          title: "Selected Point",
          icon: LineChart,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "Coordinate readout",
              wide: true,
              render: ({ notify }) => (
                <PointPhysicalReadoutCard
                  pointIndexLabel={`#${pointRef?.pointIndex ?? 0}`}
                  readout={resolvedReadout}
                  seriesLabel={seriesLabel}
                  onClearPoint={handleClearPointSelection}
                  onCopyPoint={(text) => {
                    void navigator?.clipboard?.writeText?.(text);
                    notify("Copied point coordinates", text);
                  }}
                />
              ),
            },
            {
              type: "readonly",
              label: "Descriptor",
              mono: true,
              format: () => descriptorId,
            },
            {
              type: "readonly",
              label: "Point",
              format: () => String(pointRef?.pointIndex ?? 0),
            },
            ...(pointRef?.revision !== undefined
              ? [
                  {
                    type: "readonly" as const,
                    label: "Revision",
                    format: () => String(pointRef.revision),
                  },
                ]
              : []),
          ],
        },
        {
          id: "live-point-display",
          title: "Display",
          icon: Radio,
          live: true,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "Preset",
              wide: true,
              render: () => (
                <Select
                  value={presetId}
                  onValueChange={(value) =>
                    executeLiveChartCommand("live-charts.set-preset", {
                      descriptorId: value,
                    })
                  }
                >
                  <SelectTrigger aria-label="Live Chart preset" density="compact">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {presetSelectOptions.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ),
            },
            {
              type: "custom",
              label: "Live updates",
              wide: true,
              render: () => (
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span>Follow live chart updates</span>
                  <Switch
                    aria-label="Follow live chart updates"
                    checked={followTail}
                    onCheckedChange={(following) =>
                      executeLiveChartCommand("live-charts.set-live-mode", {
                        descriptorId: presetId,
                        liveMode: following ? "following" : "paused",
                      })
                    }
                  />
                </div>
              ),
            },
            {
              type: "custom",
              label: "Window",
              wide: true,
              render: () => (
                <Select
                  value={windowMode}
                  onValueChange={(mode) => {
                    if (mode === "fixed") return;
                    executeLiveChartCommand("live-charts.set-range", {
                      descriptorId: presetId,
                      range: rangePreferenceFromMode(mode),
                    });
                  }}
                >
                  <SelectTrigger aria-label="Live Chart window" density="compact">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {descriptor?.range.mode === "fixed" ? (
                      <SelectItem disabled value="fixed">
                        Selected range
                      </SelectItem>
                    ) : null}
                    <SelectItem value="follow">Follow tail</SelectItem>
                    <SelectItem value="tailRows">Last 120 rows</SelectItem>
                    <SelectItem value="tailTime">Last 1 ns</SelectItem>
                    <SelectItem value="fullDecimated">Full, decimated</SelectItem>
                  </SelectContent>
                </Select>
              ),
            },
            ...(descriptor?.range.mode === "fixed"
              ? [
                  {
                    type: "readonly" as const,
                    label: `Selected range (${descriptor.xAxisId})`,
                    format: () =>
                      `${descriptor.range.mode === "fixed" ? descriptor.range.fromSI.toPrecision(6) : ""} … ${descriptor.range.mode === "fixed" ? descriptor.range.toSI.toPrecision(6) : ""}`,
                  },
                ]
              : []),
            ...(seriesOptions.length > 0
              ? [
                  {
                    type: "custom" as const,
                    label: "Signals",
                    wide: true,
                    render: () => (
                      <div className="flex flex-col gap-1.5">
                        {seriesOptions.map((series) => {
                          const checked = selectedSeriesIdSet.has(series.id);
                          return (
                            <label
                              className="flex items-center gap-2 text-xs"
                              key={series.id}
                            >
                              <Checkbox
                                aria-label={`Show ${series.quantity}`}
                                checked={checked}
                                onChange={() => {
                                  const next = checked
                                    ? selectedSeriesIds.filter(
                                        (id) => id !== series.id,
                                      )
                                    : [...selectedSeriesIds, series.id];
                                  executeLiveChartCommand(
                                    "live-charts.set-selected-series",
                                    {
                                      descriptorId: presetId,
                                      selectedSeriesIds: next,
                                    },
                                  );
                                }}
                              />
                              <span>{series.quantity}</span>
                            </label>
                          );
                        })}
                      </div>
                    ),
                  },
                ]
              : []),
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [
      descriptor,
      descriptorId,
      executeLiveChartCommand,
      followTail,
      handleClearPointSelection,
      pointRef,
      presetId,
      presetSelectOptions,
      resolvedReadout,
      selectedSeriesIdSet,
      selectedSeriesIds,
      seriesLabel,
      seriesOptions,
      windowMode,
    ],
  );

  return (
    <ConnectedInspectorSpec
      baseline={{ ...DEFAULT_CHART_DRAFT, presetId, windowMode, followTail }}
      selection={selection}
      spec={spec}
    />
  );
}

/* ── 3. analysis.chart — Analysis Chart Inspector ────────────────────────── */

const ANALYSIS_SURFACES: readonly {
  value: AnalysisSurface;
  label: string;
}[] = [
  { value: "dynamics", label: "Dynamics" },
  { value: "hysteresis", label: "Hysteresis" },
  { value: "resonance-fmr", label: "Resonance / FMR" },
  { value: "dispersion", label: "Dispersion" },
  { value: "comparison", label: "Comparison" },
];

export function AnalysisChartTemplatePanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const activeSurface = useAnalysisWorkspaceSelector(
    (state) => state.activeSurface,
  );
  const activeDescriptorId = useAnalysisWorkspaceSelector(
    (state) => state.activeDescriptorId,
  );
  const activeDescriptorSelectedSeriesIds = useAnalysisWorkspaceSelector(
    (state) => state.activeDescriptorSelectedSeriesIds,
  );
  const activeDescriptorDisplayUnits = useAnalysisWorkspaceSelector(
    (state) => state.activeDescriptorDisplayUnits,
  );
  const activeDescriptorRange = useAnalysisWorkspaceSelector(
    (state) => state.activeDescriptorRange,
  );
  const selectedDatasetRef = useAnalysisWorkspaceSelector(
    (state) => state.selectedDatasetRef,
  );
  const comparisonDatasetRef = useAnalysisWorkspaceSelector(
    (state) => state.comparisonDatasetRef,
  );
  const comparisonSelectedSeriesKeys = useAnalysisWorkspaceSelector(
    (state) => state.comparisonSelectedSeriesKeys,
  );
  const xAxisId = useAnalysisWorkspaceSelector((state) => state.xAxisId);
  const preferences = useAnalysisViewPreferencesHydration();

  const [axisScale, setAxisScale] = useState<"linear" | "log">("linear");

  const descriptorPreference = activeDescriptorId
    ? preferences.preferences.descriptorPreferences[activeDescriptorId]
    : undefined;
  const range = descriptorPreference?.range ?? activeDescriptorRange ?? null;
  const displayUnits = useMemo(
    () => ({
      ...activeDescriptorDisplayUnits,
      ...(descriptorPreference?.displayUnits ?? {}),
    }),
    [activeDescriptorDisplayUnits, descriptorPreference?.displayUnits],
  );

  const removeSingleSeries = useCallback(
    (seriesIdToRemove: string) => {
      if (!activeDescriptorId) return;
      const nextSeries = activeDescriptorSelectedSeriesIds.filter(
        (id) => id !== seriesIdToRemove,
      );
      preferences.setDescriptorPreference(activeDescriptorId, {
        displayUnits: descriptorPreference?.displayUnits ?? {},
        range: descriptorPreference?.range ?? null,
        selectedSeriesIds: nextSeries,
      });
      analysisWorkspaceStore.setActiveDescriptorSelection(
        activeDescriptorId,
        nextSeries,
      );
      if (activeSurface === "dynamics") {
        analysisWorkspaceStore.setChartState(xAxisId ?? "x", nextSeries);
      }
    },
    [
      activeDescriptorId,
      activeDescriptorSelectedSeriesIds,
      activeSurface,
      descriptorPreference,
      preferences,
      xAxisId,
    ],
  );

  const clearSelectedSeries = useCallback(() => {
    if (!activeDescriptorId) return;
    preferences.setDescriptorPreference(activeDescriptorId, {
      displayUnits: descriptorPreference?.displayUnits ?? {},
      range: descriptorPreference?.range ?? null,
      selectedSeriesIds: [],
    });
    analysisWorkspaceStore.setActiveDescriptorSelection(activeDescriptorId, []);
    if (activeSurface === "comparison") {
      analysisWorkspaceStore.setComparisonSelection([]);
    }
    if (activeSurface === "dynamics") {
      analysisWorkspaceStore.setChartState(xAxisId ?? "x", []);
    }
  }, [
    activeDescriptorId,
    activeSurface,
    descriptorPreference,
    preferences,
    xAxisId,
  ]);

  const resetAxisRange = useCallback(() => {
    if (!activeDescriptorId) return;
    preferences.setDescriptorPreference(activeDescriptorId, {
      displayUnits: descriptorPreference?.displayUnits ?? {},
      range: null,
      selectedSeriesIds:
        descriptorPreference?.selectedSeriesIds ??
        activeDescriptorSelectedSeriesIds,
    });
  }, [
    activeDescriptorId,
    activeDescriptorSelectedSeriesIds,
    descriptorPreference,
    preferences,
  ]);

  const clearReferenceCurves = useCallback(() => {
    analysisWorkspaceStore.clearComparisonSelection();
    analysisWorkspaceStore.setComparisonDatasetRef(null);
  }, []);

  const openAnalysisView = useCallback(() => {
    if (!kernel) return;
    void kernel.commands.execute(
      "analysis-plots.open",
      createCommandContext("inspector", kernel),
    );
  }, [kernel]);

  const pinQuickChart = useCallback(() => {
    if (!kernel) return;
    void kernel.commands.execute(
      "quick-chart.pin",
      createCommandContext("inspector", kernel),
    );
  }, [kernel]);

  const spec = useMemo<InspectorSpec<ChartInspectorDraft>>(
    () => ({
      id: `analysis.chart:${selection.nodeId ?? "chart"}`,
      header: {
        breadcrumbs: [
          { id: "analysis", label: "Analysis" },
          { id: "chart", label: selection.label || "Analysis Chart" },
        ],
        ...(kernel
          ? {
              primaryHeaderAction: {
                label: "Open Analysis View",
                icon: ExternalLink,
                onRun: openAnalysisView,
              },
              extraMenuActions: [
                {
                  id: "pin-quick-chart",
                  label: "Pin Quick Chart",
                  icon: Pin,
                  onSelect: pinQuickChart,
                },
                {
                  id: "export-analysis-csv",
                  label: "Export CSV",
                  icon: Download,
                  onSelect: () => {
                    void kernel.commands.execute(
                      "analysis-plots.export.csv",
                      createCommandContext("inspector", kernel),
                    );
                  },
                },
                {
                  id: "export-analysis-tsv",
                  label: "Export TSV",
                  icon: Download,
                  onSelect: () => {
                    void kernel.commands.execute(
                      "analysis-plots.export.tsv",
                      createCommandContext("inspector", kernel),
                    );
                  },
                },
                {
                  id: "export-analysis-png",
                  label: "Export PNG",
                  icon: Download,
                  onSelect: () => {
                    void kernel.commands.execute(
                      "analysis-plots.export.png",
                      createCommandContext("inspector", kernel),
                    );
                  },
                },
              ],
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: LineChart,
        title: () => selection.label || "Analysis Plot",
        kindLabel: "Dataset-backed scientific 2D plot",
        entityId: activeDescriptorId ?? undefined,
        statePill: () => ({ tone: "ok", label: activeSurface }),
      },
      facts: () => [
        { id: "surface", label: "Surface", value: activeSurface },
        { id: "xaxis", label: "X Axis", value: xAxisId ?? "—" },
        {
          id: "signals",
          label: "Signals",
          value: String(activeDescriptorSelectedSeriesIds.length),
        },
        { id: "source", label: "Source", value: selection.moduleSource },
      ],
      sections: [
        {
          id: "chart-series",
          title: "Axes, Scale & Active Signals",
          icon: LineChart,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "Analysis surface",
              wide: true,
              render: () => (
                <Select
                  value={activeSurface}
                  onValueChange={(next) =>
                    analysisWorkspaceStore.setActiveSurface(
                      next as AnalysisSurface,
                    )
                  }
                >
                  <SelectTrigger aria-label="Analysis surface" density="compact">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ANALYSIS_SURFACES.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ),
            },
            {
              type: "readonly",
              label: "Dataset",
              mono: true,
              format: () => selectedDatasetRef ?? "None selected",
            },
            {
              type: "readonly",
              label: "X axis",
              mono: true,
              format: () => xAxisId ?? "None selected",
            },
            {
              type: "custom",
              label: "Y axis scale",
              wide: true,
              render: () => (
                <SegmentedControl<"linear" | "log">
                  aria-label="Y axis scale"
                  columns={2}
                  options={[
                    { value: "linear", label: "Linear" },
                    { value: "log", label: "Logarithmic" },
                  ]}
                  value={axisScale}
                  onValueChange={setAxisScale}
                />
              ),
            },
            {
              type: "readonly",
              label: "Range",
              format: () =>
                range ? `${range.fromSI} – ${range.toSI}` : "Full dataset",
            },
            ...(Object.keys(displayUnits).length > 0
              ? [
                  {
                    type: "readonly" as const,
                    label: "Display units",
                    format: () =>
                      Object.entries(displayUnits)
                        .map(([k, u]) => `${k}: ${u}`)
                        .join(", "),
                  },
                ]
              : []),
            {
              type: "custom",
              label: "Selected series",
              wide: true,
              render: () => (
                <div className="grid gap-1.5 text-xs">
                  {activeDescriptorSelectedSeriesIds.length > 0 ? (
                    <ul className="grid gap-1">
                      {activeDescriptorSelectedSeriesIds.map((seriesId) => (
                        <li
                          className="flex items-center justify-between gap-2 rounded border border-fm-border px-2 py-1"
                          key={seriesId}
                        >
                          <span className="truncate font-mono">{seriesId}</span>
                          <Button
                            aria-label={`Remove series ${seriesId}`}
                            disabled={!activeDescriptorId}
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() => removeSingleSeries(seriesId)}
                          >
                            <X aria-hidden="true" size={12} />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-fm-muted">None</span>
                  )}
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <Button
                      disabled={
                        !activeDescriptorId ||
                        activeDescriptorSelectedSeriesIds.length === 0
                      }
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={clearSelectedSeries}
                    >
                      Clear selected series
                    </Button>
                    {range ? (
                      <Button
                        size="sm"
                        type="button"
                        variant="ghost"
                        onClick={resetAxisRange}
                      >
                        <RotateCcw aria-hidden="true" size={13} />
                        <span>Reset range</span>
                      </Button>
                    ) : null}
                    {kernel ? (
                      <Button
                        size="sm"
                        type="button"
                        variant="ghost"
                        onClick={openAnalysisView}
                      >
                        Open Analysis View
                      </Button>
                    ) : null}
                  </div>
                </div>
              ),
            },
          ],
        },
        {
          id: "reference-comparison-curves",
          title: "Reference & Comparison Curves",
          icon: SlidersHorizontal,
          defaultOpen:
            activeSurface === "comparison" ||
            Boolean(comparisonDatasetRef) ||
            comparisonSelectedSeriesKeys.length > 0,
          rows: [
            {
              type: "readonly",
              label: "Reference dataset",
              mono: true,
              format: () => comparisonDatasetRef ?? "None attached",
            },
            {
              type: "readonly",
              label: "Reference curves",
              format: () =>
                comparisonSelectedSeriesKeys.length > 0
                  ? comparisonSelectedSeriesKeys.join(", ")
                  : "None",
            },
            ...(comparisonDatasetRef || comparisonSelectedSeriesKeys.length > 0
              ? [
                  {
                    type: "custom" as const,
                    label: "Reference actions",
                    wide: true,
                    render: () => (
                      <Button
                        size="sm"
                        type="button"
                        variant="secondary"
                        onClick={clearReferenceCurves}
                      >
                        Clear reference curves
                      </Button>
                    ),
                  },
                ]
              : []),
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [
      activeDescriptorId,
      activeDescriptorSelectedSeriesIds,
      activeSurface,
      axisScale,
      clearReferenceCurves,
      clearSelectedSeries,
      comparisonDatasetRef,
      comparisonSelectedSeriesKeys,
      displayUnits,
      kernel,
      openAnalysisView,
      pinQuickChart,
      range,
      removeSingleSeries,
      resetAxisRange,
      selectedDatasetRef,
      selection.label,
      selection.moduleSource,
      selection.nodeId,
      xAxisId,
    ],
  );

  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_CHART_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

/* ── 4. analysis.chart-point — Analysis Chart Point Inspector ────────────── */

export function AnalysisChartPointTemplatePanel({
  selection,
  testPointValues,
}: InspectorPanelProps & {
  testPointValues?: ChartPointPhysicalValues;
}) {
  const kernel = useContext(KernelContext);
  const activeSurface = useAnalysisWorkspaceSelector(
    (state) => state.activeSurface,
  );
  const activeDescriptorId = useAnalysisWorkspaceSelector(
    (state) => state.activeDescriptorId,
  );
  const activeDescriptorSelectedSeriesIds = useAnalysisWorkspaceSelector(
    (state) => state.activeDescriptorSelectedSeriesIds,
  );
  const selectedDatasetRef = useAnalysisWorkspaceSelector(
    (state) => state.selectedDatasetRef,
  );
  const xAxisId = useAnalysisWorkspaceSelector((state) => state.xAxisId);
  const displayUnits = useAnalysisWorkspaceSelector(
    (state) => state.activeDescriptorDisplayUnits,
  );
  const preferences = useAnalysisViewPreferencesHydration();
  const descriptorPreference = activeDescriptorId
    ? preferences.preferences.descriptorPreferences[activeDescriptorId]
    : undefined;
  const range = descriptorPreference?.range ?? null;

  const pt =
    selection.ref?.type === "analysis-chart-point" ? selection.ref : null;
  const seriesLabel = pt?.quantity ?? pt?.seriesId ?? "signal";

  const readout = useMemo<ResolvedPointReadout>(() => {
    if (testPointValues) {
      return {
        hasPhysicalX: true,
        xSI: testPointValues.xSI,
        xUnit: testPointValues.xUnit === "1" ? "" : testPointValues.xUnit,
        hasPhysicalY: true,
        ySI: testPointValues.ySI,
        yUnit: testPointValues.yUnit === "1" ? "" : testPointValues.yUnit,
      };
    }
    return {
      hasPhysicalX: true,
      xSI: pt?.x ?? 0,
      xUnit: inferAxisUnit(xAxisId),
      hasPhysicalY: true,
      ySI: pt?.y ?? 0,
      yUnit: inferSeriesUnit(seriesLabel, displayUnits),
    };
  }, [displayUnits, pt, seriesLabel, testPointValues, xAxisId]);

  const clearSelectedSeries = useCallback(() => {
    if (!activeDescriptorId) return;
    preferences.setDescriptorPreference(activeDescriptorId, {
      displayUnits: descriptorPreference?.displayUnits ?? {},
      range: descriptorPreference?.range ?? null,
      selectedSeriesIds: [],
    });
    analysisWorkspaceStore.setActiveDescriptorSelection(activeDescriptorId, []);
    if (activeSurface === "comparison") {
      analysisWorkspaceStore.setComparisonSelection([]);
    }
    if (activeSurface === "dynamics") {
      analysisWorkspaceStore.setChartState(xAxisId ?? "x", []);
    }
  }, [
    activeDescriptorId,
    activeSurface,
    descriptorPreference,
    preferences,
    xAxisId,
  ]);

  const handleClearPointSelection = useCallback(() => {
    if (!kernel) return;
    if (pt?.tableId) {
      const parentNodeId = `analysis:charts:${pt.tableId}`;
      kernel.selection.set(
        {
          kind: "analysis.chart",
          label: "Analysis chart",
          nodeId: parentNodeId,
          objectId: null,
          ref: {
            chartId: pt.chartId,
            kind: "analysis.chart",
            nodeId: parentNodeId,
            tableId: pt.tableId,
            type: "analysis-chart",
          },
        },
        "inspector",
      );
      return;
    }
    kernel.selection.clear("inspector");
  }, [kernel, pt]);

  const spec = useMemo<InspectorSpec<ChartInspectorDraft>>(
    () => ({
      id: `analysis.chart-point:${selection.nodeId ?? "pt"}`,
      header: {
        breadcrumbs: [
          { id: "analysis", label: "Analysis" },
          { id: "chart", label: pt?.chartId ?? "Chart" },
          { id: "pt", label: `Row #${pt?.rowIndex ?? 0}` },
        ],
      },
      identity: {
        domain: "physics",
        icon: LineChart,
        title: () => `${seriesLabel} · Row #${pt?.rowIndex ?? 0}`,
        kindLabel: "Analysis plot data point",
        entityId: pt?.seriesId ?? undefined,
        statePill: () => ({ tone: "ok", label: "Selected" }),
      },
      facts: () => [
        { id: "series", label: "Quantity", value: seriesLabel },
        { id: "row", label: "Row", value: String(pt?.rowIndex ?? 0) },
        {
          id: "x",
          label: readout.xUnit === "s" ? "Time t" : "X",
          value:
            readout.xUnit === "s"
              ? `${formatPhysicalTimeValue(readout.xSI ?? 0, "ns")} ns`
              : `${formatPhysicalScalar(readout.xSI ?? 0)}${readout.xUnit ? ` ${readout.xUnit}` : ""}`,
        },
        {
          id: "y",
          label: "Y",
          value: `${formatPhysicalScalar(readout.ySI ?? 0)}${readout.yUnit ? ` ${readout.yUnit}` : ""}`,
        },
      ],
      sections: [
        {
          id: "analysis-point-readout",
          title: "Selected Point",
          icon: Activity,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "Coordinates",
              wide: true,
              render: ({ notify }) => (
                <PointPhysicalReadoutCard
                  readout={readout}
                  seriesLabel={seriesLabel}
                  onClearPoint={handleClearPointSelection}
                  onCopyPoint={(text) => {
                    void navigator?.clipboard?.writeText?.(text);
                    notify("Copied point coordinates", text);
                  }}
                />
              ),
            },
            {
              type: "readonly",
              label: "Series ID",
              mono: true,
              format: () => pt?.seriesId ?? seriesLabel,
            },
            {
              type: "readonly",
              label: "Row index",
              format: () => String(pt?.rowIndex ?? 0),
            },
            ...(pt?.tableId
              ? [
                  {
                    type: "readonly" as const,
                    label: "Source table",
                    mono: true,
                    format: () => pt.tableId ?? "—",
                  },
                ]
              : []),
          ],
        },
        {
          id: "analysis-parent-chart",
          title: "Analysis Chart",
          icon: LineChart,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Surface",
              format: () => activeSurface,
            },
            {
              type: "readonly",
              label: "Dataset",
              mono: true,
              format: () => selectedDatasetRef ?? "None selected",
            },
            {
              type: "readonly",
              label: "X axis",
              mono: true,
              format: () => xAxisId ?? "None selected",
            },
            {
              type: "readonly",
              label: "Range",
              format: () =>
                range ? `${range.fromSI} – ${range.toSI}` : "Full dataset",
            },
            {
              type: "readonly",
              label: "Series",
              format: () =>
                activeDescriptorSelectedSeriesIds.length > 0
                  ? activeDescriptorSelectedSeriesIds.join(", ")
                  : "None",
            },
            {
              type: "custom",
              label: "Series selection",
              wide: true,
              render: () => (
                <Button
                  disabled={
                    !activeDescriptorId ||
                    activeDescriptorSelectedSeriesIds.length === 0
                  }
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={clearSelectedSeries}
                >
                  Clear selected series
                </Button>
              ),
            },
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [
      activeDescriptorId,
      activeDescriptorSelectedSeriesIds,
      activeSurface,
      clearSelectedSeries,
      handleClearPointSelection,
      pt,
      range,
      readout,
      selectedDatasetRef,
      selection.nodeId,
      seriesLabel,
      xAxisId,
    ],
  );

  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_CHART_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

/* ── 5. results.quick_chart — Pinned Quick Chart Inspector ───────────────── */

export function QuickChartTemplatePanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const pinned = useQuickChartWorkspaceSelector((state) => state.pinned);
  const hasTableRuntime = Boolean(
    kernel &&
      typeof (kernel.resources as { subscribe?: unknown } | undefined)
        ?.subscribe === "function",
  );

  const pinnedObservables = useMemo(
    () =>
      (pinned?.selectedSeriesIds ?? []).map((seriesId) => {
        const columnId = seriesId.slice(seriesId.lastIndexOf(":") + 1);
        const unit =
          pinned?.displayUnits[columnId] ??
          pinned?.displayUnits[seriesId] ??
          inferSeriesUnit(columnId, pinned?.displayUnits);
        return { seriesId, columnId, unit };
      }),
    [pinned],
  );

  const handleOpenInAnalysis = useCallback(() => {
    if (pinned) {
      analysisWorkspaceStore.setActiveSurface("dynamics");
      analysisWorkspaceStore.setSelectedDatasetRef(pinned.tableId);
      if (kernel) {
        void kernel.commands.execute(
          "analysis-plots.open",
          createCommandContext("inspector", kernel, {
            sourceDetail: "quick-chart-inspector",
          }),
          {
            datasetRef: `table:${pinned.tableId}`,
            surface: "dynamics",
            tableId: pinned.tableId,
          },
        );
        return;
      }
    }
    if (kernel) {
      void kernel.commands.execute(
        "analysis-plots.open",
        createCommandContext("inspector", kernel, {
          sourceDetail: "quick-chart-inspector",
        }),
      );
    }
  }, [kernel, pinned]);

  const handleUnpinQuickChart = useCallback(() => {
    quickChartWorkspaceStore.clear();
    if (kernel) {
      void kernel.commands.execute(
        "quick-chart.unpin",
        createCommandContext("inspector", kernel, {
          sourceDetail: "quick-chart-inspector",
        }),
      );
    }
  }, [kernel]);

  const spec = useMemo<InspectorSpec<ChartInspectorDraft>>(
    () => ({
      id: `results.quick_chart:${selection.nodeId ?? "quick"}`,
      header: {
        breadcrumbs: [
          { id: "res", label: "Results" },
          { id: "quick", label: "Quick Chart" },
        ],
        ...(pinned
          ? {
              primaryHeaderAction: {
                label: "Open in Analysis",
                icon: ExternalLink,
                onRun: handleOpenInAnalysis,
              },
              extraMenuActions: [
                {
                  id: "unpin-quick-chart",
                  label: "Unpin Quick Chart",
                  icon: PinOff,
                  onSelect: handleUnpinQuickChart,
                },
              ],
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Pin,
        title: () =>
          pinned
            ? `Quick Chart · ${pinned.tableId}`
            : selection.label || "Quick Chart",
        kindLabel: "Pinned scalar table preview",
        entityId: pinned?.chartId,
        statePill: () =>
          pinned
            ? { tone: "ok", label: "Pinned" }
            : { tone: "neutral", label: "Unpinned" },
      },
      facts: () =>
        pinned
          ? [
              { id: "table", label: "Table", value: pinned.tableId },
              { id: "xaxis", label: "X Axis", value: pinned.xAxisId },
              {
                id: "series",
                label: "Columns",
                value: String(pinnedObservables.length),
              },
              {
                id: "range",
                label: "Range",
                value: pinned.range
                  ? `${formatPhysicalScalar(pinned.range.fromSI)}–${formatPhysicalScalar(pinned.range.toSI)}`
                  : "Full",
              },
            ]
          : [{ id: "mode", label: "Surface", value: "Store-driven preview" }],
      sections: [
        ...(pinned
          ? [
              {
                id: "quick-chart-details",
                title: "Pinned Observable & Column Details",
                icon: Activity,
                defaultOpen: true,
                rows: [
                  {
                    type: "readonly" as const,
                    label: "Chart ID",
                    mono: true,
                    format: () => pinned.chartId,
                  },
                  {
                    type: "readonly" as const,
                    label: "Source table",
                    mono: true,
                    format: () => pinned.tableId,
                  },
                  {
                    type: "readonly" as const,
                    label: "X axis column",
                    mono: true,
                    format: () => pinned.xAxisId,
                  },
                  {
                    type: "readonly" as const,
                    label: "Pinned columns",
                    format: () =>
                      pinnedObservables.length > 0
                        ? pinnedObservables
                            .map((entry) =>
                              entry.unit && entry.unit !== "1"
                                ? `${entry.columnId} (${entry.unit})`
                                : entry.columnId,
                            )
                            .join(", ")
                        : "None",
                  },
                  {
                    type: "custom" as const,
                    label: "Actions",
                    wide: true,
                    render: () => (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={handleOpenInAnalysis}
                        >
                          <ExternalLink aria-hidden="true" size={13} />
                          <span>Open in Analysis</span>
                        </Button>
                        <Button
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={handleUnpinQuickChart}
                        >
                          <PinOff aria-hidden="true" size={13} />
                          <span>Unpin Quick Chart</span>
                        </Button>
                      </div>
                    ),
                  },
                ],
              },
            ]
          : []),
        {
          id: "quick-chart-preview",
          title: "Pinned Quick Chart",
          icon: LineChart,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "Preview",
              wide: true,
              render: () =>
                hasTableRuntime ? (
                  <QuickChartResourceView />
                ) : (
                  <span className="text-xs text-fm-muted">
                    {pinned
                      ? `Pinned ${pinned.chartId} (${pinnedObservables.map((o) => o.columnId).join(", ") || "no series"})`
                      : "Pin a chart from Analysis to preview scalar signals here."}
                  </span>
                ),
            },
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [
      handleOpenInAnalysis,
      handleUnpinQuickChart,
      hasTableRuntime,
      pinned,
      pinnedObservables,
      selection.label,
      selection.nodeId,
    ],
  );

  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_CHART_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}
