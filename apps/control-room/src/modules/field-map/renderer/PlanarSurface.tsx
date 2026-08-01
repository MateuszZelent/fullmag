"use client";

import { useEffect, useRef, useState } from "react";

import { decodeFieldVector } from "@/kernel/api/codecs";

import { resolvePlanarVectorComponents } from "../model/fieldMapRenderModel";
import { localProbe } from "../model/fieldMapProbe";
import { finiteScalarRange } from "./colorRaster";
import { marchingSquares } from "./marchingSquares";
import { decodePlanarMeshOverlay } from "./meshOverlay";
import { createPlanarColorizer } from "./planarColorizer";
import { createPlanarRenderer, drawPlanarOverlays } from "./planarRenderer";
import { buildVectorGlyphs } from "./vectorGlyphs";

interface PlanarSurfaceProps {
  bounds: readonly [number, number, number, number];
  frame: {
    normal: readonly [number, number, number];
    uAxis: readonly [number, number, number];
    vAxis: readonly [number, number, number];
  };
  height: number;
  mask?: ArrayBuffer | null;
  meshOverlay?: ArrayBuffer | null;
  onPin?: (u: number, v: number) => void;
  scalar: ArrayBuffer;
  vectors?: ArrayBuffer | null;
  width: number;
}

export function PlanarSurface({
  bounds,
  frame,
  height,
  mask,
  meshOverlay,
  onPin,
  scalar,
  vectors,
  width,
}: PlanarSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const valuesRef = useRef<Float64Array | null>(null);
  const maskRef = useRef<Uint8Array | null>(null);
  const [hoverValue, setHoverValue] = useState<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlayCanvas = overlayRef.current;
    if (!canvas || !overlayCanvas) return;
    const renderer = createPlanarRenderer(canvas);
    const overlayContext = overlayCanvas.getContext("2d");
    if (!overlayContext) return renderer.dispose();
    const worker = new Worker(
      new URL("./planarRendererWorker.ts", import.meta.url),
      { type: "module" },
    );
    const colorizer = createPlanarColorizer(worker, (pixels) =>
      renderer.draw(pixels, width, height),
    );
    let drawOverlay: () => void = () => undefined;
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

    const decoded = decodeFieldVector(scalar);
    const values =
      decoded.values instanceof Float64Array
        ? new Float64Array(decoded.values)
        : new Float32Array(decoded.values);
    const emptyMask = mask ? new Uint8Array(mask.slice(0)) : undefined;
    valuesRef.current = decoded.values;
    maskRef.current = emptyMask ?? null;
    const range = finiteScalarRange(values, emptyMask);
    if (range) colorizer.colorize(values, range, emptyMask);
    const contours = range
      ? marchingSquares(
          values,
          width,
          height,
          (range.min + range.max) / 2,
          emptyMask,
        )
      : [];
    const decodedVectors = vectors ? decodeFieldVector(vectors) : null;
    const planarVectors = decodedVectors
      ? projectVectors(decodedVectors.values, frame)
      : null;
    const glyphs = planarVectors ? buildVectorGlyphs(planarVectors, 2_000) : [];
    const mesh = meshOverlay ? decodePlanarMeshOverlay(meshOverlay) : null;
    drawOverlay = () =>
      drawPlanarOverlays(overlayContext, overlayCanvas.width, overlayCanvas.height, {
        contours,
        glyphs,
        gridHeight: height,
        gridWidth: width,
        meshBounds: mesh?.bounds as [number, number, number, number] | undefined,
        meshSegments: mesh?.segments,
      });
    drawOverlay();

    return () => {
      observer.disconnect();
      colorizer.dispose();
      renderer.dispose();
      valuesRef.current = null;
      maskRef.current = null;
    };
  }, [frame, height, mask, meshOverlay, scalar, vectors, width]);

  return (
    <div
      className="fm-field-map__canvas-stack"
      style={{
        aspectRatio: String(
          Math.abs((bounds[1] - bounds[0]) / (bounds[3] - bounds[2])) || 1,
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
          const [u, v] = pointerUv(event.currentTarget, event.clientX, event.clientY, bounds);
          onPin?.(u, v);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onPin?.(0.5, 0.5);
          }
        }}
        onPointerMove={(event) => {
          const values = valuesRef.current;
          if (!values) return;
          const [u, v] = pointerUv(event.currentTarget, event.clientX, event.clientY, bounds);
          setHoverValue(
            localProbe(u, v, bounds, [width, height], values, maskRef.current ?? undefined)
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
        {hoverValue === null ? "No sample" : hoverValue}
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

function projectVectors(
  values: Float64Array,
  frame: PlanarSurfaceProps["frame"],
): Float64Array {
  const projected = new Float64Array(values.length);
  for (let index = 0; index < values.length; index += 3) {
    const components = resolvePlanarVectorComponents(
      [values[index] ?? 0, values[index + 1] ?? 0, values[index + 2] ?? 0],
      frame,
    );
    projected[index] = components.u;
    projected[index + 1] = components.v;
    projected[index + 2] = components.normal;
  }
  return projected;
}
