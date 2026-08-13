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
import {
  fitPlanarInteraction,
  panPlanarInteraction,
  zoomPlanarInteractionAt,
  type PlanarInteraction,
} from "./planarInteraction";
import { buildVectorGlyphs } from "./vectorGlyphs";

interface PlanarSurfaceProps {
  model: FieldMapRenderModel;
  onInteraction?: (interaction: PlanarInteraction) => void;
  onPin?: (u: number, v: number) => void;
  onRenderEvidence?: (evidence: PlanarRenderEvidence) => void;
}

export function PlanarSurface({
  model,
  onInteraction,
  onPin,
  onRenderEvidence,
}: PlanarSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const valuesRef = useRef<Float32Array | Float64Array | null>(null);
  const maskRef = useRef<Uint8Array | null>(null);
  const hoverFrameRef = useRef<number | null>(null);
  const hoverPointerRef = useRef<readonly [number, number] | null>(null);
  const interactionRef = useRef<PlanarInteraction>(model.interaction);
  const dragRef = useRef<{ pointerId: number; u: number; v: number } | null>(null);
  const [hoverValue, setHoverValue] = useState<number | null>(null);

  useEffect(() => {
    interactionRef.current = model.interaction;
  }, [model.interaction]);

  useEffect(() => () => {
    if (hoverFrameRef.current !== null) cancelAnimationFrame(hoverFrameRef.current);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlayCanvas = overlayRef.current;
    if (!canvas || !overlayCanvas) return;
    const renderer = createPlanarRenderer(canvas);
    renderer.setViewport(model.bounds, model.viewport);
    const overlayContext = overlayCanvas.getContext("2d");
    if (!overlayContext) return renderer.dispose();
    const needsColorizer = model.range !== null && (model.layers.raster || model.layers.contours);
    const worker = needsColorizer
      ? new Worker(new URL("./planarRendererWorker.ts", import.meta.url), { type: "module" })
      : null;
    let rasterSummary: PlanarRenderEvidence["raster"] = null;
    let glyphs: ReturnType<typeof buildVectorGlyphs> = [];
    let mesh: ReturnType<typeof decodePlanarMeshOverlay> | null = null;
    let drawOverlay: (contours?: readonly ContourSegment[]) => void = () => undefined;
    const colorizer = worker ? createPlanarColorizer(worker, ({ contours, pixels }) => {
      if (model.layers.raster) renderer.draw(pixels, model.resolution[0], model.resolution[1]);
      drawOverlay(contours);
      if (!rasterSummary || !model.layers.raster) return;
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
    }) : null;
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
    rasterSummary = model.layers.raster && model.range
      ? {
          checksum: "",
          max: model.range.max,
          min: model.range.min,
          sampleCount: model.scalar.length,
        }
      : null;
    glyphs = model.layers.vectors && model.vectors
      ? buildVectorGlyphs(model.vectors, model.vectorBudget, 1e-15, {
          lengthMode: model.vectorStyle.lengthMode,
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
        vectorColorMode: model.vectorStyle.colorMode,
        viewport: [
          ((model.viewport[0] - model.bounds[0]) / (model.bounds[1] - model.bounds[0])) * (model.resolution[0] - 1),
          ((model.viewport[1] - model.bounds[0]) / (model.bounds[1] - model.bounds[0])) * (model.resolution[0] - 1),
          ((model.viewport[2] - model.bounds[2]) / (model.bounds[3] - model.bounds[2])) * (model.resolution[1] - 1),
          ((model.viewport[3] - model.bounds[2]) / (model.bounds[3] - model.bounds[2])) * (model.resolution[1] - 1),
        ],
      });
    if (colorizer && model.range) {
      colorizer.colorize(model.scalar, model.range, model.mask ?? undefined, {
        colormap: model.colormap,
        contours: model.layers.contours,
        height: model.resolution[1],
        level: (model.range.min + model.range.max) / 2,
        // The planar contract has no opacity field. Opaque is the only
        // non-invented rendering baseline until that contract exists.
        opacity: 1,
        width: model.resolution[0],
      });
    } else {
      drawOverlay();
    }

    return () => {
      observer.disconnect();
      colorizer?.dispose();
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
        data-probes-enabled={String(model.layers.probes)}
        tabIndex={model.layers.probes ? 0 : -1}
        onClick={(event) => {
          if (!model.layers.probes) return;
          const [u, v] = pointerUv(event.currentTarget, event.clientX, event.clientY, model.viewport);
          onPin?.(u, v);
        }}
        onKeyDown={(event) => {
          if (event.key === "0") {
            event.preventDefault();
            interactionRef.current = fitPlanarInteraction();
            onInteraction?.(interactionRef.current);
            return;
          }
          if (event.key.startsWith("Arrow")) {
            event.preventDefault();
            const spanU = (model.bounds[1] - model.bounds[0]) / interactionRef.current.zoom;
            const spanV = (model.bounds[3] - model.bounds[2]) / interactionRef.current.zoom;
            const delta = event.key === "ArrowLeft" ? [-spanU / 10, 0]
              : event.key === "ArrowRight" ? [spanU / 10, 0]
                : event.key === "ArrowUp" ? [0, spanV / 10]
                  : [0, -spanV / 10];
            interactionRef.current = panPlanarInteraction(interactionRef.current, delta[0]!, delta[1]!);
            onInteraction?.(interactionRef.current);
            return;
          }
          if (!model.layers.probes) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onPin?.(model.boundsCenter[0], model.boundsCenter[1]);
          }
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          interactionRef.current = fitPlanarInteraction();
          onInteraction?.(interactionRef.current);
        }}
        onPointerDown={(event) => {
          const [u, v] = pointerUv(event.currentTarget, event.clientX, event.clientY, model.viewport);
          dragRef.current = { pointerId: event.pointerId, u, v };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onWheel={(event) => {
          event.preventDefault();
          const [u, v] = pointerUv(event.currentTarget, event.clientX, event.clientY, model.viewport);
          interactionRef.current = zoomPlanarInteractionAt(
            model.bounds,
            interactionRef.current,
            u,
            v,
            interactionRef.current.zoom * Math.exp(-event.deltaY * 0.001),
          );
          onInteraction?.(interactionRef.current);
        }}
        onPointerMove={(event) => {
          const [u, v] = pointerUv(event.currentTarget, event.clientX, event.clientY, model.viewport);
          const drag = dragRef.current;
          if (drag && drag.pointerId === event.pointerId) {
            interactionRef.current = panPlanarInteraction(interactionRef.current, drag.u - u, drag.v - v);
            dragRef.current = { ...drag, u, v };
            onInteraction?.(interactionRef.current);
          }
          if (!model.layers.probes) return;
          const values = valuesRef.current;
          if (!values) return;
          hoverPointerRef.current = [u, v];
          if (hoverFrameRef.current !== null) return;
          hoverFrameRef.current = -1;
          let frame = -1;
          frame = requestAnimationFrame(() => {
            if (hoverFrameRef.current !== -1 && hoverFrameRef.current !== frame) return;
            hoverFrameRef.current = null;
            const point = hoverPointerRef.current;
            const latestValues = valuesRef.current;
            if (!point || !latestValues) return;
            setHoverValue(localProbe(point[0], point[1], model.bounds, model.resolution, latestValues, maskRef.current ?? undefined).value);
          });
          if (hoverFrameRef.current === -1) hoverFrameRef.current = frame;
        }}
      />
      <canvas
        ref={overlayRef}
        aria-hidden="true"
        className="fm-field-map__canvas fm-field-map__canvas--overlay"
      />
      <output className="fm-field-map__probe" aria-live="polite">
        {!model.layers.probes || hoverValue === null ? "No sample" : hoverValue * model.display.probeScale}
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
