import { useEffect, useRef, useState } from "react";

import {
  planarRasterChecksum,
  type PlanarRenderEvidence,
} from "../model/fieldMapEvidence";
import type { FieldMapRenderModel } from "../model/fieldMapRenderModel";
import { viewportToRasterSpace } from "../model/planarViewTransform";
import type { ContourSegment } from "./marchingSquares";
import { decodePlanarMeshOverlayForDescriptor } from "./meshOverlay";
import { createPlanarColorizer } from "./planarColorizer";
import {
  createPlanarRenderer,
  drawPlanarOverlays,
  extractFdmOccupancyBoundaries,
  partitionPlanarMeshSegments,
  type PlanarRenderer,
} from "./planarRenderer";
import { buildVectorGlyphs } from "./vectorGlyphs";

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
    glyphs: ReturnType<typeof buildVectorGlyphs>;
    mesh: ReturnType<typeof decodePlanarMeshOverlayForDescriptor> | null;
    partitionedMesh: ReturnType<typeof partitionPlanarMeshSegments> | null;
  }>({ axisPointer: null, contours: [], glyphs: [], mesh: null, partitionedMesh: null });
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
    const glyphs = model.layers.vectors && model.vectors
      ? buildVectorGlyphs(model.vectors, model.vectorBudget, 1e-15, {
          bounds: model.bounds,
          gridHeight: model.resolution[1],
          gridWidth: model.resolution[0],
          lengthMode: model.vectorStyle.lengthMode,
          mask: model.mask ?? undefined,
          maxLengthCells: 0.4 * model.vectorScale,
          vectorScale: model.vectorScale,
        })
      : [];
    const mesh = (model.layers.mesh || model.layers.boundaries) && model.meshOverlay
      ? decodePlanarMeshOverlayForDescriptor(model.meshOverlay, model.meshOverlayDescriptor ?? {})
      : null;
    let partitionedMesh = mesh ? partitionPlanarMeshSegments(mesh) : null;
    if (
      model.layers.boundaries &&
      (!partitionedMesh || partitionedMesh.boundarySegments.length === 0) &&
      model.mask &&
      model.bounds &&
      model.resolution
    ) {
      const fdmBoundaries = extractFdmOccupancyBoundaries(model.mask, model.bounds, model.resolution);
      if (fdmBoundaries.length > 0) {
        if (!partitionedMesh) {
          partitionedMesh = {
            boundarySegments: fdmBoundaries,
            interiorSegments: new Float32Array(),
            meshSegments: new Float32Array(),
          };
        } else {
          partitionedMesh = {
            ...partitionedMesh,
            boundarySegments: fdmBoundaries,
          };
        }
      }
    }
    renderStateRef.current = {
      axisPointer: model.layers.probes ? renderStateRef.current.axisPointer : null,
      contours: [],
      glyphs,
      mesh,
      partitionedMesh,
    };
    drawOverlayRef.current = (contours) => {
      if (contours) renderStateRef.current.contours = contours;
      const current = modelRef.current;
      const state = renderStateRef.current;
      const currentMeshSegments = state.partitionedMesh;
      drawPlanarOverlays(overlayContext, overlayCanvas.width, overlayCanvas.height, {
        axisPointer: state.axisPointer,
        boundsOutline: current.boundsOutline,
        contours: state.contours,
        boundarySegments: currentMeshSegments?.boundarySegments,
        interiorSegments: currentMeshSegments?.interiorSegments,
        glyphs: state.glyphs,
        gridHeight: current.resolution[1],
        gridWidth: current.resolution[0],
        layers: current.layers,
        meshBounds: (state.mesh?.bounds ?? current.bounds) as [number, number, number, number] | undefined,
        meshSegments: currentMeshSegments?.meshSegments,
        meshViewport: current.viewport,
        samplePoints: current.samplePoints,
        pointStyle: current.pointStyle,
        vectorColorMode: current.vectorStyle.colorMode,
        vectorStyle: current.vectorStyle,
        wireframeStyle: current.wireframeStyle,
        viewport: viewportToRasterSpace(current.viewport, current.bounds, current.resolution),
      });
    };
    const range = rangeMin === undefined || rangeMax === undefined
      ? null
      : { min: rangeMin, max: rangeMax };
    const needsColorizer = range !== null && (model.layers.raster || model.layers.contours);
    if (!model.layers.raster || !needsColorizer) renderer.clearBase();
    if (needsColorizer) {
      if (renderer.getRendererKind() === "gpu" && model.layers.raster) {
        const isFdm = model.meshOverlayDescriptor?.codec === "fmfg.v1" ||
          model.meshOverlayDescriptor?.geometrySource === "fdm_structured_grid";
        if (isFdm && renderer.drawFdmCells) {
          renderer.drawFdmCells({
            bounds: model.bounds,
            colormap: model.colormap,
            mask: model.mask,
            opacity: model.rasterOpacity ?? 1,
            range,
            resolution: model.resolution,
            scalar: model.scalar,
          });
        }
      }

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
      const contourLevels: number[] = [];
      if (model.layers.contours && range.max > range.min) {
        const n = 5;
        const step = (range.max - range.min) / (n + 1);
        for (let i = 1; i <= n; i++) {
          contourLevels.push(range.min + i * step);
        }
      } else {
        contourLevels.push((range.min + range.max) / 2);
      }
      colorizerRef.current.colorize(model.scalar, range, model.mask ?? undefined, {
        colormap: model.colormap,
        contours: model.layers.contours,
        height: model.resolution[1],
        level: (range.min + range.max) / 2,
        levels: contourLevels,
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
