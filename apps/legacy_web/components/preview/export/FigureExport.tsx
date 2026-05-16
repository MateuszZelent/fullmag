"use client";

import { useCallback } from "react";

interface FigureExportOptions {
  /** Pixel ratio for export (default: 2) */
  pixelRatio?: number;
  /** Background color — null for transparent */
  backgroundColor?: string | null;
  /** Include legend overlay */
  includeLegend?: boolean;
  /** Output format */
  format?: "png" | "jpeg";
  /** JPEG quality (0-1) */
  quality?: number;
}

/**
 * Export the current 3D viewport as a high-resolution image.
 */
export function exportCanvasAsImage(
  canvas: HTMLCanvasElement,
  filename: string,
  options: FigureExportOptions = {},
) {
  const {
    backgroundColor = null,
    format = "png",
    quality = 0.95,
  } = options;

  // For WebGL canvases, we need to read pixels because toDataURL may be empty
  // if preserveDrawingBuffer is false. Use a temporary 2D canvas.
  const width = canvas.width;
  const height = canvas.height;

  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = width;
  exportCanvas.height = height;
  const ctx = exportCanvas.getContext("2d");
  if (!ctx) return;

  // Optional background
  if (backgroundColor) {
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, width, height);
  }

  // Draw the WebGL canvas content
  ctx.drawImage(canvas, 0, 0);

  const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
  const dataUrl = exportCanvas.toDataURL(mimeType, quality);

  // Download
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = `${filename}.${format}`;
  link.click();
}

interface FigureExportButtonProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  filename?: string;
  className?: string;
}

/**
 * Simple export button for the viewport.
 */
export function FigureExportButton({
  canvasRef,
  filename = "fullmag-figure",
  className,
}: FigureExportButtonProps) {
  const handleExport = useCallback(() => {
    if (!canvasRef.current) return;
    exportCanvasAsImage(canvasRef.current, filename, {
      pixelRatio: 2,
      backgroundColor: "#0f172a",
      format: "png",
    });
  }, [canvasRef, filename]);

  const handleExportTransparent = useCallback(() => {
    if (!canvasRef.current) return;
    exportCanvasAsImage(canvasRef.current, `${filename}-transparent`, {
      pixelRatio: 2,
      backgroundColor: null,
      format: "png",
    });
  }, [canvasRef, filename]);

  return (
    <div className={`flex items-center gap-1 ${className ?? ""}`}>
      <button
        className="text-[10px] px-2 py-1 rounded bg-slate-700/80 text-slate-300 hover:bg-slate-600 transition-colors border border-slate-500/20"
        onClick={handleExport}
        title="Export PNG with dark background"
      >
        PNG
      </button>
      <button
        className="text-[10px] px-2 py-1 rounded bg-slate-700/80 text-slate-300 hover:bg-slate-600 transition-colors border border-slate-500/20"
        onClick={handleExportTransparent}
        title="Export PNG with transparent background"
      >
        PNG ⊘
      </button>
    </div>
  );
}
