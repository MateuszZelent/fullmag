import { useEffect, useRef, useState } from "react";

import {
  planarRasterChecksum,
  type PlanarRenderEvidence,
} from "../model/fieldMapEvidence";
import type { FieldMapRenderModel } from "../model/fieldMapRenderModel";
import type { ContourSegment } from "./marchingSquares";
import { decodePlanarMeshOverlayForDescriptor } from "./meshOverlay";
import { createPlanarColorizer } from "./planarColorizer";
import {
  createPlanarRenderer,
  drawPlanarOverlays,
  partitionPlanarMeshSegments,
  type PlanarRenderer,
} from "./planarRenderer";

export function usePlanarSurfaceRenderer(
  model: FieldMapRenderModel,
  onRenderEvidence?: (evidence: PlanarRenderEvidence) => void,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const valuesRef = useRef<Float32Array | Float64Array | null>(null);
  const maskRef = useRef<Uint8Array | null>(null);
  const rendererRef = useRef<PlanarRenderer | null>(null);
  const overlayContextRef = useRef<CanvasRenderingContext2D | null>(null);
  const observedSizeRef = useRef({ height: -1, width: -1 });
  const colorizerRef = useRef<ReturnType<typeof createPlanarColorizer> | null>(null);
  const drawOverlayRef = useRef<(contours?: readonly ContourSegment[]) => void>(() => undefined);
  const modelRef = useRef(model);
  const renderStateRef = useRef<{
    axisPointer: { u: number; v: number } | null;
    contours: readonly ContourSegment[];
    glyphCount: number;
    mesh: ReturnType<typeof decodePlanarMeshOverlayForDescriptor> | null;
  }>({ axisPointer: null, contours: [], glyphCount: 0, mesh: null });
  const [plotSize, setPlotSize] = useState({ height: 0, width: 0 });
  const rangeMin = model.range?.min;
  const rangeMax = model.range?.max;

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

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
      const width = Math.max(0, entry.contentRect.width);
      const height = Math.max(0, entry.contentRect.height);
      if (
        observedSizeRef.current.width === width &&
        observedSizeRef.current.height === height
      ) return;
      observedSizeRef.current = { height, width };
      setPlotSize({ height, width });
      renderer.resize(width, height, window.devicePixelRatio || 1);
      overlayCanvas.width = canvas.width;
      overlayCanvas.height = canvas.height;
      drawOverlayRef.current();
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      observedSizeRef.current = { height: -1, width: -1 };
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
    const mesh = (model.layers.mesh || model.layers.boundaries) && model.meshOverlay
      ? decodePlanarMeshOverlayForDescriptor(model.meshOverlay, model.meshOverlayDescriptor ?? {})
      : null;
    renderStateRef.current = {
      axisPointer: model.layers.probes ? renderStateRef.current.axisPointer : null,
      contours: [],
      glyphCount: 0,
      mesh,
    };
    drawOverlayRef.current = (contours) => {
      if (contours) renderStateRef.current.contours = contours;
      const current = modelRef.current;
      const state = renderStateRef.current;
      const currentMeshSegments = state.mesh ? partitionPlanarMeshSegments(state.mesh) : null;
      const drawn = drawPlanarOverlays(overlayContext, overlayCanvas.width, overlayCanvas.height, {
        axisPointer: state.axisPointer,
        boundsOutline: current.boundsOutline,
        contours: state.contours,
        boundarySegments: currentMeshSegments?.boundarySegments,
        vectorField: current.layers.vectors && current.vectors
          ? {
              budget: current.vectorBudget,
              lengthMode: current.vectorStyle.lengthMode,
              mask: current.mask,
              sampleBounds: current.bounds,
              scale: current.vectorScale,
              values: current.vectors,
            }
          : null,
        gridHeight: current.resolution[1],
        gridWidth: current.resolution[0],
        layers: current.layers,
        meshBounds: state.mesh?.bounds as [number, number, number, number] | undefined,
        meshSegments: currentMeshSegments?.meshSegments,
        meshViewport: current.viewport,
        samplePoints: current.samplePoints,
        pointStyle: current.pointStyle,
        // Over a direction-coloured raster, orientation-coloured arrows would
        // repeat the raster colour; draw them dark instead, as mumax3 does.
        vectorColorMode: current.directionVectors && current.vectorStyle.colorMode === "orientation"
          ? "contrast"
          : current.vectorStyle.colorMode,
        vectorStyle: current.vectorStyle,
        wireframeStyle: current.wireframeStyle,
        viewport: [
          ((current.viewport[0] - current.bounds[0]) / (current.bounds[1] - current.bounds[0])) * (current.resolution[0] - 1),
          ((current.viewport[1] - current.bounds[0]) / (current.bounds[1] - current.bounds[0])) * (current.resolution[0] - 1),
          ((current.viewport[2] - current.bounds[2]) / (current.bounds[3] - current.bounds[2])) * (current.resolution[1] - 1),
          ((current.viewport[3] - current.bounds[2]) / (current.bounds[3] - current.bounds[2])) * (current.resolution[1] - 1),
        ],
      });
      state.glyphCount = drawn.glyphCount;
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
          if (current.layers.raster) {
            rendererRef.current?.draw(pixels, current.resolution[0], current.resolution[1]);
          }
          drawOverlayRef.current(contours);
          if (!current.layers.raster || !current.range) return;
          onRenderEvidence?.({
            glyphCount: state.glyphCount,
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
      colorizerRef.current.colorize(model.scalar, range, model.mask ?? undefined, {
        colormap: model.colormap,
        contours: model.layers.contours,
        directionVectors: model.directionVectors,
        height: model.resolution[1],
        level: (range.min + range.max) / 2,
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
          glyphCount: state.glyphCount,
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
    model.directionVectors,
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
    rendererRef.current?.setViewport(model.bounds, model.viewport);
    drawOverlayRef.current();
  }, [model.bounds, model.viewport]);

  return {
    canvasRef,
    drawOverlayRef,
    maskRef,
    modelRef,
    overlayRef,
    plotSize,
    renderStateRef,
    valuesRef,
  };
}
