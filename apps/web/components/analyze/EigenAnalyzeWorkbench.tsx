"use client";

import { useEffect, useMemo, useState } from "react";
import type { PlotMouseEvent } from "plotly.js";
import Plot from "../plots/DynamicPlot";
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

  const pathTickLabels = useMemo(() => {
    return buildEigenPathTickLabels(normalizedSpectrum);
  }, [normalizedSpectrum]);

  const spectrumTrace = useMemo(() => {
    return buildEigenSpectrumTrace(normalizedSpectrum, selection, C);
  }, [normalizedSpectrum, selection]);

  const dispersionTraces = useMemo(() => {
    return buildEigenDispersionTraces(normalizedSpectrum, branches, selection, C);
  }, [branches, normalizedSpectrum, selection]);

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
        <Plot
          data={spectrumTrace as Plotly.Data[]}
          layout={{
            paper_bgcolor: C.bg,
            plot_bgcolor: C.bg,
            margin: { l: 56, r: 16, t: 8, b: 44 },
            font: { color: C.text, size: 11 },
            xaxis: { title: { text: "raw mode index" }, gridcolor: C.grid },
            yaxis: { title: { text: "f (GHz)" }, gridcolor: C.grid },
            hovermode: "closest",
          }}
          config={{ responsive: true, displaylogo: false }}
          style={{ width: "100%", height: "var(--chart-height)" }}
          onClick={(event: Readonly<PlotMouseEvent>) => {
            const next = eigenSelectionFromSpectrumCustomData(
              event.points?.[0]?.customdata,
              normalizedSpectrum,
              selection,
            );
            if (next) {
              updateSelection(next);
            }
          }}
        />

        {dispersionTraces.length > 0 && (
          <div className="mt-5 rounded-xl border border-white/10 bg-black/10 p-3">
            <div className="mb-2 text-sm font-medium text-white/90">Dispersion / branches</div>
            <Plot
              data={dispersionTraces as Plotly.Data[]}
              layout={{
                paper_bgcolor: C.bg,
                plot_bgcolor: C.bg,
                margin: { l: 56, r: 16, t: 8, b: 44 },
                font: { color: C.text, size: 11 },
                xaxis: {
                  title: { text: "path_s" },
                  gridcolor: C.grid,
                  tickmode: pathTickLabels.length > 0 ? "array" : "auto",
                  tickvals: pathTickLabels.map((tick) => tick.value),
                  ticktext: pathTickLabels.map((tick) => tick.label),
                },
                yaxis: { title: { text: "f (GHz)" }, gridcolor: C.grid },
                hovermode: "closest",
                legend: { orientation: "h", y: -0.22 },
              }}
              config={{ responsive: true, displaylogo: false }}
              style={{ width: "100%", height: "var(--chart-height)" }}
              onClick={(event: Readonly<PlotMouseEvent>) => {
                const next = eigenSelectionFromDispersionCustomData(
                  event.points?.[0]?.customdata,
                );
                if (next) {
                  updateSelection(next);
                }
              }}
            />
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
