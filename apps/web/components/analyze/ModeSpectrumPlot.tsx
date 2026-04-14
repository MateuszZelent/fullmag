"use client";

import { useMemo } from "react";
import Plot from "../plots/DynamicPlot";

import type { EigenModeSummary } from "./eigenTypes";


const C = {
  bg: "transparent",
  text: "rgba(225,232,245,0.9)",
  grid: "rgba(120,140,170,0.16)",
  stem: "rgba(76,110,245,0.38)",
  stemSel: "rgba(255,184,108,0.7)",
  sel: "#ffb86c",
  hovBg: "rgba(10,16,28,0.96)",
  hovBorder: "rgba(132,156,240,0.55)",
} as const;

/** Marker color keyed by dominant polarization label emitted by the solver. */
const POL_COLOR: Record<string, string> = {
  ip: "#8ec5ff",
  in_plane: "#8ec5ff",
  op: "#c3a6ff",
  out_of_plane: "#c3a6ff",
  z: "#6ee7b7",
  uniform: "#f9a8d4",
  mixed: "#fcd34d",
  default: "#9cc0ff",
};

function polColor(pol: string): string {
  const key = pol.toLowerCase().replace(/[\s-]/g, "_");
  return POL_COLOR[key] ?? POL_COLOR.default;
}

/** Compact legend pills rendered via Plotly annotations */
function buildLegendAnnotations(): Partial<Plotly.Annotations>[] {
  const entries: [string, string][] = [
    ["ip", "#8ec5ff"],
    ["op", "#c3a6ff"],
    ["z", "#6ee7b7"],
    ["mixed", "#fcd34d"],
  ];
  return entries.map(([label, color], i) => ({
    x: 0 + i * 0.18,
    y: 1.065,
    xref: "paper" as const,
    yref: "paper" as const,
    text: `<span style="color:${color}">●</span> ${label}`,
    showarrow: false,
    font: { size: 9.5, color: "rgba(200,210,230,0.6)", family: "ui-monospace, Menlo, Consolas, monospace" },
    xanchor: "left" as const,
    yanchor: "bottom" as const,
  }));
}

interface ModeSpectrumPlotProps {
  modes: EigenModeSummary[];
  selectedMode: number | null;
  onSelectMode?: (modeIndex: number) => void;
}

function toFrequencyGHz(valueHz: number): number {
  return valueHz / 1e9;
}

export default function ModeSpectrumPlot({
  modes,
  selectedMode,
  onSelectMode,
}: ModeSpectrumPlotProps) {
  const plotData = useMemo(() => {
    const normalStemX: (number | null)[] = [];
    const normalStemY: (number | null)[] = [];
    const selStemX: (number | null)[] = [];
    const selStemY: (number | null)[] = [];

    for (const mode of modes) {
      const fGHz = toFrequencyGHz(mode.frequency_hz);
      if (mode.index === selectedMode) {
        selStemX.push(mode.index, mode.index, null);
        selStemY.push(0, fGHz, null);
      } else {
        normalStemX.push(mode.index, mode.index, null);
        normalStemY.push(0, fGHz, null);
      }
    }

    const markerX = modes.map((m) => m.index);
    const markerY = modes.map((m) => toFrequencyGHz(m.frequency_hz));
    const customData = modes.map((m) => m.index);
    const hoverText = modes.map(
      (m) =>
        `<b>Mode ${m.index}</b>  ${(m.frequency_hz / 1e9).toFixed(4)} GHz` +
        `<br>pol: ${m.dominant_polarization}` +
        `<br>max amp: ${m.max_amplitude.toExponential(2)}` +
        (m.k_vector
          ? `<br>k: (${m.k_vector.map((v) => v.toExponential(1)).join(", ")})`
          : "<br>k: Γ"),
    );

    const traces: Partial<Plotly.PlotData>[] = [
      // Normal stem lines
      {
        x: normalStemX,
        y: normalStemY,
        type: "scatter",
        mode: "lines",
        hoverinfo: "skip",
        line: { color: C.stem, width: 1 },
        showlegend: false,
      },
      // Selected stem (highlighted)
      {
        x: selStemX,
        y: selStemY,
        type: "scatter",
        mode: "lines",
        hoverinfo: "skip",
        line: { color: C.stemSel, width: 2.5 },
        showlegend: false,
      },
      // All mode markers
      {
        x: markerX,
        y: markerY,
        type: "scatter",
        mode: "markers",
        name: "Modes",
        customdata: customData as Plotly.Datum[],
        text: hoverText,
        hovertemplate: "%{text}<extra></extra>",
        marker: {
          color: modes.map((m) =>
            m.index === selectedMode ? C.sel : polColor(m.dominant_polarization),
          ),
          size: modes.map((m) => (m.index === selectedMode ? 14 : 9)),
          line: { color: "rgba(8,12,24,0.5)", width: 1 },
          symbol: "circle",
        },
        showlegend: false,
      },
    ];

    return traces;
  }, [modes, selectedMode]);

  const tickVals = modes.length <= 32 ? modes.map((m) => m.index) : undefined;

  const layout = useMemo(
    (): Partial<Plotly.Layout> => ({
      paper_bgcolor: C.bg,
      plot_bgcolor: C.bg,
      margin: { l: 60, r: 20, t: 36, b: 52 },
      font: {
        family: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        size: 11,
        color: C.text,
      },
      xaxis: {
        title: { text: "Mode index", standoff: 6, font: { size: 10.5 } },
        color: C.text,
        gridcolor: C.grid,
        zeroline: false,
        tickmode: tickVals ? "array" : "auto",
        tickvals: tickVals,
        tickfont: { size: 10 },
      },
      yaxis: {
        title: { text: "f (GHz)", standoff: 6, font: { size: 10.5 } },
        color: C.text,
        gridcolor: C.grid,
        zeroline: false,
        rangemode: "nonnegative",
        tickfont: { size: 10 },
      },
      hovermode: "closest",
      dragmode: "pan",
      hoverlabel: {
        bgcolor: C.hovBg,
        bordercolor: C.hovBorder,
        font: { color: "#eef4ff", size: 12 },
        align: "left",
      },
      modebar: { bgcolor: "transparent", color: C.text, activecolor: C.sel },
      annotations: [
        ...buildLegendAnnotations(),
        {
          x: 1,
          y: 1.065,
          xref: "paper",
          yref: "paper",
          text: `${modes.length} modes`,
          showarrow: false,
          font: { size: 9.5, color: "rgba(190,205,230,0.45)" },
          xanchor: "right",
          yanchor: "bottom",
        },
      ],
    }),
     
    [modes.length, tickVals],
  );

  const config = useMemo(
    (): Partial<Plotly.Config> => ({
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: [
        "lasso2d",
        "select2d",
        "hoverClosestCartesian",
        "hoverCompareCartesian",
        "sendDataToCloud",
      ],
      toImageButtonOptions: {
        format: "png",
        filename: "fullmag_eigen_spectrum",
        scale: 2,
      },
    }),
    [],
  );

  return (
    <Plot
      data={plotData}
      layout={layout}
      config={config}
      useResizeHandler
      className="h-full w-full"
      style={{ width: "100%", height: "100%" }}
      onClick={(event: Readonly<Plotly.PlotMouseEvent>) => {
        const cd = event.points?.[0]?.customdata;
        if (typeof cd === "number") {
          onSelectMode?.(cd);
        }
      }}
    />
  );
}
