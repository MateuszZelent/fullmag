"use client";

import { useMemo } from "react";
import Plot from "../plots/DynamicPlot";

import type { DispersionRow } from "./eigenTypes";


/** Palette consistent with ModeSpectrumPlot polarization colors */
const BRANCH_COLORS = [
  "#8ec5ff", // sky   – ip
  "#c3a6ff", // violet – op
  "#6ee7b7", // emerald – z
  "#fcd34d", // amber – mixed
  "#f9a8d4", // pink
  "#5eead4", // teal
  "#93c5fd", // blue-300
  "#fda4af", // rose-300
  "#a5f3fc", // cyan-200
  "#d8b4fe", // purple-300
];

const C = {
  bg: "transparent",
  text: "rgba(225,232,245,0.9)",
  grid: "rgba(120,140,170,0.16)",
  sel: "#ffb86c",
  hovBg: "rgba(10,16,28,0.96)",
  hovBorder: "rgba(132,156,240,0.55)",
} as const;

interface DispersionBranchPlotProps {
  rows: DispersionRow[];
  selectedMode: number | null;
  onSelectMode?: (modeIndex: number) => void;
}

function kMag(row: DispersionRow): number {
  return Math.sqrt(row.kx ** 2 + row.ky ** 2 + row.kz ** 2);
}

/** Estimate group velocity dω/dk for a sorted branch (returns m/s or null). */
function groupVelocity(branch: DispersionRow[]): number | null {
  if (branch.length < 2) return null;
  const sorted = [...branch].sort((a, b) => kMag(a) - kMag(b));
  const dk = kMag(sorted[sorted.length - 1]) - kMag(sorted[0]);
  if (dk === 0) return null;
  const domega =
    sorted[sorted.length - 1].angularFrequencyRadPerS - sorted[0].angularFrequencyRadPerS;
  return domega / dk; // rad·m/s → SI group velocity
}

function fmtVg(vg: number | null): string {
  if (vg === null) return "—";
  const abs = Math.abs(vg);
  if (abs >= 1e6) return `${(vg / 1e6).toFixed(2)} Mm/s`;
  if (abs >= 1e3) return `${(vg / 1e3).toFixed(2)} km/s`;
  return `${vg.toFixed(1)} m/s`;
}

export default function DispersionBranchPlot({
  rows,
  selectedMode,
  onSelectMode,
}: DispersionBranchPlotProps) {
  const traces = useMemo(() => {
    // Group rows by modeIndex
    const grouped = new Map<number, DispersionRow[]>();
    for (const row of rows) {
      const entries = grouped.get(row.modeIndex);
      if (entries) entries.push(row);
      else grouped.set(row.modeIndex, [row]);
    }

    return Array.from(grouped.entries())
      .sort(([a], [b]) => a - b)
      .map(([modeIndex, entries], idx) => {
        const sorted = [...entries].sort((a, b) => kMag(a) - kMag(b));
        const isSelected = modeIndex === selectedMode;
        const color = isSelected ? C.sel : BRANCH_COLORS[idx % BRANCH_COLORS.length];
        const vg = groupVelocity(sorted);
        const vgLabel = fmtVg(vg);
        const hoverText = sorted.map(
          (r) =>
            `<b>Mode ${r.modeIndex}</b><br>` +
            `|k| = ${kMag(r).toExponential(4)} m⁻¹<br>` +
            `f = ${(r.frequencyHz / 1e9).toFixed(4)} GHz<br>` +
            `kx = ${r.kx.toExponential(3)}<br>` +
            `ky = ${r.ky.toExponential(3)}<br>` +
            `kz = ${r.kz.toExponential(3)}<br>` +
            `vg ≈ ${vgLabel}`,
        );

        return {
          x: sorted.map(kMag),
          y: sorted.map((r) => r.frequencyHz / 1e9),
          type: "scatter" as const,
          mode: sorted.length > 1 ? ("lines+markers" as const) : ("markers" as const),
          name: `M${modeIndex}`,
          text: hoverText,
          line: { color, width: isSelected ? 2.8 : 1.6, dash: "solid" as const },
          marker: {
            color,
            size: sorted.map((r) => (r.modeIndex === selectedMode ? 11 : 7)),
            line: {
              color: isSelected ? "rgba(255,184,108,0.4)" : "rgba(8,12,24,0.45)",
              width: isSelected ? 3 : 1,
            },
            symbol: "circle" as const,
          },
          hovertemplate: "%{text}<extra></extra>",
          showlegend: sorted.length > 1 || grouped.size <= 12,
        };
      });
  }, [rows, selectedMode]);

  // Gamma-point annotation when any row is at k≈0
  const hasGammaPoint = rows.some((r) => kMag(r) < 1e3);
  const annotations: Partial<Plotly.Annotations>[] = hasGammaPoint
    ? [
        {
          x: 0,
          y: 0,
          xref: "x" as const,
          yref: "paper" as const,
          text: "Γ",
          showarrow: false,
          font: { size: 12, color: "rgba(200,215,240,0.55)", family: "ui-monospace, Menlo, Consolas, monospace" },
          xanchor: "center" as const,
          yanchor: "bottom" as const,
          yshift: 4,
        },
      ]
    : [];

  const layout = useMemo(
    (): Partial<Plotly.Layout> => ({
      paper_bgcolor: C.bg,
      plot_bgcolor: C.bg,
      margin: { l: 68, r: 12, t: 16, b: 52 },
      font: {
        family: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        size: 11,
        color: C.text,
      },
      xaxis: {
        title: { text: "|k| (m⁻¹)", standoff: 8, font: { size: 10.5 } },
        color: C.text,
        gridcolor: C.grid,
        zeroline: true,
        zerolinecolor: "rgba(180,195,230,0.22)",
        zerolinewidth: 1,
        exponentformat: "e" as const,
        tickfont: { size: 10 },
      },
      yaxis: {
        title: { text: "f (GHz)", standoff: 8, font: { size: 10.5 } },
        color: C.text,
        gridcolor: C.grid,
        zeroline: false,
        rangemode: "nonnegative" as const,
        tickfont: { size: 10 },
      },
      hovermode: "closest" as const,
      dragmode: "pan" as const,
      hoverlabel: {
        bgcolor: C.hovBg,
        bordercolor: C.hovBorder,
        font: { color: "#eef4ff", size: 12 },
        align: "left" as const,
        namelength: 0,
      },
      modebar: { bgcolor: "transparent", color: C.text, activecolor: C.sel },
      legend: {
        orientation: "h" as const,
        yanchor: "top" as const,
        y: -0.18,
        xanchor: "left" as const,
        x: 0,
        font: { size: 9.5 },
        bgcolor: "rgba(8,12,24,0.55)",
        bordercolor: "rgba(120,140,170,0.2)",
        borderwidth: 1,
      },
      annotations,
    }),
    [hasGammaPoint],
  );

  return (
    <Plot
      data={traces}
      layout={layout}
      config={{
        responsive: true,
        displaylogo: false,
        scrollZoom: true,
        modeBarButtonsToRemove: [
          "lasso2d",
          "select2d",
          "hoverClosestCartesian",
          "hoverCompareCartesian",
          "sendDataToCloud",
        ],
      }}
      useResizeHandler
      className="h-full w-full"
      style={{ width: "100%", height: "100%" }}
      onClick={(event: Readonly<Plotly.PlotMouseEvent>) => {
        const raw = event.points?.[0]?.customdata;
        if (Array.isArray(raw) && typeof raw[0] === "number") {
          onSelectMode?.(raw[0] as number);
        } else if (typeof raw === "number") {
          onSelectMode?.(raw);
        }
      }}
    />
  );
}
