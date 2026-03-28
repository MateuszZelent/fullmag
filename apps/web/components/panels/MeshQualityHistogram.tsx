"use client";

import { useEffect, useRef, useMemo } from "react";
import Panel from "../ui/Panel";
import StatusBadge from "../ui/StatusBadge";

/* ── Types ─────────────────────────────────────────────────── */

interface FemMeshLike {
  nodes: number[];            // flattened [x,y,z, ...]
  boundaryFaces: number[];    // flattened [i,j,k, ...]
  nElements: number;
}

interface MeshQualityHistogramProps {
  femMesh: FemMeshLike | null;
}

/* ── Quality computation ───────────────────────────────────── */

interface QualityStats {
  ars: Float32Array;
  min: number;
  max: number;
  mean: number;
  goodCount: number;  // AR < 3
  fairCount: number;  // 3 ≤ AR < 6
  poorCount: number;  // AR ≥ 6
}

function computeTriangleARs(nodes: number[], faces: number[]): QualityStats {
  const nFaces = faces.length / 3;
  const ars = new Float32Array(nFaces);
  let min = Infinity, max = -Infinity, sum = 0;
  let goodCount = 0, fairCount = 0, poorCount = 0;

  for (let f = 0; f < nFaces; f++) {
    const ia = faces[f * 3], ib = faces[f * 3 + 1], ic = faces[f * 3 + 2];
    const ax = nodes[ia * 3], ay = nodes[ia * 3 + 1], az = nodes[ia * 3 + 2];
    const bx = nodes[ib * 3], by = nodes[ib * 3 + 1], bz = nodes[ib * 3 + 2];
    const cx = nodes[ic * 3], cy = nodes[ic * 3 + 1], cz = nodes[ic * 3 + 2];

    const ab = Math.sqrt((bx-ax)**2 + (by-ay)**2 + (bz-az)**2);
    const bc = Math.sqrt((cx-bx)**2 + (cy-by)**2 + (cz-bz)**2);
    const ca = Math.sqrt((ax-cx)**2 + (ay-cy)**2 + (az-cz)**2);

    const maxEdge = Math.max(ab, bc, ca);
    const sp = (ab + bc + ca) / 2;
    const area = Math.sqrt(Math.max(0, sp * (sp - ab) * (sp - bc) * (sp - ca)));
    const inradius = area / sp;
    const ar = inradius > 1e-18 ? maxEdge / (2 * inradius) : 1;

    ars[f] = ar;
    if (ar < min) min = ar;
    if (ar > max) max = ar;
    sum += ar;

    if (ar < 3)      goodCount++;
    else if (ar < 6) fairCount++;
    else              poorCount++;
  }

  return { ars, min, max, mean: nFaces > 0 ? sum / nFaces : 0, goodCount, fairCount, poorCount };
}

/* ── Colors ────────────────────────────────────────────────── */

function arColor(ar: number): string {
  const t = Math.min((ar - 1) / 9, 1); // 1→0, 10→1
  if (t < 0.5) {
    // green → yellow
    const f = t * 2;
    const r = Math.round(53 + (253 - 53) * f);
    const g = Math.round(183 + (231 - 183) * f);
    const b = Math.round(121 + (37 - 121) * f);
    return `rgb(${r},${g},${b})`;
  }
  // yellow → red
  const f = (t - 0.5) * 2;
  const r = Math.round(253 + (207 - 253) * f);
  const g = Math.round(231 + (98 - 231) * f);
  const b = Math.round(37 + (86 - 37) * f);
  return `rgb(${r},${g},${b})`;
}

/* ── Component ─────────────────────────────────────────────── */

const BIN_COUNT = 24;
const BAR_RADIUS = 3;

export default function MeshQualityHistogram({ femMesh }: MeshQualityHistogramProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const stats = useMemo(() => {
    if (!femMesh || !femMesh.nodes.length || !femMesh.boundaryFaces.length) return null;
    return computeTriangleARs(femMesh.nodes, femMesh.boundaryFaces);
  }, [femMesh]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !stats) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio ?? 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    /* Histogram bins */
    const binWidth = (stats.max - stats.min) / BIN_COUNT || 1;
    const bins = new Uint32Array(BIN_COUNT);
    for (let i = 0; i < stats.ars.length; i++) {
      const idx = Math.min(Math.floor((stats.ars[i] - stats.min) / binWidth), BIN_COUNT - 1);
      bins[idx]++;
    }
    const maxBin = Math.max(...bins, 1);

    /* Layout */
    const pad = { top: 6, right: 12, bottom: 24, left: 40 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;
    const barW = Math.max(2, plotW / BIN_COUNT - 1);

    ctx.clearRect(0, 0, w, h);

    /* Grid lines */
    ctx.strokeStyle = "hsla(220, 15%, 28%, 0.35)";
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + plotH * (1 - i / 4);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
    }

    /* Bars */
    for (let i = 0; i < BIN_COUNT; i++) {
      const v = bins[i];
      if (v === 0) continue;
      const barH = (v / maxBin) * plotH;
      const x = pad.left + i * (plotW / BIN_COUNT) + 0.5;
      const y = pad.top + plotH - barH;
      const ar = stats.min + (i + 0.5) * binWidth;

      ctx.fillStyle = arColor(ar);
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, [BAR_RADIUS, BAR_RADIUS, 0, 0]);
      ctx.fill();
    }

    /* Y-axis labels */
    ctx.fillStyle = "hsla(220, 20%, 60%, 0.7)";
    ctx.font = "10px var(--font-mono, monospace)";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const val = Math.round((maxBin / 4) * i);
      const y = pad.top + plotH * (1 - i / 4);
      ctx.fillText(String(val), pad.left - 6, y);
    }

    /* X-axis labels */
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labelStep = Math.max(1, Math.floor(BIN_COUNT / 6));
    for (let i = 0; i < BIN_COUNT; i += labelStep) {
      const val = (stats.min + (i + 0.5) * binWidth).toFixed(1);
      const x = pad.left + (i + 0.5) * (plotW / BIN_COUNT);
      ctx.fillText(val, x, pad.top + plotH + 6);
    }

    /* Axis title */
    ctx.fillStyle = "hsla(220, 20%, 55%, 0.6)";
    ctx.font = "9px var(--font-mono, monospace)";
    ctx.textAlign = "center";
    ctx.fillText("Aspect Ratio", pad.left + plotW / 2, h - 2);
  }, [stats]);

  if (!stats) {
    return (
      <Panel
        title="Mesh Quality"
        subtitle="No FEM mesh data available."
        panelId="mesh-quality"
        eyebrow="FEM"
      >
        <div className="p-4 text-[0.85rem] text-[var(--text-3)]">
          Mesh quality histogram will appear once FEM topology is loaded.
        </div>
      </Panel>
    );
  }

  const total = stats.ars.length;
  const goodPct = ((stats.goodCount / total) * 100).toFixed(1);
  const fairPct = ((stats.fairCount / total) * 100).toFixed(1);
  const poorPct = ((stats.poorCount / total) * 100).toFixed(1);

  return (
    <Panel
      title="Mesh Quality"
      subtitle={`${total.toLocaleString()} boundary faces analyzed`}
      panelId="mesh-quality"
      eyebrow="FEM"
      actions={
        <StatusBadge
          label={stats.mean < 3 ? "Good" : stats.mean < 6 ? "Fair" : "Poor"}
          tone={stats.mean < 3 ? "success" : stats.mean < 6 ? "warn" : "danger"}
        />
      }
    >
      <div className="grid gap-3">
        {/* Stats row */}
        <div className="grid grid-cols-6 gap-2 font-mono text-[0.78rem]">
          <div>
            <div className="text-[0.68rem] font-bold uppercase tracking-[0.08em] text-[var(--text-3)]">Min AR</div>
            <div className="text-[var(--text-1)]">{stats.min.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-[0.68rem] font-bold uppercase tracking-[0.08em] text-[var(--text-3)]">Mean AR</div>
            <div className="text-[var(--text-1)]">{stats.mean.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-[0.68rem] font-bold uppercase tracking-[0.08em] text-[var(--text-3)]">Max AR</div>
            <div className="text-[var(--text-1)]">{stats.max.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-[0.68rem] font-bold text-[#35b779]">Good</div>
            <div className="text-[var(--text-1)]">{goodPct}%</div>
          </div>
          <div>
            <div className="text-[0.68rem] font-bold text-[#fde725]">Fair</div>
            <div className="text-[var(--text-1)]">{fairPct}%</div>
          </div>
          <div>
            <div className="text-[0.68rem] font-bold text-[#cf6256]">Poor</div>
            <div className="text-[var(--text-1)]">{poorPct}%</div>
          </div>
        </div>

        {/* Histogram canvas */}
        <canvas
          ref={canvasRef}
          className="h-40 w-full rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[rgba(6,10,18,0.6)]"
        />

        {/* Legend */}
        <div className="flex justify-center gap-4 text-[0.72rem] text-[var(--text-3)]">
          <span><span className="mr-1 inline-block size-[10px] rounded-[2px] align-middle bg-[#35b779]" /> AR &lt; 3 (Good)</span>
          <span><span className="mr-1 inline-block size-[10px] rounded-[2px] align-middle bg-[#fde725]" /> 3 ≤ AR &lt; 6 (Fair)</span>
          <span><span className="mr-1 inline-block size-[10px] rounded-[2px] align-middle bg-[#cf6256]" /> AR ≥ 6 (Poor)</span>
        </div>
      </div>
    </Panel>
  );
}
