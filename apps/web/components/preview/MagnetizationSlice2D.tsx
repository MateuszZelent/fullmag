"use client";

import { useEffect, useMemo, useRef } from "react";

interface Props {
  grid: [number, number, number];
  magnetization: Float64Array | null;
}

function magnetizationCss(mx: number, my: number, mz: number): string {
  const hue = ((Math.atan2(my, mx) / (2 * Math.PI) + 1) % 1) * 360;
  const lightness = 28 + 44 * (mz * 0.5 + 0.5);
  return `hsl(${hue.toFixed(1)} 82% ${lightness.toFixed(1)}%)`;
}

export default function MagnetizationSlice2D({ grid, magnetization }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [nx, ny, nz] = grid;
  const sliceIndex = useMemo(() => Math.max(0, Math.floor(nz / 2)), [nz]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !magnetization || nx <= 0 || ny <= 0) {
      return;
    }

    const width = canvas.clientWidth || 900;
    const height = canvas.clientHeight || 260;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, width, height);

    const pad = 16;
    const cellW = Math.max(2, (width - pad * 2) / nx);
    const cellH = Math.max(2, (height - pad * 2) / ny);
    const arrowStride = Math.max(1, Math.floor(nx / 32));

    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const cellIndex = sliceIndex * nx * ny + iy * nx + ix;
        const base = cellIndex * 3;
        const mx = magnetization[base];
        const my = magnetization[base + 1];
        const mz = magnetization[base + 2];
        const x = pad + ix * cellW;
        const y = pad + (ny - 1 - iy) * cellH;

        ctx.fillStyle = magnetizationCss(mx, my, mz);
        ctx.fillRect(x, y, Math.ceil(cellW), Math.ceil(cellH));

        if (ix % arrowStride === 0 && iy % arrowStride === 0) {
          const cx = x + cellW * 0.5;
          const cy = y + cellH * 0.5;
          const len = Math.min(cellW, cellH) * 0.35;
          ctx.strokeStyle = "rgba(255,255,255,0.82)";
          ctx.lineWidth = Math.max(1, Math.min(cellW, cellH) * 0.08);
          ctx.beginPath();
          ctx.moveTo(cx - mx * len, cy + my * len);
          ctx.lineTo(cx + mx * len, cy - my * len);
          ctx.stroke();
        }
      }
    }

    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    ctx.strokeRect(pad, pad, nx * cellW, ny * cellH);
  }, [grid, magnetization, nx, ny, sliceIndex]);

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "var(--sp-3)",
          color: "var(--text-muted)",
          fontSize: "var(--text-sm)",
        }}
      >
        <span>2D magnetization slice</span>
        <span>
          z-slice {sliceIndex + 1}/{Math.max(1, nz)}
        </span>
      </div>
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: "280px",
          borderRadius: "var(--radius-lg)",
          background: "#0b1220",
          display: "block",
        }}
      />
    </div>
  );
}
