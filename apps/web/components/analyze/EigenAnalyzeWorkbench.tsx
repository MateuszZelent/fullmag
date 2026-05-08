"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import DynamicEChart, { ECHARTS_THEME } from "../plots/DynamicEChart";
import type * as echarts from "echarts";
import type {
  AnyModeArtifact,
  AnySpectrumArtifact,
  EigenBranchesArtifact,
  EigenModeArtifactV2,
  EigenSelection,
} from "./eigenTypes";
import {
  buildModeKey,
  normalizeModeArtifact,
  normalizeSpectrumArtifact,
} from "./eigenTypes";
import {
  buildEigenDispersionTraces,
  buildEigenPathTickLabels,
  buildEigenSpectrumTrace,
  defaultEigenSelection,
  eigenGhz,
  eigenModeFromSelection,
  eigenSelectionFromDispersionCustomData,
  eigenSelectionFromSpectrumCustomData,
  selectedEigenBranch,
} from "./eigenWorkbenchModel";

export interface EigenAnalyzeWorkbenchProps {
  spectrum: AnySpectrumArtifact | null;
  branches?: EigenBranchesArtifact | null;
  modeLookup?: Record<string, AnyModeArtifact>;
  selection?: EigenSelection | null;
  onSelectionChange?: (selection: EigenSelection | null) => void;
  renderModeInspector?: (mode: EigenModeArtifactV2 | null) => React.ReactNode;
}

const C = {
  bg: "transparent",
  card: "rgba(12,18,30,0.65)",
  text: "rgba(228,236,248,0.94)",
  grid: "rgba(120,140,170,0.16)",
  border: "rgba(120,140,170,0.24)",
  selected: "#ffb86c",
  trace: "#8ec5ff",
  trace2: "#c3a6ff",
} as const;

export default function EigenAnalyzeWorkbench({
  spectrum,
  branches = null,
  modeLookup = {},
  selection: controlledSelection,
  onSelectionChange,
  renderModeInspector,
}: EigenAnalyzeWorkbenchProps) {
  const normalizedSpectrum = useMemo(() => normalizeSpectrumArtifact(spectrum), [spectrum]);
  const [internalSelection, setInternalSelection] = useState<EigenSelection | null>(
    defaultEigenSelection(normalizedSpectrum, branches),
  );
  const selection =
    controlledSelection === undefined ? internalSelection : controlledSelection;

  const updateSelection = (next: EigenSelection | null) => {
    setInternalSelection(next);
    onSelectionChange?.(next);
  };

  useEffect(() => {
    const nextDefault = defaultEigenSelection(normalizedSpectrum, branches);
    if (controlledSelection === undefined) {
      setInternalSelection(nextDefault);
    } else if (controlledSelection === null && nextDefault) {
      onSelectionChange?.(nextDefault);
    }
  }, [controlledSelection, normalizedSpectrum, branches, onSelectionChange]);

  const summaryMode = useMemo(
    () => eigenModeFromSelection(normalizedSpectrum, selection),
    [normalizedSpectrum, selection],
  );

  const selectedModeArtifact = useMemo(() => {
    if (!selection || selection.rawModeIndex == null) {
      return null;
    }
    const key = buildModeKey(selection.sampleIndex, selection.rawModeIndex);
    return normalizeModeArtifact(modeLookup[key] ?? null, selection.sampleIndex);
  }, [modeLookup, selection]);

  const currentBranch = useMemo(
    () => selectedEigenBranch(branches, selection),
    [branches, selection],
  );

  // Build ECharts options from the existing model functions
  const spectrumTraces = useMemo(() => {
    return buildEigenSpectrumTrace(normalizedSpectrum, selection, C);
  }, [normalizedSpectrum, selection]);

  const dispersionTraces = useMemo(() => {
    return buildEigenDispersionTraces(normalizedSpectrum, branches, selection, C);
  }, [branches, normalizedSpectrum, selection]);

  const pathTickLabels = useMemo(() => {
    return buildEigenPathTickLabels(normalizedSpectrum);
  }, [normalizedSpectrum]);

  // Spectrum ECharts option
  const spectrumOption = useMemo((): echarts.EChartsOption => {
    if (!spectrumTraces || spectrumTraces.length === 0) return {};

    const series: echarts.SeriesOption[] = spectrumTraces.map((trace: Record<string, unknown>) => {
      const traceMode = trace.mode as string;
      const traceType = traceMode === "markers" ? "scatter" as const : "line" as const;
      return {
        type: traceType,
        name: trace.name as string ?? "",
        data: (trace.x as number[])?.map((x: number, i: number) => ({
          value: [x, (trace.y as number[])?.[i]],
          _customdata: Array.isArray(trace.customdata) ? trace.customdata[i] : undefined,
        })) ?? [],
        lineStyle: trace.line ? { color: (trace.line as Record<string, unknown>).color as string, width: (trace.line as Record<string, unknown>).width as number } : undefined,
        itemStyle: trace.marker ? { color: Array.isArray((trace.marker as Record<string, unknown>).color) ? undefined : (trace.marker as Record<string, unknown>).color as string } : undefined,
        symbolSize: trace.marker ? (trace.marker as Record<string, unknown>).size as number ?? 6 : 6,
        showSymbol: traceMode === "markers",
        symbol: "circle",
      };
    });

    return {
      backgroundColor: C.bg,
      animation: false,
      grid: { left: 56, right: 16, top: 8, bottom: 44 },
      xAxis: {
        type: "value",
        name: "raw mode index",
        nameLocation: "middle",
        nameGap: 28,
        nameTextStyle: { color: C.text, fontSize: 11 },
        axisLine: { show: true, lineStyle: { color: C.border } },
        axisLabel: { color: C.text, fontSize: 10 },
        splitLine: { lineStyle: { color: C.grid } },
      },
      yAxis: {
        type: "value",
        name: "f (GHz)",
        nameLocation: "middle",
        nameGap: 38,
        nameTextStyle: { color: C.text, fontSize: 11 },
        axisLine: { show: true, lineStyle: { color: C.border } },
        axisLabel: { color: C.text, fontSize: 10 },
        splitLine: { lineStyle: { color: C.grid } },
      },
      tooltip: {
        trigger: "item",
        backgroundColor: ECHARTS_THEME.tooltipBg,
        borderColor: ECHARTS_THEME.tooltipBorder,
        borderWidth: 1,
        textStyle: { color: ECHARTS_THEME.tooltipText, fontSize: 11 },
      },
      series,
    };
  }, [spectrumTraces]);

  // Dispersion ECharts option
  const dispersionOption = useMemo((): echarts.EChartsOption | null => {
    if (!dispersionTraces || dispersionTraces.length === 0) return null;

    const series: echarts.SeriesOption[] = dispersionTraces.map((trace: Record<string, unknown>) => ({
      type: "line",
      name: trace.name as string ?? "",
      data: (trace.x as number[])?.map((x: number, i: number) => ({
        value: [x, (trace.y as number[])?.[i]],
        _customdata: Array.isArray(trace.customdata) ? trace.customdata[i] : undefined,
      })) ?? [],
      lineStyle: trace.line ? { color: (trace.line as Record<string, unknown>).color as string, width: (trace.line as Record<string, unknown>).width as number } : undefined,
      itemStyle: trace.marker ? { color: (trace.marker as Record<string, unknown>).color as string } : undefined,
      symbolSize: trace.marker ? (trace.marker as Record<string, unknown>).size as number ?? 6 : 6,
      showSymbol: true,
    }));

    return {
      backgroundColor: C.bg,
      animation: false,
      grid: { left: 56, right: 16, top: 8, bottom: 44 },
      xAxis: {
        type: "value",
        name: "path_s",
        nameLocation: "middle",
        nameGap: 28,
        nameTextStyle: { color: C.text, fontSize: 11 },
        axisLine: { show: true, lineStyle: { color: C.border } },
        axisLabel: {
          color: C.text,
          fontSize: 10,
          ...(pathTickLabels.length > 0 ? {
            formatter: (val: number) => {
              const tick = pathTickLabels.find((t) => Math.abs(t.value - val) < 1e-6);
              return tick?.label ?? "";
            },
          } : {}),
        },
        splitLine: { lineStyle: { color: C.grid } },
      },
      yAxis: {
        type: "value",
        name: "f (GHz)",
        nameLocation: "middle",
        nameGap: 38,
        nameTextStyle: { color: C.text, fontSize: 11 },
        axisLine: { show: true, lineStyle: { color: C.border } },
        axisLabel: { color: C.text, fontSize: 10 },
        splitLine: { lineStyle: { color: C.grid } },
      },
      tooltip: {
        trigger: "item",
        backgroundColor: ECHARTS_THEME.tooltipBg,
        borderColor: ECHARTS_THEME.tooltipBorder,
        borderWidth: 1,
        textStyle: { color: ECHARTS_THEME.tooltipText, fontSize: 11 },
      },
      legend: {
        type: "scroll",
        orient: "horizontal",
        bottom: 0,
        textStyle: { color: C.text, fontSize: 10 },
      },
      series,
    };
  }, [dispersionTraces, pathTickLabels]);

  const handleSpectrumClick = useCallback(
    (params: echarts.ECElementEvent) => {
      const data = params.data as { _customdata?: unknown } | undefined;
      const next = eigenSelectionFromSpectrumCustomData(
        data?._customdata,
        normalizedSpectrum,
        selection,
      );
      if (next) {
        updateSelection(next);
      }
    },
    [normalizedSpectrum, selection],
  );

  const handleDispersionClick = useCallback(
    (params: echarts.ECElementEvent) => {
      const data = params.data as { _customdata?: unknown } | undefined;
      const next = eigenSelectionFromDispersionCustomData(data?._customdata);
      if (next) {
        updateSelection(next);
      }
    },
    [],
  );

  if (!normalizedSpectrum) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-white/70">
        Brak artefaktu eigen spectrum.
      </div>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1.25fr,0.95fr]">
      <section className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-sm">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-white/90">Spectrum</div>
            <div className="text-xs text-white/50">
              sample {selection?.sampleIndex ?? 0}
              {summaryMode ? ` · mode ${summaryMode.raw_mode_index}` : ""}
              {selection?.branchId != null ? ` · branch ${selection.branchId}` : ""}
            </div>
          </div>
          <div className="text-[11px] text-white/45">
            solver: {normalizedSpectrum.solver_model}
          </div>
        </div>
        <div style={{ width: "100%", height: "var(--chart-height, 300px)" }}>
          <DynamicEChart
            option={spectrumOption}
            className="w-full h-full"
            onClick={handleSpectrumClick}
          />
        </div>

        {dispersionOption && (
          <div className="mt-5 rounded-xl border border-white/10 bg-black/10 p-3">
            <div className="mb-2 text-sm font-medium text-white/90">Dispersion / branches</div>
            <div style={{ width: "100%", height: "var(--chart-height, 300px)" }}>
              <DynamicEChart
                option={dispersionOption}
                className="w-full h-full"
                onClick={handleDispersionClick}
              />
            </div>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-sm">
        <div className="mb-3 text-sm font-medium text-white/90">Selected mode</div>
        <div className="grid gap-2 text-xs text-white/70 sm:grid-cols-2">
          <div className="rounded-lg border border-white/10 bg-black/10 p-3">
            <div className="text-white/45">sample</div>
            <div className="mt-1 font-medium text-white/90">{selection?.sampleIndex ?? "—"}</div>
          </div>
          <div className="rounded-lg border border-white/10 bg-black/10 p-3">
            <div className="text-white/45">branch</div>
            <div className="mt-1 font-medium text-white/90">{selection?.branchId ?? "—"}</div>
          </div>
          <div className="rounded-lg border border-white/10 bg-black/10 p-3">
            <div className="text-white/45">raw mode</div>
            <div className="mt-1 font-medium text-white/90">{selection?.rawModeIndex ?? "—"}</div>
          </div>
          <div className="rounded-lg border border-white/10 bg-black/10 p-3">
            <div className="text-white/45">frequency</div>
            <div className="mt-1 font-medium text-white/90">
              {summaryMode ? `${eigenGhz(summaryMode.frequency_real_hz).toFixed(4)} GHz` : "—"}
            </div>
          </div>
        </div>

        {currentBranch && (
          <div className="mt-4 rounded-lg border border-white/10 bg-black/10 p-3 text-xs text-white/70">
            <div className="mb-2 text-sm font-medium text-white/90">Branch diagnostics</div>
            <div>points: {currentBranch.points.length}</div>
            <div>
              avg confidence:{" "}
              {(
                currentBranch.points.reduce((acc, point) => acc + point.tracking_confidence, 0) /
                Math.max(currentBranch.points.length, 1)
              ).toFixed(3)}
            </div>
          </div>
        )}

        <div className="mt-4">
          {renderModeInspector ? (
            renderModeInspector(selectedModeArtifact)
          ) : selectedModeArtifact ? (
            <pre className="max-h-[28rem] overflow-auto rounded-lg border border-white/10 bg-black/20 p-3 text-[11px] text-white/70">
              {JSON.stringify(selectedModeArtifact, null, 2)}
            </pre>
          ) : (
            <div className="rounded-lg border border-dashed border-white/10 bg-black/10 p-4 text-sm text-white/50">
              Brak załadowanego artefaktu pola modu dla bieżącej selekcji.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
