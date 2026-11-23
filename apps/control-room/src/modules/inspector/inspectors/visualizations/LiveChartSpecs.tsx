"use client";

import {
  Activity,
  Download,
  ExternalLink,
  LineChart,
  Radio,
  RotateCcw,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { KernelContext } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import type { ChartRangePreference } from "@/kernel/workspace/liveChartPreferences";
import { useLiveChartPreferencesHydration } from "@/kernel/workspace/useLiveChartPreferencesHydration";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { Switch } from "@/shared/ui/Switch";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorSpec } from "../../template";
import { ConnectedInspectorSpec } from "../../panels/study/ConnectedInspectorSpec";
import {
  buildLiveChartSeriesOptions,
  type ChartInspectorDraft,
  rangePreferenceFromMode,
  DEFAULT_CHART_DRAFT,
  type ChartPointPhysicalValues,
  type ResolvedPointReadout,
  inferAxisUnit,
  inferSeriesUnit,
  formatPhysicalTimeValue,
  formatPhysicalScalar,
  PointPhysicalReadoutCard,
} from "./chartInspectorShared";

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
