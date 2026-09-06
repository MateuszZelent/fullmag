import { useEffect, useRef, useState } from "react";

import {
  planarRasterChecksum,
  type PlanarRenderEvidence,
} from "../model/fieldMapEvidence";
import type { FieldMapRenderModel } from "../model/fieldMapRenderModel";
import { viewportToRasterSpace } from "../model/planarViewTransform";
import type { ContourSegment } from "./marchingSquares";
import { decodePlanarMeshOverlayForDescriptor } from "./meshOverlay";
import { isRenderablePlanarOccupancy } from "../model/planarOccupancy";
import { triangulateCutPolygons } from "./femCutSurfaceLayer";
import { createPlanarColorizer } from "./planarColorizer";
import {
  createPlanarRenderer,
  drawPlanarOverlays,
  extractFdmOccupancyBoundaries,
  partitionPlanarMeshSegments,
  type PlanarRenderer,
  WebGLContextTaintedError,
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
  const gpuLayerDrawnRef = useRef(false);
  const cutSurfaceCacheRef = useRef<{
    bounds: readonly [number, number, number, number];
    geometry: ReturnType<typeof triangulateCutPolygons>;
    mask: Uint8Array | null;
    meshOverlay: unknown;
    resolution: readonly [number, number];
    scalar: Float32Array | Float64Array;
  } | null>(null);
  const renderStateRef = useRef<{
    axisPointer: { u: number; v: number } | null;
    contours: readonly ContourSegment[];
    glyphs: ReturnType<typeof buildVectorGlyphs>;
    mesh: ReturnType<typeof decodePlanarMeshOverlayForDescriptor> | null;
    partitionedMesh: ReturnType<typeof partitionPlanarMeshSegments> | null;
  }>({ axisPointer: null, contours: [], glyphs: [], mesh: null, partitionedMesh: null });
  const [plotSize, setPlotSize] = useState({ height: 0, width: 0 });
  const [canvasKey, setCanvasKey] = useState(0);
  const [preferGpu, setPreferGpu] = useState(true);
  const rangeMin = model.range?.min;
  const rangeMax = model.range?.max;

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlayCanvas = overlayRef.current;
    if (!canvas || !overlayCanvas) return;
    let renderer: PlanarRenderer;
    try {
      renderer = createPlanarRenderer(canvas, { preferGpu });
    } catch (err) {
      if (
        err instanceof WebGLContextTaintedError ||
        (err as { name?: string })?.name === "WebGLContextTaintedError"
      ) {
        queueMicrotask(() => {
          setPreferGpu(false);
          setCanvasKey((k) => k + 1);
        });
        return;
      }
      throw err;
    }
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
  }, [canvasKey, preferGpu]);

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
    let gpuRasterDrawn = false;
    if (!model.layers.raster || !needsColorizer) {
      renderer.clearBase();
      gpuLayerDrawnRef.current = false;
    }
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
          gpuRasterDrawn = true;
        } else if (
          renderer.drawFemCutSurface &&
          model.meshOverlay &&
          (!model.operator || model.operator.kind === "plane_sample") &&
          (model.meshOverlayDescriptor?.codec === "fmcs.v4" ||
           model.meshOverlayDescriptor?.codec === "fmcs.v3" ||
           model.meshOverlayDescriptor?.geometrySource === "fem_volume_mesh")
        ) {
          try {
            const cutMesh = decodePlanarMeshOverlayForDescriptor(model.meshOverlay, model.meshOverlayDescriptor ?? {});
            if (cutMesh.polygonOffsets && cutMesh.polygonVertices && cutMesh.polygonOffsets.length > 1) {
              const width = model.resolution[0];
              const height = model.resolution[1];
              const uMin = model.bounds[0];
              const uMax = model.bounds[1];
              const vMin = model.bounds[2];
              const vMax = model.bounds[3];
              const uSpan = Math.max(1e-15, uMax - uMin);
              const vSpan = Math.max(1e-15, vMax - vMin);

              const du = uSpan / width;
              const dv = vSpan / height;

              const sampleScalar = (_vertIdx: number, u: number, v: number) => {
                if (width <= 1 || height <= 1) {
                  return model.scalar[0] ?? 0;
                }
                const xCell = (u - uMin) / du - 0.5;
                const yCell = (v - vMin) / dv - 0.5;

                const c0 = Math.max(0, Math.min(width - 2, Math.floor(xCell)));
                const c1 = c0 + 1;
                const r0 = Math.max(0, Math.min(height - 2, Math.floor(yCell)));
                const r1 = r0 + 1;

                const fx = xCell - c0;
                const fy = yCell - r0;

                const idx00 = r0 * width + c0;
                const idx10 = r0 * width + c1;
                const idx01 = r1 * width + c0;
                const idx11 = r1 * width + c1;

                const occ00 = isRenderablePlanarOccupancy(model.mask?.[idx00]);
                const occ10 = isRenderablePlanarOccupancy(model.mask?.[idx10]);
                const occ01 = isRenderablePlanarOccupancy(model.mask?.[idx01]);
                const occ11 = isRenderablePlanarOccupancy(model.mask?.[idx11]);

                if (occ00 && occ10 && occ01 && occ11) {
                  const v00 = model.scalar[idx00] ?? 0;
                  const v10 = model.scalar[idx10] ?? 0;
                  const v01 = model.scalar[idx01] ?? 0;
                  const v11 = model.scalar[idx11] ?? 0;
                  if (
                    Number.isFinite(v00) &&
                    Number.isFinite(v10) &&
                    Number.isFinite(v01) &&
                    Number.isFinite(v11)
                  ) {
                    const w00 = (1 - fx) * (1 - fy);
                    const w10 = fx * (1 - fy);
                    const w01 = (1 - fx) * fy;
                    const w11 = fx * fy;
                    return w00 * v00 + w10 * v10 + w01 * v01 + w11 * v11;
                  }
                }

                const cfx = Math.max(0, Math.min(1, fx));
                const cfy = Math.max(0, Math.min(1, fy));
                let weightSum = 0;
                let valSum = 0;

                const w00 = (1 - cfx) * (1 - cfy);
                if (occ00) {
                  const val = model.scalar[idx00] ?? 0;
                  if (Number.isFinite(val)) {
                    valSum += w00 * val;
                    weightSum += w00;
                  }
                }

                const w10 = cfx * (1 - cfy);
                if (occ10) {
                  const val = model.scalar[idx10] ?? 0;
                  if (Number.isFinite(val)) {
                    valSum += w10 * val;
                    weightSum += w10;
                  }
                }

                const w01 = (1 - cfx) * cfy;
                if (occ01) {
                  const val = model.scalar[idx01] ?? 0;
                  if (Number.isFinite(val)) {
                    valSum += w01 * val;
                    weightSum += w01;
                  }
                }

                const w11 = cfx * cfy;
                if (occ11) {
                  const val = model.scalar[idx11] ?? 0;
                  if (Number.isFinite(val)) {
                    valSum += w11 * val;
                    weightSum += w11;
                  }
                }

                if (weightSum > 1e-6) {
                  return valSum / weightSum;
                }

                const nearestC = Math.max(0, Math.min(width - 1, Math.round(xCell)));
                const nearestR = Math.max(0, Math.min(height - 1, Math.round(yCell)));
                return model.scalar[nearestR * width + nearestC] ?? 0;
              };

              let cutGeometry =
                cutSurfaceCacheRef.current?.meshOverlay === model.meshOverlay &&
                cutSurfaceCacheRef.current?.scalar === model.scalar &&
                cutSurfaceCacheRef.current?.mask === model.mask &&
                cutSurfaceCacheRef.current?.bounds === model.bounds &&
                cutSurfaceCacheRef.current?.resolution === model.resolution
                  ? cutSurfaceCacheRef.current.geometry
                  : null;
              if (!cutGeometry) {
                cutGeometry = triangulateCutPolygons(
                  cutMesh.polygonOffsets,
                  cutMesh.polygonVertices,
                  cutMesh.parentElementIds,
                  sampleScalar,
                );
                cutSurfaceCacheRef.current = {
                  bounds: model.bounds,
                  geometry: cutGeometry,
                  mask: model.mask,
                  meshOverlay: model.meshOverlay,
                  resolution: model.resolution,
                  scalar: model.scalar,
                };
              }

              if (cutGeometry.verticesUv.length > 0) {
                renderer.drawFemCutSurface({
                  bounds: model.bounds,
                  colormap: model.colormap,
                  opacity: model.rasterOpacity ?? 1,
                  range,
                  scalarValues: cutGeometry.scalarValues,
                  verticesUv: cutGeometry.verticesUv,
                });
                gpuRasterDrawn = true;
              }
            }
          } catch {
            // Fall back to CPU colorizer raster
          }
        }
      }
      gpuLayerDrawnRef.current = gpuRasterDrawn;

      if (gpuRasterDrawn && !model.layers.contours) {
        colorizerRef.current?.dispose();
        colorizerRef.current = null;
        drawOverlayRef.current([]);
        const current = modelRef.current;
        const state = renderStateRef.current;
        if (current.layers.raster && current.range) {
          onRenderEvidence?.({
            glyphCount: state.glyphs.length,
            overlayCounts: {
              boundsSegments: current.layers.bounds ? 4 : 0,
              contours: 0,
              meshSegments: state.mesh?.segmentCount ?? 0,
              pointMarkers: current.samplePoints.length,
            },
            raster: {
              checksum: planarRasterChecksum(current.scalar),
              max: current.range.max,
              min: current.range.min,
              sampleCount: current.scalar.length,
            },
            sampleIdentity: current.sampleIdentity,
          });
        }
      } else {
        colorizerRef.current ??= createPlanarColorizer(
          new Worker(new URL("./planarRendererWorker.ts", import.meta.url), { type: "module" }),
          ({ contours, pixels }) => {
          const current = modelRef.current;
          const state = renderStateRef.current;
          if (current.layers.raster && !gpuLayerDrawnRef.current) {
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
      }
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
    model.bounds,
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
    model.operator,
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
    canvasKey,
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
