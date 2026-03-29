"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { cn } from "@/lib/utils";

/* ── Types ─────────────────────────────────────────────────────────── */

export interface MeshOptionsState {
  algorithm2d: number;
  algorithm3d: number;
  hmax: string;          // string for controlled input (SI metres) — primary size control
  hmin: string;          // string for controlled input (SI metres)
  sizeFactor: number;
  sizeFromCurvature: number;
  smoothingSteps: number;
  optimize: string;      // "" = none, "Netgen", "HighOrder", "Laplace2D", etc.
  optimizeIters: number;
  computeQuality: boolean;
  perElementQuality: boolean;
}

export interface MeshQualityData {
  nElements: number;
  sicnMin: number;
  sicnMax: number;
  sicnMean: number;
  sicnP5: number;
  sicnHistogram: number[];
  gammaMin: number;
  gammaMean: number;
  gammaHistogram: number[];
  volumeMin: number;
  volumeMax: number;
  volumeMean: number;
  volumeStd: number;
  avgQuality: number;
}

interface MeshSettingsPanelProps {
  options: MeshOptionsState;
  onChange: (next: MeshOptionsState) => void;
  quality?: MeshQualityData | null;
  disabled?: boolean;
  generating?: boolean;
  onGenerate?: () => void;
  nodeCount?: number;
  waitMode?: boolean;
}

/* ── Algorithm options ─────────────────────────────────────────────── */

const ALGO_2D_OPTIONS = [
  { value: "1", label: "MeshAdapt" },
  { value: "2", label: "Automatic" },
  { value: "5", label: "Delaunay" },
  { value: "6", label: "Frontal-Delaunay" },
  { value: "7", label: "BAMG" },
  { value: "8", label: "Frontal (Quads)" },
];

const ALGO_3D_OPTIONS = [
  { value: "1", label: "Delaunay" },
  { value: "4", label: "Frontal" },
  { value: "7", label: "MMG3D" },
  { value: "10", label: "HXT" },
];

const OPTIMIZE_OPTIONS = [
  { value: "",            label: "None" },
  { value: "Netgen",      label: "Netgen" },
  { value: "HighOrder",   label: "High Order" },
  { value: "Laplace2D",   label: "Laplace 2D" },
  { value: "Relocate2D",  label: "Relocate 2D" },
  { value: "Relocate3D",  label: "Relocate 3D" },
];

/* ── Defaults ──────────────────────────────────────────────────────── */

export const DEFAULT_MESH_OPTIONS: MeshOptionsState = {
  algorithm2d: 6,
  algorithm3d: 1,
  hmax: "",
  hmin: "",
  sizeFactor: 1.0,
  sizeFromCurvature: 0,
  smoothingSteps: 1,
  optimize: "",
  optimizeIters: 1,
  computeQuality: false,
  perElementQuality: false,
};

/* ── SICN color ────────────────────────────────────────────────────── */

function sicnColor(value: number): string {
  // Maps [-1, 1] → red → yellow → green
  const t = Math.max(0, Math.min(1, (value + 1) / 2));
  if (t < 0.5) {
    const f = t * 2;
    const r = Math.round(207 + (253 - 207) * f);
    const g = Math.round(98 + (231 - 98) * f);
    const b = Math.round(86 + (37 - 86) * f);
    return `rgb(${r},${g},${b})`;
  }
  const f = (t - 0.5) * 2;
  const r = Math.round(253 + (53 - 253) * f);
  const g = Math.round(231 + (183 - 231) * f);
  const b = Math.round(37 + (121 - 37) * f);
  return `rgb(${r},${g},${b})`;
}

function gammaColor(value: number): string {
  // Maps [0, 1] → red → yellow → green
  const t = Math.max(0, Math.min(1, value));
  if (t < 0.5) {
    const f = t * 2;
    return `rgb(${Math.round(207 + 46 * f)},${Math.round(98 + 133 * f)},${Math.round(86 - 49 * f)})`;
  }
  const f = (t - 0.5) * 2;
  return `rgb(${Math.round(253 - 200 * f)},${Math.round(231 - 48 * f)},${Math.round(37 + 84 * f)})`;
}

/* ── Histogram renderer ────────────────────────────────────────────── */

function drawHistogram(
  canvas: HTMLCanvasElement,
  bins: number[],
  rangeMin: number,
  rangeMax: number,
  colorFn: (v: number) => string,
  xLabel: string,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = Math.min(window.devicePixelRatio ?? 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  const nBins = bins.length;
  const maxBin = Math.max(...bins, 1);

  const pad = { top: 6, right: 8, bottom: 22, left: 32 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  const barW = Math.max(2, plotW / nBins - 1);

  ctx.clearRect(0, 0, w, h);

  // Grid lines
  ctx.strokeStyle = "hsla(220, 15%, 28%, 0.3)";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 3; i++) {
    const y = pad.top + plotH * (1 - i / 3);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
  }

  // Bars
  const binWidth = (rangeMax - rangeMin) / nBins;
  for (let i = 0; i < nBins; i++) {
    const v = bins[i];
    if (v === 0) continue;
    const barH = (v / maxBin) * plotH;
    const x = pad.left + i * (plotW / nBins) + 0.5;
    const y = pad.top + plotH - barH;
    const value = rangeMin + (i + 0.5) * binWidth;
    ctx.fillStyle = colorFn(value);
    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, [2, 2, 0, 0]);
    ctx.fill();
  }

  // Y-axis
  ctx.fillStyle = "hsla(220, 20%, 60%, 0.6)";
  ctx.font = "9px var(--font-mono, monospace)";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 3; i++) {
    const val = Math.round((maxBin / 3) * i);
    const y = pad.top + plotH * (1 - i / 3);
    ctx.fillText(String(val), pad.left - 4, y);
  }

  // X-axis
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const step = Math.max(1, Math.floor(nBins / 5));
  for (let i = 0; i < nBins; i += step) {
    const val = (rangeMin + (i + 0.5) * binWidth).toFixed(1);
    const x = pad.left + (i + 0.5) * (plotW / nBins);
    ctx.fillText(val, x, pad.top + plotH + 4);
  }

  // Label
  ctx.fillStyle = "hsla(220, 20%, 55%, 0.5)";
  ctx.font = "8px var(--font-mono, monospace)";
  ctx.textAlign = "center";
  ctx.fillText(xLabel, pad.left + plotW / 2, h - 2);
}

/* ── Component ─────────────────────────────────────────────────────── */

export default function MeshSettingsPanel({
  options,
  onChange,
  quality,
  disabled = false,
  generating = false,
  onGenerate,
  nodeCount,
  waitMode,
}: MeshSettingsPanelProps) {
  const sicnCanvasRef = useRef<HTMLCanvasElement>(null);
  const gammaCanvasRef = useRef<HTMLCanvasElement>(null);

  const set = useCallback(
    (patch: Partial<MeshOptionsState>) => onChange({ ...options, ...patch }),
    [options, onChange],
  );

  // Rating based on SICN p5
  const qualityRating = useMemo(() => {
    if (!quality) return null;
    if (quality.sicnP5 >= 0.5) return { label: "Excellent", cls: "good" };
    if (quality.sicnP5 >= 0.3) return { label: "Good", cls: "good" };
    if (quality.sicnP5 >= 0.1) return { label: "Fair", cls: "fair" };
    return { label: "Poor", cls: "poor" };
  }, [quality]);

  // Draw SICN histogram
  useEffect(() => {
    if (!sicnCanvasRef.current || !quality?.sicnHistogram) return;
    drawHistogram(
      sicnCanvasRef.current,
      quality.sicnHistogram,
      -1, 1,
      sicnColor,
      "SICN (Signed Inverse Condition Number)",
    );
  }, [quality?.sicnHistogram]);

  // Draw gamma histogram
  useEffect(() => {
    if (!gammaCanvasRef.current || !quality?.gammaHistogram) return;
    drawHistogram(
      gammaCanvasRef.current,
      quality.gammaHistogram,
      0, 1,
      gammaColor,
      "γ (inscribed/circumscribed ratio)",
    );
  }, [quality?.gammaHistogram]);

  return (
    <div className="flex flex-col gap-2 p-3">
      {/* ── Algorithm Selection ── */}
      <div className="flex flex-col gap-2 p-3 rounded-lg border border-border/40 bg-card/20 shadow-sm">
        <div className="flex items-center justify-between gap-2 border-b border-border/20 pb-2 mb-1">
          <span className="text-xs font-bold uppercase tracking-widest text-foreground">Algorithm</span>
          <span className="text-[0.65rem] font-mono text-muted-foreground/70 bg-muted px-1.5 py-0.5 rounded">Gmsh</span>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">2D surface</span>
            <div className="flex-1 max-w-[140px]">
              <select
                className="w-full appearance-none bg-card border border-border/50 rounded-md py-1 px-2 text-xs text-foreground focus:outline-none focus:border-primary disabled:opacity-50"
                value={String(options.algorithm2d)}
                onChange={(e) => set({ algorithm2d: Number(e.target.value) })}
                disabled={disabled}
              >
                {ALGO_2D_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">3D volume</span>
            <div className="flex-1 max-w-[140px]">
              <select
                className="w-full appearance-none bg-card border border-border/50 rounded-md py-1 px-2 text-xs text-foreground focus:outline-none focus:border-primary disabled:opacity-50"
                value={String(options.algorithm3d)}
                onChange={(e) => set({ algorithm3d: Number(e.target.value) })}
                disabled={disabled}
              >
                {ALGO_3D_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* ── Size Control ── */}
      <div className="flex flex-col gap-2 p-3 rounded-lg border border-border/40 bg-card/20 shadow-sm">
        <div className="flex items-center justify-between gap-2 border-b border-border/20 pb-2 mb-1">
          <span className="text-xs font-bold uppercase tracking-widest text-foreground">Element Size</span>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              hmax
              <span className="text-[0.55rem] text-muted-foreground/40">(primary)</span>
            </span>
            <div className="flex-1 max-w-[140px]">
              <input
                className="w-full bg-card border border-border/50 rounded-md py-1 px-2 text-xs text-foreground focus:outline-none focus:border-primary placeholder:text-muted-foreground/30 disabled:opacity-50 text-right font-mono"
                type="text"
                placeholder="auto"
                value={options.hmax}
                onChange={(e) => set({ hmax: e.target.value })}
                disabled={disabled}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">hmin</span>
            <div className="flex-1 max-w-[140px]">
              <input
                className="w-full bg-card border border-border/50 rounded-md py-1 px-2 text-xs text-foreground focus:outline-none focus:border-primary placeholder:text-muted-foreground/30 disabled:opacity-50 text-right font-mono"
                type="text"
                placeholder="auto"
                value={options.hmin}
                onChange={(e) => set({ hmin: e.target.value })}
                disabled={disabled}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">Size factor</span>
            <div className="flex-1 max-w-[140px]">
              <input
                className="w-full bg-card border border-border/50 rounded-md py-1 px-2 text-xs text-foreground focus:outline-none focus:border-primary placeholder:text-muted-foreground/30 disabled:opacity-50 text-right font-mono"
                type="number"
                step="0.1"
                min="0.1"
                max="10"
                value={options.sizeFactor}
                onChange={(e) => set({ sizeFactor: Number(e.target.value) || 1 })}
                disabled={disabled}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">From curvature</span>
            <div className="flex-1 max-w-[140px]">
              <input
                className="w-full bg-card border border-border/50 rounded-md py-1 px-2 text-xs text-foreground focus:outline-none focus:border-primary placeholder:text-muted-foreground/30 disabled:opacity-50 text-right font-mono"
                type="number"
                step="1"
                min="0"
                max="100"
                value={options.sizeFromCurvature}
                onChange={(e) => set({ sizeFromCurvature: Number(e.target.value) || 0 })}
                disabled={disabled}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Optimization ── */}
      <div className="flex flex-col gap-2 p-3 rounded-lg border border-border/40 bg-card/20 shadow-sm">
        <div className="flex items-center justify-between gap-2 border-b border-border/20 pb-2 mb-1">
          <span className="text-xs font-bold uppercase tracking-widest text-foreground">Optimization</span>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">Method</span>
            <div className="flex-1 max-w-[140px]">
              <select
                className="w-full appearance-none bg-card border border-border/50 rounded-md py-1 px-2 text-xs text-foreground focus:outline-none focus:border-primary disabled:opacity-50"
                value={options.optimize}
                onChange={(e) => set({ optimize: e.target.value })}
                disabled={disabled}
              >
                {OPTIMIZE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
          {options.optimize !== "" && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">Iterations</span>
              <div className="flex-1 max-w-[140px]">
                <input
                  className="w-full bg-card border border-border/50 rounded-md py-1 px-2 text-xs text-foreground focus:outline-none focus:border-primary placeholder:text-muted-foreground/30 disabled:opacity-50 text-right font-mono"
                  type="number"
                  step="1"
                  min="1"
                  max="20"
                  value={options.optimizeIters}
                  onChange={(e) => set({ optimizeIters: Number(e.target.value) || 1 })}
                  disabled={disabled}
                />
              </div>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">Smoothing</span>
            <div className="flex-1 max-w-[140px]">
              <input
                className="w-full bg-card border border-border/50 rounded-md py-1 px-2 text-xs text-foreground focus:outline-none focus:border-primary placeholder:text-muted-foreground/30 disabled:opacity-50 text-right font-mono"
                type="number"
                step="1"
                min="0"
                max="100"
                value={options.smoothingSteps}
                onChange={(e) => set({ smoothingSteps: Number(e.target.value) || 0 })}
                disabled={disabled}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Quality ── */}
      <div className="flex flex-col gap-2 p-3 rounded-lg border border-border/40 bg-card/20 shadow-sm">
        <div className="flex items-center justify-between gap-2 border-b border-border/20 pb-2 mb-1">
          <span className="text-xs font-bold uppercase tracking-widest text-foreground">Quality Analysis</span>
          {qualityRating && (
            <span className={cn("text-[0.65rem] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded text-white", qualityRating.cls === "good" ? "bg-emerald-600" : qualityRating.cls === "fair" ? "bg-amber-600" : "bg-destructive")}>
              {qualityRating.label}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between py-1">
            <span className="text-xs font-medium text-foreground">Extract quality metrics</span>
            <input
              type="checkbox"
              className="accent-primary w-3 h-3"
              checked={options.computeQuality}
              onChange={(e) => set({ computeQuality: e.target.checked })}
              disabled={disabled}
            />
          </div>
          {options.computeQuality && (
            <div className="flex items-center justify-between py-1">
              <span className="text-xs font-medium text-foreground">Per-element data</span>
              <input
                type="checkbox"
                className="accent-primary w-3 h-3"
                checked={options.perElementQuality}
                onChange={(e) => set({ perElementQuality: e.target.checked })}
                disabled={disabled}
              />
            </div>
          )}

          {quality && (
            <>
              <div className="grid grid-cols-2 gap-2 mt-2 p-2 bg-black/10 rounded-md border border-border/20">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[0.65rem] uppercase tracking-widest text-muted-foreground">Elements</span>
                  <span className="font-mono text-xs text-foreground">{quality.nElements.toLocaleString()}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[0.65rem] uppercase tracking-widest text-muted-foreground">SICN min</span>
                  <span className="font-mono text-xs text-foreground">{quality.sicnMin.toFixed(3)}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[0.65rem] uppercase tracking-widest text-muted-foreground">SICN mean</span>
                  <span className="font-mono text-xs text-foreground">{quality.sicnMean.toFixed(3)}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[0.65rem] uppercase tracking-widest text-muted-foreground">SICN p5</span>
                  <span className="font-mono text-xs text-foreground">{quality.sicnP5.toFixed(3)}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[0.65rem] uppercase tracking-widest text-muted-foreground">γ min</span>
                  <span className="font-mono text-xs text-foreground">{quality.gammaMin.toFixed(3)}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[0.65rem] uppercase tracking-widest text-muted-foreground">γ mean</span>
                  <span className="font-mono text-xs text-foreground">{quality.gammaMean.toFixed(3)}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[0.65rem] uppercase tracking-widest text-muted-foreground">Avg ICN</span>
                  <span className="font-mono text-xs text-foreground">{quality.avgQuality.toFixed(3)}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[0.65rem] uppercase tracking-widest text-muted-foreground">Vol σ/μ</span>
                  <span className="font-mono text-xs text-foreground">
                    {quality.volumeMean > 0
                      ? (quality.volumeStd / quality.volumeMean).toFixed(2)
                      : "—"
                    }
                  </span>
                </div>
              </div>

              {/* SICN Histogram */}
              <canvas ref={sicnCanvasRef} className="w-full h-16 mt-3 bg-card/30 rounded border border-border/30" />
              <div className="flex items-center justify-center gap-3 mt-1.5 text-[0.6rem] text-muted-foreground">
                <span><span className="inline-block w-1.5 h-1.5 rounded-full mr-1 bg-destructive" />SICN &lt; 0 (inverted)</span>
                <span><span className="inline-block w-1.5 h-1.5 rounded-full mr-1 bg-amber-500" />0–0.5 (fair)</span>
                <span><span className="inline-block w-1.5 h-1.5 rounded-full mr-1 bg-emerald-500" />&gt; 0.5 (good)</span>
              </div>

              {/* Gamma Histogram */}
              <canvas ref={gammaCanvasRef} className="w-full h-16 mt-3 bg-card/30 rounded border border-border/30" />
              <div className="flex items-center justify-center gap-3 mt-1.5 text-[0.6rem] text-muted-foreground">
                <span><span className="inline-block w-1.5 h-1.5 rounded-full mr-1 bg-destructive" />γ &lt; 0.3 (poor)</span>
                <span><span className="inline-block w-1.5 h-1.5 rounded-full mr-1 bg-amber-500" />0.3–0.6 (fair)</span>
                <span><span className="inline-block w-1.5 h-1.5 rounded-full mr-1 bg-emerald-500" />&gt; 0.6 (good)</span>
              </div>
            </>
          )}
        </div>
      </div>
      {/* ── Solver Compatibility ── */}
      {nodeCount != null && nodeCount > 0 && (
        <div className="flex flex-col gap-2 p-3 rounded-lg border border-border/40 bg-card/20 shadow-sm">
          <div className="flex items-center justify-between gap-2 border-b border-border/20 pb-2 mb-1">
            <span className="text-xs font-bold uppercase tracking-widest text-foreground">Solver Compatibility</span>
          </div>
          <div className="grid grid-cols-[92px_1fr] gap-2 items-center">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Nodes</span>
            <span className="font-mono text-xs text-foreground">{nodeCount.toLocaleString()}</span>
          </div>
          <div className="grid grid-cols-[92px_1fr] gap-2 items-center">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Est. RAM</span>
            <span className={cn("font-mono text-xs",
              nodeCount > 50000 ? "text-destructive font-bold" :
              nodeCount > 10000 ? "text-amber-500" : "text-emerald-500")}>
              {((nodeCount * nodeCount * 24) / 1e9).toFixed(1)} GB
              {nodeCount > 50000 && " ⛔ too large"}
              {nodeCount > 10000 && nodeCount <= 50000 && " ⚠️ large"}
            </span>
          </div>
          {nodeCount > 10000 && (
            <div className={cn("mt-1 p-2 rounded-md text-xs",
              nodeCount > 50000
                ? "bg-destructive/10 border border-destructive/30 text-destructive"
                : "bg-amber-500/10 border border-amber-500/30 text-amber-500")}>
              {nodeCount > 50000
                ? "Mesh too large for CPU dense solver. Increase hmax to reduce node count."
                : "Large mesh — may be slow. Target <10,000 nodes for CPU reference solver."}
            </div>
          )}
        </div>
      )}
      {/* ── Generate button ── */}
      {onGenerate && (
        <div className="flex flex-col gap-2 p-3 rounded-lg border border-border/40 bg-card/20 shadow-sm">
          <button
            className="w-full flex items-center justify-center gap-2 py-2 text-sm font-semibold rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none transition-colors"
            onClick={onGenerate}
            disabled={disabled || generating}
          >
            {generating ? (
              <><span className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" /> Generating…</>
            ) : (
              "⚡ Generate Mesh"
            )}
          </button>
        </div>
      )}
    </div>
  );
}
