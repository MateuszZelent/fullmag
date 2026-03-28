"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import s from "./MeshSettingsPanel.module.css";

/* ── Types ─────────────────────────────────────────────────────────── */

export interface MeshOptionsState {
  algorithm2d: number;
  algorithm3d: number;
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
    if (quality.sicnP5 >= 0.5) return { label: "Excellent", cls: s.good };
    if (quality.sicnP5 >= 0.3) return { label: "Good", cls: s.good };
    if (quality.sicnP5 >= 0.1) return { label: "Fair", cls: s.fair };
    return { label: "Poor", cls: s.poor };
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
    <div className={s.root}>
      {/* ── Algorithm Selection ── */}
      <div className={s.section}>
        <div className={s.sectionHeader}>
          <span className={s.sectionTitle}>Algorithm</span>
          <span className={s.sectionBadge}>Gmsh</span>
        </div>
        <div className={s.sectionBody}>
          <div className={s.row}>
            <span className={s.rowLabel}>2D surface</span>
            <div className={s.rowControl}>
              <select
                className={s.compactSelect}
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
          <div className={s.row}>
            <span className={s.rowLabel}>3D volume</span>
            <div className={s.rowControl}>
              <select
                className={s.compactSelect}
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
      <div className={s.section}>
        <div className={s.sectionHeader}>
          <span className={s.sectionTitle}>Element Size</span>
        </div>
        <div className={s.sectionBody}>
          <div className={s.row}>
            <span className={s.rowLabel}>hmin</span>
            <div className={s.rowControl}>
              <input
                className={s.compactInput}
                type="text"
                placeholder="auto"
                value={options.hmin}
                onChange={(e) => set({ hmin: e.target.value })}
                disabled={disabled}
              />
            </div>
          </div>
          <div className={s.row}>
            <span className={s.rowLabel}>Size factor</span>
            <div className={s.rowControl}>
              <input
                className={s.compactInput}
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
          <div className={s.row}>
            <span className={s.rowLabel}>From curvature</span>
            <div className={s.rowControl}>
              <input
                className={s.compactInput}
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
      <div className={s.section}>
        <div className={s.sectionHeader}>
          <span className={s.sectionTitle}>Optimization</span>
        </div>
        <div className={s.sectionBody}>
          <div className={s.row}>
            <span className={s.rowLabel}>Method</span>
            <div className={s.rowControl}>
              <select
                className={s.compactSelect}
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
            <div className={s.row}>
              <span className={s.rowLabel}>Iterations</span>
              <div className={s.rowControl}>
                <input
                  className={s.compactInput}
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
          <div className={s.row}>
            <span className={s.rowLabel}>Smoothing</span>
            <div className={s.rowControl}>
              <input
                className={s.compactInput}
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
      <div className={s.section}>
        <div className={s.sectionHeader}>
          <span className={s.sectionTitle}>Quality Analysis</span>
          {qualityRating && (
            <span className={`${s.sectionBadge} ${qualityRating.cls}`}>
              {qualityRating.label}
            </span>
          )}
        </div>
        <div className={s.sectionBody}>
          <div className={s.toggleRow}>
            <span className={s.toggleLabel}>Extract quality metrics</span>
            <input
              type="checkbox"
              className={s.miniToggle}
              checked={options.computeQuality}
              onChange={(e) => set({ computeQuality: e.target.checked })}
              disabled={disabled}
            />
          </div>
          {options.computeQuality && (
            <div className={s.toggleRow}>
              <span className={s.toggleLabel}>Per-element data</span>
              <input
                type="checkbox"
                className={s.miniToggle}
                checked={options.perElementQuality}
                onChange={(e) => set({ perElementQuality: e.target.checked })}
                disabled={disabled}
              />
            </div>
          )}

          {quality && (
            <>
              <div className={s.statsGrid}>
                <div className={s.stat}>
                  <span className={s.statLabel}>Elements</span>
                  <span className={s.statValue}>{quality.nElements.toLocaleString()}</span>
                </div>
                <div className={s.stat}>
                  <span className={s.statLabel}>SICN min</span>
                  <span className={s.statValue}>{quality.sicnMin.toFixed(3)}</span>
                </div>
                <div className={s.stat}>
                  <span className={s.statLabel}>SICN mean</span>
                  <span className={s.statValue}>{quality.sicnMean.toFixed(3)}</span>
                </div>
                <div className={s.stat}>
                  <span className={s.statLabel}>SICN p5</span>
                  <span className={s.statValue}>{quality.sicnP5.toFixed(3)}</span>
                </div>
                <div className={s.stat}>
                  <span className={s.statLabel}>γ min</span>
                  <span className={s.statValue}>{quality.gammaMin.toFixed(3)}</span>
                </div>
                <div className={s.stat}>
                  <span className={s.statLabel}>γ mean</span>
                  <span className={s.statValue}>{quality.gammaMean.toFixed(3)}</span>
                </div>
                <div className={s.stat}>
                  <span className={s.statLabel}>Avg ICN</span>
                  <span className={s.statValue}>{quality.avgQuality.toFixed(3)}</span>
                </div>
                <div className={s.stat}>
                  <span className={s.statLabel}>Vol σ/μ</span>
                  <span className={s.statValue}>
                    {quality.volumeMean > 0
                      ? (quality.volumeStd / quality.volumeMean).toFixed(2)
                      : "—"
                    }
                  </span>
                </div>
              </div>

              {/* SICN Histogram */}
              <canvas ref={sicnCanvasRef} className={s.histogramCanvas} />
              <div className={s.legend}>
                <span><span className={`${s.legendDot} ${s.legendDotDanger}`} />SICN &lt; 0 (inverted)</span>
                <span><span className={`${s.legendDot} ${s.legendDotWarn}`} />0–0.5 (fair)</span>
                <span><span className={`${s.legendDot} ${s.legendDotGood}`} />&gt; 0.5 (good)</span>
              </div>

              {/* Gamma Histogram */}
              <canvas ref={gammaCanvasRef} className={s.histogramCanvas} />
              <div className={s.legend}>
                <span><span className={`${s.legendDot} ${s.legendDotDanger}`} />γ &lt; 0.3 (poor)</span>
                <span><span className={`${s.legendDot} ${s.legendDotWarn}`} />0.3–0.6 (fair)</span>
                <span><span className={`${s.legendDot} ${s.legendDotGood}`} />&gt; 0.6 (good)</span>
              </div>
            </>
          )}
        </div>
      </div>
      {/* ── Generate button ── */}
      {onGenerate && (
        <div className={s.section}>
          <button
            className={s.generateBtn}
            onClick={onGenerate}
            disabled={disabled || generating}
          >
            {generating ? (
              <><span className={s.spinner} /> Generating…</>
            ) : (
              "⚡ Generate Mesh"
            )}
          </button>
        </div>
      )}
    </div>
  );
}
