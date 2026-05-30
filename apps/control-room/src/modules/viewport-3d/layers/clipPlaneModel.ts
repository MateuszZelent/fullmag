import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import type { DecodedCrossSection } from "@/kernel/api/codecs";

import type { Viewport3DBounds } from "../viewport3dRenderModel";

export interface ClipPlaneFrame {
  center: [number, number, number];
  height: number;
  normal: [number, number, number];
  planeConstant: number;
  rotationDegrees: number;
  width: number;
}

export interface ClipPlaneIntersectionMarkerBuffers {
  edgeIntersectionCount: number;
  edgeIntersectionPositions: Float32Array;
  meshNodeCount: number;
  meshNodePositions: Float32Array;
}

const MIN_CLIP_PLANE_SIZE = 1e-12;
const FMCS_POINT_KIND_EDGE_INTERSECTION = 0;
const FMCS_POINT_KIND_MESH_NODE = 1;

export function resolveClipPlaneFrame(
  clip: VisualizationStateResource["clip"] | null | undefined,
  bounds: Viewport3DBounds | null,
  rotationDegrees = 0,
): ClipPlaneFrame | null {
  if (!clip?.enabled || !bounds) return null;

  const percent = clampPercent(clip.position_percent);
  const frameRotationDegrees = clampFrameRotation(rotationDegrees);
  const normalSign = clip.flipped ? -1 : 1;
  const min = bounds.center.map(
    (value, axis) => value - bounds.size[axis] / 2,
  ) as [number, number, number];
  const positionForAxis = (axis: number) =>
    min[axis] + bounds.size[axis] * (percent / 100);
  const center: [number, number, number] = [...bounds.center];

  if (clip.axis === "x") {
    center[0] = positionForAxis(0);
    const normal: [number, number, number] = [normalSign, 0, 0];
    return {
      center,
      height: planeSize(bounds.size[2]),
      normal,
      planeConstant: -normal[0] * center[0],
      rotationDegrees: frameRotationDegrees,
      width: planeSize(bounds.size[1]),
    };
  }

  if (clip.axis === "y") {
    center[1] = positionForAxis(1);
    const normal: [number, number, number] = [0, normalSign, 0];
    return {
      center,
      height: planeSize(bounds.size[2]),
      normal,
      planeConstant: -normal[1] * center[1],
      rotationDegrees: frameRotationDegrees,
      width: planeSize(bounds.size[0]),
    };
  }

  center[2] = positionForAxis(2);
  const normal: [number, number, number] = [0, 0, normalSign];
  return {
    center,
    height: planeSize(bounds.size[1]),
    normal,
    planeConstant: -normal[2] * center[2],
    rotationDegrees: frameRotationDegrees,
    width: planeSize(bounds.size[0]),
  };
}

export function resolveClipPlaneFrameOutlineSegments(
  frame: Pick<ClipPlaneFrame, "height" | "width">,
): Float32Array {
  const halfWidth = frame.width / 2;
  const halfHeight = frame.height / 2;
  return new Float32Array([
    -halfWidth, -halfHeight, 0,
    halfWidth, -halfHeight, 0,
    halfWidth, -halfHeight, 0,
    halfWidth, halfHeight, 0,
    halfWidth, halfHeight, 0,
    -halfWidth, halfHeight, 0,
    -halfWidth, halfHeight, 0,
    -halfWidth, -halfHeight, 0,
    -halfWidth, 0, 0,
    halfWidth, 0, 0,
    0, -halfHeight, 0,
    0, halfHeight, 0,
  ]);
}

export function buildClipPlaneIntersectionMarkerBuffers(
  crossSection: DecodedCrossSection | null | undefined,
): ClipPlaneIntersectionMarkerBuffers | null {
  if (!crossSection || crossSection.vertexCount === 0) return null;

  const meshNodePositions = collectMarkerPositions(
    crossSection.intersectionWorld,
    crossSection.intersectionKinds,
    FMCS_POINT_KIND_MESH_NODE,
  );
  const edgeIntersectionPositions = collectMarkerPositions(
    crossSection.intersectionWorld,
    crossSection.intersectionKinds,
    FMCS_POINT_KIND_EDGE_INTERSECTION,
  );
  if (meshNodePositions.length === 0 && edgeIntersectionPositions.length === 0) {
    return null;
  }

  return {
    edgeIntersectionCount: edgeIntersectionPositions.length / 3,
    edgeIntersectionPositions,
    meshNodeCount: meshNodePositions.length / 3,
    meshNodePositions,
  };
}

function collectMarkerPositions(
  worldPositions: Float32Array,
  kinds: Uint32Array,
  kind: number,
): Float32Array {
  let count = 0;
  for (const value of kinds) {
    if (value === kind) count++;
  }
  if (count === 0) return new Float32Array();

  const positions = new Float32Array(count * 3);
  let target = 0;
  for (let index = 0; index < kinds.length; index++) {
    if (kinds[index] !== kind) continue;
    const source = index * 3;
    positions[target++] = worldPositions[source] ?? 0;
    positions[target++] = worldPositions[source + 1] ?? 0;
    positions[target++] = worldPositions[source + 2] ?? 0;
  }
  return positions;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(0, value));
}

function clampFrameRotation(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(180, Math.max(-180, value));
}

function planeSize(value: number): number {
  return Math.max(Math.abs(value), MIN_CLIP_PLANE_SIZE);
}
