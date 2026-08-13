"use client";

import { useEffect, useRef, useState } from "react";

import {
  planarRasterChecksum,
  type PlanarRenderEvidence,
} from "../model/fieldMapEvidence";
import type { FieldMapRenderModel } from "../model/fieldMapRenderModel";
import { localProbe } from "../model/fieldMapProbe";
import type { ContourSegment } from "./marchingSquares";
import { decodePlanarMeshOverlay } from "./meshOverlay";
import { createPlanarColorizer } from "./planarColorizer";
import { createPlanarRenderer, drawPlanarOverlays } from "./planarRenderer";
import { buildVectorGlyphs } from "./vectorGlyphs";

interface PlanarSurfaceProps {
  model: FieldMapRenderModel;
  onPin?: (u: number, v: number) => void;
  onRenderEvidence?: (evidence: PlanarRenderEvidence) => void;
}

export function PlanarSurface({
  model,
  onPin,
  onRenderEvidence,
}: PlanarSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const valuesRef = useRef<Float32Array | Float64Array | null>(null);
  const maskRef = useRef<Uint8Array | null>(null);
  const [hoverValue, setHoverValue] = useState<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlayCanvas = overlayRef.current;
    if (!canvas || !overlayCanvas) return;
    const renderer = createPlanarRenderer(canvas);
    renderer.setViewport(model.bounds, model.viewport);
    const overlayContext = overlayCanvas.getContext("2d");
    if (!overlayContext) return renderer.dispose();
    const worker = new Worker(
      new URL("./planarRendererWorker.ts", import.meta.url),
      { type: "module" },
    );
    let rasterSummary: PlanarRenderEvidence["raster"] = null;
    let glyphs: ReturnType<typeof buildVectorGlyphs> = [];
    let mesh: ReturnType<typeof decodePlanarMeshOverlay> | null = null;
    let drawOverlay: (contours?: readonly ContourSegment[]) => void = () => undefined;
    const colorizer = createPlanarColorizer(worker, ({ contours, pixels }) => {
      if (model.layers.raster) {
        renderer.draw(pixels, model.resolution[0], model.resolution[1]);
      } else {
        renderer.draw(
          new Uint8ClampedArray(model.resolution[0] * model.resolution[1] * 4),
          model.resolution[0],
          model.resolution[1],
        );
      }
      drawOverlay(contours);
      if (!rasterSummary) return;
      onRenderEvidence?.({
        glyphCount: glyphs.length,
        overlayCounts: {
          contours: contours.length,
          meshSegments: mesh?.segmentCount ?? 0,
        },
        raster: {
          ...rasterSummary,
          checksum: planarRasterChecksum(pixels),
        },
        sampleIdentity: model.sampleIdentity,
      });
    });
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      renderer.resize(
        entry.contentRect.width,
        entry.contentRect.height,
        window.devicePixelRatio || 1,
      );
      overlayCanvas.width = canvas.width;
      overlayCanvas.height = canvas.height;
      drawOverlay();
    });
    observer.observe(canvas);

    valuesRef.current = model.scalar;
    maskRef.current = model.mask;
    rasterSummary = model.range
      ? {
          checksum: "",
          max: model.range.max,
          min: model.range.min,
          sampleCount: model.scalar.length,
        }
      : null;
    glyphs = model.layers.vectors && model.vectors
      ? buildVectorGlyphs(model.vectors, model.vectorBudget, 1e-15, {
          maxLengthCells: 0.4 * model.vectorScale,
        })
      : [];
    mesh = model.layers.mesh && model.meshOverlay
      ? decodePlanarMeshOverlay(model.meshOverlay)
      : null;
    drawOverlay = (contours = []) =>
      drawPlanarOverlays(overlayContext, overlayCanvas.width, overlayCanvas.height, {
        contours,
        glyphs,
        gridHeight: model.resolution[1],
        gridWidth: model.resolution[0],
        layers: model.layers,
        meshBounds: mesh?.bounds as [number, number, number, number] | undefined,
        meshSegments: mesh?.segments,
        meshViewport: model.viewport,
        viewport: [
          ((model.viewport[0] - model.bounds[0]) / (model.bounds[1] - model.bounds[0])) * (model.resolution[0] - 1),
          ((model.viewport[1] - model.bounds[0]) / (model.bounds[1] - model.bounds[0])) * (model.resolution[0] - 1),
          ((model.bounds[3] - model.viewport[3]) / (model.bounds[3] - model.bounds[2])) * (model.resolution[1] - 1),
          ((model.bounds[3] - model.viewport[2]) / (model.bounds[3] - model.bounds[2])) * (model.resolution[1] - 1),
        ],
      });
    if (model.range) {
      colorizer.colorize(model.scalar, model.range, model.mask ?? undefined, {
        colormap: model.colormap,
        contours: model.layers.contours,
        height: model.resolution[1],
        level: (model.range.min + model.range.max) / 2,
        opacity: model.opacity,
        width: model.resolution[0],
      });
    } else {
      drawOverlay();
    }

    return () => {
      observer.disconnect();
      colorizer.dispose();
      renderer.dispose();
      valuesRef.current = null;
      maskRef.current = null;
    };
  }, [
    model,
    onRenderEvidence,
  ]);

  return (
    <div
      className="fm-field-map__canvas-stack"
      style={{
        aspectRatio: String(
          Math.abs((model.bounds[1] - model.bounds[0]) / (model.bounds[3] - model.bounds[2])) || 1,
        ),
      }}
    >
      <canvas
        ref={canvasRef}
        aria-label="Planar scalar field"
        className="fm-field-map__canvas"
        role="img"
        tabIndex={0}
        onClick={(event) => {
          const [u, v] = pointerUv(event.currentTarget, event.clientX, event.clientY, model.viewport);
          onPin?.(u, v);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onPin?.(model.boundsCenter[0], model.boundsCenter[1]);
          }
        }}
        onPointerMove={(event) => {
          const values = valuesRef.current;
          if (!values) return;
          const [u, v] = pointerUv(event.currentTarget, event.clientX, event.clientY, model.viewport);
          setHoverValue(
            localProbe(u, v, model.bounds, model.resolution, values, maskRef.current ?? undefined)
              .value,
          );
        }}
      />
      <canvas
        ref={overlayRef}
        aria-hidden="true"
        className="fm-field-map__canvas fm-field-map__canvas--overlay"
      />
      <output className="fm-field-map__probe" aria-live="polite">
        {hoverValue === null ? "No sample" : hoverValue * model.display.probeScale}
      </output>
    </div>
  );
}

function pointerUv(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  bounds: readonly [number, number, number, number],
): [number, number] {
  const rect = canvas.getBoundingClientRect();
  const tx = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
  const ty = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
  return [
    bounds[0] + tx * (bounds[1] - bounds[0]),
    bounds[3] - ty * (bounds[3] - bounds[2]),
  ];
}
