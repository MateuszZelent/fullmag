"use client";

import { useEffect, useRef, useState } from "react";

import { formatValueWithUnit } from "@/shared/domain/physics/displayUnits";

import {
  planarRasterChecksum,
  type PlanarRenderEvidence,
} from "../model/fieldMapEvidence";
import type { FieldMapRenderModel } from "../model/fieldMapRenderModel";
import { localProbe } from "../model/fieldMapProbe";
import type { ContourSegment } from "./marchingSquares";
import { decodePlanarMeshOverlayForDescriptor } from "./meshOverlay";
import { createPlanarColorizer } from "./planarColorizer";
import {
  createPlanarRenderer,
  drawPlanarOverlays,
  partitionPlanarMeshSegments,
  type PlanarRenderer,
} from "./planarRenderer";
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
  const pointersRef = useRef(new Map<number, { clientX: number; clientY: number }>());
  const pinchRef = useRef<{
    anchorU: number;
    anchorV: number;
    distance: number;
    interaction: PlanarInteraction;
  } | null>(null);
  const gestureMovedRef = useRef(false);
  const rendererRef = useRef<PlanarRenderer | null>(null);
  const overlayContextRef = useRef<CanvasRenderingContext2D | null>(null);
  const colorizerRef = useRef<ReturnType<typeof createPlanarColorizer> | null>(null);
  const drawOverlayRef = useRef<(contours?: readonly ContourSegment[]) => void>(() => undefined);
  const modelRef = useRef(model);
  const renderStateRef = useRef<{
    axisPointer: { u: number; v: number } | null;
    contours: readonly ContourSegment[];
    glyphs: ReturnType<typeof buildVectorGlyphs>;
    mesh: ReturnType<typeof decodePlanarMeshOverlayForDescriptor> | null;
  }>({ axisPointer: null, contours: [], glyphs: [], mesh: null });
  const [hoverProbe, setHoverProbe] = useState<{
    u: number;
    v: number;
    value: number | null;
  } | null>(null);
  const rangeMin = model.range?.min;
  const rangeMax = model.range?.max;

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

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
    rendererRef.current = renderer;
    const overlayContext = overlayCanvas.getContext("2d");
    if (!overlayContext) {
      renderer.dispose();
      rendererRef.current = null;
      return;
    }
    overlayContextRef.current = overlayContext;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      renderer.resize(
        entry.contentRect.width,
        entry.contentRect.height,
        window.devicePixelRatio || 1,
      );
      overlayCanvas.width = canvas.width;
      overlayCanvas.height = canvas.height;
      drawOverlayRef.current();
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      colorizerRef.current?.dispose();
      colorizerRef.current = null;
      renderer.dispose();
      rendererRef.current = null;
      overlayContextRef.current = null;
      valuesRef.current = null;
      maskRef.current = null;
    };
  }, []);

  useEffect(() => {
    const renderer = rendererRef.current;
    const overlayContext = overlayContextRef.current;
    const overlayCanvas = overlayRef.current;
    if (!renderer || !overlayContext || !overlayCanvas) return;
    valuesRef.current = model.layers.probes ? model.scalar : null;
    maskRef.current = model.layers.probes ? model.mask : null;
    const glyphs = model.layers.vectors && model.vectors
      ? buildVectorGlyphs(model.vectors, model.vectorBudget, 1e-15, {
          lengthMode: model.vectorStyle.lengthMode,
          maxLengthCells: 0.4 * model.vectorScale,
        })
      : [];
    const mesh = (model.layers.mesh || model.layers.boundaries) && model.meshOverlay
      ? decodePlanarMeshOverlayForDescriptor(model.meshOverlay, model.meshOverlayDescriptor ?? {})
      : null;
    renderStateRef.current = {
      axisPointer: model.layers.probes ? renderStateRef.current.axisPointer : null,
      contours: [],
      glyphs,
      mesh,
    };
    drawOverlayRef.current = (contours) => {
      if (contours) renderStateRef.current.contours = contours;
      const current = modelRef.current;
      const state = renderStateRef.current;
      const currentMeshSegments = state.mesh ? partitionPlanarMeshSegments(state.mesh) : null;
      drawPlanarOverlays(overlayContext, overlayCanvas.width, overlayCanvas.height, {
        axisPointer: state.axisPointer,
        boundsOutline: current.boundsOutline,
        contours: state.contours,
        boundarySegments: currentMeshSegments?.boundarySegments,
        glyphs: state.glyphs,
        gridHeight: current.resolution[1],
        gridWidth: current.resolution[0],
        layers: current.layers,
        meshBounds: state.mesh?.bounds as [number, number, number, number] | undefined,
        meshSegments: currentMeshSegments?.meshSegments,
        meshViewport: current.viewport,
        samplePoints: current.samplePoints,
        pointStyle: current.pointStyle,
        vectorColorMode: current.vectorStyle.colorMode,
        vectorStyle: current.vectorStyle,
        wireframeStyle: current.wireframeStyle,
        viewport: [
          ((current.viewport[0] - current.bounds[0]) / (current.bounds[1] - current.bounds[0])) * (current.resolution[0] - 1),
          ((current.viewport[1] - current.bounds[0]) / (current.bounds[1] - current.bounds[0])) * (current.resolution[0] - 1),
          ((current.viewport[2] - current.bounds[2]) / (current.bounds[3] - current.bounds[2])) * (current.resolution[1] - 1),
          ((current.viewport[3] - current.bounds[2]) / (current.bounds[3] - current.bounds[2])) * (current.resolution[1] - 1),
        ],
      });
    };
    const range = rangeMin === undefined || rangeMax === undefined
      ? null
      : { min: rangeMin, max: rangeMax };
    const needsColorizer = range !== null && (model.layers.raster || model.layers.contours);
    if (!model.layers.raster || !needsColorizer) renderer.clearBase();
    if (needsColorizer) {
      colorizerRef.current ??= createPlanarColorizer(
        new Worker(new URL("./planarRendererWorker.ts", import.meta.url), { type: "module" }),
        ({ contours, pixels }) => {
          const current = modelRef.current;
          const state = renderStateRef.current;
          if (current.layers.raster) rendererRef.current?.draw(pixels, current.resolution[0], current.resolution[1]);
          drawOverlayRef.current(contours);
          if (!current.layers.raster || !current.range) return;
          onRenderEvidence?.({
            glyphCount: state.glyphs.length,
            overlayCounts: {
              boundsSegments: current.layers.bounds ? 4 : 0,
              contours: contours.length,
              meshSegments: state.mesh?.segmentCount ?? 0,
              pointMarkers: current.samplePoints.length,
            },
            raster: {
              checksum: planarRasterChecksum(pixels),
              max: current.range.max,
              min: current.range.min,
              sampleCount: current.scalar.length,
            },
            sampleIdentity: current.sampleIdentity,
          });
        },
      );
      colorizerRef.current.colorize(model.scalar, range!, model.mask ?? undefined, {
        colormap: model.colormap,
        contours: model.layers.contours,
        height: model.resolution[1],
        level: (range!.min + range!.max) / 2,
        opacity: model.rasterOpacity ?? 1,
        width: model.resolution[0],
      });
    } else {
      colorizerRef.current?.dispose();
      colorizerRef.current = null;
      drawOverlayRef.current();
      const current = modelRef.current;
      const state = renderStateRef.current;
      if (
        current.layers.mesh || current.layers.boundaries || current.layers.bounds ||
        current.layers.points || current.layers.vectors
      ) {
        onRenderEvidence?.({
          glyphCount: state.glyphs.length,
          overlayCounts: {
            boundsSegments: current.layers.bounds ? 4 : 0,
            contours: 0,
            meshSegments: current.layers.mesh ? state.mesh?.segmentCount ?? 0 : 0,
            pointMarkers: current.samplePoints.length,
          },
          raster: null,
          sampleIdentity: current.sampleIdentity,
        });
      }
    }
  }, [
    model.colormap,
    model.layers.boundaries,
    model.layers.bounds,
    model.layers.contours,
    model.layers.mesh,
    model.layers.points,
    model.layers.probes,
    model.layers.raster,
    model.layers.vectors,
    model.mask,
    model.meshOverlay,
    model.meshOverlayDescriptor,
    rangeMax,
    rangeMin,
    model.rasterOpacity,
    model.resolution,
    model.scalar,
    model.vectorBudget,
    model.vectorScale,
    model.vectorStyle.colorMode,
    model.vectorStyle.color,
    model.vectorStyle.lengthMode,
    model.vectorStyle.opacity,
    model.vectorStyle.thickness,
    model.wireframeStyle,
    model.pointStyle,
    model.vectors,
    onRenderEvidence,
  ]);

  useEffect(() => {
    if (model.layers.probes) return;
    if (hoverFrameRef.current !== null && hoverFrameRef.current !== -1) {
      cancelAnimationFrame(hoverFrameRef.current);
    }
    hoverFrameRef.current = null;
    hoverPointerRef.current = null;
    renderStateRef.current.axisPointer = null;
    drawOverlayRef.current();
    resetHoverProbe(setHoverProbe);
  }, [model.layers.probes]);

  useEffect(() => {
    rendererRef.current?.setViewport(model.bounds, model.viewport);
    drawOverlayRef.current();
  }, [model.bounds, model.viewport]);

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
          if (gestureMovedRef.current) {
            gestureMovedRef.current = false;
            return;
          }
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
          if (event.key === "+" || event.key === "-") {
            event.preventDefault();
            interactionRef.current = zoomPlanarInteractionAt(
              model.bounds,
              interactionRef.current,
              model.boundsCenter[0],
              model.boundsCenter[1],
              interactionRef.current.zoom * (event.key === "+" ? 1.25 : 0.8),
            );
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
          pointersRef.current.set(event.pointerId, {
            clientX: event.clientX,
            clientY: event.clientY,
          });
          const [u, v] = pointerUv(event.currentTarget, event.clientX, event.clientY, model.viewport);
          if (pointersRef.current.size === 1) {
            gestureMovedRef.current = false;
            dragRef.current = { pointerId: event.pointerId, u, v };
          } else if (pointersRef.current.size === 2) {
            const [first, second] = [...pointersRef.current.values()];
            if (first && second) {
              const [anchorU, anchorV] = pointerUv(
                event.currentTarget,
                (first.clientX + second.clientX) / 2,
                (first.clientY + second.clientY) / 2,
                model.viewport,
              );
              pinchRef.current = {
                anchorU,
                anchorV,
                distance: pointerDistance(first, second),
                interaction: interactionRef.current,
              };
              gestureMovedRef.current = true;
              dragRef.current = null;
            }
          }
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerUp={(event) => {
          releasePlanarPointer(event.currentTarget, event.pointerId, pointersRef.current);
          pinchRef.current = null;
          if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
        }}
        onPointerCancel={(event) => {
          releasePlanarPointer(event.currentTarget, event.pointerId, pointersRef.current);
          pinchRef.current = null;
          dragRef.current = null;
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
          if (pointersRef.current.has(event.pointerId)) {
            pointersRef.current.set(event.pointerId, {
              clientX: event.clientX,
              clientY: event.clientY,
            });
          }
          const [u, v] = pointerUv(event.currentTarget, event.clientX, event.clientY, model.viewport);
          const pinch = pinchRef.current;
          if (pinch && pointersRef.current.size >= 2) {
            const [first, second] = [...pointersRef.current.values()];
            if (first && second && pinch.distance > 0) {
              interactionRef.current = zoomPlanarInteractionAt(
                model.bounds,
                pinch.interaction,
                pinch.anchorU,
                pinch.anchorV,
                pinch.interaction.zoom * pointerDistance(first, second) / pinch.distance,
              );
              gestureMovedRef.current = true;
              onInteraction?.(interactionRef.current);
            }
            return;
          }
          const drag = dragRef.current;
          if (drag && drag.pointerId === event.pointerId) {
            interactionRef.current = panPlanarInteraction(interactionRef.current, drag.u - u, drag.v - v);
            dragRef.current = { ...drag, u, v };
            gestureMovedRef.current = true;
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
            const current = modelRef.current;
            if (!current.layers.probes || !point || !latestValues) return;
            const probe = localProbe(
              point[0],
              point[1],
              current.bounds,
              current.resolution,
              latestValues,
              maskRef.current ?? undefined,
            );
            renderStateRef.current.axisPointer = { u: point[0], v: point[1] };
            drawOverlayRef.current();
            setHoverProbe({ u: point[0], v: point[1], value: probe.value });
          });
          if (hoverFrameRef.current === -1) hoverFrameRef.current = frame;
        }}
        onPointerLeave={() => {
          if (dragRef.current) return;
          hoverPointerRef.current = null;
          renderStateRef.current.axisPointer = null;
          drawOverlayRef.current();
          resetHoverProbe(setHoverProbe);
        }}
      />
      <canvas
        ref={overlayRef}
        aria-hidden="true"
        className="fm-field-map__canvas fm-field-map__canvas--overlay"
      />
      <output className="fm-field-map__probe" aria-live="polite">
        {!model.layers.probes || hoverProbe?.value === null || hoverProbe === null
          ? "No sample"
          : [
              `u ${formatValueWithUnit(hoverProbe.u, model.display.axisUnit)}`,
              `v ${formatValueWithUnit(hoverProbe.v, model.display.axisUnit)}`,
              formatValueWithUnit(
                hoverProbe.value * model.display.probeScale,
                model.display.legendUnit,
              ),
            ].join(" · ")}
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

function resetHoverProbe(
  setHoverProbe: (value: { u: number; v: number; value: number | null } | null) => void,
): void {
  setHoverProbe(null);
}

function pointerDistance(
  first: { clientX: number; clientY: number },
  second: { clientX: number; clientY: number },
): number {
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}

function releasePlanarPointer(
  canvas: HTMLCanvasElement,
  pointerId: number,
  pointers: Map<number, { clientX: number; clientY: number }>,
): void {
  pointers.delete(pointerId);
  if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
}
