import type {
  DecodedCrossSection,
  DecodedCrossSectionQuality,
} from "@/kernel/api/codecs";
import type { SliceMeshColorScale } from "@/kernel/api/apiTypes";

import {
  resolveViewport2DFrameRotation,
  rotateViewport2DPositions,
  rotateViewport2DSegments,
  summarizeViewport2DPositionBounds,
} from "./viewport2dFrameTransform";

export interface Viewport2DRenderModel {
  bounds: DecodedCrossSection["bounds"];
  colors: Float32Array;
  indices: Uint32Array;
  polygons: Viewport2DPolygonSummary[];
  positions: Float32Array;
  qualityRange: DecodedCrossSectionQuality["range"] | null;
  segments: Float32Array;
  trianglePolygonIndices: Uint32Array;
}

export interface Viewport2DPolygonSummary {
  bounds: { uMax: number; uMin: number; vMax: number; vMin: number };
  centroid: { u: number; v: number };
  parentElementId: number;
  polygonIndex: number;
  qualityValue: number | null;
  triangleCount: number;
  triangleStart: number;
  vertexEnd: number;
  vertexStart: number;
  visible: boolean;
  worldCentroid: [number, number, number];
}

export interface Viewport2DRenderOptions {
  colorScale: SliceMeshColorScale;
  frameRotationDegrees: number;
  filterExpression: string;
  shrinkFactor: number;
  wireframeVisible: boolean;
}

export const DEFAULT_VIEWPORT_2D_RENDER_OPTIONS: Viewport2DRenderOptions = {
  colorScale: "jet",
  frameRotationDegrees: 0,
  filterExpression: "",
  shrinkFactor: 1,
  wireframeVisible: true,
};

export function buildViewport2DRenderModel(
  crossSection: DecodedCrossSection,
  quality: DecodedCrossSectionQuality | null,
  options: Viewport2DRenderOptions = DEFAULT_VIEWPORT_2D_RENDER_OPTIONS,
): Viewport2DRenderModel {
  const positions = new Float32Array(crossSection.vertexCount * 3);
  const colors = new Float32Array(crossSection.vertexCount * 3);
  const indices: number[] = [];
  const polygons: Viewport2DPolygonSummary[] = [];
  const trianglePolygonIndices: number[] = [];
  const qualityValues = quality?.perElementQuality ?? null;
  const qualityRange = quality?.range ?? null;
  const filter = parseQualityFilter(options.filterExpression);
  const frameRotation = resolveViewport2DFrameRotation(
    options.frameRotationDegrees,
  );
  const shrinkFactor = clampNumber(options.shrinkFactor, 0.5, 1);

  for (let vertex = 0; vertex < crossSection.vertexCount; vertex++) {
    positions[vertex * 3] = crossSection.vertices[vertex * 2];
    positions[vertex * 3 + 1] = crossSection.vertices[vertex * 2 + 1];
    positions[vertex * 3 + 2] = 0;
  }
  rotateViewport2DPositions(positions, crossSection.bounds, frameRotation);
  const rotatedBounds = summarizeViewport2DPositionBounds(
    positions,
    crossSection.bounds,
  );

  for (let polygon = 0; polygon < crossSection.polygonCount; polygon++) {
    const start = crossSection.polygonOffsets[polygon];
    const end = crossSection.polygonOffsets[polygon + 1];
    const vertexCount = end - start;
    const qualityValue = qualityValues ? qualityValues[polygon] ?? null : null;
    const colorValue = qualityValue ?? 1;
    const visible = !filter || qualityFilterMatches(colorValue, filter);
    const triangleStart = indices.length / 3;

    if (visible && shrinkFactor < 1 && vertexCount > 0) {
      shrinkPolygonVertices(positions, start, end, shrinkFactor);
    }

    const color = resolveViewport2DQualityColor(
      colorValue,
      qualityRange ?? { min: 0, max: 1 },
      options.colorScale,
    );

    if (visible) {
      for (let vertex = start; vertex < end; vertex++) {
        colors[vertex * 3] = color[0];
        colors[vertex * 3 + 1] = color[1];
        colors[vertex * 3 + 2] = color[2];
      }
      if (vertexCount >= 3) {
        for (let vertex = start + 1; vertex < end - 1; vertex++) {
          indices.push(start, vertex, vertex + 1);
          trianglePolygonIndices.push(polygon);
        }
      }
    }

    polygons.push({
      ...summarizePolygonGeometry(positions, start, end),
      parentElementId: crossSection.parentElementIds[polygon] ?? polygon,
      polygonIndex: polygon,
      qualityValue,
      triangleCount: indices.length / 3 - triangleStart,
      triangleStart,
      vertexEnd: end,
      vertexStart: start,
      visible,
      worldCentroid: summarizePolygonWorldCentroid(
        crossSection.intersectionWorld,
        start,
        end,
      ),
    });
  }

  return {
    bounds: rotatedBounds,
    colors,
    indices: Uint32Array.from(indices),
    polygons,
    positions,
    qualityRange,
    segments: options.wireframeVisible
      ? rotateViewport2DSegments(
          crossSection.segments,
          crossSection.bounds,
          frameRotation,
        )
      : new Float32Array(),
    trianglePolygonIndices: Uint32Array.from(trianglePolygonIndices),
  };
}

export function resolveViewport2DPolygonHit(
  model: Viewport2DRenderModel,
  triangleIndex: number | null | undefined,
): Viewport2DPolygonSummary | null {
  if (
    triangleIndex === null ||
    triangleIndex === undefined ||
    triangleIndex < 0 ||
    triangleIndex >= model.trianglePolygonIndices.length
  ) {
    return null;
  }

  return model.polygons[model.trianglePolygonIndices[triangleIndex]] ?? null;
}

export function resolveViewport2DQualityColor(
  value: number,
  range: { max: number; min: number },
  colorScale: SliceMeshColorScale,
): [number, number, number] {
  const span = range.max - range.min;
  const t = span > 0 ? (value - range.min) / span : 1;
  const clamped = Math.min(1, Math.max(0, t));
  if (colorScale === "hot") return hotColor(clamped);
  if (colorScale === "coolwarm") return coolwarmColor(clamped);
  if (colorScale === "viridis") return viridisColor(clamped);
  return jetColor(clamped);
}

function jetColor(t: number): [number, number, number] {
  return [
    clampNumber(1.5 - Math.abs(4 * t - 3), 0, 1),
    clampNumber(1.5 - Math.abs(4 * t - 2), 0, 1),
    clampNumber(1.5 - Math.abs(4 * t - 1), 0, 1),
  ];
}

function viridisColor(t: number): [number, number, number] {
  return [
    0.267 + 0.726 * t,
    0.005 + 0.901 * Math.sin(t * Math.PI * 0.62),
    0.329 + 0.229 * (1 - t),
  ];
}

function hotColor(t: number): [number, number, number] {
  return [
    clampNumber(3 * t, 0, 1),
    clampNumber(3 * t - 1, 0, 1),
    clampNumber(3 * t - 2, 0, 1),
  ];
}

function coolwarmColor(t: number): [number, number, number] {
  return [
    0.23 + 0.68 * t,
    0.30 + 0.55 * (1 - Math.abs(t - 0.5) * 2),
    0.75 - 0.55 * t,
  ];
}

interface QualityFilter {
  operator: "<" | "<=" | ">" | ">=";
  threshold: number;
}

function parseQualityFilter(expression: string): QualityFilter | null {
  const trimmed = expression.trim();
  if (!trimmed) return null;
  const match = /^quality\s*(<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)$/i.exec(trimmed);
  if (!match) return null;
  const threshold = Number(match[2]);
  if (!Number.isFinite(threshold)) return null;
  return {
    operator: match[1] as QualityFilter["operator"],
    threshold,
  };
}

function qualityFilterMatches(value: number, filter: QualityFilter): boolean {
  if (filter.operator === "<") return value < filter.threshold;
  if (filter.operator === "<=") return value <= filter.threshold;
  if (filter.operator === ">") return value > filter.threshold;
  return value >= filter.threshold;
}

function shrinkPolygonVertices(
  positions: Float32Array,
  start: number,
  end: number,
  shrinkFactor: number,
): void {
  let centerU = 0;
  let centerV = 0;
  const count = end - start;
  for (let vertex = start; vertex < end; vertex++) {
    centerU += positions[vertex * 3];
    centerV += positions[vertex * 3 + 1];
  }
  centerU /= count;
  centerV /= count;
  for (let vertex = start; vertex < end; vertex++) {
    const offset = vertex * 3;
    positions[offset] = centerU + (positions[offset] - centerU) * shrinkFactor;
    positions[offset + 1] =
      centerV + (positions[offset + 1] - centerV) * shrinkFactor;
  }
}

function summarizePolygonGeometry(
  positions: Float32Array,
  start: number,
  end: number,
): Pick<Viewport2DPolygonSummary, "bounds" | "centroid"> {
  if (end <= start) {
    return {
      bounds: { uMax: 0, uMin: 0, vMax: 0, vMin: 0 },
      centroid: { u: 0, v: 0 },
    };
  }

  let centerU = 0;
  let centerV = 0;
  let uMin = Number.POSITIVE_INFINITY;
  let uMax = Number.NEGATIVE_INFINITY;
  let vMin = Number.POSITIVE_INFINITY;
  let vMax = Number.NEGATIVE_INFINITY;
  for (let vertex = start; vertex < end; vertex++) {
    const u = positions[vertex * 3];
    const v = positions[vertex * 3 + 1];
    centerU += u;
    centerV += v;
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }

  const count = end - start;
  return {
    bounds: { uMax, uMin, vMax, vMin },
    centroid: { u: centerU / count, v: centerV / count },
  };
}

function summarizePolygonWorldCentroid(
  intersectionWorld: Float32Array,
  start: number,
  end: number,
): [number, number, number] {
  if (end <= start) return [0, 0, 0];

  let x = 0;
  let y = 0;
  let z = 0;
  for (let vertex = start; vertex < end; vertex++) {
    x += intersectionWorld[vertex * 3] ?? 0;
    y += intersectionWorld[vertex * 3 + 1] ?? 0;
    z += intersectionWorld[vertex * 3 + 2] ?? 0;
  }

  const count = end - start;
  return [x / count, y / count, z / count];
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
